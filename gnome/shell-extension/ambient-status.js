// The status side of the ambient screen: the fleet's machines and the home's
// services, at a glance from across the room.
//
// - Machines: `tailscale status --json` (its socket answers any local user),
//   so every machine on the tailnet shows, the phone too. This machine's own
//   row says how systemd is doing instead: all running, or how many units failed.
// - Services: /etc/balaur/services.json (the `fleet` aspect). A unit here is
//   read from systemd over D-Bus (one ListUnitsByNames per bus, no privileges
//   needed); a service on another machine is a TCP connection to its address,
//   skipped when Tailscale already says that machine is offline.
//
// Asked only while the ambient screen is up (ambient.js). Shell-free, so the
// pure helpers are tested with the rest (tests/test-ambient.js).

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

// ---- pure helpers -----------------------------------------------------------

/** An ISO time from Tailscale -> ms, or 0 when unknown (it says year 1 for "never"). */
function seenMs(iso) {
    const ms = typeof iso === 'string' ? Date.parse(iso) : NaN;
    return Number.isFinite(ms) && ms > Date.UTC(2000, 0, 1) ? ms : 0;
}

/**
 * `tailscale status --json` -> [{name, online, self, lastSeenMs}]: this
 * machine first, then the others by name. The name is the tailnet name
 * (`pc`, `phone`), which is what the fleet calls them, not the OS hostname.
 */
export function machinesOf(json) {
    const one = (p, self) => ({
        name: (p.DNSName ?? '').split('.')[0] || p.HostName || '?',
        online: self || p.Online === true,
        self,
        lastSeenMs: seenMs(p.LastSeen),
    });
    const peers = Object.values(json?.Peer ?? {})
        .filter(p => p && typeof p === 'object')
        .map(p => one(p, false))
        .sort((a, b) => a.name.localeCompare(b.name));
    return json?.Self ? [one(json.Self, true), ...peers] : peers;
}

/** "seen 5 min ago", "seen 3 h ago", "seen 2 days ago"; "offline" when unknown. */
export function seenText(lastSeenMs, nowMs) {
    if (!lastSeenMs)
        return 'offline';
    const min = Math.max(0, Math.floor((nowMs - lastSeenMs) / 60000));
    if (min < 60)
        return `seen ${Math.max(1, min)} min ago`;
    const h = Math.floor(min / 60);
    if (h < 48)
        return `seen ${h} h ago`;
    return `seen ${Math.floor(h / 24)} days ago`;
}

/** systemd's LoadState + ActiveState -> 'ok' | 'busy' | 'bad' | 'off' | 'unknown'. */
export function unitKind(load, active) {
    if (load === 'not-found')
        return 'off';
    switch (active) {
    case 'active':
    case 'reloading':
    case 'refreshing':
        return 'ok';
    case 'activating':
    case 'deactivating':
        return 'busy';
    case 'failed':
        return 'bad';
    case 'inactive':
        return 'off';
    default:
        return 'unknown';
    }
}

/** systemd's SystemState and the failed units -> {kind, text} for this machine's row. */
export function systemText(state, failed) {
    if (failed > 0)
        return {kind: 'bad', text: `${failed} failed`};
    switch (state) {
    case 'running':
        return {kind: 'ok', text: 'all running'};
    case 'initializing':
    case 'starting':
        return {kind: 'busy', text: 'starting'};
    case 'stopping':
        return {kind: 'busy', text: 'stopping'};
    case 'degraded':
    case 'maintenance':
        return {kind: 'bad', text: state};
    default:
        return {kind: 'unknown', text: state || '…'};
    }
}

/**
 * services.json -> what the screen lists: [{label, unit, user, url, host}].
 * Ones with neither a unit nor an address have no state to show. A service on
 * another machine is labelled with it ("Syncthing · pc").
 */
export function servicesOf(list) {
    return (Array.isArray(list) ? list : [])
        .filter(s => s && typeof s.name === 'string' && (s.unit || s.url))
        .map(s => {
            const spec = s.unit || '';
            const user = spec.startsWith('user:');
            return {
                label: s.host ? `${s.name} · ${s.host}` : s.name,
                unit: user ? spec.slice('user:'.length) : spec,
                user,
                url: s.url ?? null,
                host: s.host ?? null,
            };
        });
}

// ---- asking the machine ---------------------------------------------------------

const SYSTEMD = 'org.freedesktop.systemd1';
const MANAGER_PATH = '/org/freedesktop/systemd1';
const MANAGER_IFACE = 'org.freedesktop.systemd1.Manager';
const PROBE_TIMEOUT_S = 5;
const TAILSCALE_TIMEOUT_S = 10; // `tailscale status` can hang when tailscaled does

function dbusCall(bus, method, args, replyType, cancellable, iface = MANAGER_IFACE) {
    return new Promise((resolve, reject) => {
        bus.call(SYSTEMD, MANAGER_PATH, iface, method, args, new GLib.VariantType(replyType),
            Gio.DBusCallFlags.NO_AUTO_START, 5000, cancellable, (c, res) => {
                try {
                    resolve(c.call_finish(res).deepUnpack());
                } catch (e) {
                    reject(e);
                }
            });
    });
}

export class FleetStatus {
    /** @param {{tailscale: string|null, servicesFile: string}} cfg */
    constructor(cfg) {
        this._cfg = cfg;
        this._client = new Gio.SocketClient({timeout: PROBE_TIMEOUT_S});
    }

    /**
     * Everything the panel shows, each part on its own (one that fails leaves
     * the others): {machines: [{name, kind, text}], services: [{label, kind}]}.
     */
    async refresh(cancellable) {
        const [peers, system, services] = await Promise.all([
            this._tailscale(cancellable).catch(e => warn('tailscale', e)),
            this._system(cancellable).catch(e => warn('systemd', e)),
            Promise.resolve().then(() => this._services()).catch(e => warn('services', e)),
        ]);
        const nowMs = Date.now();

        const list = peers ?? [{name: GLib.get_host_name(), online: true, self: true, lastSeenMs: 0}];
        const machines = list.map(m => {
            if (m.self)
                return {name: m.name, ...(system ?? {kind: 'unknown', text: '…'})};
            return m.online
                ? {name: m.name, kind: 'ok', text: 'online'}
                : {name: m.name, kind: 'off', text: seenText(m.lastSeenMs, nowMs)};
        });

        const svc = services ?? [];
        const [systemUnits, userUnits] = await Promise.all([
            this._units(Gio.DBus.system, svc.filter(s => s.unit && !s.user), cancellable),
            this._units(Gio.DBus.session, svc.filter(s => s.unit && s.user), cancellable),
        ]);
        const offline = new Set((peers ?? []).filter(m => !m.online).map(m => m.name));
        const kinds = await Promise.all(svc.map(s => {
            if (s.unit)
                return (s.user ? userUnits : systemUnits).get(s.unit) ?? 'unknown';
            if (s.host && offline.has(s.host))
                return 'off';
            return this._probe(s.url, cancellable);
        }));
        return {machines, services: svc.map((s, i) => ({label: s.label, kind: kinds[i]}))};
    }

    async _tailscale(cancellable) {
        if (!this._cfg.tailscale)
            return null;
        const proc = Gio.Subprocess.new([this._cfg.tailscale, 'status', '--json'],
            Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_SILENCE);
        let killer = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, TAILSCALE_TIMEOUT_S, () => {
            killer = 0;
            proc.force_exit();
            return GLib.SOURCE_REMOVE;
        });
        let stdout;
        try {
            stdout = await new Promise((resolve, reject) => {
                proc.communicate_utf8_async(null, cancellable, (p, res) => {
                    try {
                        resolve(p.communicate_utf8_finish(res)[1]);
                    } catch (e) {
                        reject(e);
                    }
                });
            });
        } finally {
            if (killer)
                GLib.source_remove(killer);
        }
        // It prints the JSON even when it exits non-zero (logged out, stopped).
        return machinesOf(JSON.parse(stdout));
    }

    async _system(cancellable) {
        const bus = Gio.DBus.system;
        const [[state], [failed]] = await Promise.all([
            dbusCall(bus, 'Get', new GLib.Variant('(ss)', [MANAGER_IFACE, 'SystemState']), '(v)',
                cancellable, 'org.freedesktop.DBus.Properties'),
            dbusCall(bus, 'ListUnitsFiltered', new GLib.Variant('(as)', [['failed']]), '(a(ssssssouso))', cancellable),
        ]);
        return systemText(state.deepUnpack(), failed.length);
    }

    _services() {
        const [, bytes] = GLib.file_get_contents(this._cfg.servicesFile);
        return servicesOf(JSON.parse(new TextDecoder().decode(bytes)));
    }

    /** unit -> kind, for the given services' units on one bus; empty on failure. */
    async _units(bus, services, cancellable) {
        const names = [...new Set(services.map(s => s.unit))];
        if (!names.length)
            return new Map();
        try {
            const [rows] = await dbusCall(bus, 'ListUnitsByNames', new GLib.Variant('(as)', [names]),
                '(a(ssssssouso))', cancellable);
            return new Map(rows.map(([name, , load, active]) => [name, unitKind(load, active)]));
        } catch (e) {
            warn('units', e);
            return new Map();
        }
    }

    /** 'ok' when something answers at the service's address, else 'off'. */
    async _probe(url, cancellable) {
        if (!url)
            return 'unknown';
        try {
            const port = url.startsWith('https:') ? 443 : 80; // when the URL names none
            const conn = await new Promise((resolve, reject) => {
                this._client.connect_to_uri_async(url, port, cancellable, (c, res) => {
                    try {
                        resolve(c.connect_to_uri_finish(res));
                    } catch (e) {
                        reject(e);
                    }
                });
            });
            conn.close(null);
            return 'ok';
        } catch {
            return 'off';
        }
    }
}

function warn(what, e) {
    if (!e.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED))
        console.warn(`balaur ambient: ${what}: ${e.message}`);
    return null;
}
