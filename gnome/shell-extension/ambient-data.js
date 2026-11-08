// What the ambient screen shows, without any of the Shell: its config, the
// weather (Open-Meteo), photos (the Jellyfin library on this machine), and
// the small pure helpers for times and layout. Plain Gio/GLib/Soup, so the
// tests run under `gjs -m` (tests/test-ambient.js).

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Soup from 'gi://Soup?version=3.0';

// Written by the tablet aspect (modules/tablet.nix); BALAUR_AMBIENT_CONFIG for testing.
export const CONFIG_PATH = GLib.getenv('BALAUR_AMBIENT_CONFIG') ?? '/etc/balaur/ambient.json';

const DEFAULTS = {
    idleSeconds: 60,
    location: null, // {name, latitude, longitude}
    photos: null, // {server, keyFile, intervalSeconds}
};

/** The config file merged over the defaults; a missing or broken file gives the defaults. */
export function loadConfig(path = CONFIG_PATH) {
    try {
        const [, bytes] = GLib.file_get_contents(path);
        return {...DEFAULTS, ...JSON.parse(new TextDecoder().decode(bytes))};
    } catch (e) {
        if (!e.matches?.(GLib.FileError, GLib.FileError.NOENT))
            console.warn(`balaur ambient: ${path}: ${e.message}`);
        return {...DEFAULTS};
    }
}

/** First line of a file, trimmed; '' when it is missing or unreadable. */
export function readSecret(path) {
    try {
        const [, bytes] = GLib.file_get_contents(path);
        return new TextDecoder().decode(bytes).split('\n')[0].trim();
    } catch {
        return '';
    }
}

// ---- weather ----------------------------------------------------------------

// WMO weather codes as Open-Meteo reports them -> [words, Adwaita icon stem].
const WMO = new Map([
    [[0], ['Clear', 'weather-clear']],
    [[1], ['Mostly clear', 'weather-few-clouds']],
    [[2], ['Partly cloudy', 'weather-few-clouds']],
    [[3], ['Overcast', 'weather-overcast']],
    [[45, 48], ['Fog', 'weather-fog']],
    [[51, 53, 55, 56, 57], ['Drizzle', 'weather-showers-scattered']],
    [[61, 63, 66, 80, 81], ['Rain', 'weather-showers']],
    [[65, 67, 82], ['Heavy rain', 'weather-showers']],
    [[71, 73, 77, 85], ['Snow', 'weather-snow']],
    [[75, 86], ['Heavy snow', 'weather-snow']],
    [[95, 96, 99], ['Thunderstorm', 'weather-storm']],
]);

/** [words, symbolic icon name] for a WMO code; night variants where Adwaita has them. */
export function describeWeather(code, isDay = true) {
    for (const [codes, v] of WMO) {
        if (codes.includes(code)) {
            const [words, stem] = v;
            const night = !isDay && (stem === 'weather-clear' || stem === 'weather-few-clouds');
            return [words, `${stem}${night ? '-night' : ''}-symbolic`];
        }
    }
    return ['', 'weather-severe-alert-symbolic'];
}

export function weatherUrl(loc) {
    const q = [
        `latitude=${loc.latitude.toFixed(4)}`,
        `longitude=${loc.longitude.toFixed(4)}`,
        'current=temperature_2m,weather_code,is_day',
        'daily=temperature_2m_max,temperature_2m_min,precipitation_probability_max',
        'forecast_days=1',
        'timezone=auto',
    ];
    return `https://api.open-meteo.com/v1/forecast?${q.join('&')}`;
}

/** Open-Meteo's answer -> what the screen shows, or null if it is not usable. */
export function parseWeather(json) {
    const c = json?.current, d = json?.daily;
    if (typeof c?.temperature_2m !== 'number')
        return null;
    const [words, icon] = describeWeather(c.weather_code, c.is_day !== 0);
    const day = k => (Array.isArray(d?.[k]) && typeof d[k][0] === 'number' ? d[k][0] : null);
    return {
        temp: Math.round(c.temperature_2m),
        words,
        icon,
        high: day('temperature_2m_max') === null ? null : Math.round(day('temperature_2m_max')),
        low: day('temperature_2m_min') === null ? null : Math.round(day('temperature_2m_min')),
        rain: day('precipitation_probability_max'),
    };
}

/** "Overcast · 15° / 6° · rain 40%" (the parts that are known). */
export function weatherLine(w) {
    const parts = [w.words];
    if (w.high !== null && w.low !== null)
        parts.push(`${w.high}° / ${w.low}°`);
    if (typeof w.rain === 'number' && w.rain >= 20)
        parts.push(`rain ${w.rain}%`);
    return parts.filter(Boolean).join(' · ');
}

// ---- HTTP -------------------------------------------------------------------

export class Http {
    constructor() {
        this._session = new Soup.Session({timeout: 20, user_agent: 'balaur-ambient/1'});
    }

    /** GET -> GLib.Bytes; throws on transport errors and non-2xx answers. */
    async get(url, headers = {}, cancellable = null) {
        const msg = Soup.Message.new('GET', url);
        if (!msg)
            throw new Error(`bad URL ${url}`);
        for (const [k, v] of Object.entries(headers))
            msg.request_headers.append(k, v);
        const bytes = await new Promise((resolve, reject) => {
            this._session.send_and_read_async(msg, GLib.PRIORITY_LOW, cancellable, (s, res) => {
                try {
                    resolve(s.send_and_read_finish(res));
                } catch (e) {
                    reject(e);
                }
            });
        });
        const status = msg.get_status();
        if (status < 200 || status >= 300)
            throw new Error(`HTTP ${status} from ${url.split('?')[0]}`);
        return bytes;
    }

    async getJSON(url, headers = {}, cancellable = null) {
        const bytes = await this.get(url, headers, cancellable);
        return JSON.parse(new TextDecoder().decode(bytes.toArray()));
    }

    abort() {
        this._session.abort();
    }
}

// ---- photos (Jellyfin) --------------------------------------------------------

/**
 * Random photos from the Jellyfin libraries on this machine. The API key
 * (`sudo balaur-photos-login`) is read on every refresh, so it can be added
 * or replaced without restarting anything.
 */
export class JellyfinPhotos {
    /** @param {{server: string, keyFile: string}} cfg */
    constructor(cfg, http) {
        this._cfg = cfg;
        this._http = http;
        this._ids = [];
        this._next = 0;
        this._listedAt = 0;
    }

    _headers() {
        const key = readSecret(this._cfg.keyFile);
        return key ? {Authorization: `MediaBrowser Token="${key}"`} : null;
    }

    static listUrl(server) {
        return `${server}/Items?Recursive=true&IncludeItemTypes=Photo&SortBy=Random&Limit=300&EnableImages=false&EnableUserData=false`;
    }

    static imageUrl(server, id, width, height) {
        return `${server}/Items/${encodeURIComponent(id)}/Images/Primary?fillWidth=${width}&fillHeight=${height}&quality=85`;
    }

    /** The id of the next photo to show, or null (no key, no photos, server down). */
    async nextId(cancellable) {
        const headers = this._headers();
        if (!headers)
            return null;
        // A new random order every hour, and whenever the last one ran out.
        if (this._next >= this._ids.length || GLib.get_monotonic_time() - this._listedAt > 3600e6) {
            const json = await this._http.getJSON(JellyfinPhotos.listUrl(this._cfg.server), headers, cancellable);
            this._ids = (json?.Items ?? []).map(i => i.Id).filter(Boolean);
            this._next = 0;
            this._listedAt = GLib.get_monotonic_time();
        }
        return this._ids.length ? this._ids[this._next++] : null;
    }

    /** The photo scaled by Jellyfin to cover width x height, as encoded bytes. */
    async image(id, width, height, cancellable) {
        const headers = this._headers();
        if (!headers)
            throw new Error('no Jellyfin API key');
        return this._http.get(JellyfinPhotos.imageUrl(this._cfg.server, id, width, height), headers, cancellable);
    }
}

// ---- layout and time helpers ----------------------------------------------------

/** Size and offset that make an image cover a box (centred, cropped, aspect kept). */
export function coverRect(imgW, imgH, boxW, boxH) {
    const s = Math.max(boxW / imgW, boxH / imgH);
    const w = Math.ceil(imgW * s), h = Math.ceil(imgH * s);
    return {x: Math.floor((boxW - w) / 2), y: Math.floor((boxH - h) / 2), width: w, height: h};
}

/** Seconds -> "4:05" or "1:02:03"; never negative. */
export function countdown(seconds) {
    const s = Math.max(0, Math.ceil(seconds));
    const h = Math.floor(s / 3600), m = Math.floor(s / 60) % 60, r = s % 60;
    const two = n => String(n).padStart(2, '0');
    return h ? `${h}:${two(m)}:${two(r)}` : `${m}:${two(r)}`;
}

const parseTime = s => {
    const dt = typeof s === 'string' ? GLib.DateTime.new_from_iso8601(s, null) : null;
    return dt ? dt.to_unix() * 1000 : NaN;
};

/** Running timers from the assistant's Snapshot, soonest first, with end times in ms. */
export function timersOf(snapshot) {
    return (snapshot?.timers ?? [])
        .map(t => ({id: t.id, label: t.label || 'Timer', endsMs: parseTime(t.ends)}))
        .filter(t => Number.isFinite(t.endsMs))
        .sort((a, b) => a.endsMs - b.endsMs);
}

/** The next reminder still to come, or null. */
export function nextReminder(snapshot, nowMs) {
    return (snapshot?.reminders ?? [])
        .map(r => ({text: r.text, atMs: parseTime(r.at)}))
        .filter(r => r.text && Number.isFinite(r.atMs) && r.atMs > nowMs)
        .sort((a, b) => a.atMs - b.atMs)[0] ?? null;
}

/** "14:05" or "2:05 PM", per GNOME's clock-format. */
export function clockText(dt, format24) {
    return format24 ? dt.format('%H:%M') : dt.format('%-l:%M %p');
}

/** When a reminder is due, relative to today: "18:00", "Tomorrow 09:00", "Fri 09:00", "12 Nov 09:00". */
export function whenText(atMs, now, format24) {
    const at = GLib.DateTime.new_from_unix_local(Math.floor(atMs / 1000));
    const time = clockText(at, format24);
    const dayIndex = d => Math.floor((d.to_unix() + d.get_utc_offset() / 1e6) / 86400);
    const days = dayIndex(at) - dayIndex(now);
    if (days <= 0)
        return time;
    if (days === 1)
        return `Tomorrow ${time}`;
    if (days < 7)
        return `${at.format('%a')} ${time}`;
    return `${at.format('%-d %b')} ${time}`;
}
