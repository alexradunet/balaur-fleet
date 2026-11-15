package main

import (
	"encoding/json"
	"strings"
	"testing"

	"lifelog/check"
)

// The commands the web app calls: index, new and check -json.

func TestIndexResolvesLinksByTitleKeyAndAlias(t *testing.T) {
	f := folderWithWeight(t)
	write(t, f, "pages/Iron.md", "---\naliases:\n  - Fe\n---\nSee [[ferritin]], [[Fe|iron]] and [[Nowhere#x]].\n")
	write(t, f, "pages/Ferritin.md", "Stored [[Iron]].\n")
	write(t, f, "journal/2026-11-14.md", "Ate [[fe]].\n")
	write(t, f, "pages/.syncthing.Iron.md.123.tmp", "half")
	code, out, errOut := lifelog(t, "", "index", "-folder", f)
	if code != exitOK {
		t.Fatalf("index: exit %d: %s", code, errOut)
	}
	var idx check.Index
	if err := json.Unmarshal([]byte(out), &idx); err != nil {
		t.Fatal(err)
	}
	byPath := map[string]check.Page{}
	for _, p := range idx.Pages {
		byPath[p.Path] = p
	}
	if len(byPath) != 4 {
		t.Fatalf("pages: %v, want the four real pages", byPath)
	}
	iron := byPath["pages/Iron.md"]
	want := map[string]string{"ferritin": "pages/Ferritin.md", "Fe": "pages/Iron.md", "Nowhere": ""}
	for k, v := range want {
		if got, ok := iron.Links[k]; !ok || got != v {
			t.Errorf("Iron links %q -> %q (present %v), want %q", k, got, ok, v)
		}
	}
	if got := byPath["journal/2026-11-14.md"].Links["fe"]; got != "pages/Iron.md" {
		t.Errorf("an alias in another case resolves to %q, want pages/Iron.md", got)
	}
	if len(iron.Aliases) != 1 || iron.Aliases[0] != "Fe" || iron.Kind != "pages" || iron.Title != "Iron" {
		t.Errorf("Iron: %+v", iron)
	}
	if len(idx.Metrics) != 1 || idx.Metrics[0].Name != "weight" || idx.Metrics[0].Unit != "kg" ||
		*idx.Metrics[0].Min != 20 || *idx.Metrics[0].Max != 300 {
		t.Errorf("metrics: %+v", idx.Metrics)
	}
}

func TestNewCreatesAPageAndRefusesWhatTheCheckerRefuses(t *testing.T) {
	f := folderWithWeight(t)
	write(t, f, "pages/Iron.md", "---\naliases:\n  - Fe\n---\n")
	if code, out, e := lifelog(t, "Body.\n", "new", "-folder", f, "people", "Ana"); code != exitOK || out != "people/Ana.md\n" {
		t.Fatalf("new: exit %d, %q: %s", code, out, e)
	}
	if got := read(t, f, "people/Ana.md"); got != "Body.\n" {
		t.Errorf("the page holds %q", got)
	}
	refused := []struct {
		name, text string
		args       []string
	}{
		{"an existing page", "", []string{"people", "Ana"}},
		{"a title held as an alias, in another case", "", []string{"places", "fe"}},
		{"an alias held as a title", "---\naliases:\n  - iron\n---\n", []string{"pages", "Metal"}},
		{"a character Obsidian cannot link to", "", []string{"pages", "C#"}},
		{"a slash", "", []string{"pages", "a/b"}},
		{"a leading point", "", []string{"pages", ".hidden"}},
		{"broken frontmatter", "---\nkey: [a\n---\n", []string{"pages", "Broken"}},
		{"a day page not named by a day", "", []string{"journal", "2026-02-30"}},
		{"files, which are not made by hand", "", []string{"files", "x"}},
	}
	for _, r := range refused {
		code, _, e := lifelog(t, r.text, append([]string{"new", "-folder", f}, r.args...)...)
		if code != exitProblem {
			t.Errorf("%s: exit %d, want %d (%s)", r.name, code, exitProblem, e)
		}
	}
	for _, p := range []string{"places/fe.md", "pages/Metal.md", "pages/C#.md", "pages/Broken.md", "journal/2026-02-30.md"} {
		if exists(f, p) {
			t.Errorf("%s was written by a refused new", p)
		}
	}
	// A warning (a key outside the list of its kind) does not refuse.
	if code, _, e := lifelog(t, "---\ncolour: red\n---\n", "new", "-folder", f, "pages", "Red"); code != exitOK || !strings.Contains(e, "unknown-key") {
		t.Errorf("a warning: exit %d, stderr %q", code, e)
	}
}

func TestCheckJSONListsTheProblems(t *testing.T) {
	f := folderWithWeight(t)
	write(t, f, "pages/A.md", "---\nkey: [a\n---\n")
	code, out, _ := lifelog(t, "", "check", "-json", f)
	if code != exitProblem {
		t.Fatalf("exit %d, want %d", code, exitProblem)
	}
	var got []problemJSON
	if err := json.Unmarshal([]byte(out), &got); err != nil {
		t.Fatal(err)
	}
	if len(got) != 1 || got[0].Class != "error" || got[0].Rule != "frontmatter" || got[0].Path != "pages/A.md" {
		t.Errorf("problems: %+v", got)
	}
	write(t, f, "pages/A.md", "fine\n")
	if code, out, _ := lifelog(t, "", "check", "-json", f); code != exitOK || strings.TrimSpace(out) != "[]" {
		t.Errorf("a clean folder: exit %d, %q", code, out)
	}
}
