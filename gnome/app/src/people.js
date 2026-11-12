// The people of the household, from /etc/balaur/people.json (written by NixOS
// from balaur.people; $BALAUR_PEOPLE overrides the path for testing). An array
// of {name, role}, role being "owner", "household" or "screen" (access.js says
// what each opens). Empty on a machine nobody shares: the People page hides.

import GObject from 'gi://GObject';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

const DEFAULT_PATH = '/etc/balaur/people.json';

export const People = GObject.registerClass({
    Signals: {'changed': {}},
}, class People extends GObject.Object {
    constructor() {
        super();
        this.path = GLib.getenv('BALAUR_PEOPLE') || DEFAULT_PATH;
        this.list = [];
        this._file = Gio.File.new_for_path(this.path);
        // A rebuild of the system replaces the file; follow it without a restart.
        this._monitor = this._file.monitor_file(Gio.FileMonitorFlags.WATCH_MOVES, null);
        this._monitor.set_rate_limit(1000);
        this._monitor.connect('changed', () => this._load());
        this._load();
    }

    _load() {
        try {
            const [, bytes] = this._file.load_contents(null);
            const data = JSON.parse(new TextDecoder().decode(bytes));
            if (!Array.isArray(data))
                throw new Error('expected a JSON array');
            this.list = data.filter(p => p && typeof p.name === 'string' && typeof p.role === 'string');
        } catch (e) {
            // No file is the usual case on a machine without people; anything
            // else is worth a line in the journal, and the page stays hidden.
            if (!(e instanceof GLib.Error && e.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.NOT_FOUND)))
                log(`Balaur: can't read ${this.path}: ${e.message}`);
            this.list = [];
        }
        this.emit('changed');
    }
});
