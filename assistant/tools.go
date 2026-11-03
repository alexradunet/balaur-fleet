package main

// The tools the language model can call. Each returns a small JSON-able value
// that goes back to the model, which then phrases the spoken answer.

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"slices"
	"sort"
	"strings"
	"sync"
	"time"
)

// turn carries per-request context into tools.
type turn struct {
	lang  string // "ro" or "en": what the user spoke, for things said later (timers, reminders)
	typed bool
}

type Tool struct {
	Name   string
	Desc   string
	Params map[string]any
	Run    func(ctx context.Context, t *turn, args json.RawMessage) (any, error)
}

func object(props map[string]any, required ...string) map[string]any {
	o := map[string]any{"type": "object", "properties": props}
	if len(required) > 0 {
		o["required"] = required
	}
	return o
}

func str(desc string) map[string]any { return map[string]any{"type": "string", "description": desc} }
func integer(desc string) map[string]any {
	return map[string]any{"type": "integer", "description": desc}
}
func strList(desc string) map[string]any {
	return map[string]any{"type": "array", "items": map[string]any{"type": "string"}, "description": desc}
}

func decode[T any](args json.RawMessage) (T, error) {
	var v T
	if len(args) == 0 || string(args) == "" {
		return v, nil
	}
	if err := json.Unmarshal(args, &v); err != nil {
		return v, fmt.Errorf("bad arguments: %w", err)
	}
	return v, nil
}

func (a *Assistant) buildTools() []Tool {
	ts := []Tool{
		{
			Name: "set_timer",
			Desc: "Start a countdown timer. It rings and speaks the label when it ends.",
			Params: object(map[string]any{
				"duration_seconds": integer("Length of the timer in seconds"),
				"label":            str("Short name for the timer in the user's language, e.g. 'paste' or 'pasta'"),
			}, "duration_seconds"),
			Run: func(ctx context.Context, t *turn, raw json.RawMessage) (any, error) {
				p, err := decode[struct {
					Seconds int    `json:"duration_seconds"`
					Label   string `json:"label"`
				}](raw)
				if err != nil {
					return nil, err
				}
				if p.Seconds <= 0 || p.Seconds > 24*3600 {
					return nil, errors.New("duration must be between 1 second and 24 hours")
				}
				tm := a.timers.add(time.Duration(p.Seconds)*time.Second, p.Label, t.lang)
				return map[string]any{"id": tm.ID, "label": tm.Label, "ends_at": tm.Ends.Format("15:04:05")}, nil
			},
		},
		{
			Name:   "list_timers",
			Desc:   "List running timers with the seconds remaining.",
			Params: object(map[string]any{}),
			Run: func(ctx context.Context, t *turn, raw json.RawMessage) (any, error) {
				return a.timers.list(), nil
			},
		},
		{
			Name: "cancel_timer",
			Desc: "Cancel a timer by id or label, or all timers.",
			Params: object(map[string]any{
				"id":    str("Timer id"),
				"label": str("Timer label"),
				"all":   map[string]any{"type": "boolean", "description": "Cancel every timer"},
			}),
			Run: func(ctx context.Context, t *turn, raw json.RawMessage) (any, error) {
				p, err := decode[struct {
					ID, Label string
					All       bool
				}](raw)
				if err != nil {
					return nil, err
				}
				n := a.timers.cancel(p.ID, p.Label, p.All)
				return map[string]any{"cancelled": n}, nil
			},
		},
		{
			Name: "add_reminder",
			Desc: "Set a reminder that is spoken aloud at a given local date and time, optionally repeating.",
			Params: object(map[string]any{
				"text":   str("What to remind about, phrased to be spoken, in the user's language"),
				"at":     str("Local date and time, format 'YYYY-MM-DD HH:MM'"),
				"repeat": map[string]any{"type": "string", "enum": []string{"none", "daily", "weekly"}},
			}, "text", "at"),
			Run: func(ctx context.Context, t *turn, raw json.RawMessage) (any, error) {
				p, err := decode[struct{ Text, At, Repeat string }](raw)
				if err != nil {
					return nil, err
				}
				at, err := time.ParseInLocation("2006-01-02 15:04", strings.Replace(strings.TrimSpace(p.At), "T", " ", 1), time.Local)
				if err != nil {
					return nil, errors.New("'at' must be 'YYYY-MM-DD HH:MM'")
				}
				if p.Repeat == "none" {
					p.Repeat = ""
				}
				if !at.After(time.Now()) && p.Repeat == "" {
					return nil, errors.New("that time is in the past")
				}
				r, err := a.store.AddReminder(Reminder{Text: p.Text, At: at, Repeat: p.Repeat, Lang: t.lang})
				if err != nil {
					return nil, err
				}
				return map[string]any{"id": r.ID, "at": r.At.Format("Mon 2006-01-02 15:04"), "repeat": r.Repeat}, nil
			},
		},
		{
			Name:   "list_reminders",
			Desc:   "List upcoming reminders.",
			Params: object(map[string]any{}),
			Run: func(ctx context.Context, t *turn, raw json.RawMessage) (any, error) {
				var out []map[string]any
				for _, r := range a.store.Reminders() {
					out = append(out, map[string]any{"id": r.ID, "text": r.Text, "at": r.At.Local().Format("Mon 2006-01-02 15:04"), "repeat": r.Repeat})
				}
				return out, nil
			},
		},
		{
			Name:   "delete_reminder",
			Desc:   "Delete a reminder by id (get ids from list_reminders).",
			Params: object(map[string]any{"id": str("Reminder id")}, "id"),
			Run: func(ctx context.Context, t *turn, raw json.RawMessage) (any, error) {
				p, err := decode[struct{ ID string }](raw)
				if err != nil {
					return nil, err
				}
				ok, err := a.store.DeleteReminder(p.ID)
				return map[string]any{"deleted": ok}, err
			},
		},
		{
			Name: "remember",
			Desc: "Save a lasting fact or preference about the user or household (names, birthdays, diet, routines, preferences) so you know it in future conversations.",
			Params: object(map[string]any{
				"fact": str("The fact as one short self-contained sentence, e.g. 'Ana is allergic to nuts.'"),
			}, "fact"),
			Run: func(ctx context.Context, t *turn, raw json.RawMessage) (any, error) {
				p, err := decode[struct{ Fact string }](raw)
				if err != nil {
					return nil, err
				}
				if strings.TrimSpace(p.Fact) == "" {
					return nil, errors.New("empty fact")
				}
				m, err := a.store.Remember(p.Fact)
				return map[string]any{"id": m.ID, "saved": m.Fact}, err
			},
		},
		{
			Name:   "forget",
			Desc:   "Delete a remembered fact by its id (shown in brackets in your memory list).",
			Params: object(map[string]any{"id": str("Memory id")}, "id"),
			Run: func(ctx context.Context, t *turn, raw json.RawMessage) (any, error) {
				p, err := decode[struct{ ID string }](raw)
				if err != nil {
					return nil, err
				}
				ok, err := a.store.Forget(p.ID)
				return map[string]any{"deleted": ok}, err
			},
		},
		{
			Name: "house_list_add",
			Desc: "Add items to a house list: 'shopping' (groceries, things to buy), 'tasks' (chores, things to do around the house), or another named list.",
			Params: object(map[string]any{
				"list":     str("List name: 'shopping', 'tasks', or another name the user gives"),
				"items":    strList("Items to add, each short, in the user's language"),
				"assignee": str("Optional: who should do it (tasks)"),
				"due":      str("Optional: when it is due, 'YYYY-MM-DD'"),
			}, "list", "items"),
			Run: func(ctx context.Context, t *turn, raw json.RawMessage) (any, error) {
				p, err := decode[struct {
					List     string
					Items    []string
					Assignee string
					Due      string
				}](raw)
				if err != nil {
					return nil, err
				}
				added, err := a.store.AddItems(p.List, p.Items, p.Assignee, p.Due)
				if err != nil {
					return nil, err
				}
				return map[string]any{"list": canonicalList(p.List), "added": itemTexts(added), "open_items": len(openItems(a.store.Lists()[canonicalList(p.List)]))}, nil
			},
		},
		{
			Name: "house_list_remove",
			Desc: "Remove items from a house list (bought, done, or no longer needed).",
			Params: object(map[string]any{
				"list":  str("List name"),
				"items": strList("Items to remove (approximate text is fine)"),
			}, "list", "items"),
			Run: func(ctx context.Context, t *turn, raw json.RawMessage) (any, error) {
				p, err := decode[struct {
					List  string
					Items []string
				}](raw)
				if err != nil {
					return nil, err
				}
				removed, missing, err := a.store.RemoveItems(p.List, p.Items)
				return map[string]any{"removed": itemTexts(removed), "not_found": missing}, err
			},
		},
		{
			Name:   "house_list_show",
			Desc:   "Show what is on a house list, or on all lists when no name is given.",
			Params: object(map[string]any{"list": str("List name (optional)")}),
			Run: func(ctx context.Context, t *turn, raw json.RawMessage) (any, error) {
				p, err := decode[struct{ List string }](raw)
				if err != nil {
					return nil, err
				}
				lists := a.store.Lists()
				out := map[string]any{}
				for _, name := range a.store.ListNames() {
					if p.List != "" && name != canonicalList(p.List) {
						continue
					}
					var items []map[string]string
					for _, it := range openItems(lists[name]) {
						m := map[string]string{"text": it.Text}
						if it.Assignee != "" {
							m["assignee"] = it.Assignee
						}
						if it.Due != "" {
							m["due"] = it.Due
						}
						items = append(items, m)
					}
					out[name] = items
				}
				return out, nil
			},
		},
		{
			Name: "set_volume",
			Desc: "Change the speaker volume, absolutely (percent) or relatively (change).",
			Params: object(map[string]any{
				"percent": integer("Volume 0-100"),
				"change":  integer("Relative change in percent points, e.g. 10 or -10"),
			}),
			Run: func(ctx context.Context, t *turn, raw json.RawMessage) (any, error) {
				p, err := decode[struct {
					Percent *int
					Change  int
				}](raw)
				if err != nil {
					return nil, err
				}
				v := a.Volume() + p.Change
				if p.Percent != nil {
					v = *p.Percent
				}
				if err := a.SetVolume(ctx, v); err != nil {
					return nil, err
				}
				return map[string]any{"volume": a.Volume()}, nil
			},
		},
		{
			Name: "weather",
			Desc: "Current weather and daily forecast. Defaults to the home location.",
			Params: object(map[string]any{
				"place": str("Optional city name if not home"),
				"days":  integer("Days of forecast, 1-7 (default 2: today and tomorrow)"),
			}),
			Run: func(ctx context.Context, t *turn, raw json.RawMessage) (any, error) {
				p, err := decode[struct {
					Place string
					Days  int
				}](raw)
				if err != nil {
					return nil, err
				}
				return a.web.weather(ctx, p.Place, p.Days)
			},
		},
		{
			Name:   "news",
			Desc:   "Latest news headlines from the configured feeds, optionally filtered by topic or language.",
			Params: object(map[string]any{"topic": str("Optional keyword"), "language": map[string]any{"type": "string", "enum": []string{"ro", "en"}}}),
			Run: func(ctx context.Context, t *turn, raw json.RawMessage) (any, error) {
				p, err := decode[struct{ Topic, Language string }](raw)
				if err != nil {
					return nil, err
				}
				return a.web.news(ctx, p.Topic, p.Language)
			},
		},
	}
	if a.cfg.Search.Model != "" {
		ts = append(ts, Tool{
			Name:   "web_search",
			Desc:   "Search the web for current facts, prices, opening hours, sports results, etc. Returns the top results with snippets.",
			Params: object(map[string]any{"query": str("Search query")}, "query"),
			Run: func(ctx context.Context, t *turn, raw json.RawMessage) (any, error) {
				p, err := decode[struct{ Query string }](raw)
				if err != nil {
					return nil, err
				}
				return a.mistral.WebSearch(ctx, a.cfg.Search.Model, p.Query)
			},
		})
	}
	return ts
}

func itemTexts(items []HouseItem) []string {
	out := make([]string, 0, len(items))
	for _, it := range items {
		out = append(out, it.Text)
	}
	return out
}

func openItems(items []HouseItem) []HouseItem {
	return slices.DeleteFunc(slices.Clone(items), func(it HouseItem) bool { return it.Done })
}

func toolSpecs(ts []Tool) []toolSpec {
	out := make([]toolSpec, len(ts))
	for i, t := range ts {
		out[i].Type = "function"
		out[i].Function.Name = t.Name
		out[i].Function.Description = t.Desc
		out[i].Function.Parameters = t.Params
	}
	return out
}

// ---- timers (in memory: a restart drops them) ----

type Timer struct {
	ID    string    `json:"id"`
	Label string    `json:"label"`
	Ends  time.Time `json:"ends"`
	Lang  string    `json:"-"`
	t     *time.Timer
}

type timers struct {
	mu   sync.Mutex
	all  map[string]*Timer
	fire func(*Timer)
}

func newTimers(fire func(*Timer)) *timers {
	return &timers{all: map[string]*Timer{}, fire: fire}
}

func (ts *timers) add(d time.Duration, label, lang string) *Timer {
	ts.mu.Lock()
	defer ts.mu.Unlock()
	tm := &Timer{ID: newID(), Label: label, Ends: time.Now().Add(d), Lang: lang}
	tm.t = time.AfterFunc(d, func() {
		ts.mu.Lock()
		delete(ts.all, tm.ID)
		ts.mu.Unlock()
		ts.fire(tm)
	})
	ts.all[tm.ID] = tm
	return tm
}

func (ts *timers) list() []map[string]any {
	ts.mu.Lock()
	defer ts.mu.Unlock()
	var all []*Timer
	for _, t := range ts.all {
		all = append(all, t)
	}
	sort.Slice(all, func(i, j int) bool { return all[i].Ends.Before(all[j].Ends) })
	out := []map[string]any{}
	for _, t := range all {
		out = append(out, map[string]any{"id": t.ID, "label": t.Label, "ends": t.Ends, "remaining_seconds": int(time.Until(t.Ends).Round(time.Second).Seconds())})
	}
	return out
}

func (ts *timers) cancel(id, label string, all bool) int {
	ts.mu.Lock()
	defer ts.mu.Unlock()
	n := 0
	for k, t := range ts.all {
		if all || (id != "" && t.ID == id) || (label != "" && fold(t.Label) == fold(label)) {
			t.t.Stop()
			delete(ts.all, k)
			n++
		}
	}
	return n
}
