package main

import (
	"bufio"
	"encoding/csv"
	"flag"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"regexp"
	"strings"

	"lifelog/check"
)

// conflictPart is what Syncthing adds to the name of a conflict copy.
var conflictPart = regexp.MustCompile(`\.sync-conflict-\d{8}-\d{6}-[A-Z0-9]{7}`)

type mergeLine struct {
	text string
	key  [3]string // day, taken_at, source
}

func parseCSV(name, text string) ([]mergeLine, error) {
	text = strings.ReplaceAll(text, "\r\n", "\n")
	lines := strings.Split(strings.TrimSuffix(text, "\n"), "\n")
	if len(lines) == 0 || lines[0] != check.CSVHeader {
		return nil, fmt.Errorf("%s does not start with the header %s", name, check.CSVHeader)
	}
	var out []mergeLine
	for i, l := range lines[1:] {
		if l == "" {
			continue
		}
		f, err := csv.NewReader(strings.NewReader(l)).Read()
		if err != nil || len(f) != 4 {
			return nil, fmt.Errorf("line %d of %s is not a reading; correct it first (lifelog check shows why)", i+2, name)
		}
		out = append(out, mergeLine{l, [3]string{f[0], f[1], f[3]}})
	}
	return out, nil
}

// cmdMerge merges a Syncthing conflict copy of a CSV into its file, by the key
// (day, taken_at, source) of each line, and removes the copy. It asks about a
// key with two values. A page's conflict copy is merged by hand.
func cmdMerge(args []string, stdin io.Reader, stdout, stderr io.Writer) int {
	fs := flag.NewFlagSet("merge", flag.ContinueOnError)
	fs.SetOutput(stderr)
	folder := fs.String("folder", defaultFolder(), "the life folder")
	if err := fs.Parse(args); err != nil {
		return exitUsage
	}
	if fs.NArg() != 1 {
		fmt.Fprintln(stderr, "usage: lifelog merge COPY")
		return exitUsage
	}
	refuse := func(format string, a ...any) int {
		fmt.Fprintf(stderr, "lifelog merge: "+format+"\n", a...)
		return exitProblem
	}
	copyRel, err := inFolder(*folder, fs.Arg(0))
	if err != nil {
		return refuse("%v", err)
	}
	if !conflictPart.MatchString(copyRel) {
		return refuse("%s is not a Syncthing conflict copy", copyRel)
	}
	origRel := conflictPart.ReplaceAllString(copyRel, "")
	if !strings.HasSuffix(origRel, ".csv") {
		return refuse("merge a page by hand: compare %s with %s, keep what you want in %s, then delete the copy", copyRel, origRel, origRel)
	}
	copyPath, origPath := filepath.Join(*folder, copyRel), filepath.Join(*folder, origRel)
	copyText, err := os.ReadFile(copyPath)
	if err != nil {
		return refuse("%v", err)
	}
	origText, err := os.ReadFile(origPath)
	if err != nil {
		return refuse("%v", err)
	}
	theirs, err := parseCSV(copyRel, string(copyText))
	if err != nil {
		return refuse("%v", err)
	}
	ours, err := parseCSV(origRel, string(origText))
	if err != nil {
		return refuse("%v", err)
	}

	have := map[string]bool{}
	byKey := map[[3]string]int{} // key -> index of its first line in ours
	for i, l := range ours {
		have[l.text] = true
		if _, ok := byKey[l.key]; !ok {
			byKey[l.key] = i
		}
	}
	answers := bufio.NewReader(stdin)
	var added []string
	replaced := 0
	for _, l := range theirs {
		if have[l.text] {
			continue
		}
		i, clash := byKey[l.key]
		if !clash {
			added = append(added, l.text)
			have[l.text] = true
			continue
		}
		fmt.Fprintf(stdout, "%s: day %s, taken_at %q, source %s has two values\n  this file: %s\n  the copy:  %s\n[k]eep this file's line, [r]eplace it with the copy's, [b]oth (two readings)? ",
			origRel, l.key[0], l.key[1], l.key[2], ours[i].text, l.text)
		answer, err := answers.ReadString('\n')
		switch strings.TrimSpace(answer) {
		case "k":
		case "r":
			ours[i].text = l.text
			replaced++
		case "b":
			added = append(added, l.text)
		default:
			if err != nil {
				fmt.Fprintln(stdout)
			}
			return refuse("no answer; nothing was changed")
		}
		have[l.text] = true
	}

	var b strings.Builder
	b.WriteString(check.CSVHeader + "\n")
	for _, l := range ours {
		b.WriteString(l.text + "\n")
	}
	for _, l := range added {
		b.WriteString(l + "\n")
	}
	if err := writeFile(origPath, []byte(b.String())); err != nil {
		fmt.Fprintf(stderr, "lifelog merge: %v\n", err)
		return exitFailed
	}
	if err := os.Remove(copyPath); err != nil {
		fmt.Fprintf(stderr, "lifelog merge: %s is merged, but the copy stays: %v\n", origRel, err)
		return exitFailed
	}
	fmt.Fprintf(stdout, "%s: %d lines added, %d replaced; the copy is removed\n", origRel, len(added), replaced)
	return exitOK
}
