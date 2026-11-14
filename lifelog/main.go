// Command lifelog checks the life folder and holds the commands that write
// into it (docs/design.md). This version has `check`; the others follow
// (docs/plans/002-into-the-fleet.md).
package main

import (
	"context"
	"flag"
	"fmt"
	"io"
	"os"
	"time"

	"lifelog/check"
)

// The exit codes. The keeper reads them: 1 holds `checked` back.
const (
	exitOK      = 0 // no error and no loss; warnings may be printed
	exitProblem = 1 // an error or a loss
	exitUsage   = 2
	exitFailed  = 3 // the run did not finish: nothing is known about the folder
)

const usage = "usage: lifelog check [-report] [-git-dir DIR [-seen REF] [-live REF]] FOLDER"

func main() {
	os.Exit(run(context.Background(), os.Args[1:], os.Stdout, os.Stderr))
}

func run(ctx context.Context, args []string, stdout, stderr io.Writer) int {
	if len(args) == 0 {
		fmt.Fprintln(stderr, usage)
		return exitUsage
	}
	switch args[0] {
	case "check":
		return cmdCheck(ctx, args[1:], stdout, stderr)
	default:
		fmt.Fprintf(stderr, "lifelog: unknown command %q\n%s\n", args[0], usage)
		return exitUsage
	}
}

func cmdCheck(ctx context.Context, args []string, stdout, stderr io.Writer) int {
	fs := flag.NewFlagSet("check", flag.ContinueOnError)
	fs.SetOutput(stderr)
	report := fs.Bool("report", false, "print the text of _check.md")
	gitDir := fs.String("git-dir", "", "the git dir of the folder's history; with it, the rules that compare -seen with -live run too")
	seen := fs.String("seen", "seen", "the ref of the state the owner last acknowledged")
	live := fs.String("live", "live", "the ref of the state just committed")
	if err := fs.Parse(args); err != nil {
		return exitUsage
	}
	if fs.NArg() != 1 {
		fmt.Fprintln(stderr, usage)
		return exitUsage
	}
	folder := fs.Arg(0)
	// A missing folder (a disk that did not mount) has no content folders, so
	// the rules would find nothing; that is a run that did not finish.
	if st, err := os.Stat(folder); err != nil || !st.IsDir() {
		fmt.Fprintf(stderr, "lifelog check: the run did not finish: %s is not a folder\n", folder)
		return exitFailed
	}
	problems, err := check.Tree(os.DirFS(folder))
	if err != nil {
		fmt.Fprintf(stderr, "lifelog check: the run did not finish: %v\n", err)
		return exitFailed
	}
	header := "Run at " + time.Now().Format(time.RFC3339) + "."
	if *gitDir != "" {
		if !check.RefExists(ctx, *gitDir, *live) {
			fmt.Fprintf(stderr, "lifelog check: the run did not finish: %s has no commit %q\n", *gitDir, *live)
			return exitFailed
		}
		if check.RefExists(ctx, *gitDir, *seen) {
			past, err := check.History(ctx, *gitDir, *seen, *live)
			if err != nil {
				fmt.Fprintf(stderr, "lifelog check: the run did not finish: %v\n", err)
				return exitFailed
			}
			problems = append(problems, past...)
		} else {
			// The first run: nothing has been acknowledged, so there is no past to compare with.
			header += " There is no acknowledged state yet, so the rules that compare with the past did not run."
		}
	}
	if *report {
		fmt.Fprint(stdout, check.Report(problems, header))
	} else {
		for _, p := range problems {
			fmt.Fprintf(stdout, "%s\t%s\t%s\t%s (fix: %s)\n", p.Class, p.Rule, p.Path, p.Message, p.Fix)
		}
	}
	for _, p := range problems {
		if p.Class != check.Warning {
			return exitProblem
		}
	}
	return exitOK
}
