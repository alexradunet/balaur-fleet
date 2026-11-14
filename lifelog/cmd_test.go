package main

import (
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
)

// lifelog runs one command and returns its exit code and output.
func lifelog(t *testing.T, stdin string, args ...string) (int, string, string) {
	t.Helper()
	var out, errOut strings.Builder
	code := run(t.Context(), args, strings.NewReader(stdin), &out, &errOut)
	return code, out.String(), errOut.String()
}

func read(t *testing.T, root, rel string) string {
	t.Helper()
	data, err := os.ReadFile(filepath.Join(root, filepath.FromSlash(rel)))
	if err != nil {
		t.Fatal(err)
	}
	return string(data)
}

func exists(root, rel string) bool {
	_, err := os.Stat(filepath.Join(root, filepath.FromSlash(rel)))
	return err == nil
}

// folderWithWeight is a life folder with one metric, weight, from 20 to 300.
func folderWithWeight(t *testing.T) string {
	t.Helper()
	f := t.TempDir()
	write(t, f, "metrics/weight.md", "---\nunit: kg\nmin: 20\nmax: 300\n---\nMorning weight.\n")
	return f
}

func TestAdd(t *testing.T) {
	f := folderWithWeight(t)
	add := func(args ...string) (int, string) {
		code, _, errOut := lifelog(t, "", append([]string{"add", "-folder", f, "-machine", "laptop"}, args...)...)
		return code, errOut
	}
	if code, e := add("-at", "2026-11-14T07:02:00+02:00", "weight", "81.4"); code != exitOK {
		t.Fatalf("add: exit %d: %s", code, e)
	}
	if code, e := add("-day", "2026-11-15", "weight", "81.2"); code != exitOK {
		t.Fatalf("add: exit %d: %s", code, e)
	}
	want := "day,taken_at,value,source\n2026-11-14,2026-11-14T07:02:00+02:00,81.4,manual\n2026-11-15,,81.2,manual\n"
	if got := read(t, f, "metrics/weight/2026.laptop.csv"); got != want {
		t.Errorf("the file:\n%s\nwant:\n%s", got, want)
	}

	// A line typed by hand without its newline is not joined to the next one.
	write(t, f, "metrics/weight/2025.laptop.csv", "day,taken_at,value,source\n2025-12-31,,80,manual")
	if code, e := add("-day", "2025-12-30", "weight", "80.2"); code != exitOK {
		t.Fatalf("add: exit %d: %s", code, e)
	}
	if got, want := read(t, f, "metrics/weight/2025.laptop.csv"), "day,taken_at,value,source\n2025-12-31,,80,manual\n2025-12-30,,80.2,manual\n"; got != want {
		t.Errorf("the file:\n%s\nwant:\n%s", got, want)
	}

	// The default: now, on today's day.
	if code, e := add("weight", "82"); code != exitOK {
		t.Fatalf("add: exit %d: %s", code, e)
	}

	for _, tc := range []struct {
		name string
		args []string
	}{
		{"no page for the metric", []string{"steps", "9000"}},
		{"a comma for a decimal", []string{"weight", "81,4"}},
		{"outside the range", []string{"weight", "400"}},
		{"not a day", []string{"-day", "14.11.2026", "weight", "81"}},
		{"an instant without its offset", []string{"-at", "2026-11-14T07:02:00", "weight", "81"}},
		{"a bad source", []string{"-day", "2026-11-14", "-source", "Phone", "weight", "81"}},
		{"a path in the metric's name", []string{"../weight", "81"}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			before := read(t, f, "metrics/weight/2026.laptop.csv")
			if code, _ := add(tc.args...); code != exitProblem {
				t.Errorf("exit %d, want %d", code, exitProblem)
			}
			if after := read(t, f, "metrics/weight/2026.laptop.csv"); after != before {
				t.Errorf("a refused add changed the file")
			}
		})
	}
	if code, _, _ := lifelog(t, "", "check", f); code != exitOK {
		t.Errorf("the folder after the adds does not pass check")
	}
}

func TestMerge(t *testing.T) {
	const orig = "metrics/weight/2026.laptop.csv"
	const copyName = "metrics/weight/2026.laptop.sync-conflict-20261114-141957-RNZH7UE.csv"
	setup := func(t *testing.T) string {
		f := folderWithWeight(t)
		write(t, f, orig, "day,taken_at,value,source\n2026-11-01,,81.0,manual\n2026-11-02,,80.8,manual\n")
		write(t, f, copyName, "day,taken_at,value,source\n2026-11-01,,81.0,manual\n2026-11-02,,80.6,manual\n2026-11-03,,80.9,manual")
		return f
	}
	for _, tc := range []struct {
		answer string
		want   string
	}{
		{"k\n", "day,taken_at,value,source\n2026-11-01,,81.0,manual\n2026-11-02,,80.8,manual\n2026-11-03,,80.9,manual\n"},
		{"r\n", "day,taken_at,value,source\n2026-11-01,,81.0,manual\n2026-11-02,,80.6,manual\n2026-11-03,,80.9,manual\n"},
		{"b\n", "day,taken_at,value,source\n2026-11-01,,81.0,manual\n2026-11-02,,80.8,manual\n2026-11-02,,80.6,manual\n2026-11-03,,80.9,manual\n"},
	} {
		t.Run("answer "+strings.TrimSpace(tc.answer), func(t *testing.T) {
			f := setup(t)
			code, out, errOut := lifelog(t, tc.answer, "merge", "-folder", f, copyName)
			if code != exitOK {
				t.Fatalf("exit %d: %s", code, errOut)
			}
			if !strings.Contains(out, "this file: 2026-11-02,,80.8,manual") || !strings.Contains(out, "the copy:  2026-11-02,,80.6,manual") {
				t.Errorf("the question does not show both lines:\n%s", out)
			}
			if got := read(t, f, orig); got != tc.want {
				t.Errorf("the file:\n%s\nwant:\n%s", got, tc.want)
			}
			if exists(f, copyName) {
				t.Error("the copy is still there")
			}
		})
	}
	t.Run("no answer changes nothing", func(t *testing.T) {
		f := setup(t)
		before := read(t, f, orig)
		if code, _, _ := lifelog(t, "", "merge", "-folder", f, copyName); code != exitProblem {
			t.Errorf("exit %d, want %d", code, exitProblem)
		}
		if read(t, f, orig) != before || !exists(f, copyName) {
			t.Error("a merge without an answer changed the files")
		}
	})
	t.Run("a page is merged by hand", func(t *testing.T) {
		f := t.TempDir()
		write(t, f, "pages/A.md", "mine\n")
		write(t, f, "pages/A.sync-conflict-20261114-141957-RNZH7UE.md", "theirs\n")
		code, _, errOut := lifelog(t, "", "merge", "-folder", f, "pages/A.sync-conflict-20261114-141957-RNZH7UE.md")
		if code != exitProblem || !strings.Contains(errOut, "by hand") {
			t.Errorf("exit %d, stderr %q", code, errOut)
		}
	})
	t.Run("not a conflict copy", func(t *testing.T) {
		f := setup(t)
		if code, _, _ := lifelog(t, "", "merge", "-folder", f, orig); code != exitProblem {
			t.Errorf("exit %d, want %d", code, exitProblem)
		}
	})
}

func TestRenameLinks(t *testing.T) {
	f := t.TempDir()
	write(t, f, "pages/Iron levels.md", "The page, renamed outside Obsidian.\n")
	write(t, f, "journal/2026-11-14.md", "See [[Iron]], [[iron|the metal]] and ![[Iron#Table]]. Not [[Ironing]].\n")
	write(t, f, "pages/Ferritin.md", "---\npart-of: \"[[Iron]]\"\n---\nA protein.\n")
	write(t, f, "pages/Other.md", "No link here.\n")
	code, out, errOut := lifelog(t, "", "rename-links", "-folder", f, "Iron", "Iron levels")
	if code != exitOK {
		t.Fatalf("exit %d: %s", code, errOut)
	}
	if got, want := read(t, f, "journal/2026-11-14.md"),
		"See [[Iron levels]], [[Iron levels|the metal]] and ![[Iron levels#Table]]. Not [[Ironing]].\n"; got != want {
		t.Errorf("got  %q\nwant %q", got, want)
	}
	if got, want := read(t, f, "pages/Ferritin.md"), "---\npart-of: \"[[Iron levels]]\"\n---\nA protein.\n"; got != want {
		t.Errorf("got  %q\nwant %q", got, want)
	}
	if !strings.Contains(out, "2 pages changed") {
		t.Errorf("stdout: %s", out)
	}
	if code, _, _ := lifelog(t, "", "rename-links", "-folder", f, "Iron levels", "C#"); code != exitProblem {
		t.Errorf("a new name Obsidian cannot link to: exit %d, want %d", code, exitProblem)
	}
}

func TestRestore(t *testing.T) {
	folder, gitDir := t.TempDir(), filepath.Join(t.TempDir(), "life.git")
	if out, err := exec.Command("git", "init", "-q", "--bare", gitDir).CombinedOutput(); err != nil {
		t.Fatalf("git init: %v\n%s", err, out)
	}
	keeperGit(t, gitDir, folder, "symbolic-ref", "HEAD", "refs/heads/live")
	write(t, folder, "pages/A.md", "The text as it was.\n")
	keeperGit(t, gitDir, folder, "add", "-A")
	keeperGit(t, gitDir, folder, "commit", "-q", "-m", "settled")
	keeperGit(t, gitDir, folder, "update-ref", "refs/heads/checked", "refs/heads/live")

	write(t, folder, "pages/A.md", "")
	if code, out, errOut := lifelog(t, "", "restore", "-folder", folder, "-git-dir", gitDir, "pages/A.md"); code != exitOK {
		t.Fatalf("exit %d: %s%s", code, out, errOut)
	}
	if got := read(t, folder, "pages/A.md"); got != "The text as it was.\n" {
		t.Errorf("restored %q", got)
	}
	if err := os.Remove(filepath.Join(folder, "pages/A.md")); err != nil {
		t.Fatal(err)
	}
	if code, _, errOut := lifelog(t, "", "restore", "-folder", folder, "-git-dir", gitDir, filepath.Join(folder, "pages/A.md"), "live"); code != exitOK {
		t.Fatalf("an absolute path, from live: exit %d: %s", code, errOut)
	}
	for _, p := range []string{"pages/None.md", "../outside.md"} {
		if code, _, _ := lifelog(t, "", "restore", "-folder", folder, "-git-dir", gitDir, p); code != exitProblem {
			t.Errorf("%s: exit %d, want %d", p, code, exitProblem)
		}
	}
}
