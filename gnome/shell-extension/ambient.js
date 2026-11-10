// The ambient screen: when nobody has touched the Duet for a while, a
// full-screen view that is readable across the room. It shows a big clock and
// the date, the weather, the running timers and the next reminder, over a
// slow slideshow (a synced folder, or Jellyfin), and on the side how the
// fleet's machines and the home's services are doing (ambient-status.js).
//
// - Shown by Mutter's idle monitor (real input only), after `idleSeconds`.
//   Movement in front of the camera does not end it: it keeps the screen
//   awake (duet-presence), so the view stays up while people are in the room.
//   GNOME still blanks the screen when nobody is there.
// - Any touch, click or key ends it. The first tap lands on the view, not
//   on the app underneath.
// - Not shown over a full-screen window (a film) or while another app holds
//   an idle inhibitor (a video call, a player). duet-presence's own inhibitor
//   doesn't count.
// - Lean: no timers, downloads or decoding while it is hidden. Photos are
//   decoded at about the screen's size (scaled by Jellyfin, or while decoding
//   a file), off the main thread.
//   Each one fades in with a Clutter transition.

import Clutter from 'gi://Clutter';
import Cogl from 'gi://Cogl';
import GdkPixbuf from 'gi://GdkPixbuf';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Pango from 'gi://Pango';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import {
    FolderPhotos, Http, JellyfinPhotos, clockText, decodeSize, countdown, coverRect, loadConfig,
    nextReminder, parseWeather, timersOf, weatherLine, weatherUrl, whenText,
} from './ambient-data.js';
import {FleetStatus} from './ambient-status.js';

const FADE_MS = 400;
const PHOTO_FADE_MS = 1500;
const RECHECK_S = 30; // idle but held back (film, call): look again this often
const WEATHER_TTL_S = 15 * 60;
const WEATHER_RETRY_S = 5 * 60;
const STATUS_S = 30;
const PRESENCE_APP_ID = 'duet-presence';
const IDLE_INHIBIT = 8; // GsmInhibitorFlag IDLE

export class AmbientScreen {
    constructor() {
        this._cfg = loadConfig();
        this._http = new Http();
        const photos = this._cfg.photos;
        this._photos = photos?.dir ? new FolderPhotos(photos)
            : photos?.server ? new JellyfinPhotos(photos, this._http) : null;
        this._fleet = this._cfg.status ? new FleetStatus(this._cfg.status) : null;
        this._iface = new Gio.Settings({schema_id: 'org.gnome.desktop.interface'});
        this._cancellable = new Gio.Cancellable();

        this._shown = false;
        this._snapshotJson = '';
        this._snapshot = null;
        this._weather = null;
        this._weatherAt = 0; // monotonic µs of the last attempt
        this._weatherBusy = false;
        this._photoBusy = false;
        this._photoAt = 0;
        this._photo = null; // {actor, width, height}
        this._statusBusy = false;
        this._statusAt = 0;

        this._buildUi();

        this._monitor = global.backend.get_core_idle_monitor();
        this._idleWatch = this._cfg.idleSeconds > 0
            ? this._monitor.add_idle_watch(this._cfg.idleSeconds * 1000, () => this._onIdle())
            : 0;
        this._activeWatch = 0;
        this._recheckId = 0;
        this._tickId = 0;
    }

    destroy() {
        this._cancellable.cancel();
        this._http.abort();
        if (this._idleWatch)
            this._monitor.remove_watch(this._idleWatch);
        if (this._activeWatch)
            this._monitor.remove_watch(this._activeWatch);
        this._clearSource('_recheckId');
        this._clearSource('_tickId');
        Main.layoutManager.disconnect(this._monitorsId);
        this._root?.destroy();
        this._root = null;
    }

    /** The assistant's state, from AssistantClient (timers, reminders). */
    sync(status) {
        const json = status.running ? status.snapshot : '';
        if (json === this._snapshotJson)
            return;
        this._snapshotJson = json;
        try {
            this._snapshot = json ? JSON.parse(json) : null;
        } catch {
            this._snapshot = null;
        }
        if (this._shown)
            this._tick();
    }

    // ---- building ------------------------------------------------------------

    _buildUi() {
        this._root = new St.Widget({
            name: 'balaurAmbient',
            style_class: 'balaur-ambient',
            reactive: true, // swallows the tap that ends it
            visible: false,
            opacity: 0,
            clip_to_allocation: true,
            layout_manager: new Clutter.BinLayout(),
        });

        // Photos: plain actors with image content, placed by hand (cover fit).
        this._photoLayer = new Clutter.Actor({x_expand: true, y_expand: true});
        this._root.add_child(this._photoLayer);
        // Darkens the bottom of the picture so the text stays readable.
        this._root.add_child(new St.Widget({style_class: 'balaur-ambient-scrim', x_expand: true, y_expand: true}));

        const front = this._front = new St.BoxLayout({
            style_class: 'balaur-ambient-front',
            x_expand: true,
            y_expand: true,
            y_align: Clutter.ActorAlign.END,
        });
        this._root.add_child(front);

        const left = new St.BoxLayout({
            orientation: Clutter.Orientation.VERTICAL,
            x_expand: true,
            y_align: Clutter.ActorAlign.END,
        });
        front.add_child(left);
        this._clock = new St.Label({style_class: 'balaur-ambient-clock'});
        this._date = new St.Label({style_class: 'balaur-ambient-date'});
        left.add_child(this._clock);
        left.add_child(this._date);

        this._weatherRow = new St.BoxLayout({style_class: 'balaur-ambient-weather', visible: false});
        this._weatherIcon = new St.Icon({style_class: 'balaur-ambient-weather-icon', y_align: Clutter.ActorAlign.CENTER});
        this._weatherTemp = new St.Label({style_class: 'balaur-ambient-temp', y_align: Clutter.ActorAlign.CENTER});
        this._weatherText = new St.Label({style_class: 'balaur-ambient-weather-text', y_align: Clutter.ActorAlign.CENTER});
        this._weatherRow.add_child(this._weatherIcon);
        this._weatherRow.add_child(this._weatherTemp);
        this._weatherRow.add_child(this._weatherText);
        left.add_child(this._weatherRow);

        // Right: the machines and services, then timers (live countdowns) and
        // the next reminder.
        this._side = new St.BoxLayout({
            style_class: 'balaur-ambient-side',
            orientation: Clutter.Orientation.VERTICAL,
            y_align: Clutter.ActorAlign.END,
        });
        front.add_child(this._side);
        this._buildStatus();
        this._timerRows = new Map(); // id -> {box, label, time}
        this._reminder = new St.BoxLayout({style_class: 'balaur-ambient-card', orientation: Clutter.Orientation.VERTICAL, visible: false});
        this._reminderWhen = new St.Label({style_class: 'balaur-ambient-card-label'});
        this._reminderText = new St.Label({style_class: 'balaur-ambient-card-text'});
        this._reminderText.clutter_text.ellipsize = Pango.EllipsizeMode.END;
        this._reminder.add_child(this._reminderWhen);
        this._reminder.add_child(this._reminderText);
        this._side.add_child(this._reminder);

        // Above the windows and the top bar, below the notification banners
        // (a timer going off still shows) and the assistant's orb (top chrome).
        Main.layoutManager.addChrome(this._root, {trackFullscreen: false});
        Main.layoutManager.uiGroup.set_child_below_sibling(this._root, Main.messageTray);

        this._monitorsId = Main.layoutManager.connect('monitors-changed', () => this._place());
        this._place();
        this._root.connect('destroy', () => {
            this._root = null;
        });
    }

    // Two sections in one card: a row per machine (name, state on the right),
    // then the services in two columns. Filled by _maybeStatus.
    _buildStatus() {
        this._statusCard = new St.BoxLayout({
            style_class: 'balaur-ambient-card balaur-ambient-status',
            orientation: Clutter.Orientation.VERTICAL,
            visible: false,
        });
        const heading = text => new St.Label({style_class: 'balaur-ambient-card-label balaur-ambient-status-heading', text});
        this._statusCard.add_child(heading('Devices'));
        this._machineBox = new St.BoxLayout({style_class: 'balaur-ambient-status-list', orientation: Clutter.Orientation.VERTICAL});
        this._statusCard.add_child(this._machineBox);
        this._statusCard.add_child(heading('Services'));
        const columns = new St.BoxLayout({style_class: 'balaur-ambient-status-columns'});
        this._serviceColumns = [0, 1].map(() => {
            const col = new St.BoxLayout({style_class: 'balaur-ambient-status-list', orientation: Clutter.Orientation.VERTICAL, x_expand: true});
            columns.add_child(col);
            return col;
        });
        this._statusCard.add_child(columns);
        this._side.add_child(this._statusCard);
    }

    _place() {
        const m = Main.layoutManager.primaryMonitor;
        if (!m || !this._root)
            return;
        this._root.set_position(m.x, m.y);
        this._root.set_size(m.width, m.height);
        // Landscape: the clock on the left, the cards on the right. Portrait
        // (the tablet turned) has no room for both side by side: the cards go
        // above the clock, at the full width.
        const portrait = m.height > m.width;
        this._front.orientation = portrait ? Clutter.Orientation.VERTICAL : Clutter.Orientation.HORIZONTAL;
        this._front.set_child_at_index(this._side, portrait ? 0 : 1);
        this._side.x_align = portrait ? Clutter.ActorAlign.FILL : Clutter.ActorAlign.END;
        this._reminder.style = `max-width: ${Math.round(m.width * (portrait ? 0.9 : 0.4))}px;`;
        this._statusCard.style = `max-width: ${Math.round(m.width * (portrait ? 0.9 : 0.45))}px;`;
        if (this._photo)
            this._fit(this._photo);
    }

    // ---- idle -> shown -> active -------------------------------------------------

    async _onIdle() {
        if (!this._activeWatch)
            this._activeWatch = this._monitor.add_user_active_watch(() => this._onActive());
        if (this._shown || !this._root)
            return;
        if (await this._heldBack()) {
            // Look again later, as long as nobody touches anything.
            if (!this._recheckId) {
                this._recheckId = GLib.timeout_add_seconds(GLib.PRIORITY_LOW, RECHECK_S, () => {
                    this._recheckId = 0;
                    this._onIdle();
                    return GLib.SOURCE_REMOVE;
                });
            }
            return;
        }
        if (this._activeWatch) // still idle after the await
            this._show();
    }

    _onActive() {
        this._activeWatch = 0; // one-shot: Mutter removed it
        this._clearSource('_recheckId');
        this._hide();
    }

    /** A film or call in front: a full-screen window, or someone else's idle inhibitor. */
    async _heldBack() {
        const primary = Main.layoutManager.primaryIndex;
        if (primary >= 0 && global.display.get_monitor_in_fullscreen(primary))
            return true;
        try {
            return await this._foreignIdleInhibitor();
        } catch (e) {
            console.warn(`balaur ambient: inhibitors: ${e.message}`);
            return false;
        }
    }

    async _foreignIdleInhibitor() {
        const call = (path, iface, method) => new Promise((resolve, reject) => {
            Gio.DBus.session.call('org.gnome.SessionManager', path, iface, method, null, null,
                Gio.DBusCallFlags.NO_AUTO_START, 2000, this._cancellable, (c, res) => {
                    try {
                        resolve(c.call_finish(res).deepUnpack()[0]);
                    } catch (e) {
                        reject(e);
                    }
                });
        });
        const paths = await call('/org/gnome/SessionManager', 'org.gnome.SessionManager', 'GetInhibitors');
        for (const p of paths) {
            const iface = 'org.gnome.SessionManager.Inhibitor';
            // eslint-disable-next-line no-await-in-loop
            const [appId, flags] = await Promise.all([call(p, iface, 'GetAppId'), call(p, iface, 'GetFlags')]);
            if ((flags & IDLE_INHIBIT) && appId !== PRESENCE_APP_ID)
                return true;
        }
        return false;
    }

    _show() {
        if (this._shown)
            return;
        this._shown = true;
        this._place();
        this._tick();
        this._tickId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, 1, () => {
            this._tick();
            return GLib.SOURCE_CONTINUE;
        });
        this._root.remove_all_transitions();
        this._root.show();
        this._root.ease({opacity: 255, duration: FADE_MS, mode: Clutter.AnimationMode.EASE_OUT_QUAD});
    }

    _hide() {
        if (!this._shown)
            return;
        this._shown = false;
        this._clearSource('_tickId');
        // Stays reactive while it fades, so the touch that ended it doesn't
        // reach the app underneath.
        this._root?.ease({
            opacity: 0,
            duration: FADE_MS,
            mode: Clutter.AnimationMode.EASE_OUT_QUAD,
            onStopped: () => {
                if (this._root && !this._shown)
                    this._root.hide();
            },
        });
    }

    // ---- what is on it ---------------------------------------------------------------

    _tick() {
        const now = GLib.DateTime.new_now_local();
        const format24 = this._iface.get_string('clock-format') !== '12h';
        setText(this._clock, clockText(now, format24));
        setText(this._date, now.format('%A, %-d %B'));
        this._syncTimers(now.to_unix() * 1000 + now.get_microsecond() / 1000);
        this._syncReminder(now, format24);
        this._maybeWeather();
        this._maybePhoto();
        this._maybeStatus();
    }

    _syncTimers(nowMs) {
        const timers = timersOf(this._snapshot).filter(t => t.endsMs > nowMs - 1000);
        const seen = new Set();
        for (const [i, t] of timers.entries()) {
            seen.add(t.id);
            let row = this._timerRows.get(t.id);
            if (!row) {
                row = {box: new St.BoxLayout({style_class: 'balaur-ambient-card', orientation: Clutter.Orientation.VERTICAL})};
                row.label = new St.Label({style_class: 'balaur-ambient-card-label'});
                row.time = new St.Label({style_class: 'balaur-ambient-timer'});
                row.box.add_child(row.label);
                row.box.add_child(row.time);
                this._timerRows.set(t.id, row);
                this._side.insert_child_at_index(row.box, i);
            }
            setText(row.label, t.label);
            setText(row.time, countdown((t.endsMs - nowMs) / 1000));
        }
        for (const [id, row] of this._timerRows) {
            if (!seen.has(id)) {
                row.box.destroy();
                this._timerRows.delete(id);
            }
        }
    }

    _syncReminder(now, format24) {
        const r = nextReminder(this._snapshot, now.to_unix() * 1000);
        this._reminder.visible = !!r;
        if (r) {
            setText(this._reminderWhen, whenText(r.atMs, now, format24));
            setText(this._reminderText, r.text);
        }
    }

    async _maybeWeather() {
        const loc = this._cfg.location;
        const age = (GLib.get_monotonic_time() - this._weatherAt) / 1e6;
        const due = this._weatherAt === 0 || age > (this._weather ? WEATHER_TTL_S : WEATHER_RETRY_S);
        if (!loc || this._weatherBusy || !due)
            return;
        this._weatherBusy = true;
        this._weatherAt = GLib.get_monotonic_time();
        try {
            const w = parseWeather(await this._http.getJSON(weatherUrl(loc), {}, this._cancellable));
            if (w)
                this._weather = w;
        } catch (e) {
            if (!e.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED))
                console.warn(`balaur ambient: weather: ${e.message}`);
        } finally {
            this._weatherBusy = false;
        }
        if (!this._root || !this._weather)
            return;
        this._weatherRow.visible = true;
        this._weatherIcon.icon_name = this._weather.icon;
        setText(this._weatherTemp, `${this._weather.temp}°`);
        setText(this._weatherText, weatherLine(this._weather));
    }

    async _maybeStatus() {
        const due = this._statusAt === 0 || (GLib.get_monotonic_time() - this._statusAt) / 1e6 >= STATUS_S;
        if (!this._fleet || this._statusBusy || !due)
            return;
        this._statusBusy = true;
        this._statusAt = GLib.get_monotonic_time();
        let status = null;
        try {
            status = await this._fleet.refresh(this._cancellable);
        } catch (e) {
            if (!e.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED))
                console.warn(`balaur ambient: status: ${e.message}`);
        } finally {
            this._statusBusy = false;
        }
        if (!this._root || !status)
            return;

        // A handful of rows every 30 s: rebuilt rather than diffed.
        this._machineBox.destroy_all_children();
        for (const m of status.machines)
            this._machineBox.add_child(statusRow(m.kind, m.name, m.text));
        for (const col of this._serviceColumns)
            col.destroy_all_children();
        const half = Math.ceil(status.services.length / 2);
        status.services.forEach((s, i) =>
            this._serviceColumns[i < half ? 0 : 1].add_child(statusRow(s.kind, s.label)));
        this._statusCard.visible = status.machines.length + status.services.length > 0;
    }

    async _maybePhoto() {
        const interval = this._cfg.photos?.intervalSeconds ?? 30;
        const due = !this._photo || (GLib.get_monotonic_time() - this._photoAt) / 1e6 >= interval;
        if (!this._photos || this._photoBusy || !due)
            return;
        this._photoBusy = true;
        this._photoAt = GLib.get_monotonic_time();
        try {
            await this._nextPhoto();
        } catch (e) {
            if (!e.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED))
                console.warn(`balaur ambient: photo: ${e.message}`);
        } finally {
            this._photoBusy = false;
        }
    }

    async _nextPhoto() {
        const id = await this._photos.nextId(this._cancellable);
        if (!id || !this._root)
            return;
        const m = Main.layoutManager.primaryMonitor;
        const scale = m.geometry_scale ?? 1;
        const [w, h] = [Math.round(m.width * scale), Math.round(m.height * scale)];
        // Decoded in a worker thread (GdkPixbuf's async loader).
        const pixbuf = this._photos instanceof FolderPhotos
            ? await this._decodeFile(id, w, h)
            : await this._decode(Gio.MemoryInputStream.new_from_bytes(
                await this._photos.image(id, w, h, this._cancellable)));
        if (!this._root || !this._shown)
            return;
        const img = pixbuf.apply_embedded_orientation() ?? pixbuf;
        const content = St.ImageContent.new_with_preferred_size(img.width, img.height);
        content.set_bytes(
            global.stage.context.get_backend().get_cogl_context(),
            img.read_pixel_bytes(),
            img.has_alpha ? Cogl.PixelFormat.RGBA_8888 : Cogl.PixelFormat.RGB_888,
            img.width, img.height, img.rowstride);

        const photo = {actor: new Clutter.Actor({content, opacity: 0}), width: img.width, height: img.height};
        this._fit(photo);
        this._photoLayer.add_child(photo.actor);
        const old = this._photo;
        this._photo = photo;
        photo.actor.ease({
            opacity: 255,
            duration: PHOTO_FADE_MS,
            mode: Clutter.AnimationMode.EASE_IN_OUT_QUAD,
            onStopped: () => old?.actor.destroy(),
        });
    }

    /** A stream -> Pixbuf, at a size or as it is. */
    _decode(stream, size = null) {
        return new Promise((resolve, reject) => {
            const done = (o, res) => {
                try {
                    resolve(GdkPixbuf.Pixbuf.new_from_stream_finish(res));
                } catch (e) {
                    reject(e);
                }
            };
            if (size)
                GdkPixbuf.Pixbuf.new_from_stream_at_scale_async(stream, size.width, size.height, true, this._cancellable, done);
            else
                GdkPixbuf.Pixbuf.new_from_stream_async(stream, this._cancellable, done);
        });
    }

    /** A photo file, decoded no larger than the screen needs (its header gives the size first). */
    async _decodeFile(path, w, h) {
        const [format, imgW, imgH] = await new Promise((resolve, reject) => {
            GdkPixbuf.Pixbuf.get_file_info_async(path, this._cancellable, (o, res) => {
                try {
                    resolve(GdkPixbuf.Pixbuf.get_file_info_finish(res));
                } catch (e) {
                    reject(e);
                }
            });
        });
        if (!format)
            throw new Error(`${path}: not a picture GdkPixbuf can read`);
        const file = Gio.File.new_for_path(path);
        const stream = await new Promise((resolve, reject) => {
            file.read_async(GLib.PRIORITY_LOW, this._cancellable, (f, res) => {
                try {
                    resolve(f.read_finish(res));
                } catch (e) {
                    reject(e);
                }
            });
        });
        try {
            return await this._decode(stream, decodeSize(imgW, imgH, w, h));
        } finally {
            stream.close(null);
        }
    }

    _fit(photo) {
        const m = Main.layoutManager.primaryMonitor;
        const r = coverRect(photo.width, photo.height, m.width, m.height);
        photo.actor.set_position(r.x, r.y);
        photo.actor.set_size(r.width, r.height);
    }

    _clearSource(field) {
        if (this[field]) {
            GLib.source_remove(this[field]);
            this[field] = 0;
        }
    }
}

/** A coloured dot, a name, and optionally a dimmer note on the right. */
function statusRow(kind, name, note = null) {
    const row = new St.BoxLayout({style_class: 'balaur-ambient-status-row'});
    row.add_child(new St.Widget({
        style_class: `balaur-ambient-dot balaur-ambient-dot-${kind}`,
        y_align: Clutter.ActorAlign.CENTER,
    }));
    const label = new St.Label({style_class: 'balaur-ambient-status-name', text: name, y_align: Clutter.ActorAlign.CENTER});
    label.clutter_text.ellipsize = Pango.EllipsizeMode.END;
    row.add_child(label);
    if (note !== null) {
        row.add_child(new St.Label({
            style_class: `balaur-ambient-status-note balaur-ambient-note-${kind}`,
            text: note,
            x_expand: true,
            x_align: Clutter.ActorAlign.END,
            y_align: Clutter.ActorAlign.CENTER,
        }));
    }
    return row;
}

// Setting the same text again still relayouts; skip it.
function setText(label, text) {
    if (label.text !== text)
        label.text = text;
}
