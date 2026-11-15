package main

import (
	"flag"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing/fstest"

	"lifelog/check"
)

// cmdNew creates a page: KIND/TITLE.md, with the text read from stdin. It
// refuses a page that the checker would find in error (its path, its
// frontmatter), and a title or an alias that another page holds; then it
// changes nothing. A warning does not refuse it: it is printed.
func cmdNew(args []string, stdin io.Reader, stdout, stderr io.Writer) int {
	flags := flag.NewFlagSet("new", flag.ContinueOnError)
	flags.SetOutput(stderr)
	folder := flags.String("folder", defaultFolder(), "the life folder")
	if err := flags.Parse(args); err != nil {
		return exitUsage
	}
	if flags.NArg() != 2 {
		fmt.Fprintln(stderr, "usage: lifelog new KIND TITLE < TEXT   (KIND: one of "+strings.Join(check.ContentFolders, ", ")+")")
		return exitUsage
	}
	refuse := func(format string, a ...any) int {
		fmt.Fprintf(stderr, "lifelog new: "+format+"\n", a...)
		return exitProblem
	}
	kind, title := flags.Arg(0), strings.TrimSpace(flags.Arg(1))
	if !slices.Contains(check.ContentFolders, kind) || kind == "files" {
		return refuse("%q is not a kind of page that is made by hand (journal, pages, people, places, metrics)", kind)
	}
	// Containment first: the rest of the rules are the checker's.
	if title == "" || strings.ContainsAny(title, "/\\\x00\n") || strings.HasPrefix(title, ".") {
		return refuse("%q cannot be a title (no / \\ or newline, and not starting with a point)", title)
	}
	text, err := io.ReadAll(io.LimitReader(stdin, 16<<20))
	if err != nil {
		fmt.Fprintf(stderr, "lifelog new: %v\n", err)
		return exitFailed
	}
	rel := kind + "/" + title + ".md"
	path := filepath.Join(*folder, filepath.FromSlash(rel))
	if _, err := os.Lstat(path); err == nil {
		return refuse("%s exists", rel)
	}

	// The checker on the new page alone: its path, its encoding, its frontmatter.
	alone, err := check.Tree(fstest.MapFS{rel: {Data: text}})
	if err != nil {
		fmt.Fprintf(stderr, "lifelog new: %v\n", err)
		return exitFailed
	}
	var warnings []check.Problem
	for _, p := range alone {
		if p.Class == check.Warning {
			warnings = append(warnings, p)
			continue
		}
		return refuse("%s: %s (fix: %s)", p.Rule, p.Message, p.Fix)
	}
	// And against the folder: no title or alias of another page.
	idx, err := check.ReadIndex(os.DirFS(*folder))
	if err != nil {
		fmt.Fprintf(stderr, "lifelog new: %v\n", err)
		return exitFailed
	}
	mine, err := check.ReadIndex(fstest.MapFS{rel: {Data: text}})
	if err != nil {
		fmt.Fprintf(stderr, "lifelog new: %v\n", err)
		return exitFailed
	}
	held := map[string]string{}
	for _, p := range idx.Pages {
		for _, t := range append([]string{p.Title}, p.Aliases...) {
			held[check.TitleKey(t)] = p.Path
		}
	}
	for _, p := range mine.Pages {
		for _, t := range append([]string{p.Title}, p.Aliases...) {
			if other, ok := held[check.TitleKey(t)]; ok {
				return refuse("the title or alias %q is held by %s", t, other)
			}
		}
	}

	if err := writeFile(path, text); err != nil {
		fmt.Fprintf(stderr, "lifelog new: %v\n", err)
		return exitFailed
	}
	fmt.Fprintln(stdout, rel)
	for _, p := range warnings {
		fmt.Fprintf(stderr, "warning\t%s\t%s\t%s (fix: %s)\n", p.Rule, p.Path, p.Message, p.Fix)
	}
	return exitOK
}
