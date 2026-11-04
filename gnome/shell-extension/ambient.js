// The ambient screen: when nobody has touched the Duet for a while, a
// full-screen view that is readable across the room. It shows a big clock and
// the date, the weather, the running timers and the next reminder, over a
// slow slideshow from the Jellyfin photo library.
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
//   scaled by Jellyfin to the screen size, then decoded off the main thread.
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
    Http, JellyfinPhotos, clockText, countdown, coverRect, loadConfig,
    nextReminder, parseWeather, timersOf, weatherLine, weatherUrl, whenText,
} from './ambient-data.js';

const FADE_MS = 400;
const PHOTO_FADE_MS = 1500;
const RECHECK_S = 30; // idle but held back (film, call): look again this often
const WEATHER_TTL_S = 15 * 60;
const WEATHER_RETRY_S = 5 * 60;
const PRESENCE_APP_ID = 'duet-presence';
const IDLE_INHIBIT = 8; // GsmInhibitorFlag IDLE

export class AmbientScreen {
    constructor() {
        this._cfg = loadConfig();
        this._http = new Http();
        this._photos = this._cfg.photos ? new JellyfinPhotos(this._cfg.photos, this._http) : null;
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

        const front = new St.BoxLayout({
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

        // Right: timers (live countdowns) and the next reminder.
        this._side = new St.BoxLayout({
            style_class: 'balaur-ambient-side',
            orientation: Clutter.Orientation.VERTICAL,
            y_align: Clutter.ActorAlign.END,
        });
        front.add_child(this._side);
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

    _place() {
        const m = Main.layoutManager.primaryMonitor;
        if (!m || !this._root)
            return;
        this._root.set_position(m.x, m.y);
        this._root.set_size(m.width, m.height);
        this._reminder.style = `max-width: ${Math.round(m.width * 0.4)}px;`;
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
        const bytes = await this._photos.image(id, w, h, this._cancellable);
        // Decoded in a worker thread (GdkPixbuf's async loader).
        const pixbuf = await new Promise((resolve, reject) => {
            GdkPixbuf.Pixbuf.new_from_stream_async(Gio.MemoryInputStream.new_from_bytes(bytes), this._cancellable, (o, res) => {
                try {
                    resolve(GdkPixbuf.Pixbuf.new_from_stream_finish(res));
                } catch (e) {
                    reject(e);
                }
            });
        });
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

// Setting the same text again still relayouts; skip it.
function setText(label, text) {
    if (label.text !== text)
        label.text = text;
}
