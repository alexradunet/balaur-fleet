// What GNOME's overview search finds in Balaur (search-provider.js), without
// GTK or D-Bus so tests/test-app.js can run it headless: the home's services,
// the lists' items, the remembered facts, the running timers and the
// reminders, plus "Ask <name>" for a typed question.
//
// A result id says what it is and how to open it: `service:<name>`,
// `list:<list>:<item id>`, `memory:<id>`, `timer:<id>`, `reminder:<id>`,
// `ask:<question>`.

import {formatWhen, listTitle, parseTime} from './format.js';

// Matching ignores case and diacritics: "paine" finds "pâine", "sedinta" "ședința".
export function fold(text) {
    return (text ?? '').normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();
}

// Every term must start a word of the text ("mil" finds "oat milk", "ilk" does not).
export function matches(terms, text) {
    const words = fold(text).split(/[^\p{L}\p{N}]+/u).filter(Boolean);
    return terms.every(t => {
        const term = fold(t);
        return words.some(w => w.startsWith(term));
    });
}

// A question rather than a lookup: three words or more. Only then does the
// search offer to ask the assistant, so it doesn't crowd every search.
export function isQuestion(terms) {
    return terms.filter(t => t.trim()).length >= 3;
}

/**
 * Everything searchable, as [{id, name, description, icon, text}] where
 * `text` is what the terms are matched against and `icon` is a GIcon string
 * (or null: the caller picks the app's own). `snapshot` is the assistant's
 * (normalized, assistant.js), `services` services.json's list.
 */
export function searchItems(snapshot, services, now = undefined) {
    const items = [];
    for (const s of services) {
        const icon = typeof s.icon === 'string' && /^([\w.-]+|\/.+)$/.test(s.icon) ? s.icon : null;
        const where = s.host ? `On ${s.host}` : '';
        items.push({
            id: `service:${s.name}`,
            name: s.name,
            description: [s.description, where].filter(Boolean).join(' · '),
            icon,
            text: `${s.name} ${s.description ?? ''} ${s.group ?? ''}`,
            desktopId: s.desktopId ?? null,
        });
    }
    for (const list of snapshot.listOrder) {
        for (const item of snapshot.lists[list] ?? []) {
            items.push({
                id: `list:${list}:${item.id}`,
                name: item.text,
                description: `${listTitle(list)} list${item.done ? ' · done' : ''}`,
                icon: item.done ? 'checkbox-checked-symbolic' : 'checkbox-symbolic',
                text: `${item.text} ${list} ${listTitle(list)}`,
            });
        }
    }
    for (const m of snapshot.memories) {
        items.push({
            id: `memory:${m.id}`,
            name: m.fact,
            description: 'Remembered',
            icon: 'user-bookmarks-symbolic',
            text: m.fact,
        });
    }
    for (const t of snapshot.timers) {
        const ends = parseTime(t.ends);
        items.push({
            id: `timer:${t.id}`,
            name: t.label || 'Timer',
            description: ends ? `Timer, rings at ${formatWhen(ends, now)}` : 'Timer',
            icon: 'alarm-symbolic',
            text: `${t.label ?? ''} timer`,
        });
    }
    for (const r of snapshot.reminders) {
        const at = parseTime(r.at);
        items.push({
            id: `reminder:${r.id}`,
            name: r.text,
            description: at ? `Reminder, ${formatWhen(at, now)}` : 'Reminder',
            icon: 'alarm-symbolic',
            text: `${r.text} reminder`,
        });
    }
    return items;
}

// Best first: a name that starts with the first term, then the rest in their
// order (services, lists, memory, timers, reminders).
export function search(items, terms) {
    const found = items.filter(i => matches(terms, i.text));
    const first = fold(terms[0] ?? '');
    const starts = i => fold(i.name).startsWith(first) ? 0 : 1;
    return found.map((i, n) => [starts(i), n, i]).sort((a, b) => a[0] - b[0] || a[1] - b[1]).map(x => x[2]);
}

// The ids for GNOME, with "Ask" first when the terms read like a question.
export function resultIds(items, terms, assistantAvailable) {
    const ids = search(items, terms).map(i => i.id);
    if (assistantAvailable && isQuestion(terms))
        ids.unshift(`ask:${terms.join(' ')}`);
    return ids;
}

// "list:shopping:a1b2" -> {kind: 'list', key: 'shopping:a1b2'}.
export function parseId(id) {
    const i = id.indexOf(':');
    return i < 0 ? {kind: '', key: id} : {kind: id.slice(0, i), key: id.slice(i + 1)};
}

// Which page of the app shows a result.
export const PAGE_OF = {list: 'lists', memory: 'memory', timer: 'timers', reminder: 'timers',
    ask: 'assistant', service: 'home'};
