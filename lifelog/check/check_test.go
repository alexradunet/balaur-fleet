package check

import (
	"fmt"
	"os"
	"path/filepath"
	"slices"
	"strconv"
	"strings"
	"testing"
	"testing/fstest"
)

// An archive is a vector: free text, then sections opened by a line
// `-- NAME --`. The section `want` lists the expected problems, one
// `class rule "path"` per line (the path as a Go string with ASCII escapes);
// every other section is a file of the tree, its name a path or a Go string.
func readArchive(t *testing.T, file string) (want []string, tree fstest.MapFS) {
	t.Helper()
	data, err := os.ReadFile(file)
	if err != nil {
		t.Fatal(err)
	}
	tree = fstest.MapFS{}
	name, body := "", ""
	flush := func() {
		switch name {
		case "":
		case "want":
			for _, l := range strings.Split(body, "\n") {
				if l != "" {
					want = append(want, l)
				}
			}
		default:
			tree[name] = &fstest.MapFile{Data: []byte(body)}
		}
	}
	for _, line := range strings.SplitAfter(string(data), "\n") {
		trimmed := strings.TrimSuffix(line, "\n")
		if strings.HasPrefix(trimmed, "-- ") && strings.HasSuffix(trimmed, " --") {
			flush()
			name, body = strings.TrimSuffix(strings.TrimPrefix(trimmed, "-- "), " --"), ""
			if strings.HasPrefix(name, `"`) {
				if name, err = strconv.Unquote(name); err != nil {
					t.Fatalf("%s: section name: %v", file, err)
				}
			}
			continue
		}
		if name != "" {
			body += line
		}
	}
	flush()
	return want, tree
}

// got is the set of problems in the form of a want line, sorted.
func got(problems []Problem) []string {
	var out []string
	for _, p := range problems {
		l := fmt.Sprintf("%s %s %+q", p.Class, p.Rule, p.Path)
		if !slices.Contains(out, l) {
			out = append(out, l)
		}
	}
	slices.Sort(out)
	return out
}

func TestVectors(t *testing.T) {
	files, err := filepath.Glob("testdata/*.txtar")
	if err != nil || len(files) == 0 {
		t.Fatalf("no vectors: %v", err)
	}
	for _, file := range files {
		t.Run(filepath.Base(file), func(t *testing.T) {
			want, tree := readArchive(t, file)
			slices.Sort(want)
			problems, err := Tree(tree)
			if err != nil {
				t.Fatal(err)
			}
			if g := got(problems); !slices.Equal(g, want) {
				t.Errorf("problems differ\n got:\n  %s\nwant:\n  %s\nall:\n%s",
					strings.Join(g, "\n  "), strings.Join(want, "\n  "), describe(problems))
			}
		})
	}
}

func describe(problems []Problem) string {
	var b strings.Builder
	for _, p := range problems {
		fmt.Fprintf(&b, "  %s %s %s: %s\n", p.Class, p.Rule, p.Path, p.Message)
	}
	return b.String()
}

func TestRulesAnArchiveCannotHold(t *testing.T) {
	csvPage := &fstest.MapFile{Data: []byte("---\nunit: kg\n---\n")}
	cases := []struct {
		name string
		tree fstest.MapFS
		want []string
	}{
		{"not UTF-8", fstest.MapFS{"pages/A.md": {Data: []byte("caf\xe9\n")}},
			[]string{`error encoding "pages/A.md"`}},
		{"CRLF only is read as LF", fstest.MapFS{"pages/A.md": {Data: []byte("---\r\nday: 2026-01-01\r\n---\r\nText.\r\n")}},
			nil},
		{"CRLF and LF mixed", fstest.MapFS{"pages/A.md": {Data: []byte("one\r\ntwo\n")}},
			[]string{`error line-endings "pages/A.md"`}},
		{"a conflict marker", fstest.MapFS{"pages/A.md": {Data: []byte("<<<<<<< HEAD\nmine\n=======\ntheirs\n>>>>>>> other\n")}},
			[]string{`error conflict-marker "pages/A.md"`}},
		{"a setext heading is not a marker", fstest.MapFS{"pages/A.md": {Data: []byte("Title\n=======\n")}},
			nil},
		{"no final newline", fstest.MapFS{
			"metrics/w.md":          csvPage,
			"metrics/w/2026.pc.csv": {Data: []byte("day,taken_at,value,source\n2026-01-01,,80,manual")}},
			[]string{`warning final-newline "metrics/w/2026.pc.csv"`}},
		{"a path of 201 bytes", fstest.MapFS{"pages/" + strings.Repeat("a", 192) + ".md": {}},
			[]string{fmt.Sprintf(`error path-length %+q`, "pages/"+strings.Repeat("a", 192)+".md")}},
		{"a path of 200 bytes", fstest.MapFS{"pages/" + strings.Repeat("a", 191) + ".md": {}},
			nil},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			problems, err := Tree(tc.tree)
			if err != nil {
				t.Fatal(err)
			}
			if g := got(problems); !slices.Equal(g, tc.want) {
				t.Errorf("got %q, want %q\n%s", g, tc.want, describe(problems))
			}
		})
	}
}

func TestManyBadLinesAreCounted(t *testing.T) {
	var b strings.Builder
	b.WriteString("day,taken_at,value,source\n")
	for i := 0; i < 10; i++ {
		b.WriteString("14.11.2026,,81,manual\n") // a spreadsheet app rewrote the days
	}
	tree := fstest.MapFS{
		"metrics/w.md":          {Data: []byte("---\nunit: kg\n---\n")},
		"metrics/w/2026.pc.csv": {Data: []byte(b.String())},
	}
	problems, err := Tree(tree)
	if err != nil {
		t.Fatal(err)
	}
	var lines []string
	for _, p := range problems {
		if p.Rule == "reading-day" {
			lines = append(lines, p.Message)
		}
	}
	want := []string{
		`line 2: "14.11.2026" is not a day`,
		`line 3: "14.11.2026" is not a day`,
		`line 4: "14.11.2026" is not a day`,
		`and 7 more lines`,
	}
	if !slices.Equal(lines, want) {
		t.Errorf("got %q, want %q", lines, want)
	}
}

func TestReportGroupsByClass(t *testing.T) {
	r := Report([]Problem{
		{Warning, "unknown-key", "pages/A.md", `the key "tags" is not one that a page in pages/ takes`, "remove it"},
		{Error, "csv-header", "metrics/w/2026.pc.csv", "the first line is not the header", "make the first line right"},
	}, "Run at 2026-11-14T15:00:00+02:00.")
	for _, want := range []string{"## Errors (1)", "## Warnings (1)", "`metrics/w/2026.pc.csv` (csv-header)", "delete this file"} {
		if !strings.Contains(r, want) {
			t.Errorf("the report does not hold %q:\n%s", want, r)
		}
	}
	if strings.Contains(r, "## Losses") {
		t.Errorf("the report has a Losses section with no loss:\n%s", r)
	}
	if strings.Index(r, "## Errors") > strings.Index(r, "## Warnings") {
		t.Errorf("errors come after warnings:\n%s", r)
	}
}
