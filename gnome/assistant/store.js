// Everything the assistant keeps lives in small JSON files in the state
// directory (memory.json, house.json, reminders.json), each rewritten
// atomically on change. A port of assistant/store.go (the former Go service, in git history) that writes the same
// bytes: the Go and GJS versions can take turns on the same files.
//
// Times are kept as the strings read from (or written to) the files, so a
// value round-trips unchanged; they are parsed only to compare.

import GLib from 'gi://GLib';

import {fold} from './lang.js';
import {marshal, localTime, nowString, parseTime, rfc3339} from './gojson.js';

// The two lists every house has; more are created on demand.
export const defaultLists = ['shopping', 'tasks'];

const listAliases = {
    'shopping': 'shopping', 'shop': 'shopping', 'groceries': 'shopping', 'grocery': 'shopping',
    'cumparaturi': 'shopping', 'lista de cumparaturi': 'shopping', 'shopping list': 'shopping',
    'tasks': 'tasks', 'task': 'tasks', 'todo': 'tasks', 'to-do': 'tasks', 'to do': 'tasks', 'chores': 'tasks',
    'sarcini': 'tasks', 'treburi': 'tasks', 'de facut': 'tasks', 'lucruri de facut': 'tasks', 'task list': 'tasks',
};

export function canonicalList(name) {
    let n = fold(name ?? '');
    if (n === '')
        return 'shopping';
    if (Object.hasOwn(listAliases, n))
        return listAliases[n];
    if (n.startsWith('lista '))
        n = n.slice('lista '.length);
    if (n.endsWith(' list'))
        n = n.slice(0, -' list'.length);
    if (Object.hasOwn(listAliases, n))
        return listAliases[n];
    return n;
}

/** 8 random hex digits, like the Go newID. */
export function newID() {
    // The first 8 hex digits of a random (v4) UUID are all random.
    return GLib.uuid_string_random().slice(0, 8);
}

// encoding/json matches field names case-insensitively; so do we.
function field(o, name) {
    if (o === null || typeof o !== 'object')
        return undefined;
    if (name in o)
        return o[name];
    const k = Object.keys(o).find(x => x.toLowerCase() === name.toLowerCase());
    return k === undefined ? undefined : o[k];
}
const str = v => (typeof v === 'string' ? v : '');
const ZERO_TIME = '0001-01-01T00:00:00Z';
const timeStr = v => (typeof v === 'string' ? v : ZERO_TIME);

// The Go structs, field order and omitempty included.
export function memory(o) {
    return {id: str(field(o, 'id')), fact: str(field(o, 'fact')), added: timeStr(field(o, 'added'))};
}

export function houseItem(o) {
    const assignee = str(field(o, 'assignee')), due = str(field(o, 'due'));
    return {
        id: str(field(o, 'id')),
        text: str(field(o, 'text')),
        done: field(o, 'done') === true,
        assignee: assignee || undefined,
        due: due || undefined,
        added: timeStr(field(o, 'added')),
    };
}

export function reminder(o) {
    const repeat = str(field(o, 'repeat')), lang = str(field(o, 'lang'));
    return {
        id: str(field(o, 'id')),
        text: str(field(o, 'text')),
        at: timeStr(field(o, 'at')),
        repeat: repeat || undefined, // "", "daily", "weekly"
        lang: lang || undefined,
    };
}

// A JSON array as Go would decode it into a slice: null stays null (a nil slice).
const slice = (v, conv) => (Array.isArray(v) ? v.map(conv) : null);

export class Store {
    constructor(dir) {
        this.dir = dir;
        this.memories = null;
        this.lists = new Map(); // name -> items (or null, a list that was null in the file)
        this.reminders = null;
        this.onChange = null;
        GLib.mkdir_with_parents(dir, 0o700);

        const mem = this._read('memory.json');
        if (mem !== undefined)
            this.memories = slice(mem, memory);
        const house = this._read('house.json');
        if (house && typeof house === 'object' && !Array.isArray(house)) {
            for (const [k, v] of Object.entries(house))
                this.lists.set(k, slice(v, houseItem));
        }
        const rem = this._read('reminders.json');
        if (rem !== undefined)
            this.reminders = slice(rem, reminder);
        for (const l of defaultLists) {
            if (!this.lists.has(l))
                this.lists.set(l, []);
        }
    }

    _read(name) {
        const path = GLib.build_filenamev([this.dir, name]);
        let bytes;
        try {
            [, bytes] = GLib.file_get_contents(path);
        } catch (e) {
            if (e.matches?.(GLib.FileError, GLib.FileError.NOENT))
                return undefined;
            throw e;
        }
        // A broken file is fatal, as in Go: better than overwriting the household's data.
        return JSON.parse(new TextDecoder().decode(bytes));
    }

    _save(name) {
        let v;
        if (name === 'memory.json')
            v = this.memories;
        else if (name === 'house.json')
            v = this.lists;
        else
            v = this.reminders;
        const bytes = new TextEncoder().encode(marshal(v, '  '));
        try {
            // Temp file + fsync + rename, mode 0600 as Go's os.CreateTemp.
            GLib.file_set_contents_full(GLib.build_filenamev([this.dir, name]), bytes,
                GLib.FileSetContentsFlags.CONSISTENT | GLib.FileSetContentsFlags.DURABLE, 0o600);
        } finally {
            this.onChange?.();
        }
    }

    // ---- memory ----

    Memories() {
        return [...this.memories ?? []];
    }

    Remember(fact) {
        for (const m of this.memories ?? []) {
            if (fold(m.fact) === fold(fact))
                return m;
        }
        const m = {id: newID(), fact: fact.trim(), added: nowString()};
        this.memories = [...this.memories ?? [], m];
        this._save('memory.json');
        return m;
    }

    Forget(id) {
        const before = this.memories ?? [];
        const after = before.filter(m => m.id !== id);
        if (after.length === before.length)
            return false;
        this.memories = after;
        this._save('memory.json');
        return true;
    }

    // ---- house lists ----

    Lists() {
        return new Map([...this.lists].map(([k, v]) => [k, v === null ? null : [...v]]));
    }

    /** The default lists first, then the rest alphabetically. */
    ListNames() {
        const rest = [...this.lists.keys()].filter(k => !defaultLists.includes(k)).sort();
        return [...defaultLists, ...rest];
    }

    AddItems(list, texts, assignee = '', due = '') {
        list = canonicalList(list);
        const added = [];
        let items = this.lists.get(list) ?? null;
        for (let t of texts ?? []) {
            t = (t ?? '').trim();
            if (t === '')
                continue;
            // Already there and not done: don't add it twice.
            if ((items ?? []).some(it => !it.done && fold(it.text) === fold(t)))
                continue;
            const it = houseItem({id: newID(), text: t, assignee, due, added: nowString()});
            items = [...items ?? [], it];
            added.push(it);
        }
        if (added.length === 0)
            return [];
        this.lists.set(list, items);
        this._save('house.json');
        return added;
    }

    /** Removes matching items; returns [removed, queries that matched nothing]. */
    RemoveItems(list, queries) {
        list = canonicalList(list);
        const removed = [], missing = [];
        for (const q of queries ?? []) {
            const items = this.lists.get(list) ?? [];
            const i = findItem(items, q);
            if (i < 0) {
                missing.push(q);
                continue;
            }
            removed.push(items[i]);
            this.lists.set(list, items.filter((_, j) => j !== i));
        }
        if (removed.length > 0)
            this._save('house.json');
        return [removed, missing];
    }

    SetDone(list, id, done) {
        list = canonicalList(list);
        const items = this.lists.get(list) ?? [];
        const i = findItem(items, id);
        if (i < 0)
            return false;
        const copy = [...items];
        copy[i] = {...copy[i], done};
        this.lists.set(list, copy);
        this._save('house.json');
        return true;
    }

    /** Removes ticked items; an empty non-default list disappears. */
    ClearDone(list) {
        list = canonicalList(list);
        const items = this.lists.get(list) ?? null;
        const kept = items === null ? null : items.filter(it => !it.done);
        this.lists.set(list, kept);
        if ((kept ?? []).length === 0 && !defaultLists.includes(list))
            this.lists.delete(list);
        this._save('house.json');
    }

    // ---- reminders ----

    Reminders() {
        return [...this.reminders ?? []].sort((a, b) => parseTime(a.at) - parseTime(b.at));
    }

    AddReminder(r) {
        r = reminder({...r, id: newID()});
        this.reminders = [...this.reminders ?? [], r];
        this._save('reminders.json');
        return r;
    }

    DeleteReminder(id) {
        const before = this.reminders ?? [];
        const after = before.filter(r => r.id !== id);
        if (after.length === before.length)
            return false;
        this.reminders = after;
        this._save('reminders.json');
        return true;
    }

    /**
     * Returns reminders whose time has come; repeating ones move to their next
     * time, one-off ones are removed.
     */
    TakeDue(nowUs) {
        const due = [], keep = [];
        for (const r of this.reminders ?? []) {
            const at = parseTime(r.at);
            if (at > nowUs) {
                keep.push(r);
                continue;
            }
            due.push(r);
            const days = {daily: 1, weekly: 7}[r.repeat] ?? 0;
            if (days > 0) {
                // In local time, so a daily 08:00 stays 08:00 across DST changes.
                let dt = localTime(at);
                while (dt.to_unix() * 1e6 + dt.get_microsecond() <= nowUs)
                    dt = dt.add_days(days);
                keep.push({...r, at: rfc3339(dt)});
            }
        }
        if (due.length > 0) {
            this.reminders = keep;
            this._save('reminders.json');
        }
        return due;
    }
}

/** Matches by id, then exact text, then substring (accents and case ignored). */
export function findItem(items, q) {
    let i = items.findIndex(it => it.id === q);
    if (i >= 0)
        return i;
    const fq = fold(q);
    i = items.findIndex(it => fold(it.text) === fq);
    if (i >= 0)
        return i;
    return items.findIndex(it => {
        const ft = fold(it.text);
        return fq !== '' && (ft.includes(fq) || fq.includes(ft));
    });
}

export function openItems(items) {
    return (items ?? []).filter(it => !it.done);
}
