// JSON exactly as Go's encoding/json writes it, so the state files stay
// byte-compatible with the Go assistant (they hold the household's lists and
// memories, and either version may read the other's files):
//   - struct fields in declaration order (plain JS objects, insertion order),
//   - map keys sorted bytewise (pass a JS Map),
//   - <, >, & and U+2028/U+2029 escaped as < etc. (Go's HTML-safe default),
//   - MarshalIndent's layout: "key": value, two-space indent, [] and {} when empty,
//     no trailing newline.
// Plus time.Time's RFC 3339 format (fraction trimmed, "Z" for UTC).

import GLib from 'gi://GLib';

const utf8 = new TextEncoder();

function compareUtf8(a, b) {
    const x = utf8.encode(a), y = utf8.encode(b);
    const n = Math.min(x.length, y.length);
    for (let i = 0; i < n; i++) {
        if (x[i] !== y[i])
            return x[i] - y[i];
    }
    return x.length - y.length;
}

export function goString(s) {
    // Go writes invalid UTF-16 (lone surrogates) as U+FFFD.
    const wf = s.toWellFormed ? s.toWellFormed() : s;
    return JSON.stringify(wf).replace(/[<>&\u2028\u2029]/g,
        c => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`);
}

/**
 * Marshals v like json.Marshal (indent "") or json.MarshalIndent(v, "", indent).
 * Undefined object fields are left out (Go's omitempty is done by the caller).
 */
export function marshal(v, indent = '', prefix = '') {
    if (v === null || v === undefined)
        return 'null';
    if (typeof v === 'boolean')
        return v ? 'true' : 'false';
    if (typeof v === 'number')
        return Number.isFinite(v) ? JSON.stringify(v) : 'null';
    if (typeof v === 'string')
        return goString(v);
    const inner = prefix + indent;
    const nl = indent ? `\n${inner}` : '';
    const end = indent ? `\n${prefix}` : '';
    const sep = indent ? ': ' : ':';
    if (Array.isArray(v)) {
        if (v.length === 0)
            return '[]';
        return `[${nl}${v.map(x => marshal(x, indent, inner)).join(`,${nl}`)}${end}]`;
    }
    let entries;
    if (v instanceof Map)
        entries = [...v.entries()].sort((a, b) => compareUtf8(a[0], b[0]));
    else
        entries = Object.entries(v).filter(([, x]) => x !== undefined);
    if (entries.length === 0)
        return '{}';
    return `{${nl}${entries.map(([k, x]) => goString(k) + sep + marshal(x, indent, inner)).join(`,${nl}`)}${end}}`;
}

/** A plain object's entries as a Map, so marshal sorts the keys (a Go map). */
export function sorted(obj) {
    return new Map(Object.entries(obj).filter(([, x]) => x !== undefined));
}

// ---- time ----

let localTz = null;
export function localZone() {
    // $TZ (Europe/Bucharest), read once like Go's time.Local.
    localTz ??= GLib.TimeZone.new_local();
    return localTz;
}

/** A GLib.DateTime in local time for a moment in microseconds since the epoch. */
export function localTime(us) {
    const secs = Math.floor(us / 1e6);
    const dt = GLib.DateTime.new_from_unix_local(secs);
    return dt.add(us - secs * 1e6);
}

/** time.Time's MarshalJSON / RFC3339Nano: "2026-11-04T16:13:20.123456+02:00". */
export function rfc3339(dt) {
    let s = dt.format('%Y-%m-%dT%H:%M:%S');
    const us = dt.get_microsecond();
    if (us)
        s += `.${String(us).padStart(6, '0').replace(/0+$/, '')}`;
    const off = Math.round(dt.get_utc_offset() / 1e6 / 60); // minutes
    if (off === 0)
        return `${s}Z`;
    const a = Math.abs(off);
    return `${s}${off < 0 ? '-' : '+'}${String(Math.floor(a / 60)).padStart(2, '0')}:${String(a % 60).padStart(2, '0')}`;
}

/** Microseconds since the epoch for an RFC 3339 string; NaN if it does not parse. */
export function parseTime(s) {
    const dt = typeof s === 'string' ? GLib.DateTime.new_from_iso8601(s, null) : null;
    return dt ? dt.to_unix() * 1e6 + dt.get_microsecond() : NaN;
}

/** The current local time as Go would marshal time.Now(). */
export function nowString() {
    return rfc3339(GLib.DateTime.new_now_local());
}

// Go's reference-layout formats used by the assistant, in English like Go's.
const DAYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August',
    'September', 'October', 'November', 'December'];
const p2 = n => String(n).padStart(2, '0');

/** "Monday, 2 January 2006" */
export function longDate(dt) {
    return `${DAYS[dt.get_day_of_week() - 1]}, ${dt.get_day_of_month()} ${MONTHS[dt.get_month() - 1]} ${dt.get_year()}`;
}

/** "15:04" or with seconds "15:04:05" */
export function clock(dt, seconds = false) {
    return `${p2(dt.get_hour())}:${p2(dt.get_minute())}${seconds ? `:${p2(dt.get_second())}` : ''}`;
}

/** "Mon 2006-01-02 15:04" */
export function shortDateTime(dt) {
    return `${DAYS[dt.get_day_of_week() - 1].slice(0, 3)} ${dt.get_year()}-${p2(dt.get_month())}-${p2(dt.get_day_of_month())} ${clock(dt)}`;
}
