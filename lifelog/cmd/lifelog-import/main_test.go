package main

import (
	"database/sql"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"

	"lifelog/check"
)

// snapshot builds a synthetic snapshot from testdata/snapshot.sql.
func snapshot(t *testing.T) string {
	t.Helper()
	ddl, err := os.ReadFile("testdata/snapshot.sql")
	if err != nil {
		t.Fatal(err)
	}
	p := filepath.Join(t.TempDir(), "life-latest.db")
	db, err := sql.Open("sqlite", p)
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	if _, err := db.Exec(string(ddl)); err != nil {
		t.Fatal(err)
	}
	return p
}

func read(t *testing.T, root, rel string) string {
	t.Helper()
	data, err := os.ReadFile(filepath.Join(root, filepath.FromSlash(rel)))
	if err != nil {
		t.Fatal(err)
	}
	return string(data)
}

func gitOut(t *testing.T, gitDir string, args ...string) string {
	t.Helper()
	out, err := git(gitDir, nil, args...)
	if err != nil {
		t.Fatalf("git %s: %v\n%s", strings.Join(args, " "), err, out)
	}
	return strings.TrimSpace(string(out))
}

func TestImport(t *testing.T) {
	db := snapshot(t)
	folder, gitDir := filepath.Join(t.TempDir(), "life"), filepath.Join(t.TempDir(), "life.git")
	var report, errOut strings.Builder
	if code := run([]string{"-db", db, "-folder", folder, "-git-dir", gitDir}, &report, &errOut); code != 0 {
		t.Fatalf("exit %d: %s", code, errOut.String())
	}

	files := map[string]string{
		"journal/2026-11-14.md": "Walked with [[Ana]] in [[Cluj]]. Read about [[C#]].\n",
		"people/Ana Pop.md":     "---\naliases:\n  - Ana\nborn: 1990-04-02\n---\nA friend.\n",
		"pages/Cluj.md":         "---\npart-of: \"[[Places]]\"\n---\nA city.\n\nAlso filed in: [[Cities]]\n",
		"pages/C＃.md":           "---\naliases:\n  - C#\n---\nA\nlanguage.\n",
		"metrics/Mood.md":       "---\nunit: 1-5\nmin: 1\nmax: 5\ndaily: true\n---\nMood of the day.\n",
		"files/2026/Receipt.md": "---\nday: 2026-03-03\nsha256: " + strings.Repeat("a", 64) + "\nmime: image/jpeg\n---\nThe text of a receipt.\n",
		"pages/Cities.md":       "---\n---\n---\nnot frontmatter, a body that starts with a rule\n",
		// Current values only: 2026-11-14 was corrected to 4; 2026-11-15 was retracted.
		// 2026-11-13 18:00 UTC is 20:00 in Bucharest.
		"metrics/Mood/2026.import.csv": "day,taken_at,value,source\n2026-11-13,2026-11-13T20:00:00+02:00,3,manual\n2026-11-14,,4,manual\n",
		"metrics/Mood/2025.import.csv": "day,taken_at,value,source\n2025-12-31,,1,scale:old\n",
	}
	for rel, want := range files {
		if got := read(t, folder, rel); got != want {
			t.Errorf("%s:\n got %q\nwant %q", rel, got, want)
		}
	}
	if got := read(t, folder, "files/2026/Receipt.jpg"); got != "\xff\xd8\xff\xe0\x00\x10JFIF" {
		t.Errorf("the preview: %q", got)
	}
	if _, err := os.Stat(filepath.Join(folder, "people/Dan.md")); err == nil {
		t.Error("a tombstoned page is in the folder")
	}

	// One commit per page and per deletion, and one for the readings.
	if n := gitOut(t, gitDir, "rev-list", "--count", "live"); n != "11" {
		t.Errorf("%s commits, want 11", n)
	}
	if d := gitOut(t, gitDir, "log", "-1", "--format=%aI", "live", "--", "pages/Cluj.md"); d != "2025-05-01T09:00:00Z" {
		t.Errorf("Cluj's commit date %s, want its created_at", d)
	}
	if out := gitOut(t, gitDir, "log", "--diff-filter=D", "--name-only", "--format=", "live"); out != "people/Dan.md" {
		t.Errorf("deleted in the history: %q, want people/Dan.md", out)
	}

	// The folder passes the checker: no error and no loss.
	problems, err := check.Tree(os.DirFS(folder))
	if err != nil {
		t.Fatal(err)
	}
	for _, p := range problems {
		if p.Class != check.Warning {
			t.Errorf("the imported folder: %s %s %s: %s", p.Class, p.Rule, p.Path, p.Message)
		}
	}
	for _, want := range []string{`"C#" is now "C＃"`, "filed in 2 categories", "1 pages had CRLF", "2 readings were earlier values", "1 were retractions"} {
		if !strings.Contains(report.String(), want) {
			t.Errorf("the report does not hold %q:\n%s", want, report.String())
		}
	}
}

func TestImportRefusesToOverwrite(t *testing.T) {
	db := snapshot(t)
	full := t.TempDir()
	if err := os.WriteFile(filepath.Join(full, "x"), []byte("x"), 0o644); err != nil {
		t.Fatal(err)
	}
	existing := t.TempDir()
	for _, args := range [][]string{
		{"-db", db, "-folder", full, "-git-dir", filepath.Join(t.TempDir(), "g.git")},
		{"-db", db, "-folder", filepath.Join(t.TempDir(), "life"), "-git-dir", existing},
		{"-db", filepath.Join(t.TempDir(), "none.db"), "-folder", filepath.Join(t.TempDir(), "life"), "-git-dir", filepath.Join(t.TempDir(), "g.git")},
	} {
		var out, errOut strings.Builder
		if code := run(args, &out, &errOut); code != 1 {
			t.Errorf("%v: exit %d, want 1", args, code)
		}
	}
	if _, err := exec.LookPath("git"); err != nil {
		t.Skip("git is not installed")
	}
}
