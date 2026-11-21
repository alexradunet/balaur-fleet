package main

import (
	"bytes"
	"context"
	"flag"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strings"
	"time"
)

// fromRef names the machine of a ref that a client pushed: refs/heads/from/laptop.
var fromRef = regexp.MustCompile(`^(?:refs/heads/)?from/([a-z0-9-]{1,32})$`)

// cmdIntegrate merges another machine's commits into the branch the folder is a
// work tree of (plan 005): the keeper merges a client's `from/<host>` into
// `live`, a client merges the server's `live` into its own branch. It runs after
// the caller committed the settled folder, and refuses a folder with changes
// that are not committed, so it never overwrites a write.
//
// What git merges by itself is merged. A file both sides changed keeps the
// version already in the folder; the other side's goes beside it as a conflict
// copy, `<name>.sync-conflict-<date>-<time>-<machine>.<ext>`, which the checker
// reports and `lifelog merge` merges for a CSV. A file one side deleted and the
// other changed keeps the changed one. Nothing is lost, and the merge commit
// records it.
func cmdIntegrate(ctx context.Context, args []string, stdout, stderr io.Writer) int {
	fs := flag.NewFlagSet("integrate", flag.ContinueOnError)
	fs.SetOutput(stderr)
	folder := fs.String("folder", defaultFolder(), "the life folder: the work tree")
	gitDir := fs.String("git-dir", defaultGitDir(), "the git dir of the folder's history; its HEAD is the branch merged into")
	from := fs.String("from", "", "the machine the other commits come from, in the name of a conflict copy (default: the host of a from/<host> ref)")
	machine := fs.String("machine", "", "this machine's name, as the merge's committer (default: the hostname)")
	if err := fs.Parse(args); err != nil {
		return exitUsage
	}
	if fs.NArg() != 1 {
		fmt.Fprintln(stderr, "usage: lifelog integrate [-folder DIR] [-git-dir DIR] [-from MACHINE] [-machine NAME] REF")
		return exitUsage
	}
	ref := fs.Arg(0)
	refuse := func(code int, format string, a ...any) int {
		fmt.Fprintf(stderr, "lifelog integrate: "+format+"\n", a...)
		return code
	}
	if *from == "" {
		m := fromRef.FindStringSubmatch(ref)
		if m == nil {
			return refuse(exitUsage, "%s is not a from/<host> ref: pass -from", ref)
		}
		*from = m[1]
	}
	if *machine == "" {
		m, err := machineName()
		if err != nil {
			return refuse(exitUsage, "%v", err)
		}
		*machine = m
	}
	for _, m := range []string{*from, *machine} {
		if !machineText.MatchString(m) {
			return refuse(exitUsage, "%q is not a machine name (a-z, 0-9, -)", m)
		}
	}

	g := gitRunner{ctx: ctx, gitDir: *gitDir, folder: *folder, name: "lifelog " + *machine, email: *machine + "@lifelog"}
	other, err := g.out("rev-parse", "--verify", "-q", ref+"^{commit}")
	if err != nil {
		return refuse(exitProblem, "%s is not a commit in %s", ref, *gitDir)
	}
	if _, err := g.out("rev-parse", "--verify", "-q", "HEAD^{commit}"); err != nil {
		return refuse(exitProblem, "the branch HEAD names has no commit yet: commit the folder first")
	}
	if g.ok("merge-base", "--is-ancestor", other, "HEAD") {
		fmt.Fprintf(stdout, "%s is already in the folder\n", ref)
		return exitOK
	}
	if status, err := g.out("status", "--porcelain", "--untracked-files=all"); err != nil {
		return refuse(exitFailed, "git status: %v", err)
	} else if status != "" {
		return refuse(exitProblem, "the folder has changes that are not committed; commit it first, then integrate:\n%s", status)
	}

	msg := fmt.Sprintf("integrate %s (from %s)", ref, *from)
	if _, err := g.out("merge", "--no-edit", "--no-verify", "-q", "-m", msg, other); err == nil {
		fmt.Fprintf(stdout, "%s: merged into the folder\n", ref)
		return exitOK
	}

	// The merge stopped. Either some files conflict, which the rule above settles,
	// or git refused to start (a file written into the folder a moment ago).
	unmerged, err := g.unmerged()
	if err != nil {
		g.abort()
		return refuse(exitFailed, "git ls-files: %v", err)
	}
	if len(unmerged) == 0 {
		g.abort()
		return refuse(exitProblem, "git did not merge %s, and nothing was changed; it is tried again at the next run", ref)
	}
	stamp := time.Now().Format("20060102-150405")
	var copies []string
	for _, u := range unmerged {
		switch {
		case u.ours != "" && u.theirs != "":
			// Both changed it (or both added it): the folder's version stays, the
			// other goes beside it.
			if err := g.checkout("--ours", u.path); err != nil {
				g.abort()
				return refuse(exitFailed, "%s: %v", u.path, err)
			}
			data, err := g.blob(u.theirs)
			if err != nil {
				g.abort()
				return refuse(exitFailed, "%s: %v", u.path, err)
			}
			cp := conflictCopy(u.path, stamp, *from)
			if err := writeFile(filepath.Join(*folder, filepath.FromSlash(cp)), data); err != nil {
				g.abort()
				return refuse(exitFailed, "%v", err)
			}
			if _, err := g.out("add", "--", u.path, cp); err != nil {
				g.abort()
				return refuse(exitFailed, "git add: %v", err)
			}
			copies = append(copies, cp)
		case u.theirs != "":
			// Deleted here, changed there: the changed one stays.
			if err := g.checkout("--theirs", u.path); err != nil {
				g.abort()
				return refuse(exitFailed, "%s: %v", u.path, err)
			}
			if _, err := g.out("add", "--", u.path); err != nil {
				g.abort()
				return refuse(exitFailed, "git add: %v", err)
			}
		default:
			// Changed here, deleted there: the folder already holds the changed one.
			if _, err := g.out("add", "--", u.path); err != nil {
				g.abort()
				return refuse(exitFailed, "git add: %v", err)
			}
		}
	}
	body := msg + "\n\nConflict copies (the other side's version, beside the folder's):\n"
	for _, c := range copies {
		body += "  " + c + "\n"
	}
	if len(copies) == 0 {
		body = msg + "\n\nA file deleted on one side and changed on the other kept the change.\n"
	}
	if _, err := g.out("commit", "--no-verify", "-q", "-m", body); err != nil {
		g.abort()
		return refuse(exitFailed, "git commit: %v", err)
	}
	fmt.Fprintf(stdout, "%s: merged into the folder\n", ref)
	for _, c := range copies {
		fmt.Fprintf(stdout, "conflict copy: %s\n", c)
	}
	return exitOK
}

// conflictCopy names the copy of rel holding the other machine's version, in
// Syncthing's form with the machine's name in place of a device id, so the
// checker and `lifelog merge` know it: pages/A.md -> pages/A.sync-conflict-20261121-143000-laptop.md.
func conflictCopy(rel, stamp, machine string) string {
	dir, base := filepath.Split(filepath.FromSlash(rel))
	ext := filepath.Ext(base)
	return filepath.ToSlash(filepath.Join(dir, strings.TrimSuffix(base, ext)+".sync-conflict-"+stamp+"-"+machine+ext))
}

// gitRunner runs git with the git dir outside the folder, as the keeper does,
// with no system or user configuration.
type gitRunner struct {
	ctx            context.Context
	gitDir, folder string
	name, email    string
}

func (g gitRunner) cmd(args ...string) *exec.Cmd {
	base := []string{"--git-dir", g.gitDir, "--work-tree", g.folder,
		"-c", "safe.directory=" + g.gitDir, "-c", "gc.autoDetach=false", "-c", "merge.renames=true",
		"-c", "user.name=" + g.name, "-c", "user.email=" + g.email}
	c := exec.CommandContext(g.ctx, "git", append(base, args...)...)
	c.Dir = g.folder
	c.Env = append(os.Environ(), "GIT_CONFIG_NOSYSTEM=1", "GIT_CONFIG_GLOBAL=/dev/null", "LC_ALL=C",
		"GIT_AUTHOR_NAME="+g.name, "GIT_AUTHOR_EMAIL="+g.email,
		"GIT_COMMITTER_NAME="+g.name, "GIT_COMMITTER_EMAIL="+g.email)
	return c
}

func (g gitRunner) out(args ...string) (string, error) {
	var out, errOut bytes.Buffer
	c := g.cmd(args...)
	c.Stdout, c.Stderr = &out, &errOut
	if err := c.Run(); err != nil {
		return "", fmt.Errorf("%w: %s%s", err, strings.TrimSpace(errOut.String()), strings.TrimSpace(out.String()))
	}
	return strings.TrimSpace(out.String()), nil
}

func (g gitRunner) ok(args ...string) bool {
	return g.cmd(args...).Run() == nil
}

func (g gitRunner) blob(sha string) ([]byte, error) {
	var out, errOut bytes.Buffer
	c := g.cmd("cat-file", "blob", sha)
	c.Stdout, c.Stderr = &out, &errOut
	if err := c.Run(); err != nil {
		return nil, fmt.Errorf("%w: %s", err, strings.TrimSpace(errOut.String()))
	}
	return out.Bytes(), nil
}

func (g gitRunner) checkout(side, path string) error {
	_, err := g.out("checkout", side, "--", path)
	return err
}

// abort leaves the folder and the branch as they were before the merge.
func (g gitRunner) abort() {
	if g.ok("rev-parse", "-q", "--verify", "MERGE_HEAD") {
		_ = g.cmd("merge", "--abort").Run()
	}
}

type unmergedPath struct {
	path         string
	ours, theirs string // the blob of each side; empty where that side deleted it
}

// unmerged lists the paths the merge left in conflict, with each side's blob.
func (g gitRunner) unmerged() ([]unmergedPath, error) {
	out, err := g.out("ls-files", "-u", "-z")
	if err != nil {
		return nil, err
	}
	byPath := map[string]*unmergedPath{}
	var order []string
	for _, entry := range strings.Split(out, "\x00") {
		// <mode> <sha> <stage>\t<path>
		meta, path, found := strings.Cut(entry, "\t")
		f := strings.Fields(meta)
		if !found || len(f) != 3 {
			continue
		}
		u := byPath[path]
		if u == nil {
			u = &unmergedPath{path: path}
			byPath[path] = u
			order = append(order, path)
		}
		switch f[2] {
		case "2":
			u.ours = f[1]
		case "3":
			u.theirs = f[1]
		}
	}
	list := make([]unmergedPath, 0, len(order))
	for _, p := range order {
		list = append(list, *byPath[p])
	}
	return list, nil
}
