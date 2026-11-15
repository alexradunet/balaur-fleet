package check

import (
	"errors"
	"io/fs"
	"path"
	"regexp"
	"sort"
	"strings"

	"golang.org/x/text/cases"
)

// Index is what a reader of the folder needs to draw it: each page with its
// title, its properties and where each of its links leads. The rules stay in
// Tree; Index only reads. A program in another language (the web app) reads
// it as JSON, so that the title key and the link grammar have one home.
type Index struct {
	Pages   []Page   `json:"pages"`
	Metrics []Metric `json:"metrics"`
}

// Page is one page of the content folders.
type Page struct {
	Path    string              `json:"path"`
	Kind    string              `json:"kind"` // its top folder
	Title   string              `json:"title"`
	Aliases []string            `json:"aliases"`
	Props   map[string][]string `json:"props"`
	// Links maps the target of each link in the page (the text between [[ and
	// the first | # ^ or ]]) to the path of the page it resolves to, or to ""
	// when no page holds that title.
	Links map[string]string `json:"links"`
	// Problem is set when the frontmatter does not parse; Props is then empty.
	Problem string `json:"problem,omitempty"`
}

// Metric is a metric's page, read as its properties.
type Metric struct {
	Name  string   `json:"name"`
	Unit  string   `json:"unit"`
	Min   *float64 `json:"min"`
	Max   *float64 `json:"max"`
	Daily bool     `json:"daily"`
}

// linkTarget is the target of a wikilink: the text after [[ up to | # ^ or ]].
var linkTarget = regexp.MustCompile(`\[\[([^\[\]|#^\n]+)`)

// ReadIndex reads the pages of the content folders of fsys. It skips what
// Tree reports as not a page (a Syncthing temp file, a conflict copy, a file
// outside the layout, a file that is not UTF-8).
func ReadIndex(fsys fs.FS) (Index, error) {
	fold := cases.Fold()
	idx := Index{Pages: []Page{}, Metrics: []Metric{}}
	titles := map[string]string{} // title key -> the first path that holds it
	own := func(title, p string) {
		if k := fold.String(title); titles[k] == "" {
			titles[k] = p
		}
	}
	for _, top := range ContentFolders {
		if _, err := fs.Stat(fsys, top); errors.Is(err, fs.ErrNotExist) {
			continue
		} else if err != nil {
			return Index{}, err
		}
		err := fs.WalkDir(fsys, top, func(p string, d fs.DirEntry, err error) error {
			if err != nil {
				return err
			}
			name := d.Name()
			if isSyncthingTemp(name) || strings.Contains(name, ".sync-conflict-") {
				if d.IsDir() {
					return fs.SkipDir
				}
				return nil
			}
			if d.IsDir() || !isIndexedPage(top, p, name) {
				return nil
			}
			data, err := fs.ReadFile(fsys, p)
			if err != nil {
				return err
			}
			s := strings.ReplaceAll(string(data), "\r\n", "\n")
			pg := Page{
				Path:    p,
				Kind:    top,
				Title:   strings.TrimSuffix(name, ".md"),
				Aliases: []string{},
				Props:   map[string][]string{},
				Links:   map[string]string{},
			}
			fm, ferr := frontmatter(s)
			if ferr != nil {
				pg.Problem = ferr.msg
			}
			for k, v := range fm {
				pg.Props[k] = v.values()
			}
			if a, ok := fm["aliases"]; ok {
				pg.Aliases = a.values()
			}
			for _, m := range linkTarget.FindAllStringSubmatch(s, -1) {
				pg.Links[m[1]] = ""
			}
			own(pg.Title, p)
			for _, a := range pg.Aliases {
				own(a, p)
			}
			if top == "metrics" {
				idx.Metrics = append(idx.Metrics, metricOf(pg.Title, fm))
			}
			idx.Pages = append(idx.Pages, pg)
			return nil
		})
		if err != nil {
			return Index{}, err
		}
	}
	for i := range idx.Pages {
		for target := range idx.Pages[i].Links {
			idx.Pages[i].Links[target] = titles[fold.String(target)]
		}
	}
	sort.Slice(idx.Pages, func(i, j int) bool { return idx.Pages[i].Path < idx.Pages[j].Path })
	sort.Slice(idx.Metrics, func(i, j int) bool { return idx.Metrics[i].Name < idx.Metrics[j].Name })
	return idx, nil
}

// isIndexedPage reports whether p is a page in the layout of design §2.
func isIndexedPage(top, p, name string) bool {
	if !strings.HasSuffix(name, ".md") {
		return false
	}
	depth := strings.Count(p, "/")
	switch top {
	case "journal":
		m := dayPageName.FindStringSubmatch(name)
		return depth == 1 && m != nil && IsDay(m[1])
	case "pages", "people", "places":
		return true
	case "metrics":
		return depth == 1
	case "files":
		return depth == 2 && yearName.MatchString(path.Base(path.Dir(p)))
	}
	return false
}

func metricOf(name string, fm map[string]value) Metric {
	m := Metric{Name: name, Unit: fm["unit"].scalar, Daily: fm["daily"].scalar == "true"}
	for key, bound := range map[string]**float64{"min": &m.Min, "max": &m.Max} {
		if f, ok := ParseNumber(fm[key].scalar); ok {
			*bound = &f
		}
	}
	return m
}
