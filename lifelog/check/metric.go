package check

import (
	"fmt"

	"golang.org/x/text/cases"
)

// TitleKey is the key under which a title or an alias is unique: the title
// after Unicode case folding. `Iron` and `iron` are one key.
func TitleKey(title string) string {
	return cases.Fold().String(title)
}

// IsSource reports whether s is a source of a reading.
func IsSource(s string) bool {
	return sourceText.MatchString(s)
}

// Range is a metric's range, from the frontmatter of its page. A nil bound
// is open.
type Range struct {
	Min, Max *float64
}

// Holds reports whether v is inside the range.
func (r Range) Holds(v float64) bool {
	return (r.Min == nil || v >= *r.Min) && (r.Max == nil || v <= *r.Max)
}

// MetricRange reads the range from the text of a metric's page.
func MetricRange(page string) (Range, error) {
	fm, err := frontmatter(page)
	if err != nil {
		return Range{}, fmt.Errorf("the frontmatter: %s", err.msg)
	}
	var r Range
	for key, bound := range map[string]**float64{"min": &r.Min, "max": &r.Max} {
		if s := fm[key].scalar; s != "" {
			f, ok := ParseNumber(s)
			if !ok {
				return Range{}, fmt.Errorf("%s is not a number: %q", key, s)
			}
			*bound = &f
		}
	}
	return r, nil
}
