package check

import (
	"fmt"
	"strings"
)

// Report is the text of _check.md for the problems of one run. The header
// line (when the run happened, on which commit) comes from the caller.
func Report(problems []Problem, header string) string {
	var b strings.Builder
	b.WriteString("# The check of the life folder\n\n")
	b.WriteString(header + "\n")
	sections := []struct {
		class Class
		title string
		says  string
	}{
		{Error, "Errors", "The state is damaged. `checked` stays until the files are fixed; deleting this file does not clear them."},
		{Loss, "Losses", "Something may be gone. `checked` stays until you acknowledge it."},
		{Warning, "Warnings", "The state may be wrong. `checked` moves; this report stays until you acknowledge it."},
	}
	for _, s := range sections {
		var lines []string
		for _, p := range problems {
			if p.Class == s.class {
				lines = append(lines, fmt.Sprintf("- `%s` (%s): %s. Fix: %s.", p.Path, p.Rule, p.Message, p.Fix))
			}
		}
		if len(lines) == 0 {
			continue
		}
		fmt.Fprintf(&b, "\n## %s (%d)\n\n%s\n\n%s\n", s.title, len(lines), s.says, strings.Join(lines, "\n"))
	}
	b.WriteString("\nTo acknowledge the losses and the warnings, delete this file.\n")
	return b.String()
}
