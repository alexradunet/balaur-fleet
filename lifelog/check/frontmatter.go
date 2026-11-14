package check

import (
	"fmt"
	"regexp"
	"strconv"
	"strings"
)

// The frontmatter grammar is a strict subset of YAML: the form Obsidian
// writes. A block opens with a first line `---` and closes with a line `---`.
// Each line between is `key: value`, `key:` followed by list lines
// `  - value`, or blank. A value is a plain scalar, or a string in double or
// single quotes. Anything else (nesting, flow lists, anchors, comments) is
// refused with its line, because a page's properties are flat. A parser of
// full YAML would accept more than any rule here can read.

var keyText = regexp.MustCompile(`^[a-z][a-z0-9-]*$`)

type value struct {
	scalar string
	list   []string
}

// values is the list of a list value, or the scalar as a list of one.
func (v value) values() []string {
	if len(v.list) > 0 {
		return v.list
	}
	if v.scalar != "" {
		return []string{v.scalar}
	}
	return nil
}

type syntaxError struct{ msg, fix string }

func frontmatter(s string) (map[string]value, *syntaxError) {
	rest, ok := strings.CutPrefix(s, "---\n")
	if !ok {
		return nil, nil // no frontmatter
	}
	lines := strings.Split(rest, "\n")
	end := -1
	for i, l := range lines {
		if l == "---" {
			end = i
			break
		}
	}
	if end < 0 {
		return nil, &syntaxError{"the frontmatter has no closing ---", "add a line --- after the last property"}
	}
	out := map[string]value{}
	list := "" // the key whose list lines may follow
	for i, l := range lines[:end] {
		n := i + 2 // the line number in the file
		if strings.TrimSpace(l) == "" {
			continue
		}
		if item, ok := strings.CutPrefix(strings.TrimLeft(l, " "), "- "); ok {
			if list == "" {
				return nil, at(n, "a list line without its key", "put it under a key line such as aliases:")
			}
			sv, err := scalar(strings.TrimSpace(item))
			if err != nil {
				return nil, at(n, err.msg, err.fix)
			}
			v := out[list]
			v.list = append(v.list, sv)
			out[list] = v
			continue
		}
		k, raw, ok := strings.Cut(l, ":")
		if !ok || !keyText.MatchString(k) {
			return nil, at(n, fmt.Sprintf("not a property line: %q", l), "write key: value, with the key in lowercase at the start of the line")
		}
		if _, dup := out[k]; dup {
			return nil, at(n, fmt.Sprintf("the key %q appears twice", k), "keep one of the two lines")
		}
		raw = strings.TrimSpace(raw)
		if raw == "" || raw == "[]" { // "[]": an empty list, as Obsidian writes one
			out[k] = value{}
			list = k
			continue
		}
		sv, err := scalar(raw)
		if err != nil {
			return nil, at(n, err.msg, err.fix)
		}
		out[k] = value{scalar: sv}
		list = ""
	}
	return out, nil
}

func at(line int, msg, fix string) *syntaxError {
	return &syntaxError{fmt.Sprintf("line %d: %s", line, msg), fix}
}

func scalar(raw string) (string, *syntaxError) {
	if raw == "" {
		return "", nil
	}
	quote := `put the value in double quotes, such as "[[Title]]"`
	switch raw[0] {
	case '"':
		s, err := strconv.Unquote(raw)
		if err != nil || len(raw) < 2 || raw[len(raw)-1] != '"' {
			return "", &syntaxError{fmt.Sprintf("a quoted value does not close: %s", raw), "end it with \""}
		}
		return s, nil
	case '\'':
		if len(raw) < 2 || raw[len(raw)-1] != '\'' {
			return "", &syntaxError{fmt.Sprintf("a quoted value does not close: %s", raw), "end it with '"}
		}
		return strings.ReplaceAll(raw[1:len(raw)-1], "''", "'"), nil
	}
	// A plain scalar may not start with a YAML indicator, nor hold ": " or
	// " #": YAML would read a list, a map or a comment there.
	if strings.ContainsAny(raw[:1], "[]{}&*!|>%@`#,") ||
		(len(raw) > 1 && strings.ContainsAny(raw[:1], "?:-") && raw[1] == ' ') ||
		strings.Contains(raw, ": ") || strings.Contains(raw, " #") {
		return "", &syntaxError{fmt.Sprintf("YAML does not read this as one value: %s", raw), quote}
	}
	return raw, nil
}
