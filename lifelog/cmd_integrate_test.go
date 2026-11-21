package main

import (
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strings"
	"testing"
)

// twoMachines is the hub of plan 005 in small: the server's git dir with its
// folder as the work tree of live, and a laptop's clone with a folder of its
// own. Both start from one commit holding pages/A.md.
type twoMachines struct {
	t                    *testing.T
	hub, server          string // the server's git dir and folder
	laptopGit, laptopDir string
}

func newTwoMachines(t *testing.T) *twoMachines {
	t.Helper()
	m := &twoMachines{
		t:         t,
		hub:       filepath.Join(t.TempDir(), "life.git"),
		server:    t.TempDir(),
		laptopGit: filepath.Join(t.TempDir(), "laptop.git"),
		laptopDir: t.TempDir(),
	}
	if out, err := exec.Command("git", "init", "-q", "--bare", m.hub).CombinedOutput(); err != nil {
		t.Fatalf("git init: %v\n%s", err, out)
	}
	keeperGit(t, m.hub, m.server, "symbolic-ref", "HEAD", "refs/heads/live")
	write(t, m.server, "pages/A.md", "The first line.\n")
	m.commitServer()

	if out, err := exec.Command("git", "clone", "-q", "--bare", m.hub, m.laptopGit).CombinedOutput(); err != nil {
		t.Fatalf("git clone: %v\n%s", err, out)
	}
	keeperGit(t, m.laptopGit, m.laptopDir, "symbolic-ref", "HEAD", "refs/heads/live")
	keeperGit(t, m.laptopGit, m.laptopDir, "checkout", "-q", "-f", "live")
	return m
}

func (m *twoMachines) commitServer() {
	m.t.Helper()
	keeperGit(m.t, m.hub, m.server, "add", "-A")
	keeperGit(m.t, m.hub, m.server, "commit", "-q", "--allow-empty", "-m", "settled")
}

// commitLaptop commits the laptop's folder and pushes it to the hub's from/laptop.
func (m *twoMachines) commitLaptop() {
	m.t.Helper()
	keeperGit(m.t, m.laptopGit, m.laptopDir, "add", "-A")
	keeperGit(m.t, m.laptopGit, m.laptopDir, "commit", "-q", "-m", "settled")
	keeperGit(m.t, m.laptopGit, m.laptopDir, "push", "-q", m.hub, "live:refs/heads/from/laptop")
}

func (m *twoMachines) integrate(want int) string {
	m.t.Helper()
	code, out, errOut := lifelog(m.t, "", "integrate", "-folder", m.server, "-git-dir", m.hub, "-machine", "server", "from/laptop")
	if code != want {
		m.t.Fatalf("exit %d, want %d\nstdout: %s\nstderr: %s", code, want, out, errOut)
	}
	return out + errOut
}

// clean says the folder holds exactly what live does.
func (m *twoMachines) clean() {
	m.t.Helper()
	cmd := exec.Command("git", "--git-dir", m.hub, "--work-tree", m.server, "status", "--porcelain", "--untracked-files=all")
	out, err := cmd.CombinedOutput()
	if err != nil || len(out) != 0 {
		m.t.Errorf("the folder is not what live holds (%v):\n%s", err, out)
	}
}

var copyName = regexp.MustCompile(`^A\.sync-conflict-\d{8}-\d{6}-laptop\.md$`)

// conflictCopies lists the conflict copies in one folder of the server's folder.
func conflictCopies(t *testing.T, dir string) []string {
	t.Helper()
	entries, err := os.ReadDir(dir)
	if err != nil {
		t.Fatal(err)
	}
	var names []string
	for _, e := range entries {
		if strings.Contains(e.Name(), ".sync-conflict-") {
			names = append(names, e.Name())
		}
	}
	return names
}

func TestIntegrate(t *testing.T) {
	t.Run("a fast-forward", func(t *testing.T) {
		m := newTwoMachines(t)
		write(t, m.laptopDir, "pages/B.md", "Written on the laptop.\n")
		m.commitLaptop()
		m.integrate(exitOK)
		if got := read(t, m.server, "pages/B.md"); got != "Written on the laptop.\n" {
			t.Errorf("pages/B.md: %q", got)
		}
		m.clean()
	})

	t.Run("both sides, different files", func(t *testing.T) {
		m := newTwoMachines(t)
		write(t, m.laptopDir, "pages/B.md", "From the laptop.\n")
		m.commitLaptop()
		write(t, m.server, "pages/C.md", "From the web app.\n")
		m.commitServer()
		m.integrate(exitOK)
		if !exists(m.server, "pages/B.md") || !exists(m.server, "pages/C.md") {
			t.Error("a side's page is missing")
		}
		parents := strings.Fields(gitOut(t, m.hub, "rev-list", "--parents", "-n", "1", "live"))
		if len(parents) != 3 {
			t.Errorf("live is not a merge of the two: %v", parents)
		}
		m.clean()
	})

	t.Run("one page, both sides", func(t *testing.T) {
		m := newTwoMachines(t)
		write(t, m.laptopDir, "pages/A.md", "The laptop's line.\n")
		m.commitLaptop()
		write(t, m.server, "pages/A.md", "The server's line.\n")
		m.commitServer()
		out := m.integrate(exitOK)
		if got := read(t, m.server, "pages/A.md"); got != "The server's line.\n" {
			t.Errorf("the folder's version did not stay: %q", got)
		}
		copies := conflictCopies(t, filepath.Join(m.server, "pages"))
		if len(copies) != 1 || !copyName.MatchString(copies[0]) {
			t.Fatalf("conflict copies: %v", copies)
		}
		if got := read(t, m.server, "pages/"+copies[0]); got != "The laptop's line.\n" {
			t.Errorf("the copy holds %q", got)
		}
		if !strings.Contains(out, "conflict copy: pages/"+copies[0]) {
			t.Errorf("the output does not name the copy:\n%s", out)
		}
		m.clean()
		// The checker reports the copy as an error, so checked waits for the owner.
		if code, _, _ := lifelog(t, "", "check", m.server); code != exitProblem {
			t.Errorf("check: exit %d, want %d", code, exitProblem)
		}
	})

	t.Run("deleted here, changed there", func(t *testing.T) {
		m := newTwoMachines(t)
		write(t, m.laptopDir, "pages/A.md", "Changed on the laptop.\n")
		m.commitLaptop()
		if err := os.Remove(filepath.Join(m.server, "pages/A.md")); err != nil {
			t.Fatal(err)
		}
		write(t, m.server, "pages/Other.md", "Keeps pages/ there.\n")
		m.commitServer()
		m.integrate(exitOK)
		if got := read(t, m.server, "pages/A.md"); got != "Changed on the laptop.\n" {
			t.Errorf("the change was lost: %q", got)
		}
		m.clean()
	})

	t.Run("changed here, deleted there", func(t *testing.T) {
		m := newTwoMachines(t)
		if err := os.Remove(filepath.Join(m.laptopDir, "pages/A.md")); err != nil {
			t.Fatal(err)
		}
		write(t, m.laptopDir, "pages/Other.md", "Keeps pages/ there.\n")
		m.commitLaptop()
		write(t, m.server, "pages/A.md", "Changed on the server.\n")
		m.commitServer()
		m.integrate(exitOK)
		if got := read(t, m.server, "pages/A.md"); got != "Changed on the server.\n" {
			t.Errorf("the change was lost: %q", got)
		}
		m.clean()
	})

	t.Run("a picture, both sides", func(t *testing.T) {
		m := newTwoMachines(t)
		write(t, m.server, "files/2026/x.jpg", "\xff\xd8 the first picture")
		m.commitServer()
		keeperGit(t, m.laptopGit, m.laptopDir, "pull", "-q", "--ff-only", m.hub, "live")
		write(t, m.laptopDir, "files/2026/x.jpg", "\xff\xd8 the laptop's picture\x00")
		m.commitLaptop()
		write(t, m.server, "files/2026/x.jpg", "\xff\xd8 the server's picture\x00")
		m.commitServer()
		m.integrate(exitOK)
		if got := read(t, m.server, "files/2026/x.jpg"); got != "\xff\xd8 the server's picture\x00" {
			t.Errorf("the folder's picture did not stay: %q", got)
		}
		copies := conflictCopies(t, filepath.Join(m.server, "files/2026"))
		if len(copies) != 1 || !strings.HasSuffix(copies[0], "-laptop.jpg") {
			t.Fatalf("conflict copies: %v", copies)
		}
		m.clean()
	})

	t.Run("a CSV copy merges with lifelog merge", func(t *testing.T) {
		m := newTwoMachines(t)
		const csv = "metrics/weight/2026.laptop.csv"
		write(t, m.server, "metrics/weight.md", "---\nunit: kg\nmin: 20\nmax: 300\n---\n")
		write(t, m.server, csv, "day,taken_at,value,source\n2026-11-01,,81.0,manual\n")
		m.commitServer()
		keeperGit(t, m.laptopGit, m.laptopDir, "pull", "-q", "--ff-only", m.hub, "live")
		write(t, m.laptopDir, csv, "day,taken_at,value,source\n2026-11-01,,81.0,manual\n2026-11-02,,80.8,manual\n")
		m.commitLaptop()
		write(t, m.server, csv, "day,taken_at,value,source\n2026-11-01,,80.9,manual\n")
		m.commitServer()
		m.integrate(exitOK)
		copies := conflictCopies(t, filepath.Join(m.server, "metrics/weight"))
		if len(copies) != 1 {
			t.Fatalf("conflict copies: %v", copies)
		}
		code, _, errOut := lifelog(t, "r\n", "merge", "-folder", m.server, "metrics/weight/"+copies[0])
		if code != exitOK {
			t.Fatalf("lifelog merge: exit %d: %s", code, errOut)
		}
		if got, want := read(t, m.server, csv), "day,taken_at,value,source\n2026-11-01,,81.0,manual\n2026-11-02,,80.8,manual\n"; got != want {
			t.Errorf("the CSV:\n%s\nwant:\n%s", got, want)
		}
	})

	t.Run("already in", func(t *testing.T) {
		m := newTwoMachines(t)
		keeperGit(t, m.laptopGit, m.laptopDir, "push", "-q", m.hub, "live:refs/heads/from/laptop")
		write(t, m.server, "pages/C.md", "Newer, on the server.\n")
		m.commitServer()
		before := gitOut(t, m.hub, "rev-parse", "live")
		if out := m.integrate(exitOK); !strings.Contains(out, "already in") {
			t.Errorf("output: %s", out)
		}
		if gitOut(t, m.hub, "rev-parse", "live") != before {
			t.Error("live moved")
		}
	})

	t.Run("a folder with a change not committed", func(t *testing.T) {
		m := newTwoMachines(t)
		write(t, m.laptopDir, "pages/B.md", "From the laptop.\n")
		m.commitLaptop()
		write(t, m.server, "pages/A.md", "Typed a moment ago.\n")
		before := gitOut(t, m.hub, "rev-parse", "live")
		m.integrate(exitProblem)
		if read(t, m.server, "pages/A.md") != "Typed a moment ago.\n" || exists(m.server, "pages/B.md") {
			t.Error("the folder changed")
		}
		if gitOut(t, m.hub, "rev-parse", "live") != before {
			t.Error("live moved")
		}
	})

	t.Run("the arguments", func(t *testing.T) {
		m := newTwoMachines(t)
		for _, args := range [][]string{
			{"integrate", "-folder", m.server, "-git-dir", m.hub, "-machine", "server", "live"},                    // not from/<host>, and no -from
			{"integrate", "-folder", m.server, "-git-dir", m.hub, "-machine", "server", "-from", "Laptop", "live"}, // not a machine name
			{"integrate", "-folder", m.server, "-git-dir", m.hub, "-machine", "server"},                            // no ref
		} {
			if code, _, _ := lifelog(t, "", args...); code != exitUsage {
				t.Errorf("%v: exit %d, want %d", args[len(args)-1], code, exitUsage)
			}
		}
		if code, _, _ := lifelog(t, "", "integrate", "-folder", m.server, "-git-dir", m.hub, "-machine", "server", "from/nobody"); code != exitProblem {
			t.Errorf("a ref that is not there: exit %d, want %d", code, exitProblem)
		}
	})
}

func TestConflictCopy(t *testing.T) {
	for in, want := range map[string]string{
		"pages/A.md":                     "pages/A.sync-conflict-20261121-143000-laptop.md",
		"metrics/weight/2026.laptop.csv": "metrics/weight/2026.laptop.sync-conflict-20261121-143000-laptop.csv",
		"files/2026/x.jpg":               "files/2026/x.sync-conflict-20261121-143000-laptop.jpg",
	} {
		got := conflictCopy(in, "20261121-143000", "laptop")
		if got != want {
			t.Errorf("%s: %s, want %s", in, got, want)
		}
		if conflictPart.ReplaceAllString(got, "") != in {
			t.Errorf("lifelog merge does not find %s from %s", in, got)
		}
	}
}

func gitOut(t *testing.T, gitDir string, args ...string) string {
	t.Helper()
	out, err := exec.Command("git", append([]string{"--git-dir", gitDir}, args...)...).Output()
	if err != nil {
		t.Fatalf("git %s: %v", strings.Join(args, " "), err)
	}
	return strings.TrimSpace(string(out))
}
