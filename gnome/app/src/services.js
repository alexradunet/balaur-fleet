// The household's home services, from /etc/duet/services.json (written by
// NixOS from duet.dashboard.services; $DUET_SERVICES overrides the path for
// testing). An array of {name, description, icon, url, unit, desktopId}, plus
// an optional `group` to section the Home page.

import GObject from 'gi://GObject';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GioUnix from 'gi://GioUnix?version=2.0';
import Gtk from 'gi://Gtk?version=4.0';

Gio._promisify(Gtk.UriLauncher.prototype, 'launch', 'launch_finish');

const DEFAULT_PATH = '/etc/duet/services.json';

export const Services = GObject.registerClass({
    Signals: {'changed': {}},
}, class Services extends GObject.Object {
    constructor() {
        super();
        this.path = GLib.getenv('DUET_SERVICES') || DEFAULT_PATH;
        this.list = [];
        this.problem = null; // why the list is empty, for the Home page
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
            this.list = data.filter(s => s && typeof s.name === 'string');
            this.problem = null;
        } catch (e) {
            this.list = [];
            this.problem = e instanceof GLib.Error && e.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.NOT_FOUND)
                ? `${this.path} doesn't exist yet.`
                : `Can't read ${this.path}: ${e.message}`;
        }
        this.emit('changed');
    }

    find(name) {
        return this.list.find(s => s.name === name) ?? null;
    }

    // The GNOME app for this service, or null when there is none installed.
    appInfo(service) {
        if (!service?.desktopId)
            return null;
        try {
            return GioUnix.DesktopAppInfo.new(service.desktopId);
        } catch {
            return null; // older bindings throw instead of returning null
        }
    }

    canOpen(service) {
        return Boolean(this.appInfo(service) || service?.url);
    }

    // Its GNOME app if installed, else its web address in the default browser.
    async open(service, window) {
        const app = this.appInfo(service);
        if (app) {
            const ctx = window.get_display().get_app_launch_context();
            app.launch([], ctx);
            return;
        }
        if (service.url) {
            await new Gtk.UriLauncher({uri: service.url}).launch(window, null);
            return;
        }
        throw new Error(service.desktopId
            ? `${service.desktopId} isn't installed`
            : `${service.name} has nothing to open`);
    }
});
