package check

import (
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"slices"
	"strings"
	"testing"
)

// gitRepo is a throwaway repository with a work tree, for the history rules.
type gitRepo struct {
	t    *testing.T
	work string
}

func newGitRepo(t *testing.T) *gitRepo {
	t.Helper()
	g := &gitRepo{t, t.TempDir()}
	g.git("init", "-q", "-b", "live")
	return g
}

func (g *gitRepo) git(args ...string) string {
	g.t.Helper()
	cmd := exec.Command("git", args...)
	cmd.Dir = g.work
	cmd.Env = append(os.Environ(), "GIT_CONFIG_NOSYSTEM=1", "GIT_CONFIG_GLOBAL=/dev/null",
		"GIT_AUTHOR_NAME=keeper", "GIT_AUTHOR_EMAIL=keeper@example.invalid",
		"GIT_COMMITTER_NAME=keeper", "GIT_COMMITTER_EMAIL=keeper@example.invalid")
	out, err := cmd.CombinedOutput()
	if err != nil {
		g.t.Fatalf("git %s: %v\n%s", strings.Join(args, " "), err, out)
	}
	return strings.TrimSpace(string(out))
}

// commit writes the files (an empty string deletes one), commits, and
// returns the commit.
func (g *gitRepo) commit(files map[string]string) string {
	g.t.Helper()
	for rel, text := range files {
		p := filepath.Join(g.work, filepath.FromSlash(rel))
		if text == "" {
			if err := os.Remove(p); err != nil {
				g.t.Fatal(err)
			}
			continue
		}
		if text == "<empty>" {
			text = ""
		}
		if err := os.MkdirAll(filepath.Dir(p), 0o755); err != nil {
			g.t.Fatal(err)
		}
		if err := os.WriteFile(p, []byte(text), 0o644); err != nil {
			g.t.Fatal(err)
		}
	}
	g.git("add", "-A")
	g.git("commit", "-q", "--allow-empty", "-m", "settled")
	return g.git("rev-parse", "HEAD")
}

func (g *gitRepo) history() []Problem {
	g.t.Helper()
	problems, err := History(g.t.Context(), filepath.Join(g.work, ".git"), "seen", "live")
	if err != nil {
		g.t.Fatal(err)
	}
	return problems
}

const longText = "This page holds enough text for git to see a rename as a rename and not as a delete and an add.\n"

func TestHistoryRules(t *testing.T) {
	pages := func(n int) map[string]string {
		m := map[string]string{}
		for i := 0; i < n; i++ {
			m[fmt.Sprintf("pages/P%02d.md", i)] = fmt.Sprintf("Page %d.\n", i)
		}
		return m
	}
	deleted := func(n int) map[string]string {
		m := map[string]string{}
		for i := 0; i < n; i++ {
			m[fmt.Sprintf("pages/P%02d.md", i)] = ""
		}
		return m
	}
	csv := "day,taken_at,value,source\n2026-11-14,,81.4,manual\n"
	cases := []struct {
		name  string
		steps []map[string]string // each step is a commit; seen is the one before the last
		want  []string
	}{
		{"nothing changed", []map[string]string{pages(3), {}}, nil},
		{"twenty pages deleted", []map[string]string{pages(25), deleted(20)}, nil},
		{"twenty-one pages deleted", []map[string]string{pages(25), deleted(21)},
			[]string{`loss mass-deletion "."`}},
		{"a CSV removed", []map[string]string{{"metrics/w.md": "W.\n", "metrics/w/2026.pc.csv": csv}, {"metrics/w/2026.pc.csv": ""}},
			[]string{`loss csv-removed "metrics/w/2026.pc.csv"`}},
		{"a page emptied", []map[string]string{{"pages/A.md": longText}, {"pages/A.md": "<empty>"}},
			[]string{`loss page-emptied "pages/A.md"`}},
		{"a page shrank by more than half", []map[string]string{{"pages/A.md": longText}, {"pages/A.md": "Short.\n"}},
			[]string{`warning page-shrank "pages/A.md"`}},
		{"a rename that leaves links behind", []map[string]string{
			{"pages/Iron.md": longText, "pages/A.md": "See [[Iron]].\n", "pages/B.md": "And [[iron|the metal]].\n"},
			{"pages/Iron.md": "", "pages/Iron levels.md": longText}},
			[]string{`warning broken-link "pages/Iron.md"`}},
		{"a rename that keeps the old name as an alias", []map[string]string{
			{"pages/Iron.md": longText, "pages/A.md": "See [[Iron]].\n"},
			{"pages/Iron.md": "", "pages/Iron levels.md": "---\naliases:\n  - Iron\n---\n" + longText}},
			nil},
		{"a rename that rewrites the links", []map[string]string{
			{"pages/Iron.md": longText, "pages/A.md": "See [[Iron]].\n"},
			{"pages/Iron.md": "", "pages/Iron levels.md": longText, "pages/A.md": "See [[Iron levels]].\n"}},
			nil},
		{"an alias removed while linked", []map[string]string{
			{"people/Ana Pop.md": "---\naliases:\n  - Ana\n---\n", "pages/A.md": "With [[Ana]].\n"},
			{"people/Ana Pop.md": "A friend from school, met again in Cluj.\n"}},
			[]string{`warning broken-link "people/Ana Pop.md"`}},
		{"a link that never resolved", []map[string]string{{"pages/A.md": "See [[Nowhere]].\n"}, {"pages/B.md": "And [[Nowhere]].\n"}},
			nil},
		{"a title of a deleted page taken again", []map[string]string{
			{"people/Dan.md": "Dan the barber.\n"}, {"people/Dan.md": ""}, {"people/Dan.md": "Dan from work, a colleague.\n"}},
			[]string{`warning title-reused "people/Dan.md"`}},
		{"a reading corrected", []map[string]string{
			{"metrics/w.md": "W.\n", "metrics/w/2026.pc.csv": csv},
			{"metrics/w/2026.pc.csv": "day,taken_at,value,source\n2026-11-14,,81.6,manual\n"}},
			[]string{`warning reading-changed "metrics/w/2026.pc.csv"`}},
		{"a reading added", []map[string]string{
			{"metrics/w.md": "W.\n", "metrics/w/2026.pc.csv": csv},
			{"metrics/w/2026.pc.csv": csv + "2026-11-15,,81.2,manual\n"}},
			nil},
		{"a unit changed", []map[string]string{
			{"metrics/w.md": "---\nunit: kg\n---\n"}, {"metrics/w.md": "---\nunit: lb\n---\n"}},
			[]string{`warning unit-changed "metrics/w.md"`}},
		{"a change outside the content folders", []map[string]string{{"pages/A.md": "A.\n", "notes.txt": "x\n"}, {"notes.txt": ""}},
			nil},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			g := newGitRepo(t)
			for i, files := range tc.steps {
				c := g.commit(files)
				if i == len(tc.steps)-2 {
					g.git("update-ref", "refs/heads/seen", c)
				}
			}
			problems := g.history()
			if g := got(problems); !slices.Equal(g, tc.want) {
				t.Errorf("got %q, want %q\n%s", g, tc.want, describe(problems))
			}
		})
	}
}

func TestBrokenLinkNamesTheRenameAndTheFix(t *testing.T) {
	g := newGitRepo(t)
	g.git("update-ref", "refs/heads/seen", g.commit(map[string]string{"pages/Iron.md": longText, "pages/A.md": "See [[Iron]].\n"}))
	g.commit(map[string]string{"pages/Iron.md": "", "pages/Iron levels.md": longText})
	problems := g.history()
	if len(problems) != 1 {
		t.Fatalf("want one problem:\n%s", describe(problems))
	}
	p := problems[0]
	for _, want := range []string{"[[Iron]]", "pages/A.md", "renamed to pages/Iron levels.md"} {
		if !strings.Contains(p.Message, want) {
			t.Errorf("the message %q does not hold %q", p.Message, want)
		}
	}
	if want := `lifelog rename-links "Iron" "Iron levels"`; !strings.Contains(p.Fix, want) {
		t.Errorf("the fix %q does not hold %q", p.Fix, want)
	}
}

func TestRefExists(t *testing.T) {
	g := newGitRepo(t)
	g.commit(map[string]string{"pages/A.md": "A.\n"})
	dir := filepath.Join(g.work, ".git")
	if !RefExists(t.Context(), dir, "live") {
		t.Error("live has a commit")
	}
	if RefExists(t.Context(), dir, "seen") {
		t.Error("seen does not exist yet")
	}
}
