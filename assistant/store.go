package main

// Everything the assistant keeps lives in small JSON files in the state
// directory, each rewritten atomically (temp file + rename) on change.

import (
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io/fs"
	"os"
	"path/filepath"
	"slices"
	"sort"
	"strings"
	"sync"
	"time"
)

type Memory struct {
	ID    string    `json:"id"`
	Fact  string    `json:"fact"`
	Added time.Time `json:"added"`
}

type HouseItem struct {
	ID       string    `json:"id"`
	Text     string    `json:"text"`
	Done     bool      `json:"done"`
	Assignee string    `json:"assignee,omitempty"`
	Due      string    `json:"due,omitempty"`
	Added    time.Time `json:"added"`
}

type Reminder struct {
	ID     string    `json:"id"`
	Text   string    `json:"text"`
	At     time.Time `json:"at"`
	Repeat string    `json:"repeat,omitempty"` // "", "daily", "weekly"
	Lang   string    `json:"lang,omitempty"`
}

// The two lists every house has; more are created on demand.
var defaultLists = []string{"shopping", "tasks"}

var listAliases = map[string]string{
	"shopping": "shopping", "shop": "shopping", "groceries": "shopping", "grocery": "shopping",
	"cumparaturi": "shopping", "lista de cumparaturi": "shopping", "shopping list": "shopping",
	"tasks": "tasks", "task": "tasks", "todo": "tasks", "to-do": "tasks", "to do": "tasks", "chores": "tasks",
	"sarcini": "tasks", "treburi": "tasks", "de facut": "tasks", "lucruri de facut": "tasks", "task list": "tasks",
}

func canonicalList(name string) string {
	n := fold(name)
	if n == "" {
		return "shopping"
	}
	if c, ok := listAliases[n]; ok {
		return c
	}
	n = strings.TrimPrefix(n, "lista ")
	n = strings.TrimSuffix(n, " list")
	if c, ok := listAliases[n]; ok {
		return c
	}
	return n
}

type Store struct {
	dir string

	mu        sync.Mutex
	memories  []Memory
	lists     map[string][]HouseItem
	reminders []Reminder
	onChange  func()
}

func newID() string {
	b := make([]byte, 4)
	_, _ = rand.Read(b)
	return hex.EncodeToString(b)
}

func openStore(dir string) (*Store, error) {
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return nil, err
	}
	s := &Store{dir: dir, lists: map[string][]HouseItem{}}
	for _, f := range []struct {
		name string
		v    any
	}{{"memory.json", &s.memories}, {"house.json", &s.lists}, {"reminders.json", &s.reminders}} {
		b, err := os.ReadFile(filepath.Join(dir, f.name))
		if errors.Is(err, fs.ErrNotExist) {
			continue
		}
		if err != nil {
			return nil, err
		}
		if err := json.Unmarshal(b, f.v); err != nil {
			return nil, err
		}
	}
	if s.lists == nil {
		s.lists = map[string][]HouseItem{}
	}
	for _, l := range defaultLists {
		if _, ok := s.lists[l]; !ok {
			s.lists[l] = []HouseItem{}
		}
	}
	return s, nil
}

func writeAtomic(path string, v any) error {
	b, err := json.MarshalIndent(v, "", "  ")
	if err != nil {
		return err
	}
	tmp, err := os.CreateTemp(filepath.Dir(path), ".tmp-*")
	if err != nil {
		return err
	}
	defer os.Remove(tmp.Name())
	if _, err := tmp.Write(b); err != nil {
		tmp.Close()
		return err
	}
	if err := tmp.Sync(); err != nil {
		tmp.Close()
		return err
	}
	if err := tmp.Close(); err != nil {
		return err
	}
	return os.Rename(tmp.Name(), path)
}

// save must be called with s.mu held.
func (s *Store) save(name string) error {
	var v any
	switch name {
	case "memory.json":
		v = s.memories
	case "house.json":
		v = s.lists
	case "reminders.json":
		v = s.reminders
	}
	err := writeAtomic(filepath.Join(s.dir, name), v)
	if s.onChange != nil {
		go s.onChange()
	}
	return err
}

// ---- memory ----

func (s *Store) Memories() []Memory {
	s.mu.Lock()
	defer s.mu.Unlock()
	return slices.Clone(s.memories)
}

func (s *Store) Remember(fact string) (Memory, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	for _, m := range s.memories {
		if fold(m.Fact) == fold(fact) {
			return m, nil
		}
	}
	m := Memory{ID: newID(), Fact: strings.TrimSpace(fact), Added: time.Now()}
	s.memories = append(s.memories, m)
	return m, s.save("memory.json")
}

func (s *Store) Forget(id string) (bool, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	n := len(s.memories)
	s.memories = slices.DeleteFunc(s.memories, func(m Memory) bool { return m.ID == id })
	if len(s.memories) == n {
		return false, nil
	}
	return true, s.save("memory.json")
}

// ---- house lists ----

func (s *Store) Lists() map[string][]HouseItem {
	s.mu.Lock()
	defer s.mu.Unlock()
	out := make(map[string][]HouseItem, len(s.lists))
	for k, v := range s.lists {
		out[k] = slices.Clone(v)
	}
	return out
}

// ListNames returns the default lists first, then the rest alphabetically.
func (s *Store) ListNames() []string {
	s.mu.Lock()
	defer s.mu.Unlock()
	var rest []string
	for k := range s.lists {
		if !slices.Contains(defaultLists, k) {
			rest = append(rest, k)
		}
	}
	sort.Strings(rest)
	return append(slices.Clone(defaultLists), rest...)
}

func (s *Store) AddItems(list string, texts []string, assignee, due string) ([]HouseItem, error) {
	list = canonicalList(list)
	s.mu.Lock()
	defer s.mu.Unlock()
	var added []HouseItem
	for _, t := range texts {
		t = strings.TrimSpace(t)
		if t == "" {
			continue
		}
		// Already there and not done: don't add it twice.
		if i := slices.IndexFunc(s.lists[list], func(it HouseItem) bool { return !it.Done && fold(it.Text) == fold(t) }); i >= 0 {
			continue
		}
		it := HouseItem{ID: newID(), Text: t, Assignee: assignee, Due: due, Added: time.Now()}
		s.lists[list] = append(s.lists[list], it)
		added = append(added, it)
	}
	if len(added) == 0 {
		return nil, nil
	}
	return added, s.save("house.json")
}

// findItem matches by ID, then exact text, then substring (accents and case ignored).
func findItem(items []HouseItem, q string) int {
	if i := slices.IndexFunc(items, func(it HouseItem) bool { return it.ID == q }); i >= 0 {
		return i
	}
	fq := fold(q)
	if i := slices.IndexFunc(items, func(it HouseItem) bool { return fold(it.Text) == fq }); i >= 0 {
		return i
	}
	return slices.IndexFunc(items, func(it HouseItem) bool {
		ft := fold(it.Text)
		return fq != "" && (strings.Contains(ft, fq) || strings.Contains(fq, ft))
	})
}

// RemoveItems deletes matching items; it returns the ones removed and the queries that matched nothing.
func (s *Store) RemoveItems(list string, queries []string) (removed []HouseItem, missing []string, err error) {
	list = canonicalList(list)
	s.mu.Lock()
	defer s.mu.Unlock()
	for _, q := range queries {
		i := findItem(s.lists[list], q)
		if i < 0 {
			missing = append(missing, q)
			continue
		}
		removed = append(removed, s.lists[list][i])
		s.lists[list] = slices.Delete(s.lists[list], i, i+1)
	}
	if len(removed) > 0 {
		err = s.save("house.json")
	}
	return removed, missing, err
}

func (s *Store) SetDone(list, id string, done bool) (bool, error) {
	list = canonicalList(list)
	s.mu.Lock()
	defer s.mu.Unlock()
	i := findItem(s.lists[list], id)
	if i < 0 {
		return false, nil
	}
	s.lists[list][i].Done = done
	return true, s.save("house.json")
}

// ClearDone removes ticked items; an empty non-default list disappears.
func (s *Store) ClearDone(list string) error {
	list = canonicalList(list)
	s.mu.Lock()
	defer s.mu.Unlock()
	s.lists[list] = slices.DeleteFunc(s.lists[list], func(it HouseItem) bool { return it.Done })
	if len(s.lists[list]) == 0 && !slices.Contains(defaultLists, list) {
		delete(s.lists, list)
	}
	return s.save("house.json")
}

// ---- reminders ----

func (s *Store) Reminders() []Reminder {
	s.mu.Lock()
	defer s.mu.Unlock()
	out := slices.Clone(s.reminders)
	sort.Slice(out, func(i, j int) bool { return out[i].At.Before(out[j].At) })
	return out
}

func (s *Store) AddReminder(r Reminder) (Reminder, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	r.ID = newID()
	s.reminders = append(s.reminders, r)
	return r, s.save("reminders.json")
}

func (s *Store) DeleteReminder(id string) (bool, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	n := len(s.reminders)
	s.reminders = slices.DeleteFunc(s.reminders, func(r Reminder) bool { return r.ID == id })
	if len(s.reminders) == n {
		return false, nil
	}
	return true, s.save("reminders.json")
}

// TakeDue returns reminders whose time has come; repeating ones move to
// their next time, one-off ones are removed.
func (s *Store) TakeDue(now time.Time) []Reminder {
	s.mu.Lock()
	defer s.mu.Unlock()
	var due []Reminder
	keep := s.reminders[:0]
	for _, r := range s.reminders {
		if r.At.After(now) {
			keep = append(keep, r)
			continue
		}
		due = append(due, r)
		days := map[string]int{"daily": 1, "weekly": 7}[r.Repeat]
		if days > 0 {
			// In local time, so a daily 08:00 stays 08:00 across DST changes.
			for !r.At.After(now) {
				r.At = r.At.In(time.Local).AddDate(0, 0, days)
			}
			keep = append(keep, r)
		}
	}
	s.reminders = keep
	if len(due) > 0 {
		_ = s.save("reminders.json")
	}
	return due
}
