// Command lifelog checks the life folder and holds the commands that write
// into it (docs/design.md). This version has `check`; the others follow
// (docs/plans/002-into-the-fleet.md).
package main

import (
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

func main() {
	os.Exit(run(os.Args[1:], os.Stdout, os.Stderr))
}

func run(args []string, stdout, stderr io.Writer) int {
	if len(args) == 0 {
		fmt.Fprintln(stderr, "usage: lifelog check [-report] DIR")
		return exitUsage
	}
	switch args[0] {
	case "check":
		return cmdCheck(args[1:], stdout, stderr)
	default:
		fmt.Fprintf(stderr, "lifelog: unknown command %q\nusage: lifelog check [-report] DIR\n", args[0])
		return exitUsage
	}
}

func cmdCheck(args []string, stdout, stderr io.Writer) int {
	fs := flag.NewFlagSet("check", flag.ContinueOnError)
	fs.SetOutput(stderr)
	report := fs.Bool("report", false, "print the text of _check.md")
	if err := fs.Parse(args); err != nil {
		return exitUsage
	}
	if fs.NArg() != 1 {
		fmt.Fprintln(stderr, "usage: lifelog check [-report] DIR")
		return exitUsage
	}
	// A missing folder (a disk that did not mount) has no content folders, so
	// the rules would find nothing; that is a run that did not finish.
	if st, err := os.Stat(fs.Arg(0)); err != nil || !st.IsDir() {
		fmt.Fprintf(stderr, "lifelog check: the run did not finish: %s is not a folder\n", fs.Arg(0))
		return exitFailed
	}
	problems, err := check.Tree(os.DirFS(fs.Arg(0)))
	if err != nil {
		fmt.Fprintf(stderr, "lifelog check: the run did not finish: %v\n", err)
		return exitFailed
	}
	if *report {
		fmt.Fprint(stdout, check.Report(problems, "Run at "+time.Now().Format(time.RFC3339)+"."))
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
