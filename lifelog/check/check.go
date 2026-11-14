// Package check holds the rules of the life folder that need only the tree
// (docs/design.md §6). It reads the content folders through an fs.FS and
// returns the problems it finds. It never writes.
//
// A problem is a finding about the files. A failure to read them is not a
// finding: Tree returns it as an error, and the caller reports that the run
// did not finish.
package check

import (
	"encoding/csv"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"math"
	"path"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"time"
	"unicode/utf8"

	"golang.org/x/text/cases"
	"golang.org/x/text/unicode/norm"
)

// Class is how much a problem holds back the ref `checked`.
type Class int

const (
	// Error: the state is damaged; `checked` stays until the files are fixed.
	Error Class = iota
	// Loss: something may be gone; `checked` stays until the owner acknowledges.
	Loss
	// Warning: the state may be wrong; `checked` moves.
	Warning
)

func (c Class) String() string {
	switch c {
	case Error:
		return "error"
	case Loss:
		return "loss"
	default:
		return "warning"
	}
}

// Problem is one finding: its class, the rule it breaks, the path (slash
// separated, relative to the folder), what is wrong and how to fix it.
type Problem struct {
	Class   Class
	Rule    string
	Path    string
	Message string
	Fix     string
}

// ContentFolders are the folders the checker reads. Everything else in the
// life folder (_check.md, .obsidian/, Syncthing's own files) is outside them.
var ContentFolders = []string{"journal", "pages", "people", "places", "metrics", "files"}

const (
	maxPathBytes = 200
	csvHeader    = "day,taken_at,value,source"
	// The most problems of one rule that one CSV file reports line by line;
	// beyond that, one more problem gives the count. A spreadsheet app that
	// rewrites every line must not bury the other findings.
	maxLinesPerRule = 3
)

var (
	dayPageName = regexp.MustCompile(`^(\d{4}-\d{2}-\d{2})\.md$`)
	csvName     = regexp.MustCompile(`^\d{4}\.[a-z0-9-]+\.csv$`)
	yearName    = regexp.MustCompile(`^\d{4}$`)
	numberText  = regexp.MustCompile(`^-?(0|[1-9][0-9]*)(\.[0-9]+)?([eE][+-]?[0-9]+)?$`)
	sourceText  = regexp.MustCompile(`^[a-z0-9_:.-]{1,64}$`)
	linkText    = regexp.MustCompile(`^\[\[([^\[\]|#^]+)\]\]$`)
	shaText     = regexp.MustCompile(`^[0-9a-f]{64}$`)
	mimeText    = regexp.MustCompile(`^[a-z]+/[a-z0-9.+-]+$`)
)

// keysOf is the closed list of frontmatter keys of each kind (design §6).
var keysOf = map[string]map[string]bool{
	"journal": set("aliases"),
	"pages":   set("aliases", "part-of", "day"),
	"people":  set("aliases", "part-of", "day", "name", "born", "died"),
	"places":  set("aliases", "part-of", "day"),
	"metrics": set("aliases", "part-of", "day", "unit", "min", "max", "daily"),
	"files":   set("aliases", "part-of", "day", "sha256", "mime"),
}

func set(keys ...string) map[string]bool {
	m := make(map[string]bool, len(keys))
	for _, k := range keys {
		m[k] = true
	}
	return m
}

type metric struct {
	min, max *float64
}

type readingKey struct{ day, takenAt, source string }

type csvFile struct {
	path string
	text string
}

type checker struct {
	fsys     fs.FS
	fold     cases.Caser
	problems []Problem
	titles   map[string][]string // title key -> the paths that hold it, as a title or an alias
	partOf   [][2]string         // path, target title
	shas     map[string][]string // sha256 -> paths
	metrics  map[string]metric   // metric name -> its page's range
	csvs     []csvFile
}

// Tree checks the content folders of fsys.
func Tree(fsys fs.FS) ([]Problem, error) {
	c := &checker{
		fsys:    fsys,
		fold:    cases.Fold(),
		titles:  map[string][]string{},
		shas:    map[string][]string{},
		metrics: map[string]metric{},
	}
	for _, top := range ContentFolders {
		if _, err := fs.Stat(fsys, top); errors.Is(err, fs.ErrNotExist) {
			continue
		} else if err != nil {
			return nil, err
		}
		err := fs.WalkDir(fsys, top, func(p string, d fs.DirEntry, err error) error {
			if err != nil {
				return err
			}
			if p == top {
				return nil
			}
			return c.entry(top, p, d)
		})
		if err != nil {
			return nil, err
		}
	}
	c.finish()
	sort.Slice(c.problems, func(i, j int) bool {
		a, b := c.problems[i], c.problems[j]
		if a.Class != b.Class {
			return a.Class < b.Class
		}
		if a.Path != b.Path {
			return a.Path < b.Path
		}
		return a.Rule < b.Rule
	})
	return c.problems, nil
}

func (c *checker) add(class Class, rule, p, fix, format string, args ...any) {
	c.problems = append(c.problems, Problem{class, rule, p, fmt.Sprintf(format, args...), fix})
}

// isSyncthingTemp is a file Syncthing is still writing. It becomes a real file
// by a rename, so the checker meets it at the next run.
func isSyncthingTemp(name string) bool {
	return strings.HasPrefix(name, ".syncthing.") || strings.HasPrefix(name, "~syncthing~")
}

func (c *checker) entry(top, p string, d fs.DirEntry) error {
	name := d.Name()
	if isSyncthingTemp(name) {
		if d.IsDir() {
			return fs.SkipDir
		}
		return nil
	}
	if !c.pathOK(p, name) {
		if d.IsDir() {
			return fs.SkipDir
		}
		return nil
	}
	if strings.Contains(name, ".sync-conflict-") {
		c.add(Error, "conflict-copy", p, "merge it into its file (`lifelog merge` for a CSV), then delete it",
			"a Syncthing conflict copy: two machines changed this file while apart")
		if d.IsDir() {
			return fs.SkipDir
		}
		return nil
	}
	depth := strings.Count(p, "/")
	if d.IsDir() {
		return c.dir(top, p, name, depth)
	}
	return c.file(top, p, name, depth)
}

// pathOK holds the path rules. A path that breaks one is not read further.
func (c *checker) pathOK(p, name string) bool {
	switch {
	case !utf8.ValidString(name):
		c.add(Error, "path-encoding", p, "rename it", "the name is not UTF-8")
	case !norm.NFC.IsNormalString(p):
		c.add(Error, "path-nfc", p, "rename it (type the name again); a tool wrote it decomposed (NFD)",
			"the name is not in Unicode NFC")
	case strings.ContainsAny(name, "#^[]|"):
		c.add(Error, "path-character", p, "rename it without # ^ [ ] |",
			"the name has a character that Obsidian cannot link to")
	case len(p) > maxPathBytes:
		c.add(Error, "path-length", p, "give it a shorter name",
			"the path is %d bytes; the most is %d", len(p), maxPathBytes)
	default:
		return true
	}
	return false
}

func (c *checker) dir(top, p, name string, depth int) error {
	switch {
	case top == "journal":
		c.add(Error, "layout", p, "move its pages to journal/ or pages/", "journal/ holds only day pages, no folders")
	case top == "metrics" && depth > 1:
		c.add(Error, "layout", p, "move its files up", "a metric's folder holds only its CSV files")
	case top == "files" && (depth > 1 || !yearName.MatchString(name)):
		c.add(Error, "layout", p, "move it into files/<year>/", "files/ holds only folders named by a year")
	default:
		return nil
	}
	return fs.SkipDir
}

func (c *checker) file(top, p, name string, depth int) error {
	switch top {
	case "journal":
		m := dayPageName.FindStringSubmatch(name)
		if m == nil || !isDay(m[1]) {
			c.add(Error, "day-page", p, "rename it to YYYY-MM-DD.md, or move it to pages/",
				"a file in journal/ must be named by a real day")
			return nil
		}
		return c.page(top, p)
	case "pages", "people", "places":
		if !strings.HasSuffix(name, ".md") {
			c.add(Error, "layout", p, "move it to files/<year>/", "only pages (.md) live here")
			return nil
		}
		return c.page(top, p)
	case "metrics":
		switch {
		case depth == 1 && strings.HasSuffix(name, ".md"):
			return c.page(top, p)
		case depth == 2 && csvName.MatchString(name):
			s, ok, err := c.text(p)
			if ok {
				c.csvs = append(c.csvs, csvFile{p, s})
			}
			return err
		}
		c.add(Error, "layout", p, "a metric is metrics/<name>.md and metrics/<name>/<year>.<machine>.csv",
			"this file has no place in metrics/")
		return nil
	case "files":
		switch {
		case depth == 2 && strings.HasSuffix(name, ".md"):
			return c.page(top, p)
		case depth == 2 && strings.HasSuffix(name, ".jpg"):
			return nil
		}
		c.add(Error, "layout", p, "keep a file as files/<year>/<name>.md (its text) and .jpg (its picture)",
			"this file has no place in files/")
		return nil
	}
	return nil
}

// text reads a file and holds the rules about its encoding. It reports
// ok=false when the content cannot be read as text.
func (c *checker) text(p string) (s string, ok bool, err error) {
	data, err := fs.ReadFile(c.fsys, p)
	if err != nil {
		return "", false, err
	}
	if !utf8.Valid(data) {
		c.add(Error, "encoding", p, "save it as UTF-8", "the file is not UTF-8")
		return "", false, nil
	}
	s = string(data)
	crlf := strings.Count(s, "\r\n")
	if crlf > 0 {
		if crlf != strings.Count(s, "\n") {
			c.add(Error, "line-endings", p, "save it with one kind of line ending", "the file mixes CRLF and LF")
			return "", false, nil
		}
		s = strings.ReplaceAll(s, "\r\n", "\n")
	}
	for _, line := range strings.Split(s, "\n") {
		if strings.HasPrefix(line, "<<<<<<< ") || strings.HasPrefix(line, ">>>>>>> ") {
			c.add(Error, "conflict-marker", p, "keep the right side, and delete the marker lines",
				"the file holds a merge conflict marker")
			break
		}
	}
	return s, true, nil
}

func (c *checker) own(title, p string) {
	key := c.fold.String(title)
	for _, q := range c.titles[key] {
		if q == p {
			return
		}
	}
	c.titles[key] = append(c.titles[key], p)
}

func (c *checker) page(top, p string) error {
	s, ok, err := c.text(p)
	if err != nil || !ok {
		return err
	}
	c.own(strings.TrimSuffix(path.Base(p), ".md"), p)
	fm, ferr := frontmatter(s)
	if ferr != nil {
		c.add(Error, "frontmatter", p, ferr.fix, "%s", ferr.msg)
		return nil
	}
	var m metric
	for _, key := range sortedKeys(fm) {
		v := fm[key]
		if top == "journal" && key == "part-of" {
			c.add(Error, "part-of-day-page", p, "remove part-of: a day page is never filed", "a day page has part-of")
			continue
		}
		if !keysOf[top][key] {
			c.add(Warning, "unknown-key", p, "remove it, or move what it says into the body",
				"the key %q is not one that a page in %s/ takes", key, top)
			continue
		}
		if key == "aliases" {
			for _, a := range v.values() {
				c.own(a, p)
			}
			continue
		}
		if len(v.list) > 0 {
			c.add(Error, "frontmatter", p, "give it one value", "the key %q takes one value, not a list", key)
			continue
		}
		val := v.scalar
		if val == "" {
			continue // an empty property, as Obsidian writes one: absent
		}
		switch key {
		case "part-of":
			t := linkText.FindStringSubmatch(val)
			if t == nil {
				c.add(Error, "part-of", p, `write it as part-of: "[[Title]]"`, "part-of is not a link: %q", val)
				continue
			}
			c.partOf = append(c.partOf, [2]string{p, t[1]})
		case "day", "born", "died":
			if !isDay(val) {
				c.add(Error, "date", p, "write a real day as YYYY-MM-DD", "%s is not a day: %q", key, val)
			}
		case "sha256":
			if !shaText.MatchString(val) {
				c.add(Error, "sha256", p, "write the 64 lowercase hex digits of the original's SHA-256", "sha256 is not a hash: %q", val)
				continue
			}
			c.shas[val] = append(c.shas[val], p)
		case "mime":
			if !mimeText.MatchString(val) {
				c.add(Error, "mime", p, "write a media type such as image/jpeg", "mime is not a media type: %q", val)
			}
		case "min", "max":
			f, ok := parseNumber(val)
			if !ok {
				c.add(Error, "range", p, "write a plain number, with a point for decimals", "%s is not a number: %q", key, val)
				continue
			}
			if key == "min" {
				m.min = &f
			} else {
				m.max = &f
			}
		case "daily":
			if val != "true" && val != "false" {
				c.add(Error, "daily", p, "write true or false", "daily is not true or false: %q", val)
			}
		}
	}
	if top == "metrics" {
		if m.min != nil && m.max != nil && *m.min > *m.max {
			c.add(Error, "range", p, "make min at most max", "min is more than max")
		}
		c.metrics[strings.TrimSuffix(path.Base(p), ".md")] = m
	}
	return nil
}

func (c *checker) finish() {
	for _, key := range sortedKeys(c.titles) {
		paths := c.titles[key]
		if len(paths) < 2 {
			continue
		}
		for _, p := range paths {
			c.add(Error, "duplicate-title", p, "rename one of them, or remove the alias",
				"the title or alias %q is held by %s", key, strings.Join(paths, ", "))
		}
	}
	for _, r := range c.partOf {
		if _, ok := c.titles[c.fold.String(r[1])]; !ok {
			c.add(Warning, "unresolved-part-of", r[0], "create the page, or correct the link",
				"part-of names %q, which no page holds", r[1])
		}
	}
	for _, sha := range sortedKeys(c.shas) {
		if paths := c.shas[sha]; len(paths) > 1 {
			for _, p := range paths {
				c.add(Error, "duplicate-file", p, "keep one of them", "the same original is kept by %s", strings.Join(paths, ", "))
			}
		}
	}
	readings := map[string]map[readingKey][]string{} // metric -> key -> "path:line"
	for _, f := range c.csvs {
		name := path.Base(path.Dir(f.path))
		m, ok := c.metrics[name]
		if !ok {
			c.add(Error, "metric-page-missing", f.path, "create metrics/"+name+".md with its unit, min and max",
				"the metric %q has no page", name)
		}
		if readings[name] == nil {
			readings[name] = map[readingKey][]string{}
		}
		c.readings(f, m, readings[name])
	}
	for _, name := range sortedKeys(readings) {
		byKey := readings[name]
		for _, k := range sortedReadingKeys(byKey) {
			locs := byKey[k]
			if len(locs) < 2 {
				continue
			}
			seen := map[string]bool{}
			for _, loc := range locs {
				p := loc[:strings.LastIndex(loc, ":")]
				if seen[p] {
					continue
				}
				seen[p] = true
				c.add(Warning, "duplicate-reading", p, "delete the line typed twice, or acknowledge a real repeat",
					"one reading (day %s, taken_at %q, source %s) is on %s", k.day, k.takenAt, k.source, strings.Join(locs, ", "))
			}
		}
	}
}

// readings holds the rules of one CSV file of readings.
func (c *checker) readings(f csvFile, m metric, byKey map[readingKey][]string) {
	if f.text != "" && !strings.HasSuffix(f.text, "\n") {
		c.add(Warning, "final-newline", f.path, "end the last line with a newline (`lifelog add` does this)",
			"the file does not end with a newline; the next line added by hand joins the last one")
	}
	r := csv.NewReader(strings.NewReader(f.text))
	r.FieldsPerRecord = -1
	header, err := r.Read()
	if err != nil || strings.Join(header, ",") != csvHeader {
		c.add(Error, "csv-header", f.path, "make the first line "+csvHeader, "the first line is not the header %s", csvHeader)
		return
	}
	counts := map[string]int{}
	bad := func(rule, fix string, line int, format string, args ...any) {
		counts[rule]++
		if counts[rule] <= maxLinesPerRule {
			c.add(Error, rule, f.path, fix, "line %d: "+format, append([]any{line}, args...)...)
		}
	}
	for {
		rec, err := r.Read()
		if err == io.EOF {
			break
		}
		if err != nil {
			line, _ := r.FieldPos(0)
			bad("csv-parse", "correct the quotes on that line", line, "%v", err)
			break
		}
		line, _ := r.FieldPos(0)
		if len(rec) != 4 {
			bad("csv-fields", "write four fields; a decimal takes a point, not a comma", line, "%d fields, not 4", len(rec))
			continue
		}
		day, takenAt, val, src := rec[0], rec[1], rec[2], rec[3]
		if !isDay(day) {
			bad("reading-day", "write a real day as YYYY-MM-DD", line, "%q is not a day", day)
		}
		if takenAt != "" && !isInstant(takenAt) {
			bad("reading-time", "write an instant with its offset, such as 2026-11-14T07:02:00+02:00, or leave it empty", line, "%q is not an instant", takenAt)
		}
		if v, ok := parseNumber(val); !ok {
			bad("reading-value", "write a plain number, with a point for decimals", line, "%q is not a number", val)
		} else if (m.min != nil && v < *m.min) || (m.max != nil && v > *m.max) {
			bad("reading-range", "correct the value, or the metric's min and max", line, "%s is outside the metric's range", val)
		}
		if !sourceText.MatchString(src) {
			bad("reading-source", "write a source of a-z, 0-9 and _ : . -", line, "%q is not a source", src)
		}
		k := readingKey{day, takenAt, src}
		byKey[k] = append(byKey[k], fmt.Sprintf("%s:%d", f.path, line))
	}
	for _, rule := range sortedKeys(counts) {
		if n := counts[rule] - maxLinesPerRule; n > 0 {
			c.add(Error, rule, f.path, "see the lines above", "and %d more lines", n)
		}
	}
}

func isDay(s string) bool {
	if len(s) != 10 {
		return false
	}
	_, err := time.Parse("2006-01-02", s)
	return err == nil
}

func isInstant(s string) bool {
	_, err := time.Parse(time.RFC3339, s)
	return err == nil
}

func parseNumber(s string) (float64, bool) {
	if !numberText.MatchString(s) {
		return 0, false
	}
	f, err := strconv.ParseFloat(s, 64)
	if err != nil || math.IsInf(f, 0) {
		return 0, false
	}
	return f, true
}

func sortedKeys[V any](m map[string]V) []string {
	keys := make([]string, 0, len(m))
	for k := range m {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	return keys
}

func sortedReadingKeys(m map[readingKey][]string) []readingKey {
	keys := make([]readingKey, 0, len(m))
	for k := range m {
		keys = append(keys, k)
	}
	sort.Slice(keys, func(i, j int) bool {
		a, b := keys[i], keys[j]
		if a.day != b.day {
			return a.day < b.day
		}
		if a.takenAt != b.takenAt {
			return a.takenAt < b.takenAt
		}
		return a.source < b.source
	})
	return keys
}
