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
	if fs.NArg() > 1 {
		fmt.Fprintln(stderr, usage)
		return exitUsage
	}
	folder := defaultFolder()
	if fs.NArg() == 1 {
		folder = fs.Arg(0)
	}
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
