package main

import (
	"encoding/json"
	"flag"
	"fmt"
	"io"
	"os"

	"lifelog/check"
)

// cmdIndex prints the index of the folder as JSON: each page with its title,
// aliases, properties and resolved links, and each metric. The web app reads
// it, so the title key and the link grammar stay in Go.
func cmdIndex(args []string, stdout, stderr io.Writer) int {
	flags := flag.NewFlagSet("index", flag.ContinueOnError)
	flags.SetOutput(stderr)
	folder := flags.String("folder", defaultFolder(), "the life folder")
	if err := flags.Parse(args); err != nil {
		return exitUsage
	}
	if flags.NArg() != 0 {
		fmt.Fprintln(stderr, "usage: lifelog index [-folder FOLDER]")
		return exitUsage
	}
	if st, err := os.Stat(*folder); err != nil || !st.IsDir() {
		fmt.Fprintf(stderr, "lifelog index: %s is not a folder\n", *folder)
		return exitFailed
	}
	idx, err := check.ReadIndex(os.DirFS(*folder))
	if err != nil {
		fmt.Fprintf(stderr, "lifelog index: %v\n", err)
		return exitFailed
	}
	if err := json.NewEncoder(stdout).Encode(idx); err != nil {
		fmt.Fprintf(stderr, "lifelog index: %v\n", err)
		return exitFailed
	}
	return exitOK
}
