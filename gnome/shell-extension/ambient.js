// The ambient screen: when nobody has touched the Duet for a while, a
// full-screen view that is readable across the room. It shows a big clock,
// the date and the weather over a slow slideshow (a synced folder, or
// Jellyfin), and on the side how the fleet's machines and the home's services
// are doing (ambient-status.js).
//
// - Shown by Mutter's idle monitor (real input only), after `idleSeconds`.
//   Movement in front of the camera does not end it: it keeps the screen
//   awake (duet-presence), so the view stays up while people are in the room.
//   GNOME still blanks the screen when nobody is there.
// - Any touch, click or key ends it. The view holds a modal grab while it is
//   up, so that first tap or key press lands on it, not on the app underneath.
// - Not shown over a full-screen window (a film) or while another app holds
//   an idle inhibitor (a video call, a player), and taken down when one
//   starts while it is up. duet-presence's own inhibitor doesn't count: the
//   idle watch ignores inhibitors, and _heldBack() decides.
// - Lean: no ticking, downloads or decoding while it is hidden. Photos are
//   decoded at about the screen's size (scaled by Jellyfin, or while decoding
//   a file), off the main thread.
//   Each one fades in with a Clutter transition.

import Clutter from 'gi://Clutter';
import Cogl from 'gi://Cogl';
import GdkPixbuf from 'gi://GdkPixbuf';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Meta from 'gi://Meta';
import Pango from 'gi://Pango';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import {
    FolderPhotos, Http, JellyfinPhotos, clockText, decodeSize, coverRect, loadConfig,
    parseWeather, refreshDue, weatherLine, weatherUrl,
} from './ambient-data.js';
import {FleetStatus} from './ambient-status.js';

const FADE_MS = 400;
const PHOTO_FADE_MS = 1500;
const RECHECK_S = 30; // idle but held back (film, call): look again this often
const WEATHER_TTL_S = 15 * 60;
const WEATHER_RETRY_S = 5 * 60;
const WEATHER_STALE_S = 2 * 3600; // a reading older than this is not shown as current
const PHOTO_RETRY_S = 60; // no photo yet (empty folder, server down): try again this often
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
        this._weather = null;
        this._weatherAt = 0; // monotonic µs of the last attempt
        this._weatherOkAt = 0; // ... and of the last success
        this._weatherBusy = false;
        this._photoBusy = false;
        this._photoAt = 0;
        this._photo = null; // {actor, width, height}
        this._statusBusy = false;
        this._statusAt = 0;
        this._heldAt = 0; // when _heldBack() last ran while shown
        this._heldBusy = false;
        this._grab = null;
        this._fullscreenId = 0;

        this._buildUi();

        // Uninhibitable: duet-presence holds an idle inhibitor for as long as
        // anyone is moving in the room, which must not keep the screen away.
        this._monitor = global.backend.get_core_idle_monitor();
        this._idleWatch = this._cfg.idleSeconds > 0
            ? this._monitor.add_idle_watch_full(this._cfg.idleSeconds * 1000, () => this._onIdle(),
                Meta.IdleMonitorWatchFlags.UNINHIBITABLE)
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
        this._idleWatch = this._activeWatch = 0;
        this._clearSource('_recheckId');
        this._clearSource('_tickId');
        this._unwatchFullscreen();
        this._popGrab();
        Main.layoutManager.disconnect(this._monitorsId);
        this._root?.destroy();
        this._root = null;
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

        // Right: the machines and services.
        this._side = new St.BoxLayout({
            style_class: 'balaur-ambient-side',
            orientation: Clutter.Orientation.VERTICAL,
            y_align: Clutter.ActorAlign.END,
        });
        front.add_child(this._side);
        this._buildStatus();

        // Above the windows and the top bar, below the notification banners
        // (so they still show).
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
        // Landscape: the clock on the left, the status card on the right. Portrait
        // (the tablet turned) has no room for both side by side: the card goes
        // above the clock, at the full width.
        const portrait = m.height > m.width;
        this._front.orientation = portrait ? Clutter.Orientation.VERTICAL : Clutter.Orientation.HORIZONTAL;
        this._front.set_child_at_index(this._side, portrait ? 0 : 1);
        this._side.x_align = portrait ? Clutter.ActorAlign.FILL : Clutter.ActorAlign.END;
        this._statusCard.style = `max-width: ${Math.round(m.width * (portrait ? 0.9 : 0.45))}px;`;
        if (this._photo)
            this._fit(this._photo);
    }

    // ---- idle -> shown -> active -------------------------------------------------

    async _onIdle() {
        if (!this._root)
            return;
        if (!this._activeWatch)
            this._activeWatch = this._monitor.add_user_active_watch(() => this._onActive());
        if (this._shown)
            return;
        const held = await this._heldBack();
        if (!this._root) // disabled during the D-Bus calls
            return;
        if (held) {
            this._recheckLater();
            return;
        }
        if (this._activeWatch) // still idle after the await
            this._show();
    }

    // Look again later, as long as nobody touches anything.
    _recheckLater() {
        if (this._recheckId)
            return;
        this._recheckId = GLib.timeout_add_seconds(GLib.PRIORITY_LOW, RECHECK_S, () => {
            this._recheckId = 0;
            this._onIdle();
            return GLib.SOURCE_REMOVE;
        });
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
            if (!e.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED))
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
        if (!this._grab) {
            try {
                this._grab = Main.pushModal(this._root);
            } catch (e) {
                console.warn(`balaur ambient: no modal grab: ${e.message}`);
                this._recheckLater();
                return;
            }
        }
        this._shown = true;
        this._heldAt = GLib.get_monotonic_time();
        this._fullscreenId = global.display.connect('in-fullscreen-changed', () => this._checkHeld());
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
        this._unwatchFullscreen();
        // The grab stays while it fades, so the touch or key that ended it
        // doesn't reach the app underneath.
        this._root?.ease({
            opacity: 0,
            duration: FADE_MS,
            mode: Clutter.AnimationMode.EASE_OUT_QUAD,
            onStopped: () => {
                if (this._root && !this._shown) {
                    this._root.hide();
                    this._popGrab();
                }
            },
        });
    }

    _popGrab() {
        if (!this._grab)
            return;
        const grab = this._grab;
        this._grab = null;
        try {
            Main.popModal(grab);
        } catch (e) {
            console.warn(`balaur ambient: popModal: ${e.message}`);
        }
    }

    _unwatchFullscreen() {
        if (this._fullscreenId) {
            global.display.disconnect(this._fullscreenId);
            this._fullscreenId = 0;
        }
    }

    // A film or call that starts while the screen is up (no input to end it).
    async _checkHeld() {
        if (!this._shown || this._heldBusy)
            return;
        this._heldBusy = true;
        this._heldAt = GLib.get_monotonic_time();
        let held = false;
        try {
            held = await this._heldBack();
        } finally {
            this._heldBusy = false;
        }
        if (held && this._root && this._shown) {
            this._hide();
            this._recheckLater();
        }
    }

    // ---- what is on it ---------------------------------------------------------------

    _tick() {
        const now = GLib.DateTime.new_now_local();
        const format24 = this._iface.get_string('clock-format') !== '12h';
        setText(this._clock, clockText(now, format24));
        setText(this._date, now.format('%A, %-d %B'));
        this._maybeWeather();
        this._maybePhoto();
        this._maybeStatus();
        if (refreshDue(this._heldAt, GLib.get_monotonic_time(), true, STATUS_S, STATUS_S))
            this._checkHeld();
    }

    async _maybeWeather() {
        const loc = this._cfg.location;
        const now = GLib.get_monotonic_time();
        if (this._weather && (now - this._weatherOkAt) / 1e6 > WEATHER_STALE_S) {
            this._weather = null;
            this._weatherRow.visible = false;
        }
        if (!loc || this._weatherBusy || !refreshDue(this._weatherAt, now, !!this._weather, WEATHER_TTL_S, WEATHER_RETRY_S))
            return;
        this._weatherBusy = true;
        this._weatherAt = now;
        try {
            const w = parseWeather(await this._http.getJSON(weatherUrl(loc), {}, this._cancellable));
            if (w) {
                this._weather = w;
                this._weatherOkAt = GLib.get_monotonic_time();
            }
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
        if (!this._fleet || this._statusBusy || !refreshDue(this._statusAt, GLib.get_monotonic_time(), true, STATUS_S, STATUS_S))
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
        if (!this._photos || this._photoBusy
            || !refreshDue(this._photoAt, GLib.get_monotonic_time(), !!this._photo, interval, PHOTO_RETRY_S))
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
            // Disabled during the crossfade: the actors went with the root.
            onStopped: () => {
                if (this._root)
                    old?.actor.destroy();
            },
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
