package main

import (
	"flag"
	"fmt"
	"io"
	"io/fs"
	"os"
	"path/filepath"
	"regexp"
	"strings"

	"lifelog/check"
)

// fullLink is a whole wikilink: an optional ! (an embed), the target, and the
// rest (#heading, ^block, |text) up to ]].
var fullLink = regexp.MustCompile(`(!?)\[\[([^\[\]|#^\n]+)([^\[\]\n]*)\]\]`)

// cmdRenameLinks rewrites every link to OLD (compared by title key, as links
// resolve) into a link to NEW, in the pages of the content folders, as
// Obsidian does on a rename. It keeps each link's heading and text.
func cmdRenameLinks(args []string, stdout, stderr io.Writer) int {
	flags := flag.NewFlagSet("rename-links", flag.ContinueOnError)
	flags.SetOutput(stderr)
	folder := flags.String("folder", defaultFolder(), "the life folder")
	if err := flags.Parse(args); err != nil {
		return exitUsage
	}
	if flags.NArg() != 2 {
		fmt.Fprintln(stderr, "usage: lifelog rename-links OLD NEW")
		return exitUsage
	}
	oldName, newName := strings.TrimSpace(flags.Arg(0)), strings.TrimSpace(flags.Arg(1))
	if newName == "" || strings.ContainsAny(newName, "#^[]|/\\\n") {
		fmt.Fprintf(stderr, "lifelog rename-links: %q cannot be a title\n", newName)
		return exitProblem
	}
	oldKey := check.TitleKey(oldName)
	root := os.DirFS(*folder)
	type edit struct {
		rel  string
		text string
		n    int
	}
	var edits []edit
	newExists := false
	for _, top := range check.ContentFolders {
		err := fs.WalkDir(root, top, func(p string, d fs.DirEntry, err error) error {
			if err != nil {
				if p == top && os.IsNotExist(err) {
					return fs.SkipDir
				}
				return err
			}
			name := d.Name()
			if d.IsDir() || !strings.HasSuffix(name, ".md") || strings.HasPrefix(name, ".syncthing.") || strings.Contains(name, ".sync-conflict-") {
				return nil
			}
			if check.TitleKey(strings.TrimSuffix(name, ".md")) == check.TitleKey(newName) {
				newExists = true
			}
			data, err := fs.ReadFile(root, p)
			if err != nil {
				return err
			}
			n := 0
			text := fullLink.ReplaceAllStringFunc(string(data), func(link string) string {
				m := fullLink.FindStringSubmatch(link)
				if check.TitleKey(strings.TrimSpace(m[2])) != oldKey {
					return link
				}
				n++
				return m[1] + "[[" + newName + m[3] + "]]"
			})
			if n > 0 {
				edits = append(edits, edit{p, text, n})
			}
			return nil
		})
		if err != nil {
			fmt.Fprintf(stderr, "lifelog rename-links: %v; nothing was changed\n", err)
			return exitFailed
		}
	}
	for _, e := range edits {
		if err := writeFile(filepath.Join(*folder, filepath.FromSlash(e.rel)), []byte(e.text)); err != nil {
			fmt.Fprintf(stderr, "lifelog rename-links: %s: %v\n", e.rel, err)
			return exitFailed
		}
		fmt.Fprintf(stdout, "%s: %d links\n", e.rel, e.n)
	}
	fmt.Fprintf(stdout, "%d pages changed\n", len(edits))
	if !newExists {
		fmt.Fprintf(stderr, "lifelog rename-links: note: no page has the title %q yet\n", newName)
	}
	return exitOK
}
