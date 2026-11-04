// Live state of one systemd unit, read over D-Bus from systemd itself:
// org.freedesktop.systemd1 on the system bus for system units, the user
// session's own systemd on the session bus for `user:<unit>` ones.
//
// Reading unit state needs no privileges. We ask the manager to load the
// unit (LoadUnit works for units that are not loaded yet, where GetUnit
// would fail), then keep a proxy on the unit object whose cached
// ActiveState/SubState GLib refreshes from PropertiesChanged.

import GObject from 'gi://GObject';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

Gio._promisify(Gio.DBusConnection.prototype, 'call');

const SYSTEMD = 'org.freedesktop.systemd1';
const MANAGER_PATH = '/org/freedesktop/systemd1';
const MANAGER_IFACE = 'org.freedesktop.systemd1.Manager';
const UNIT_IFACE = 'org.freedesktop.systemd1.Unit';

// systemd only broadcasts unit changes while at least one client has called
// Subscribe(); do it once per bus so we don't depend on someone else.
const subscribed = new Set();

async function subscribe(conn, busType) {
    if (subscribed.has(busType))
        return;
    subscribed.add(busType);
    try {
        await conn.call(SYSTEMD, MANAGER_PATH, MANAGER_IFACE, 'Subscribe',
            null, null, Gio.DBusCallFlags.NONE, -1, null);
    } catch (e) {
        // Already subscribed on this connection, or not allowed: changes
        // still arrive whenever anyone else is subscribed (GNOME usually is).
        log(`systemd Subscribe on ${busType === Gio.BusType.SYSTEM ? 'system' : 'session'} bus: ${e.message}`);
    }
}

export const UnitWatcher = GObject.registerClass({
    Signals: {'changed': {}},
}, class UnitWatcher extends GObject.Object {
    // spec: "foo.service" (system) or "user:foo.service" (user session).
    constructor(spec) {
        super();
        this.isUser = spec.startsWith('user:');
        this.unit = this.isUser ? spec.slice('user:'.length) : spec;
        this._proxy = null;
        this._signal = 0;
        this._failure = null;
        this._start().catch(e => {
            this._failure = e.message;
            this.emit('changed');
        });
    }

    async _start() {
        const busType = this.isUser ? Gio.BusType.SESSION : Gio.BusType.SYSTEM;
        const conn = Gio.bus_get_sync(busType, null);
        await subscribe(conn, busType);
        const reply = await conn.call(SYSTEMD, MANAGER_PATH, MANAGER_IFACE, 'LoadUnit',
            new GLib.Variant('(s)', [this.unit]), new GLib.VariantType('(o)'),
            Gio.DBusCallFlags.NONE, -1, null);
        const [path] = reply.deepUnpack();
        if (this._disposed)
            return;
        this._proxy = await new Promise((resolve, reject) => {
            Gio.DBusProxy.new(conn,
                // systemd announces some changes as "invalidated" without a
                // value; this flag makes GLib fetch those instead of dropping them.
                Gio.DBusProxyFlags.GET_INVALIDATED_PROPERTIES,
                null, SYSTEMD, path, UNIT_IFACE, null, (_o, res) => {
                    try {
                        resolve(Gio.DBusProxy.new_finish(res));
                    } catch (e) {
                        reject(e);
                    }
                });
        });
        if (this._disposed)
            return;
        this._signal = this._proxy.connect('g-properties-changed', () => this.emit('changed'));
        this.emit('changed');
    }

    _prop(name) {
        return this._proxy?.get_cached_property(name)?.deepUnpack() ?? '';
    }

    // {label, kind}: what to print and how to color it.
    // kind: 'ok' | 'busy' | 'bad' | 'off' | 'unknown'
    get status() {
        if (this._failure)
            return {label: 'Unknown', kind: 'unknown', detail: this._failure};
        if (!this._proxy)
            return {label: '…', kind: 'unknown', detail: ''};
        const load = this._prop('LoadState');
        const active = this._prop('ActiveState');
        const sub = this._prop('SubState');
        const detail = `${this.isUser ? 'user unit' : 'unit'} ${this.unit}: ${load}, ${active} (${sub})`;
        if (load === 'not-found')
            return {label: 'Not installed', kind: 'off', detail};
        switch (active) {
        case 'active':
        case 'reloading':
        case 'refreshing':
            return {label: 'Running', kind: 'ok', detail};
        case 'activating':
            return {label: 'Starting', kind: 'busy', detail};
        case 'deactivating':
            return {label: 'Stopping', kind: 'busy', detail};
        case 'failed':
            return {label: 'Failed', kind: 'bad', detail};
        case 'inactive':
            return {label: 'Stopped', kind: 'off', detail};
        default:
            return {label: active || 'Unknown', kind: 'unknown', detail};
        }
    }

    destroy() {
        this._disposed = true;
        if (this._proxy && this._signal)
            this._proxy.disconnect(this._signal);
        this._proxy = null;
    }
});
