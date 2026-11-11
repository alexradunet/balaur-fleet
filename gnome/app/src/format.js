// Pure helpers (GLib and Gio only, no GTK) so tests/test-app.js can run them
// headless; util.js re-exports the ones the pages use.

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

// RFC 3339 from the daemon (Go writes nanoseconds, which JS' Date.parse
// doesn't promise to read) -> GLib.DateTime in local time, or null.
export function parseTime(iso) {
    if (!iso)
        return null;
    const dt = GLib.DateTime.new_from_iso8601(iso, null);
    return dt ? dt.to_local() : null;
}

// Seconds from now until `dt` (negative once past).
export function secondsUntil(dt) {
    return dt.difference(GLib.DateTime.new_now_local()) / 1e6;
}

// 754 -> "12:34", 3754 -> "1:02:34".
export function formatCountdown(seconds) {
    const s = Math.max(0, Math.ceil(seconds));
    const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), r = s % 60;
    const p = n => String(n).padStart(2, '0');
    return h ? `${h}:${p(m)}:${p(r)}` : `${m}:${p(r)}`;
}

// Whether the desktop shows 24-hour times (org.gnome.desktop.interface
// clock-format); 24 h when the schema is missing, as in the shell extension.
let desktopInterface;
export function clock24() {
    if (desktopInterface === undefined) {
        const id = 'org.gnome.desktop.interface';
        desktopInterface = Gio.SettingsSchemaSource.get_default()?.lookup(id, true)
            ? new Gio.Settings({schema_id: id}) : null;
    }
    return desktopInterface?.get_string('clock-format') !== '12h';
}

// "14:05" or "2:05 PM", with seconds when asked.
export function clockText(dt, format24 = clock24(), seconds = false) {
    if (format24)
        return dt.format(seconds ? '%H:%M:%S' : '%H:%M');
    return dt.format(seconds ? '%-l:%M:%S %p' : '%-l:%M %p');
}

// Like the shell extension's whenText: "16:30" today, "Tomorrow 16:30",
// "Thu 16:30" within a week, "12 Nov 16:30" beyond (and "Yesterday" for the log).
export function formatWhen(dt, now = GLib.DateTime.new_now_local(), format24 = clock24()) {
    if (!dt)
        return '';
    const time = clockText(dt, format24);
    const dayIndex = d => Math.floor((d.to_unix() + d.get_utc_offset() / 1e6) / 86400);
    const days = dayIndex(dt) - dayIndex(now);
    if (days === 0)
        return time;
    if (days === 1)
        return `Tomorrow ${time}`;
    if (days === -1)
        return `Yesterday ${time}`;
    if (Math.abs(days) < 7)
        return `${dt.format('%a')} ${time}`;
    return `${dt.format(dt.get_year() === now.get_year() ? '%-d %b' : '%-d %b %Y')} ${time}`;
}

// List keys from the daemon ("shopping") -> group titles.
const LIST_TITLES = {shopping: 'Shopping', tasks: 'Tasks', todo: 'To do'};
export function listTitle(name) {
    return LIST_TITLES[name] ?? name.charAt(0).toUpperCase() + name.slice(1);
}

// For widget properties that parse Pango markup (AdwPreferencesGroup and
// AdwEntryRow titles, AdwStatusPage descriptions, ...). Not for plain-text ones.
export function escape(text) {
    return GLib.markup_escape_text(text ?? '', -1);
}

// Where the Mistral key is sent must be a secure or a local address. Returns ''
// when `text` is fine (empty means the machine's default), else what is wrong.
const LOOPBACK = ['127.0.0.1', 'localhost', '::1'];
export function speechUrlProblem(text) {
    const url = (text ?? '').trim();
    if (!url)
        return '';
    let uri;
    try {
        uri = GLib.Uri.parse(url, GLib.UriFlags.NONE);
    } catch {
        return 'Not a valid address';
    }
    const host = uri.get_host();
    if (!host)
        return 'The address needs a host name';
    if (!/^[a-z0-9._:-]+$/i.test(host)) // GLib lets a space or a percent escape through
        return 'Not a valid host name';
    const scheme = uri.get_scheme();
    if (scheme === 'https' || (scheme === 'http' && LOOPBACK.includes(host)))
        return '';
    if (scheme === 'http')
        return 'Use https:// (http:// only for this machine)';
    return 'The address must start with https://';
}
