package check

import (
	"fmt"
	"math/rand"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// TestScale is spike S5 of plan 001: a synthetic fifty-year tree on real
// files, and the time of a whole-tree check. It runs only when asked:
//
//	LIFELOG_SCALE=1 go test ./check -run TestScale -v
//
// The tree: a day page for each of 50 years (about 18 000), 5 000 pages,
// 50 metrics with one CSV per year for each of 3 machines, and one reading a
// day for each metric, spread over the machines (about 900 000 lines).
func TestScale(t *testing.T) {
	if os.Getenv("LIFELOG_SCALE") == "" {
		t.Skip("set LIFELOG_SCALE=1 to run spike S5")
	}
	root := t.TempDir()
	rng := rand.New(rand.NewSource(1)) // a fixed seed: the same tree each run
	write := func(rel, text string) {
		p := filepath.Join(root, filepath.FromSlash(rel))
		if err := os.MkdirAll(filepath.Dir(p), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(p, []byte(text), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	const years, pages, metrics = 50, 5000, 50
	machines := []string{"laptop", "pc", "tablet"}
	start := time.Date(1977, 1, 1, 0, 0, 0, 0, time.UTC)
	end := start.AddDate(years, 0, 0)

	began := time.Now()
	for i := 0; i < pages; i++ {
		write(fmt.Sprintf("pages/Page %04d.md", i),
			fmt.Sprintf("---\naliases:\n  - P%04d\n---\nA page about [[Page %04d]] and [[Page %04d]].\n", i, rng.Intn(pages), rng.Intn(pages)))
	}
	days := 0
	for d := start; d.Before(end); d = d.AddDate(0, 0, 1) {
		write("journal/"+d.Format("2006-01-02")+".md",
			fmt.Sprintf("Wrote about [[Page %04d]]. %s\n", rng.Intn(pages), strings.Repeat("A line of the day. ", 20)))
		days++
	}
	lines := 0
	for m := 0; m < metrics; m++ {
		name := fmt.Sprintf("metric%02d", m)
		write("metrics/"+name+".md", "---\nunit: u\nmin: 0\nmax: 1000\n---\n")
		files := map[string]*strings.Builder{}
		for d := start; d.Before(end); d = d.AddDate(0, 0, 1) {
			rel := fmt.Sprintf("metrics/%s/%d.%s.csv", name, d.Year(), machines[rng.Intn(len(machines))])
			b := files[rel]
			if b == nil {
				b = &strings.Builder{}
				b.WriteString(csvHeader + "\n")
				files[rel] = b
			}
			fmt.Fprintf(b, "%s,%s,%.1f,manual\n", d.Format("2006-01-02"), d.Add(7*time.Hour).Format(time.RFC3339), 50+rng.Float64()*50)
			lines++
		}
		for rel, b := range files {
			write(rel, b.String())
		}
	}
	t.Logf("tree: %d day pages, %d pages, %d metrics, %d reading lines; written in %v", days, pages, metrics, lines, time.Since(began).Round(time.Millisecond))

	for run := 1; run <= 3; run++ {
		began = time.Now()
		problems, err := Tree(os.DirFS(root))
		if err != nil {
			t.Fatal(err)
		}
		t.Logf("check %d: %v, %d problems", run, time.Since(began).Round(time.Millisecond), len(problems))
		if len(problems) != 0 {
			t.Fatalf("the synthetic tree should be clean:\n%s", describe(problems[:min(len(problems), 5)]))
		}
	}

	// The history rules: the tree in git as seen, five changes as live.
	g := &gitRepo{t, root}
	began = time.Now()
	g.git("init", "-q", "-b", "live")
	g.git("update-ref", "refs/heads/seen", g.commit(nil))
	t.Logf("git: the first commit of the tree in %v", time.Since(began).Round(time.Millisecond))
	g.commit(map[string]string{
		"pages/Page 0001.md":               "",
		"pages/Page 0002.md":               "<empty>",
		"metrics/metric00/2000.pc.csv":     "",
		"journal/2026-11-14.md":            "A new day.\n",
		"metrics/metric01/2026.laptop.csv": csvHeader + "\n2026-11-14,,70,manual\n",
	})
	for run := 1; run <= 3; run++ {
		began = time.Now()
		problems, err := History(t.Context(), filepath.Join(root, ".git"), "seen", "live")
		if err != nil {
			t.Fatal(err)
		}
		t.Logf("history %d: %v, %d problems", run, time.Since(began).Round(time.Millisecond), len(problems))
		if run == 1 {
			t.Logf("%s", describe(problems[:min(len(problems), 8)]))
		}
	}
}
