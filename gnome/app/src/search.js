// What GNOME's overview search finds in Balaur (search-provider.js), without
// GTK or D-Bus so tests/test-app.js can run it headless: the home's services.
//
// A result id says what it is: `service:<name>`.

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

/**
 * Everything searchable, as [{id, name, description, icon, text}] where
 * `text` is what the terms are matched against and `icon` is a GIcon string
 * (or null: the caller picks the app's own). `services` is services.json's list.
 */
export function searchItems(services) {
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
    return items;
}

// Best first: a name that starts with the first term, then the rest in
// services.json's order.
export function search(items, terms) {
    const found = items.filter(i => matches(terms, i.text));
    const first = fold(terms[0] ?? '');
    const starts = i => fold(i.name).startsWith(first) ? 0 : 1;
    return found.map((i, n) => [starts(i), n, i]).sort((a, b) => a[0] - b[0] || a[1] - b[1]).map(x => x[2]);
}

// The ids for GNOME.
export function resultIds(items, terms) {
    return search(items, terms).map(i => i.id);
}

// "service:Jellyfin" -> {kind: 'service', key: 'Jellyfin'}.
export function parseId(id) {
    const i = id.indexOf(':');
    return i < 0 ? {kind: '', key: id} : {kind: id.slice(0, i), key: id.slice(i + 1)};
}
