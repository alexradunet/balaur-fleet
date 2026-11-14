// Pure helpers (GLib only, no GTK) so tests/test-app.js can run them headless.

import GLib from 'gi://GLib';

// For widget properties that parse Pango markup (AdwPreferencesGroup and
// AdwActionRow titles, AdwStatusPage descriptions, ...). Not for plain-text ones.
export function escape(text) {
    return GLib.markup_escape_text(text ?? '', -1);
}
