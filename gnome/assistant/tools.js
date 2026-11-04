// The daemon-side tools: the agent (gnome/agent/) forwards the model's calls
// to these as tool_call records, because the state lives here (timers,
// reminders, house lists, memory, the speaker). Same behaviour and results as
// the matching tools in assistant/tools.go.

import GLib from 'gi://GLib';

import {canonicalList, openItems} from './store.js';
import {clock, localTime, parseTime, rfc3339, shortDateTime} from './gojson.js';
import {nowUs} from './util.js';

// The decoding json.Unmarshal did: field names match case-insensitively and
// a value of the wrong type is an error ("bad arguments: ...").
function decode(args, fields) {
    const out = {};
    const src = args && typeof args === 'object' ? args : {};
    const lower = Object.fromEntries(Object.entries(src).map(([k, v]) => [k.toLowerCase(), v]));
    for (const [name, type] of Object.entries(fields)) {
        const v = lower[name.toLowerCase()];
        if (v === undefined || v === null)
            continue;
        const ok = {
            string: typeof v === 'string',
            int: Number.isInteger(v),
            bool: typeof v === 'boolean',
            strings: Array.isArray(v) && v.every(x => typeof x === 'string'),
        }[type];
        if (!ok)
            throw new Error(`bad arguments: ${name} must be ${{string: 'a string', int: 'an integer', bool: 'a boolean', strings: 'a list of strings'}[type]}`);
        out[name] = v;
    }
    return out;
}

const itemTexts = items => items.map(it => it.text);

/** "YYYY-MM-DD HH:MM" (or with a T) in local time -> GLib.DateTime, or null. */
export function parseLocal(s) {
    const m = s.trim().replace('T', ' ').match(/^(\d{4})-(\d{2})-(\d{2}) (\d{1,2}):(\d{2})$/);
    if (!m)
        return null;
    const [y, mo, d, h, mi] = m.slice(1).map(Number);
    if (mo < 1 || mo > 12 || d < 1 || d > 31 || h > 23 || mi > 59)
        return null;
    const dt = GLib.DateTime.new_local(y, mo, d, h, mi, 0);
    // GLib normalises nothing, but reject 31 February and the like.
    return dt && dt.get_day_of_month() === d ? dt : null;
}

/**
 * Runs one tool for turn ({lang}) on assistant a (store, timers, volume).
 * Returns the result value (JSON-able); throws with a message for the model.
 */
export async function runTool(a, name, args, turn) {
    const lang = turn?.lang ?? '';
    switch (name) {
    case 'set_timer': {
        const p = decode(args, {duration_seconds: 'int', label: 'string'});
        const secs = p.duration_seconds ?? 0;
        if (secs <= 0 || secs > 24 * 3600)
            throw new Error('duration must be between 1 second and 24 hours');
        const t = a.timers.add(secs * 1000, p.label ?? '', lang);
        a.changed();
        return {ends_at: clock(localTime(t.ends), true), id: t.id, label: t.label};
    }
    case 'list_timers':
        return a.timers.list();
    case 'cancel_timer': {
        const p = decode(args, {id: 'string', label: 'string', all: 'bool'});
        const n = a.timers.cancel(p.id ?? '', p.label ?? '', p.all ?? false);
        a.changed();
        return {cancelled: n};
    }
    case 'add_reminder': {
        const p = decode(args, {text: 'string', at: 'string', repeat: 'string'});
        const at = parseLocal(p.at ?? '');
        if (!at)
            throw new Error("'at' must be 'YYYY-MM-DD HH:MM'");
        let repeat = p.repeat ?? '';
        if (repeat === 'none')
            repeat = '';
        if (at.to_unix() * 1e6 <= nowUs() && repeat === '')
            throw new Error('that time is in the past');
        const r = a.store.AddReminder({text: p.text ?? '', at: rfc3339(at), repeat, lang});
        return {at: shortDateTime(at), id: r.id, repeat: r.repeat ?? ''};
    }
    case 'list_reminders': {
        const out = a.store.Reminders().map(r => ({
            at: shortDateTime(localTime(parseTime(r.at))), id: r.id, repeat: r.repeat ?? '', text: r.text,
        }));
        return out.length ? out : null;
    }
    case 'delete_reminder': {
        const p = decode(args, {id: 'string'});
        return {deleted: a.store.DeleteReminder(p.id ?? '')};
    }
    case 'remember': {
        const p = decode(args, {fact: 'string'});
        if (!(p.fact ?? '').trim())
            throw new Error('empty fact');
        const m = a.store.Remember(p.fact);
        return {id: m.id, saved: m.fact};
    }
    case 'forget': {
        const p = decode(args, {id: 'string'});
        return {deleted: a.store.Forget(p.id ?? '')};
    }
    case 'house_list_add': {
        const p = decode(args, {list: 'string', items: 'strings', assignee: 'string', due: 'string'});
        const added = a.store.AddItems(p.list ?? '', p.items ?? [], p.assignee ?? '', p.due ?? '');
        const list = canonicalList(p.list ?? '');
        return {added: itemTexts(added), list, open_items: openItems(a.store.Lists().get(list)).length};
    }
    case 'house_list_remove': {
        const p = decode(args, {list: 'string', items: 'strings'});
        const [removed, missing] = a.store.RemoveItems(p.list ?? '', p.items ?? []);
        return {not_found: missing.length ? missing : null, removed: itemTexts(removed)};
    }
    case 'house_list_show': {
        const p = decode(args, {list: 'string'});
        const lists = a.store.Lists();
        const out = {};
        for (const name of a.store.ListNames()) {
            if (p.list && name !== canonicalList(p.list))
                continue;
            const items = openItems(lists.get(name)).map(it => {
                const m = {text: it.text};
                if (it.assignee)
                    m.assignee = it.assignee;
                if (it.due)
                    m.due = it.due;
                return m;
            });
            out[name] = items.length ? items : null;
        }
        return out;
    }
    case 'set_volume': {
        const p = decode(args, {percent: 'int', change: 'int'});
        const v = p.percent ?? a.volume + (p.change ?? 0);
        await a.setVolume(v);
        return {volume: a.volume};
    }
    }
    throw new Error(`unknown tool "${name}"`);
}
