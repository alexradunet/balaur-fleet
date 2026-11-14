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
	"strings"
)

// cmdRestore writes a file of the folder back from a ref of its git history
// (default: checked). It runs where the git dir is: on the keeper's machine.
func cmdRestore(ctx context.Context, args []string, stdout, stderr io.Writer) int {
	fs := flag.NewFlagSet("restore", flag.ContinueOnError)
	fs.SetOutput(stderr)
	folder := fs.String("folder", defaultFolder(), "the life folder")
	gitDir := fs.String("git-dir", defaultGitDir(), "the git dir of the folder's history")
	if err := fs.Parse(args); err != nil {
		return exitUsage
	}
	if fs.NArg() < 1 || fs.NArg() > 2 {
		fmt.Fprintln(stderr, "usage: lifelog restore [-git-dir DIR] PATH [REF]")
		return exitUsage
	}
	ref := "checked"
	if fs.NArg() == 2 {
		ref = fs.Arg(1)
	}
	rel, err := inFolder(*folder, fs.Arg(0))
	if err != nil {
		fmt.Fprintf(stderr, "lifelog restore: %v\n", err)
		return exitProblem
	}
	cmd := exec.CommandContext(ctx, "git", "--git-dir", *gitDir, "-c", "safe.directory="+*gitDir, "show", ref+":"+rel)
	cmd.Env = append(os.Environ(), "GIT_CONFIG_NOSYSTEM=1", "GIT_CONFIG_GLOBAL=/dev/null", "LC_ALL=C")
	var out, errOut bytes.Buffer
	cmd.Stdout, cmd.Stderr = &out, &errOut
	if err := cmd.Run(); err != nil {
		fmt.Fprintf(stderr, "lifelog restore: %s is not in %s: %s\n", rel, ref, strings.TrimSpace(errOut.String()))
		return exitProblem
	}
	path := filepath.Join(*folder, filepath.FromSlash(rel))
	if now, err := os.ReadFile(path); err == nil && bytes.Equal(now, out.Bytes()) {
		fmt.Fprintf(stdout, "%s is already as in %s\n", rel, ref)
		return exitOK
	}
	if err := writeFile(path, out.Bytes()); err != nil {
		fmt.Fprintf(stderr, "lifelog restore: %v\n", err)
		return exitFailed
	}
	fmt.Fprintf(stdout, "%s: restored from %s\n", rel, ref)
	return exitOK
}
