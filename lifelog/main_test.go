package main

import (
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
)

func write(t *testing.T, root, rel, text string) {
	t.Helper()
	p := filepath.Join(root, filepath.FromSlash(rel))
	if err := os.MkdirAll(filepath.Dir(p), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(p, []byte(text), 0o644); err != nil {
		t.Fatal(err)
	}
}

func TestCheckExitCodes(t *testing.T) {
	clean := t.TempDir()
	write(t, clean, "pages/A.md", "Text.\n")

	warned := t.TempDir()
	write(t, warned, "pages/A.md", "---\ntags:\n  - x\n---\n")

	broken := t.TempDir()
	write(t, broken, "pages/A.md", "---\npart-of: [[B]]\n---\n")

	cases := []struct {
		name string
		args []string
		code int
		out  string
	}{
		{"a clean folder", []string{"check", clean}, exitOK, ""},
		{"a warning does not hold checked back", []string{"check", warned}, exitOK, "unknown-key"},
		{"an error does", []string{"check", broken}, exitProblem, "frontmatter"},
		{"the report", []string{"check", "-report", broken}, exitProblem, "## Errors (1)"},
		{"a missing folder is a failed run, not a clean one", []string{"check", filepath.Join(clean, "missing")}, exitFailed, ""},
		{"two folders", []string{"check", clean, clean}, exitUsage, ""},
		{"an unknown command", []string{"keep"}, exitUsage, ""},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			var out, errOut strings.Builder
			if code := run(t.Context(), tc.args, strings.NewReader(""), &out, &errOut); code != tc.code {
				t.Fatalf("exit %d, want %d; stderr: %s", code, tc.code, errOut.String())
			}
			if !strings.Contains(out.String(), tc.out) {
				t.Errorf("stdout does not hold %q:\n%s", tc.out, out.String())
			}
		})
	}
}

// keeperGit runs git with the git dir outside the folder, as the keeper does.
func keeperGit(t *testing.T, gitDir, folder string, args ...string) {
	t.Helper()
	cmd := exec.Command("git", append([]string{"--git-dir", gitDir, "--work-tree", folder}, args...)...)
	cmd.Env = append(os.Environ(), "GIT_CONFIG_NOSYSTEM=1", "GIT_CONFIG_GLOBAL=/dev/null",
		"GIT_AUTHOR_NAME=keeper", "GIT_AUTHOR_EMAIL=keeper@example.invalid",
		"GIT_COMMITTER_NAME=keeper", "GIT_COMMITTER_EMAIL=keeper@example.invalid")
	if out, err := cmd.CombinedOutput(); err != nil {
		t.Fatalf("git %s: %v\n%s", strings.Join(args, " "), err, out)
	}
}

func TestCheckWithHistory(t *testing.T) {
	folder, gitDir := t.TempDir(), filepath.Join(t.TempDir(), "life.git")
	if out, err := exec.Command("git", "init", "-q", "--bare", gitDir).CombinedOutput(); err != nil {
		t.Fatalf("git init: %v\n%s", err, out)
	}
	keeperGit(t, gitDir, folder, "symbolic-ref", "HEAD", "refs/heads/live")
	write(t, folder, "pages/A.md", "A page with enough text to matter.\n")
	keeperGit(t, gitDir, folder, "add", "-A")
	keeperGit(t, gitDir, folder, "commit", "-q", "-m", "settled")

	check := func(want int, wantOut string) {
		t.Helper()
		var out, errOut strings.Builder
		if code := run(t.Context(), []string{"check", "-report", "-git-dir", gitDir, folder}, strings.NewReader(""), &out, &errOut); code != want {
			t.Fatalf("exit %d, want %d; stderr: %s", code, want, errOut.String())
		}
		if !strings.Contains(out.String(), wantOut) {
			t.Errorf("the report does not hold %q:\n%s", wantOut, out.String())
		}
	}
	// The first run: no seen yet, so the past is not compared, and the report says so.
	check(exitOK, "no acknowledged state yet")

	keeperGit(t, gitDir, folder, "update-ref", "refs/heads/seen", "refs/heads/live")
	write(t, folder, "pages/A.md", "")
	keeperGit(t, gitDir, folder, "add", "-A")
	keeperGit(t, gitDir, folder, "commit", "-q", "-m", "settled")
	check(exitProblem, "page-emptied")

	var out, errOut strings.Builder
	if code := run(t.Context(), []string{"check", "-git-dir", filepath.Join(t.TempDir(), "none.git"), folder}, strings.NewReader(""), &out, &errOut); code != exitFailed {
		t.Errorf("a git dir without live: exit %d, want %d", code, exitFailed)
	}
}

func TestCheckTakesTheFolderFromTheEnvironment(t *testing.T) {
	f := t.TempDir()
	write(t, f, "pages/A.md", "---\npart-of: [[B]]\n---\n")
	t.Setenv("LIFELOG_FOLDER", f)
	var out, errOut strings.Builder
	if code := run(t.Context(), []string{"check"}, strings.NewReader(""), &out, &errOut); code != exitProblem {
		t.Fatalf("exit %d, want %d; stderr: %s", code, exitProblem, errOut.String())
	}
}
