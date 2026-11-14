package main

import (
	"errors"
	"flag"
	"fmt"
	"io"
	"io/fs"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"time"

	"lifelog/check"
)

var metricText = regexp.MustCompile(`^[^/\\#^\[\]|.][^/\\#^\[\]|]*$`)

// cmdAdd appends one reading to this machine's CSV of a metric. It refuses a
// reading that the checker would refuse, and changes nothing then.
func cmdAdd(args []string, stdout, stderr io.Writer) int {
	flags := flag.NewFlagSet("add", flag.ContinueOnError)
	flags.SetOutput(stderr)
	folder := flags.String("folder", defaultFolder(), "the life folder")
	day := flags.String("day", "", "the day of the reading, YYYY-MM-DD (default: today, or the day of -at)")
	at := flags.String("at", "", "the instant of the reading, with its offset (default: now, unless -day is given)")
	source := flags.String("source", "manual", "where the reading comes from")
	machine := flags.String("machine", "", "this machine's name in the file name (default: the hostname)")
	if err := flags.Parse(args); err != nil {
		return exitUsage
	}
	if flags.NArg() != 2 {
		fmt.Fprintln(stderr, "usage: lifelog add [-day DAY] [-at INSTANT] [-source SOURCE] [-machine NAME] METRIC VALUE")
		return exitUsage
	}
	refuse := func(format string, a ...any) int {
		fmt.Fprintf(stderr, "lifelog add: "+format+"\n", a...)
		return exitProblem
	}
	metric, value := flags.Arg(0), flags.Arg(1)

	if *day == "" && *at == "" {
		*at = time.Now().Truncate(time.Second).Format(time.RFC3339)
	}
	if *at != "" && !check.IsInstant(*at) {
		return refuse("%q is not an instant with its offset, such as 2026-11-14T07:02:00+02:00", *at)
	}
	if *day == "" {
		*day = (*at)[:10] // the day in the instant's own offset
	}
	if !check.IsDay(*day) {
		return refuse("%q is not a day (YYYY-MM-DD)", *day)
	}
	if !check.IsSource(*source) {
		return refuse("%q is not a source (a-z, 0-9 and _ : . -)", *source)
	}
	if *machine == "" {
		m, err := machineName()
		if err != nil {
			return refuse("%v", err)
		}
		*machine = m
	}
	if !machineText.MatchString(*machine) {
		return refuse("%q is not a machine name (a-z, 0-9, -)", *machine)
	}
	if !metricText.MatchString(metric) {
		return refuse("%q is not a metric name", metric)
	}
	page, err := os.ReadFile(filepath.Join(*folder, "metrics", metric+".md"))
	if errors.Is(err, fs.ErrNotExist) {
		return refuse("the metric %q has no page metrics/%s.md; create it with its unit, min and max first", metric, metric)
	} else if err != nil {
		fmt.Fprintf(stderr, "lifelog add: %v\n", err)
		return exitFailed
	}
	rng, err := check.MetricRange(string(page))
	if err != nil {
		return refuse("metrics/%s.md: %v; run lifelog check", metric, err)
	}
	v, ok := check.ParseNumber(value)
	if !ok {
		return refuse("%q is not a number (write a point for decimals)", value)
	}
	if !rng.Holds(v) {
		return refuse("%s is outside the range of %s", value, metric)
	}

	rel := filepath.Join("metrics", metric, (*day)[:4]+"."+*machine+".csv")
	path := filepath.Join(*folder, rel)
	line := strings.Join([]string{*day, *at, value, *source}, ",") + "\n"
	old, err := os.ReadFile(path)
	switch {
	case errors.Is(err, fs.ErrNotExist):
		old = []byte(check.CSVHeader + "\n")
	case err != nil:
		fmt.Fprintf(stderr, "lifelog add: %v\n", err)
		return exitFailed
	case !strings.HasPrefix(strings.ReplaceAll(string(old), "\r\n", "\n"), check.CSVHeader+"\n"):
		return refuse("%s does not start with the header %s; run lifelog check", rel, check.CSVHeader)
	case len(old) > 0 && old[len(old)-1] != '\n':
		old = append(old, '\n') // a line typed by hand without its newline
	}
	if err := writeFile(path, append(old, line...)); err != nil {
		fmt.Fprintf(stderr, "lifelog add: %v\n", err)
		return exitFailed
	}
	fmt.Fprintf(stdout, "%s: %s", filepath.ToSlash(rel), line)
	return exitOK
}
