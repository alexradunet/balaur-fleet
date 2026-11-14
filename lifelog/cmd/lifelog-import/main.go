// Command lifelog-import turns a snapshot of aminte's life.db into a life
// folder and its git history (docs/design.md §8):
//
//	lifelog-import -db life-latest.db -folder OUT -git-dir OUT.git
//
// It reads the snapshot read-only, and never the live life.db. It builds the
// branch live with git fast-import: one commit per page at its created_at
// (so creation times live in git), each tombstoned page added and then
// deleted (so the title-reuse rule knows the names aminte held), and a last
// commit with the readings, each correction chain flattened to its current
// value. Then it checks live out into the folder. It writes a report of what
// it renamed or left out.
//
// It is a binary of its own so that its SQLite dependency stays out of
// `lifelog`.
package main

import (
	"bytes"
	"database/sql"
	"errors"
	"flag"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"time"
	_ "time/tzdata" // a reading's zone name becomes its offset on any machine

	"golang.org/x/text/unicode/norm"
	_ "modernc.org/sqlite"

	"lifelog/check"
)

func main() {
	os.Exit(run(os.Args[1:], os.Stdout, os.Stderr))
}

func run(args []string, stdout, stderr io.Writer) int {
	fs := flag.NewFlagSet("lifelog-import", flag.ContinueOnError)
	fs.SetOutput(stderr)
	db := fs.String("db", "", "a snapshot of aminte's life.db (never the live file)")
	folder := fs.String("folder", "", "the new life folder; it must not exist or be empty")
	gitDir := fs.String("git-dir", "", "the new git dir; it must not exist")
	if err := fs.Parse(args); err != nil || *db == "" || *folder == "" || *gitDir == "" || fs.NArg() != 0 {
		fmt.Fprintln(stderr, "usage: lifelog-import -db SNAPSHOT -folder OUT -git-dir OUT.git")
		return 2
	}
	if err := importAll(*db, *folder, *gitDir, stdout); err != nil {
		fmt.Fprintf(stderr, "lifelog-import: %v\n", err)
		return 1
	}
	return 0
}

const aminteTime = "2006-01-02T15:04:05.000Z"

type entity struct {
	id               int64
	kind             string // page, person, metric, file
	nameKey, title   string
	aliases          []string
	day              sql.NullString
	journal          bool
	created, deleted time.Time
	isDeleted        bool
	body             string
	path             string
	front            [][2]string // frontmatter, in order
	preview          []byte
	partOf           []int64
	personName       string
	born, died       sql.NullString
	unit             string
	daily            bool
	sha256, mime     string
}

type reading struct {
	id, metric  int64
	day         string
	takenAt, tz sql.NullString
	value       sql.NullFloat64
	source      string
	supersedes  sql.NullInt64
}

func importAll(dbPath, folder, gitDir string, report io.Writer) error {
	if entries, err := os.ReadDir(folder); err == nil && len(entries) > 0 {
		return fmt.Errorf("%s is not empty", folder)
	}
	if _, err := os.Stat(gitDir); err == nil {
		return fmt.Errorf("%s exists", gitDir)
	}
	if _, err := os.Stat(dbPath); err != nil {
		return err
	}
	// mode=ro and immutable=1: no lock, no journal, no -wal or -shm beside the snapshot.
	db, err := sql.Open("sqlite", "file:"+dbPath+"?mode=ro&immutable=1")
	if err != nil {
		return err
	}
	defer db.Close()

	ents, err := readEntities(db)
	if err != nil {
		return err
	}
	byID := map[int64]*entity{}
	for _, e := range ents {
		byID[e.id] = e
	}
	var notes []string
	note := func(format string, a ...any) { notes = append(notes, fmt.Sprintf(format, a...)) }
	placeAll(ents, note)
	for _, e := range ents {
		frontmatter(e, byID, note)
	}
	csvs, err := readings(db, byID, note)
	if err != nil {
		return err
	}
	if err := writeHistory(gitDir, ents, csvs); err != nil {
		return err
	}
	if err := os.MkdirAll(folder, 0o770); err != nil {
		return err
	}
	if out, err := git(gitDir, nil, "--work-tree", folder, "checkout", "-q", "-f", "live"); err != nil {
		return fmt.Errorf("git checkout: %v: %s", err, out)
	}

	live, deleted := 0, 0
	for _, e := range ents {
		if e.isDeleted {
			deleted++
		} else {
			live++
		}
	}
	fmt.Fprintf(report, "# Import from aminte\n\n%d pages, %d tombstoned pages (added and deleted in the history), %d files of readings.\n", live, deleted, len(csvs))
	if len(notes) > 0 {
		fmt.Fprintf(report, "\n## What changed on the way (%d)\n\n", len(notes))
		for _, n := range notes {
			fmt.Fprintf(report, "- %s\n", n)
		}
	}
	return nil
}

func parseTime(s string) (time.Time, error) {
	return time.Parse(aminteTime, s)
}

func readEntities(db *sql.DB) ([]*entity, error) {
	rows, err := db.Query(`SELECT e.id, e.entity_type, e.preferred_name_key, n.title, e.day, e.is_journal,
	       e.created_at, e.deleted_at, e.body
	  FROM entities e JOIN entity_names n ON n.entity_id = e.id AND n.name_key = e.preferred_name_key
	 ORDER BY e.id`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var ents []*entity
	for rows.Next() {
		e := &entity{}
		var created string
		var deleted sql.NullString
		if err := rows.Scan(&e.id, &e.kind, &e.nameKey, &e.title, &e.day, &e.journal, &created, &deleted, &e.body); err != nil {
			return nil, err
		}
		if e.created, err = parseTime(created); err != nil {
			return nil, fmt.Errorf("entity %d: created_at: %w", e.id, err)
		}
		if deleted.Valid {
			e.isDeleted = true
			if e.deleted, err = parseTime(deleted.String); err != nil {
				return nil, fmt.Errorf("entity %d: deleted_at: %w", e.id, err)
			}
		}
		ents = append(ents, e)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	byID := map[int64]*entity{}
	for _, e := range ents {
		byID[e.id] = e
	}

	extra := []struct {
		query string
		scan  func(*sql.Rows) error
	}{
		{`SELECT entity_id, title FROM entity_names n JOIN entities e ON e.id = n.entity_id
		   WHERE n.name_key <> e.preferred_name_key ORDER BY n.id`, func(r *sql.Rows) error {
			var id int64
			var t string
			if err := r.Scan(&id, &t); err != nil {
				return err
			}
			if e := byID[id]; e != nil {
				e.aliases = append(e.aliases, t)
			}
			return nil
		}},
		{`SELECT id, name, birth_day, death_day FROM people`, func(r *sql.Rows) error {
			var id int64
			var name string
			var born, died sql.NullString
			if err := r.Scan(&id, &name, &born, &died); err != nil {
				return err
			}
			if e := byID[id]; e != nil {
				e.personName, e.born, e.died = name, born, died
			}
			return nil
		}},
		{`SELECT id, unit, daily FROM metrics`, func(r *sql.Rows) error {
			var id int64
			var unit string
			var daily bool
			if err := r.Scan(&id, &unit, &daily); err != nil {
				return err
			}
			if e := byID[id]; e != nil {
				e.unit, e.daily = unit, daily
			}
			return nil
		}},
		{`SELECT id, sha256, mime, preview FROM files`, func(r *sql.Rows) error {
			var id int64
			var sha, mime string
			var preview []byte
			if err := r.Scan(&id, &sha, &mime, &preview); err != nil {
				return err
			}
			if e := byID[id]; e != nil {
				e.sha256, e.mime, e.preview = sha, mime, preview
			}
			return nil
		}},
		{`SELECT from_id, to_id FROM links WHERE kind = 'part-of' ORDER BY id`, func(r *sql.Rows) error {
			var from, to int64
			if err := r.Scan(&from, &to); err != nil {
				return err
			}
			if e := byID[from]; e != nil {
				e.partOf = append(e.partOf, to)
			}
			return nil
		}},
	}
	for _, x := range extra {
		rows, err := db.Query(x.query)
		if err != nil {
			return nil, err
		}
		for rows.Next() {
			if err := x.scan(rows); err != nil {
				rows.Close()
				return nil, err
			}
		}
		err = rows.Err()
		rows.Close()
		if err != nil {
			return nil, err
		}
	}
	return ents, nil
}

const maxPathBytes = 200

// safeTitle is a title the path rules accept: NFC, without the characters
// Obsidian cannot link to (# ^ become their fullwidth and modifier forms).
func safeTitle(t string) string {
	t = norm.NFC.String(t)
	return strings.NewReplacer("#", "＃", "^", "ˆ", "|", "｜", "[", "［", "]", "］").Replace(t)
}

// placeAll gives each entity its path. Titles that change on the way keep
// their old spelling as an alias, and the report lists them.
func placeAll(ents []*entity, note func(string, ...any)) {
	taken := map[string]bool{} // title keys of the living pages
	for _, e := range ents {
		title := safeTitle(e.title)
		var dir string
		switch {
		case e.kind == "page" && e.journal:
			dir = "journal"
		case e.kind == "page":
			dir = "pages"
		case e.kind == "person":
			dir = "people"
		case e.kind == "metric":
			dir = "metrics"
		case e.kind == "file":
			dir = "files/" + e.created.Format("2006")
		}
		for len(dir)+1+len(title)+3 > maxPathBytes {
			r := []rune(title)
			title = strings.TrimSpace(string(r[:len(r)-1]))
		}
		if !e.isDeleted {
			base, n := title, 2
			for taken[check.TitleKey(title)] {
				title = fmt.Sprintf("%s (%d)", base, n)
				n++
			}
			taken[check.TitleKey(title)] = true
		}
		if title != e.title {
			e.aliases = append([]string{e.title}, e.aliases...)
			if !e.isDeleted {
				note("%q is now %q (a path rule); the old spelling is an alias", e.title, title)
			}
		}
		e.title = title
		e.path = dir + "/" + title + ".md"
	}
}

// scaleUnit is a scale's unit, which names its range (aminte's D6): 1-5, 0-10.
var scaleUnit = regexp.MustCompile(`^(\d+)-(\d+)$`)

var plainScalar = regexp.MustCompile(`^[^\s\[\]{}&*!|>%@` + "`" + `#,"'?:-][^\n]*$`)

// yamlValue writes a value the frontmatter grammar reads back as itself.
func yamlValue(s string) string {
	if plainScalar.MatchString(s) && !strings.Contains(s, ": ") && !strings.Contains(s, " #") && strings.TrimSpace(s) == s {
		return s
	}
	return strconv.Quote(s)
}

func frontmatter(e *entity, byID map[int64]*entity, note func(string, ...any)) {
	add := func(k, v string) { e.front = append(e.front, [2]string{k, v}) }
	if len(e.partOf) > 0 && !e.journal {
		if t := byID[e.partOf[0]]; t != nil {
			add("part-of", strconv.Quote("[["+t.title+"]]"))
		}
		if len(e.partOf) > 1 && !e.isDeleted {
			note("%s was filed in %d categories; the first is its part-of, the others are links in its body", e.path, len(e.partOf))
			var more []string
			for _, id := range e.partOf[1:] {
				if t := byID[id]; t != nil {
					more = append(more, "[["+t.title+"]]")
				}
			}
			e.body = strings.TrimRight(e.body, "\n") + "\n\nAlso filed in: " + strings.Join(more, ", ") + "\n"
		}
	}
	if e.day.Valid && !e.journal {
		add("day", e.day.String)
	}
	switch e.kind {
	case "person":
		if e.personName != "" && e.personName != e.title {
			add("name", yamlValue(e.personName))
		}
		if e.born.Valid {
			add("born", e.born.String)
		}
		if e.died.Valid {
			add("died", e.died.String)
		}
	case "metric":
		if e.unit != "" {
			add("unit", yamlValue(e.unit))
		}
		// A scale names its range as its unit (aminte's D6): 1-5, 0-10.
		if m := scaleUnit.FindStringSubmatch(e.unit); m != nil {
			add("min", m[1])
			add("max", m[2])
		}
		if e.daily {
			add("daily", "true")
		}
	case "file":
		add("sha256", e.sha256)
		add("mime", e.mime)
	}
}

func (e *entity) text() string {
	var b strings.Builder
	if len(e.aliases) > 0 || len(e.front) > 0 || strings.HasPrefix(e.body, "---\n") {
		b.WriteString("---\n")
		if len(e.aliases) > 0 {
			b.WriteString("aliases:\n")
			for _, a := range e.aliases {
				b.WriteString("  - " + yamlValue(a) + "\n")
			}
		}
		for _, kv := range e.front {
			b.WriteString(kv[0] + ": " + kv[1] + "\n")
		}
		b.WriteString("---\n")
	}
	b.WriteString(e.body)
	if e.body != "" && !strings.HasSuffix(e.body, "\n") {
		b.WriteString("\n")
	}
	return b.String()
}

// readings flattens each correction chain to its current value and returns
// the CSV files: path -> text.
func readings(db *sql.DB, byID map[int64]*entity, note func(string, ...any)) (map[string]string, error) {
	rows, err := db.Query(`SELECT id, metric_id, day, taken_at, tz, value, source, supersedes_id FROM measurements ORDER BY id`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var all []reading
	superseded := map[int64]bool{}
	for rows.Next() {
		var r reading
		if err := rows.Scan(&r.id, &r.metric, &r.day, &r.takenAt, &r.tz, &r.value, &r.source, &r.supersedes); err != nil {
			return nil, err
		}
		if r.supersedes.Valid {
			superseded[r.supersedes.Int64] = true
		}
		all = append(all, r)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	lines := map[string][]string{}
	dropped, retracted, corrected := 0, 0, 0
	for _, r := range all {
		switch {
		case superseded[r.id]:
			corrected++
			continue
		case !r.value.Valid:
			retracted++
			continue
		}
		m := byID[r.metric]
		if m == nil || m.isDeleted {
			dropped++
			continue
		}
		at := ""
		if r.takenAt.Valid {
			t, err := parseTime(r.takenAt.String)
			if err != nil {
				return nil, fmt.Errorf("reading %d: taken_at: %w", r.id, err)
			}
			if r.tz.Valid {
				if loc, err := time.LoadLocation(r.tz.String); err == nil {
					t = t.In(loc)
				}
			}
			at = t.Format(time.RFC3339Nano)
		}
		p := "metrics/" + strings.TrimSuffix(path.Base(m.path), ".md") + "/" + r.day[:4] + ".import.csv"
		lines[p] = append(lines[p], strings.Join([]string{r.day, at, strconv.FormatFloat(r.value.Float64, 'f', -1, 64), r.source}, ","))
	}
	if corrected+retracted > 0 {
		note("%d readings were earlier values of a correction chain and %d were retractions; only current values are in the CSVs (the chains stay in aminte's snapshots)", corrected, retracted)
	}
	if dropped > 0 {
		note("%d readings belong to a tombstoned metric and are left out", dropped)
	}
	csvs := map[string]string{}
	for p, ls := range lines {
		sort.Strings(ls) // by day, then taken_at
		csvs[p] = check.CSVHeader + "\n" + strings.Join(ls, "\n") + "\n"
	}
	return csvs, nil
}

type event struct {
	at   time.Time
	e    *entity
	gone bool
}

func writeHistory(gitDir string, ents []*entity, csvs map[string]string) error {
	if out, err := exec.Command("git", "init", "-q", "--bare", gitDir).CombinedOutput(); err != nil {
		return fmt.Errorf("git init: %v: %s", err, out)
	}
	if out, err := git(gitDir, nil, "symbolic-ref", "HEAD", "refs/heads/live"); err != nil {
		return fmt.Errorf("git symbolic-ref: %v: %s", err, out)
	}
	var events []event
	for _, e := range ents {
		events = append(events, event{e.created, e, false})
		if e.isDeleted {
			events = append(events, event{e.deleted, e, true})
		}
	}
	sort.SliceStable(events, func(i, j int) bool { return events[i].at.Before(events[j].at) })

	// Commits on one branch in one stream follow each other: no `from` line.
	var s bytes.Buffer
	commit := func(at time.Time, msg string, body func()) {
		ts := fmt.Sprintf("%d +0000", at.Unix())
		fmt.Fprintf(&s, "commit refs/heads/live\nauthor lifelog import <import@lifelog> %s\ncommitter lifelog import <import@lifelog> %s\ndata %d\n%s\n", ts, ts, len(msg), msg)
		body()
		s.WriteString("\n")
	}
	file := func(p string, data []byte) {
		fmt.Fprintf(&s, "M 100644 inline %s\ndata %d\n", quotePath(p), len(data))
		s.Write(data)
		s.WriteString("\n")
	}
	jpg := func(e *entity) string { return strings.TrimSuffix(e.path, ".md") + ".jpg" }
	for _, ev := range events {
		e := ev.e
		if ev.gone {
			commit(ev.at, "import: "+e.path+" (deleted in aminte)", func() {
				fmt.Fprintf(&s, "D %s\n", quotePath(e.path))
				if len(e.preview) > 0 {
					fmt.Fprintf(&s, "D %s\n", quotePath(jpg(e)))
				}
			})
			continue
		}
		commit(ev.at, "import: "+e.path, func() {
			file(e.path, []byte(e.text()))
			if len(e.preview) > 0 {
				file(jpg(e), e.preview)
			}
		})
	}
	commit(time.Now(), "import: the readings, current values", func() {
		paths := make([]string, 0, len(csvs))
		for p := range csvs {
			paths = append(paths, p)
		}
		sort.Strings(paths)
		for _, p := range paths {
			file(p, []byte(csvs[p]))
		}
	})
	if out, err := git(gitDir, &s, "fast-import", "--quiet"); err != nil {
		return fmt.Errorf("git fast-import: %v: %s", err, out)
	}
	return nil
}

// quotePath writes a path as fast-import reads it: C-style quoted when it
// starts with a quote or holds a newline, as is otherwise.
func quotePath(p string) string {
	if strings.HasPrefix(p, `"`) || strings.ContainsAny(p, "\n") {
		return strconv.Quote(p)
	}
	return p
}

func git(gitDir string, stdin io.Reader, args ...string) ([]byte, error) {
	cmd := exec.Command("git", append([]string{"--git-dir", gitDir}, args...)...)
	cmd.Env = append(os.Environ(), "GIT_CONFIG_NOSYSTEM=1", "GIT_CONFIG_GLOBAL=/dev/null", "LC_ALL=C")
	cmd.Stdin = stdin
	out, err := cmd.CombinedOutput()
	if err != nil && errors.Is(err, exec.ErrNotFound) {
		return out, fmt.Errorf("git is not installed: %w", err)
	}
	return out, err
}
