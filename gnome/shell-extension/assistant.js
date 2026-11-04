// The org.duet.Assistant D-Bus API (gnome/CONTRACT.md) and a small client
// for it. Pure Gio/GLib on purpose: no Shell imports, so it can be loaded
// with plain `gjs -m` (tools/mock-assistant.js and tools/watch-assistant.js
// use it) as well as inside GNOME Shell.

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

export const BUS_NAME = 'org.duet.Assistant';
export const OBJECT_PATH = '/org/duet/Assistant';
export const INTERFACE_NAME = 'org.duet.Assistant1';
export const ERROR_FAILED = 'org.duet.Assistant.Error.Failed';

// Verbatim from gnome/CONTRACT.md (comments dropped).
export const INTERFACE_XML = `
<node>
  <interface name="org.duet.Assistant1">
    <property name="State" type="s" access="read"/>
    <property name="Caption" type="s" access="read"/>
    <property name="Muted" type="b" access="readwrite"/>
    <property name="Volume" type="u" access="readwrite"/>
    <property name="Name" type="s" access="read"/>
    <property name="WakeWord" type="s" access="read"/>
    <property name="Error" type="s" access="read"/>
    <property name="Snapshot" type="s" access="read"/>
    <method name="Ask">
      <arg name="text" type="s" direction="in"/>
      <arg name="speak" type="b" direction="in"/>
      <arg name="reply" type="s" direction="out"/>
    </method>
    <method name="Stop"/>
    <method name="ListAdd"><arg name="list" type="s" direction="in"/><arg name="text" type="s" direction="in"/></method>
    <method name="ListSetDone"><arg name="list" type="s" direction="in"/><arg name="id" type="s" direction="in"/><arg name="done" type="b" direction="in"/></method>
    <method name="ListRemove"><arg name="list" type="s" direction="in"/><arg name="id" type="s" direction="in"/></method>
    <method name="ListClearDone"><arg name="list" type="s" direction="in"/></method>
    <method name="MemoryAdd"><arg name="fact" type="s" direction="in"/></method>
    <method name="MemoryRemove"><arg name="id" type="s" direction="in"/></method>
    <method name="TimerCancel"><arg name="id" type="s" direction="in"/></method>
    <method name="ReminderCancel"><arg name="id" type="s" direction="in"/></method>
  </interface>
</node>`;

// States in which the orb overlay is on screen.
export const ACTIVE_STATES = ['listening', 'thinking', 'speaking', 'ringing'];

const AssistantProxy = Gio.DBusProxy.makeProxyWrapper(INTERFACE_XML);

// Never D-Bus-activate the daemon: it is a systemd user service and we only
// want to observe it, not start it.
const CALL_FLAGS = Gio.DBusCallFlags.NO_AUTO_START;

/**
 * Watches the assistant on the session bus and reports a plain snapshot of
 * what the Shell UI needs whenever anything changes (including the daemon
 * appearing or vanishing).
 *
 * One GDBusProxy does all the watching: with a well-known name it follows the
 * name owner by itself (g-name-owner), re-reads every property when a new
 * owner appears and drops them when it goes, so no separate bus_watch_name
 * is needed.
 */
export class AssistantClient {
    /** @param {(status: object) => void} onChanged */
    constructor(onChanged) {
        this._onChanged = onChanged;
        this._cancellable = new Gio.Cancellable();
        this._proxy = null;
        this._proxySignals = [];
    }

    async start() {
        let proxy;
        try {
            proxy = await AssistantProxy.newAsync(
                Gio.DBus.session, BUS_NAME, OBJECT_PATH, this._cancellable,
                Gio.DBusProxyFlags.DO_NOT_AUTO_START);
        } catch (e) {
            if (!e.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED))
                console.error(`duet: cannot create the ${BUS_NAME} proxy: ${e.message}`);
            return;
        }
        if (this._cancellable.is_cancelled())
            return; // destroy() ran while we were waiting

        this._proxy = proxy;
        this._proxySignals = [
            proxy.connect('g-properties-changed', () => this._emit()),
            proxy.connect('notify::g-name-owner', () => this._emit()),
        ];
        this._emit();
    }

    destroy() {
        this._cancellable.cancel();
        if (this._proxy) {
            this._proxySignals.forEach(id => this._proxy.disconnect(id));
            this._proxySignals = [];
            this._proxy = null;
        }
        this._onChanged = null;
    }

    /** Snapshot of everything the UI shows. Safe to call any time. */
    get status() {
        const p = this._proxy;
        const running = !!p?.g_name_owner;
        // The wrapper's getters return null for properties not cached yet.
        const str = v => (running && typeof v === 'string' ? v : '');
        return {
            running,
            state: running ? str(p.State) || 'idle' : 'idle',
            caption: str(running ? p.Caption : ''),
            muted: running ? !!p.Muted : false,
            name: str(running ? p.Name : ''),
            wakeWord: str(running ? p.WakeWord : ''),
            error: str(running ? p.Error : ''),
        };
    }

    setMuted(muted) {
        // An explicit Properties.Set call (rather than the wrapper's setter)
        // so failures are logged; the UI follows the PropertiesChanged that
        // the daemon sends back, so it never shows a state it isn't in.
        this._call('org.freedesktop.DBus.Properties.Set',
            new GLib.Variant('(ssv)', [INTERFACE_NAME, 'Muted', new GLib.Variant('b', muted)]));
    }

    stop() {
        this._call('Stop', null);
    }

    _call(method, params) {
        if (!this._proxy?.g_name_owner)
            return;
        this._proxy.call(method, params, CALL_FLAGS, -1, this._cancellable, (proxy, res) => {
            try {
                proxy.call_finish(res);
            } catch (e) {
                if (!e.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED))
                    console.warn(`duet: ${method} failed: ${e.message}`);
            }
        });
    }

    _emit() {
        this._onChanged?.(this.status);
    }
}

/** "hey_jarvis" -> "Hey Jarvis"; falls back to "Hey <Name>". */
export function wakePhrase(status) {
    if (status.wakeWord) {
        return status.wakeWord.split(/[_\s-]+/).filter(Boolean)
            .map(w => w[0].toUpperCase() + w.slice(1)).join(' ');
    }
    return status.name ? `Hey ${status.name}` : 'the wake word';
}

/** Quick Settings subtitle for a status snapshot. */
export function describe(status) {
    if (!status.running)
        return 'Not running';
    if (status.muted || status.state === 'muted')
        return 'Microphone off';
    switch (status.state) {
    case 'listening': return 'Listening…';
    case 'thinking': return 'Thinking…';
    case 'speaking': return 'Speaking…';
    case 'ringing': return 'Alarm ringing';
    default: return `Listening for ${wakePhrase(status)}`;
    }
}

/** Big title over the caption in the overlay. */
export function overlayTitle(state) {
    return {
        listening: 'Listening…',
        thinking: 'Thinking…',
        speaking: 'Speaking',
        ringing: 'Alarm',
    }[state] ?? '';
}

// Long replies would push the orb off a landscape screen at 200% scale; show
// the start and an ellipsis (the whole reply is in the app's conversation).
const CAPTION_MAX = 220;

export function trimCaption(text) {
    text = (text ?? '').replace(/\s+/g, ' ').trim();
    if (text.length <= CAPTION_MAX)
        return text;
    const cut = text.lastIndexOf(' ', CAPTION_MAX);
    const head = text.slice(0, cut > CAPTION_MAX * 0.6 ? cut : CAPTION_MAX);
    return `${head.replace(/[\s.,;:!?…]+$/, '')}…`;
}
