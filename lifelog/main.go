// Command lifelog checks the life folder and holds the commands that write
// into it (docs/design.md):
//
//	lifelog check         the rules of design §6; the keeper runs it
//	lifelog index         print the pages, their links and the metrics as JSON (for the web app)
//	lifelog new           create a page, refused when the checker would find it in error
//	lifelog add           append one reading to this machine's CSV of a metric
//	lifelog merge         merge a Syncthing conflict copy of a CSV into its file
//	lifelog rename-links  rewrite the links to a renamed page
//	lifelog restore       write a file back from git (on the keeper's machine)
package main

import (
	"context"
	"fmt"
	"io"
	"os"
	"regexp"
	"strings"
)

// The exit codes. The keeper reads them from `check`: 1 holds `checked` back.
const (
	exitOK      = 0 // done; for check: no error and no loss, warnings may be printed
	exitProblem = 1 // check: an error or a loss; another command: it refused, and changed nothing
	exitUsage   = 2
	exitFailed  = 3 // the run did not finish
)

const usage = `usage:
  lifelog check [-report | -json] [-git-dir DIR [-seen REF] [-live REF]] [FOLDER]
  lifelog index
  lifelog new KIND TITLE < TEXT
  lifelog add [-day DAY] [-at INSTANT] [-source SOURCE] [-machine NAME] METRIC VALUE
  lifelog merge COPY
  lifelog rename-links OLD NEW
  lifelog restore [-git-dir DIR] PATH [REF]
Each command except check takes -folder (default $LIFELOG_FOLDER, else /srv/life).`

func main() {
	os.Exit(run(context.Background(), os.Args[1:], os.Stdin, os.Stdout, os.Stderr))
}

func run(ctx context.Context, args []string, stdin io.Reader, stdout, stderr io.Writer) int {
	if len(args) == 0 {
		fmt.Fprintln(stderr, usage)
		return exitUsage
	}
	cmds := map[string]func() int{
		"check":        func() int { return cmdCheck(ctx, args[1:], stdout, stderr) },
		"index":        func() int { return cmdIndex(args[1:], stdout, stderr) },
		"new":          func() int { return cmdNew(args[1:], stdin, stdout, stderr) },
		"add":          func() int { return cmdAdd(args[1:], stdout, stderr) },
		"merge":        func() int { return cmdMerge(args[1:], stdin, stdout, stderr) },
		"rename-links": func() int { return cmdRenameLinks(args[1:], stdout, stderr) },
		"restore":      func() int { return cmdRestore(ctx, args[1:], stdout, stderr) },
	}
	cmd, ok := cmds[args[0]]
	if !ok {
		fmt.Fprintf(stderr, "lifelog: unknown command %q\n%s\n", args[0], usage)
		return exitUsage
	}
	return cmd()
}

func defaultFolder() string {
	if f := os.Getenv("LIFELOG_FOLDER"); f != "" {
		return f
	}
	return "/srv/life"
}

func defaultGitDir() string {
	if d := os.Getenv("LIFELOG_GIT_DIR"); d != "" {
		return d
	}
	return "/var/lib/lifelog/life.git"
}

var machineText = regexp.MustCompile(`^[a-z0-9-]{1,32}$`)

// machineName is this machine's name in the name of its CSV files: its
// hostname, in lowercase, up to the first dot.
func machineName() (string, error) {
	h, err := os.Hostname()
	if err != nil {
		return "", err
	}
	h, _, _ = strings.Cut(strings.ToLower(h), ".")
	if !machineText.MatchString(h) {
		return "", fmt.Errorf("the hostname %q is not a machine name (a-z, 0-9, -); pass -machine", h)
	}
	return h, nil
}
