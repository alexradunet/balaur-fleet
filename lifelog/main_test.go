package main

import (
	"os"
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
		{"no folder", []string{"check"}, exitUsage, ""},
		{"an unknown command", []string{"keep"}, exitUsage, ""},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			var out, errOut strings.Builder
			if code := run(tc.args, &out, &errOut); code != tc.code {
				t.Fatalf("exit %d, want %d; stderr: %s", code, tc.code, errOut.String())
			}
			if !strings.Contains(out.String(), tc.out) {
				t.Errorf("stdout does not hold %q:\n%s", tc.out, out.String())
			}
		})
	}
}
