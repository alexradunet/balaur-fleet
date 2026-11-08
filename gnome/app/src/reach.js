// Whether a service on another machine answers: a TCP connection to its web
// address, every 30 s. Its systemd unit is on that machine, out of reach of
// UnitWatcher, so this is the best live state the Home page can show for it.
// Same interface as UnitWatcher: a `changed` signal, `status`, `destroy()`.

import GObject from 'gi://GObject';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

Gio._promisify(Gio.SocketClient.prototype, 'connect_to_uri_async', 'connect_to_uri_finish');

const INTERVAL_S = 30;

export const ReachWatcher = GObject.registerClass({
    Signals: {'changed': {}},
}, class ReachWatcher extends GObject.Object {
    constructor(url, host) {
        super();
        this.url = url;
        this.host = host;
        this._client = new Gio.SocketClient({timeout: 5});
        this._cancellable = new Gio.Cancellable();
        this._state = null; // null (not yet known) | {ok, detail}
        this._probe();
        this._timer = GLib.timeout_add_seconds(GLib.PRIORITY_LOW, INTERVAL_S, () => {
            this._probe();
            return GLib.SOURCE_CONTINUE;
        });
    }

    async _probe() {
        if (this._busy)
            return;
        this._busy = true;
        try {
            const port = this.url.startsWith('https:') ? 443 : 80; // when the URL names none
            const conn = await this._client.connect_to_uri_async(this.url, port, this._cancellable);
            conn.close(null);
            this._state = {ok: true, detail: `${this.url} answers`};
        } catch (e) {
            if (e.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED))
                return;
            this._state = {ok: false, detail: `${this.url}: ${e.message}`};
        } finally {
            this._busy = false;
        }
        this.emit('changed');
    }

    get status() {
        if (!this._state)
            return {label: '…', kind: 'unknown', detail: `Checking ${this.url}`};
        return this._state.ok
            ? {label: 'Reachable', kind: 'ok', detail: this._state.detail}
            : {label: 'No answer', kind: 'off', detail: `${this._state.detail} (is ${this.host} awake and on the tailnet?)`};
    }

    destroy() {
        this._cancellable.cancel();
        if (this._timer)
            GLib.source_remove(this._timer);
        this._timer = 0;
    }
});
