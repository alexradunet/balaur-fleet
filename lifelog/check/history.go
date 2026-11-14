package check

import (
	"bufio"
	"bytes"
	"context"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path"
	"regexp"
	"sort"
	"strconv"
	"strings"

	"golang.org/x/text/cases"
)

// History holds the rules of design §6 that compare two commits of the life
// folder's git history: the losses, and the warnings that need the past. It
// compares `from` (the ref seen: what the owner last acknowledged) with `to`
// (the ref live: the state the keeper has just committed). It reads git only,
// through the git program, and never the folder.
func History(ctx context.Context, gitDir, from, to string) ([]Problem, error) {
	r := repo{ctx, gitDir}
	h := &history{repo: r, fold: cases.Fold()}
	return h.run(from, to)
}

// RefExists reports whether ref names a commit. The first run of the keeper
// has no ref seen yet, and so no past to compare with.
func RefExists(ctx context.Context, gitDir, ref string) bool {
	_, err := repo{ctx, gitDir}.git(nil, "rev-parse", "--verify", "--quiet", ref+"^{commit}")
	return err == nil
}

const massDeletion = 20 // more page deletions than this at once are a loss

// wikilink finds the target of [[Target]], [[Target|text]], [[Target#heading]]
// and ![[Target]]: the text before | # ^ or ]].
var wikilink = regexp.MustCompile(`\[\[([^\[\]|#^\n]+)`)

type repo struct {
	ctx context.Context
	dir string
}

func (r repo) git(stdin io.Reader, args ...string) ([]byte, error) {
	// safe.directory: the git dir belongs to the keeper's user; the owner reads it too.
	cmd := exec.CommandContext(r.ctx, "git", append([]string{"--git-dir", r.dir, "-c", "safe.directory=" + r.dir}, args...)...)
	// The owner's git settings must not change what the rules see: a
	// different diff.renames or a pager would change the output.
	cmd.Env = append(os.Environ(), "LC_ALL=C", "GIT_CONFIG_NOSYSTEM=1", "GIT_CONFIG_GLOBAL=/dev/null", "GIT_PAGER=cat")
	cmd.Stdin = stdin
	var stderr bytes.Buffer
	cmd.Stderr = &stderr
	out, err := cmd.Output()
	if err != nil {
		return nil, fmt.Errorf("git %s: %w: %s", strings.Join(args, " "), err, strings.TrimSpace(stderr.String()))
	}
	return out, nil
}

type entry struct {
	oid  string
	size int64
}

// tree lists the files of the content folders at ref, with their blob ids and sizes.
func (r repo) tree(ref string) (map[string]entry, error) {
	out, err := r.git(nil, "ls-tree", "-r", "-l", "-z", ref, "--")
	if err != nil {
		return nil, err
	}
	m := map[string]entry{}
	for _, rec := range bytes.Split(out, []byte{0}) {
		meta, p, ok := bytes.Cut(rec, []byte{'\t'})
		if !ok {
			continue
		}
		f := strings.Fields(string(meta)) // mode, type, oid, size
		if len(f) != 4 || f[1] != "blob" || !inContent(string(p)) {
			continue
		}
		size, err := strconv.ParseInt(f[3], 10, 64)
		if err != nil {
			return nil, fmt.Errorf("git ls-tree: the size of %s: %w", p, err)
		}
		m[string(p)] = entry{f[2], size}
	}
	return m, nil
}

type change struct {
	status   byte // A added, D deleted, M modified, R renamed, T type changed
	from, to string
}

// diff lists the changes in the content folders between two commits, with
// git's rename detection.
func (r repo) diff(from, to string) ([]change, error) {
	out, err := r.git(nil, "diff", "-M", "-z", "--name-status", from, to, "--")
	if err != nil {
		return nil, err
	}
	f := bytes.Split(out, []byte{0})
	var changes []change
	for i := 0; i < len(f); {
		if len(f[i]) == 0 {
			i++
			continue
		}
		st := f[i][0]
		if (st == 'R' || st == 'C') && i+2 < len(f) {
			changes = append(changes, change{st, string(f[i+1]), string(f[i+2])})
			i += 3
			continue
		}
		if i+1 >= len(f) {
			return nil, fmt.Errorf("git diff: a record without its path")
		}
		changes = append(changes, change{st, string(f[i+1]), string(f[i+1])})
		i += 2
	}
	var kept []change
	for _, c := range changes {
		if inContent(c.from) || inContent(c.to) {
			kept = append(kept, c)
		}
	}
	return kept, nil
}

// blobs reads the content of blobs by their ids, in one git process.
func (r repo) blobs(oids []string) (map[string][]byte, error) {
	out := map[string][]byte{}
	if len(oids) == 0 {
		return out, nil
	}
	in := strings.Join(oids, "\n") + "\n"
	raw, err := r.git(strings.NewReader(in), "cat-file", "--batch")
	if err != nil {
		return nil, err
	}
	br := bufio.NewReader(bytes.NewReader(raw))
	for {
		header, err := br.ReadString('\n')
		if err == io.EOF {
			return out, nil
		}
		if err != nil {
			return nil, err
		}
		f := strings.Fields(header) // oid, type, size
		if len(f) != 3 {
			return nil, fmt.Errorf("git cat-file: an unexpected line %q", header)
		}
		size, err := strconv.Atoi(f[2])
		if err != nil {
			return nil, fmt.Errorf("git cat-file: %q: %w", header, err)
		}
		data := make([]byte, size+1) // the content and its trailing newline
		if _, err := io.ReadFull(br, data); err != nil {
			return nil, fmt.Errorf("git cat-file: %s: %w", f[0], err)
		}
		out[f[0]] = data[:size]
	}
}

func inContent(p string) bool {
	top, _, _ := strings.Cut(p, "/")
	for _, f := range ContentFolders {
		if top == f {
			return true
		}
	}
	return false
}

func isPagePath(p string) bool { return inContent(p) && strings.HasSuffix(p, ".md") }

func isCSVPath(p string) bool {
	return strings.HasPrefix(p, "metrics/") && strings.HasSuffix(p, ".csv")
}

func isMetricPage(p string) bool {
	return strings.HasPrefix(p, "metrics/") && strings.Count(p, "/") == 1 && strings.HasSuffix(p, ".md")
}

func titleOf(p string) string { return strings.TrimSuffix(path.Base(p), ".md") }

type history struct {
	repo
	fold     cases.Caser
	problems []Problem
}

func (h *history) add(class Class, rule, p, fix, format string, args ...any) {
	h.problems = append(h.problems, Problem{class, rule, p, fmt.Sprintf(format, args...), fix})
}

func (h *history) run(from, to string) ([]Problem, error) {
	old, err := h.tree(from)
	if err != nil {
		return nil, err
	}
	cur, err := h.tree(to)
	if err != nil {
		return nil, err
	}
	changes, err := h.diff(from, to)
	if err != nil {
		return nil, err
	}

	// Read every page at both commits (titles, aliases, links, units) and the
	// CSV files that changed. S5 measured the whole tree in about a second.
	need := map[string]bool{}
	for _, t := range []map[string]entry{old, cur} {
		for p, e := range t {
			if isPagePath(p) {
				need[e.oid] = true
			}
		}
	}
	for _, c := range changes {
		if c.status == 'M' && isCSVPath(c.to) {
			need[old[c.from].oid] = true
			need[cur[c.to].oid] = true
		}
	}
	content, err := h.blobs(sortedKeys(need))
	if err != nil {
		return nil, err
	}
	text := func(e entry) string { return strings.ReplaceAll(string(content[e.oid]), "\r\n", "\n") }

	h.deletions(changes)
	h.sizes(changes, old, cur)
	h.units(changes, old, cur, text)
	h.readings(changes, old, cur, text)
	h.links(changes, old, cur, text)
	if err := h.reusedTitles(to, changes); err != nil {
		return nil, err
	}
	sort.Slice(h.problems, func(i, j int) bool {
		a, b := h.problems[i], h.problems[j]
		if a.Class != b.Class {
			return a.Class < b.Class
		}
		if a.Path != b.Path {
			return a.Path < b.Path
		}
		return a.Rule < b.Rule
	})
	return h.problems, nil
}

func (h *history) deletions(changes []change) {
	var pages []string
	for _, c := range changes {
		if c.status != 'D' {
			continue
		}
		switch {
		case isCSVPath(c.from):
			h.add(Loss, "csv-removed", c.from, "lifelog restore "+c.from+"; or, if you meant it, delete _check.md",
				"a file of readings was removed")
		case isPagePath(c.from):
			pages = append(pages, c.from)
		}
	}
	if len(pages) > massDeletion {
		h.add(Loss, "mass-deletion", ".", "if you meant it, delete _check.md; else lifelog restore each page",
			"%d pages were deleted since the last acknowledged check, such as %s", len(pages), strings.Join(pages[:5], ", "))
	}
}

func (h *history) sizes(changes []change, old, cur map[string]entry) {
	for _, c := range changes {
		if (c.status != 'M' && c.status != 'R') || !isPagePath(c.to) {
			continue
		}
		before, after := old[c.from].size, cur[c.to].size
		switch {
		case after == 0 && before > 0:
			h.add(Loss, "page-emptied", c.to, "lifelog restore "+c.to+"; or, if you meant it, delete _check.md",
				"the page is empty; it held %d bytes", before)
		case after*2 < before:
			h.add(Warning, "page-shrank", c.to, "lifelog restore "+c.to+" if this was not meant",
				"the page went from %d to %d bytes", before, after)
		}
	}
}

func unitOf(s string) string {
	fm, err := frontmatter(s)
	if err != nil {
		return ""
	}
	return fm["unit"].scalar
}

func (h *history) units(changes []change, old, cur map[string]entry, text func(entry) string) {
	for _, c := range changes {
		if c.status != 'M' || !isMetricPage(c.to) {
			continue
		}
		if a, b := unitOf(text(old[c.from])), unitOf(text(cur[c.to])); a != b {
			h.add(Warning, "unit-changed", c.to, "if the old readings are in the old unit, convert them, or keep the old unit",
				"the unit changed from %q to %q; the readings already written keep their numbers", a, b)
		}
	}
}

func (h *history) readings(changes []change, old, cur map[string]entry, text func(entry) string) {
	for _, c := range changes {
		if c.status != 'M' || !isCSVPath(c.to) {
			continue
		}
		now := map[string]bool{}
		for _, l := range strings.Split(text(cur[c.to]), "\n") {
			now[l] = true
		}
		var gone []string
		for i, l := range strings.Split(text(old[c.from]), "\n") {
			if i > 0 && l != "" && !now[l] {
				gone = append(gone, l)
			}
		}
		if len(gone) > 0 {
			h.add(Warning, "reading-changed", c.to, "if it was a correction, delete _check.md; else lifelog restore "+c.to,
				"%d lines were changed or removed since the last acknowledged check, such as %q", len(gone), gone[0])
		}
	}
}

// titles is the title and alias keys of the pages of a tree: key -> a path that holds it.
func (h *history) titles(t map[string]entry, text func(entry) string) map[string]string {
	m := map[string]string{}
	for _, p := range sortedKeys(t) {
		if !isPagePath(p) {
			continue
		}
		m[h.fold.String(titleOf(p))] = p
		if fm, err := frontmatter(text(t[p])); err == nil {
			for _, a := range fm["aliases"].values() {
				if _, held := m[h.fold.String(a)]; !held {
					m[h.fold.String(a)] = p
				}
			}
		}
	}
	return m
}

func (h *history) links(changes []change, old, cur map[string]entry, text func(entry) string) {
	before, after := h.titles(old, text), h.titles(cur, text)
	renamed := map[string]string{} // old path -> new path
	for _, c := range changes {
		if c.status == 'R' && isPagePath(c.from) {
			renamed[c.from] = c.to
		}
	}
	broken := map[string][]string{} // old path of the target -> linking pages
	names := map[string]string{}    // old path of the target -> the name as linked
	for _, p := range sortedKeys(cur) {
		if !isPagePath(p) {
			continue
		}
		seen := map[string]bool{}
		for _, m := range wikilink.FindAllStringSubmatch(text(cur[p]), -1) {
			name := strings.TrimSpace(m[1])
			key := h.fold.String(name)
			if _, ok := after[key]; ok || seen[key] {
				continue
			}
			target, ok := before[key]
			if !ok {
				continue // it never resolved: an unresolved link is allowed
			}
			seen[key] = true
			broken[target] = append(broken[target], p)
			names[target] = name
		}
	}
	for _, target := range sortedKeys(broken) {
		pages := broken[target]
		shown := pages
		if len(shown) > 5 {
			shown = shown[:5]
		}
		msg := fmt.Sprintf("%d pages link to [[%s]], which no page holds now: %s", len(pages), names[target], strings.Join(shown, ", "))
		fix := "add the old name to the aliases of the page that took it, or correct the links"
		if to, ok := renamed[target]; ok {
			msg += fmt.Sprintf("; git sees %s renamed to %s", target, to)
			fix = fmt.Sprintf("lifelog rename-links %q %q, or add %q to its aliases", names[target], titleOf(to), names[target])
		}
		h.add(Warning, "broken-link", target, fix, "%s", msg)
	}
}

// reusedTitles warns when a page added since `seen` takes the title of a page
// deleted earlier in the history of `to`: old links would reach the new page.
func (h *history) reusedTitles(to string, changes []change) error {
	added := map[string]string{} // title key -> new path
	for _, c := range changes {
		if (c.status == 'A' || c.status == 'R') && isPagePath(c.to) {
			added[h.fold.String(titleOf(c.to))] = c.to
		}
	}
	if len(added) == 0 {
		return nil
	}
	out, err := h.git(nil, "log", "-M", "--diff-filter=D", "--name-only", "-z", "--format=", to, "--")
	if err != nil {
		return err
	}
	deleted := map[string]string{}
	for _, p := range bytes.Split(out, []byte{0}) {
		s := strings.TrimSpace(string(p))
		if isPagePath(s) {
			if _, ok := deleted[h.fold.String(titleOf(s))]; !ok {
				deleted[h.fold.String(titleOf(s))] = s
			}
		}
	}
	for _, key := range sortedKeys(added) {
		if was, ok := deleted[key]; ok {
			h.add(Warning, "title-reused", added[key], "if it is the same page restored, delete _check.md; else give it another title",
				"a deleted page had this title (%s); old links to it now reach this page", was)
		}
	}
	return nil
}
