// Client for the voice assistant daemon, org.duet.Assistant on the session bus
// (API in gnome/CONTRACT.md). One instance per app; every page reads from it
// and listens to its `changed` signal.
//
// We use a plain Gio.DBusProxy with the interface info so GLib caches and
// type-checks the properties for us and keeps them fresh from
// PropertiesChanged. It follows the bus name: when the daemon goes away the
// cache empties, and when it comes back GLib re-reads every property before
// telling us (notify::g-name-owner).

import GObject from 'gi://GObject';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

Gio._promisify(Gio.DBusProxy.prototype, 'call');
Gio._promisify(Gio.DBusConnection.prototype, 'call');

const BUS_NAME = 'org.duet.Assistant';
const OBJECT_PATH = '/org/duet/Assistant';
const IFACE_NAME = 'org.duet.Assistant1';

const IFACE_XML = `
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
    <property name="Models" type="s" access="read"/>
    <property name="ApiKeys" type="s" access="read"/>
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
    <method name="SetApiKey"><arg name="provider" type="s" direction="in"/><arg name="key" type="s" direction="in"/></method>
    <method name="TestModel"><arg name="error" type="s" direction="out"/></method>
  </interface>
</node>`;

const IFACE_INFO = Gio.DBusNodeInfo.new_for_xml(IFACE_XML).interfaces[0];

// An answer can take a while (speech-to-text, LLM, web search); D-Bus'
// default 25 s timeout would cut long ones off.
const ASK_TIMEOUT_MS = 180 * 1000;

// What the pages see when the daemon is away or sends something unreadable.
function emptySnapshot() {
    return {log: [], timers: [], reminders: [], lists: {}, listOrder: [], memories: []};
}

// Fill in missing fields so pages never have to check for undefined (the Go
// service sends `null` for some empty slices).
function normalize(s) {
    const out = emptySnapshot();
    if (!s || typeof s !== 'object')
        return out;
    for (const key of ['log', 'timers', 'reminders', 'memories', 'listOrder'])
        out[key] = Array.isArray(s[key]) ? s[key] : [];
    out.lists = s.lists && typeof s.lists === 'object' ? s.lists : {};
    // Lists that exist but aren't in listOrder still deserve a place.
    for (const name of Object.keys(out.lists)) {
        if (!out.listOrder.includes(name))
            out.listOrder.push(name);
    }
    for (const name of out.listOrder)
        out.lists[name] = Array.isArray(out.lists[name]) ? out.lists[name] : [];
    return out;
}

export const Assistant = GObject.registerClass({
    Properties: {
        'available': GObject.ParamSpec.boolean('available', null, null,
            GObject.ParamFlags.READABLE, false),
        // Typed questions in flight, so the page can show it's waiting.
        'asking': GObject.ParamSpec.boolean('asking', null, null,
            GObject.ParamFlags.READABLE, false),
    },
    Signals: {
        // Any property or the snapshot changed (or availability flipped).
        'changed': {},
    },
}, class Assistant extends GObject.Object {
    constructor() {
        super();
        this.snapshot = emptySnapshot();
        this._asking = 0;
        this._proxy = null;
        try {
            this._proxy = Gio.DBusProxy.new_for_bus_sync(Gio.BusType.SESSION,
                // Never start anything: the daemon is a systemd user service.
                Gio.DBusProxyFlags.DO_NOT_AUTO_START,
                IFACE_INFO, BUS_NAME, OBJECT_PATH, IFACE_NAME, null);
        } catch (e) {
            logError(e, 'Cannot reach the session bus');
            return;
        }
        this._proxy.connect('g-properties-changed', (_p, changed) => {
            if (changed.lookup_value('Snapshot', null))
                this._readSnapshot();
            this.emit('changed');
        });
        this._proxy.connect('notify::g-name-owner', () => {
            this._readSnapshot();
            this.notify('available');
            this.emit('changed');
        });
        this._readSnapshot();
    }

    get available() {
        return this._proxy !== null && this._proxy.g_name_owner !== null;
    }

    get asking() {
        return this._asking > 0;
    }

    _prop(name, fallback) {
        const v = this._proxy?.get_cached_property(name);
        return v ? v.deepUnpack() : fallback;
    }

    get state() { return this._prop('State', 'idle'); }
    get caption() { return this._prop('Caption', ''); }
    get muted() { return this._prop('Muted', false); }
    get volume() { return this._prop('Volume', 0); }
    get name() { return this._prop('Name', '') || 'Assistant'; }
    get wakeWord() { return this._prop('WakeWord', ''); }

    // pi's model catalog: [{id, name, models: [{id, name}]}] (empty while
    // the daemon is away or hasn't heard from its agent yet).
    get providers() {
        try {
            const p = JSON.parse(this._prop('Models', '') || '{}').providers;
            return Array.isArray(p) ? p.filter(x => x && typeof x.id === 'string') : [];
        } catch {
            return [];
        }
    }

    // Which providers have an API key stored: {mistral: true, ...}.
    get apiKeys() {
        try {
            const k = JSON.parse(this._prop('ApiKeys', '') || '{}');
            return k && typeof k === 'object' ? k : {};
        } catch {
            return {};
        }
    }
    get error() { return this._prop('Error', ''); }

    // "hey_jarvis_v0.1, alexa" -> "Hey Jarvis", as the old dashboard did.
    get wakePhrase() {
        const first = this.wakeWord.split(',')[0].trim().replace(/_v[\d.]+$/, '');
        if (!first)
            return `Hey ${this.name}`;
        return first.split('_').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
    }

    _readSnapshot() {
        const json = this._prop('Snapshot', '');
        try {
            this.snapshot = normalize(json ? JSON.parse(json) : null);
        } catch (e) {
            logError(e, 'Unreadable Snapshot from the assistant');
            this.snapshot = emptySnapshot();
        }
    }

    // Calls a method; on failure throws an Error whose message is the
    // daemon's human text (D-Bus error name stripped), ready for a toast.
    async _call(method, signature = null, args = [], timeout = -1) {
        if (!this._proxy)
            throw new Error('No session bus');
        const params = signature ? new GLib.Variant(signature, args) : null;
        try {
            return await this._proxy.call(method, params, Gio.DBusCallFlags.NONE, timeout, null);
        } catch (e) {
            throw humanError(e);
        }
    }

    async _set(property, variant) {
        try {
            await this._proxy.get_connection().call(BUS_NAME, OBJECT_PATH,
                'org.freedesktop.DBus.Properties', 'Set',
                new GLib.Variant('(ssv)', [IFACE_NAME, property, variant]),
                null, Gio.DBusCallFlags.NONE, -1, null);
        } catch (e) {
            throw humanError(e);
        }
    }

    async ask(text, speak = true) {
        this._asking++;
        this.notify('asking');
        this.emit('changed');
        try {
            const [reply] = (await this._call('Ask', '(sb)', [text, speak], ASK_TIMEOUT_MS)).deepUnpack();
            return reply;
        } finally {
            this._asking--;
            this.notify('asking');
            this.emit('changed');
        }
    }

    stop() { return this._call('Stop'); }
    setMuted(muted) { return this._set('Muted', new GLib.Variant('b', muted)); }
    setVolume(volume) { return this._set('Volume', new GLib.Variant('u', volume)); }
    listAdd(list, text) { return this._call('ListAdd', '(ss)', [list, text]); }
    listSetDone(list, id, done) { return this._call('ListSetDone', '(ssb)', [list, id, done]); }
    listRemove(list, id) { return this._call('ListRemove', '(ss)', [list, id]); }
    listClearDone(list) { return this._call('ListClearDone', '(s)', [list]); }
    memoryAdd(fact) { return this._call('MemoryAdd', '(s)', [fact]); }
    memoryRemove(id) { return this._call('MemoryRemove', '(s)', [id]); }
    timerCancel(id) { return this._call('TimerCancel', '(s)', [id]); }
    reminderCancel(id) { return this._call('ReminderCancel', '(s)', [id]); }
    // "" deletes the key.
    setApiKey(provider, key) { return this._call('SetApiKey', '(ss)', [provider, key]); }

    // One small request with the current settings; resolves to "" when it
    // worked, else the human error. Network round trip, so allow a minute.
    async testModel() {
        const [error] = (await this._call('TestModel', null, [], 60 * 1000)).deepUnpack();
        return error;
    }
});

// GLib.Error from D-Bus -> Error with just the human part of the message.
function humanError(e) {
    if (e instanceof GLib.Error) {
        if (Gio.DBusError.is_remote_error(e))
            Gio.DBusError.strip_remote_error(e);
        if (e.matches(Gio.DBusError, Gio.DBusError.SERVICE_UNKNOWN) ||
            e.matches(Gio.DBusError, Gio.DBusError.NAME_HAS_NO_OWNER))
            return new Error("The assistant isn't running");
        return new Error(e.message);
    }
    return e;
}
