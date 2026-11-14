// org.balaur.Balaur: the household's companion app for the Balaur home server.
//
// Every user action goes through an application action (app.open-service,
// app.quit). Buttons bind to them directly, failures become toasts in one
// place, and since GApplication exports its actions on the session bus they
// can be exercised from a shell too (see README.md).

import GObject from 'gi://GObject';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Gtk from 'gi://Gtk?version=4.0';
import Gdk from 'gi://Gdk?version=4.0';
import Adw from 'gi://Adw?version=1';

import {Services} from './services.js';
import {People} from './people.js';
import {BalaurWindow} from './window.js';
import {SearchProvider} from './search-provider.js';
import {parseId} from './search.js';

export const BalaurApplication = GObject.registerClass(
class BalaurApplication extends Adw.Application {
    constructor() {
        super({
            application_id: 'org.balaur.Balaur',
            flags: Gio.ApplicationFlags.DEFAULT_FLAGS,
            // Started by GNOME's search (D-Bus activation, no window): stay a
            // minute after the last search rather than start again for each.
            inactivity_timeout: 60 * 1000,
        });
        GLib.set_application_name('Balaur');
        this._searchProvider = new SearchProvider(this);
    }

    // The overview's search provider, on the app's own bus connection (the
    // primary instance only; startup runs before the first call is answered).
    vfunc_dbus_register(connection, objectPath) {
        if (!super.vfunc_dbus_register(connection, objectPath))
            return false;
        this._searchProvider.export(connection);
        return true;
    }

    vfunc_dbus_unregister(connection, objectPath) {
        this._searchProvider.unexport();
        super.vfunc_dbus_unregister(connection, objectPath);
    }

    vfunc_startup() {
        super.vfunc_startup();

        const css = new Gtk.CssProvider();
        css.load_from_path(GLib.build_filenamev([
            GLib.path_get_dirname(GLib.filename_from_uri(import.meta.url)[0]), 'style.css']));
        Gtk.StyleContext.add_provider_for_display(Gdk.Display.get_default(), css,
            Gtk.STYLE_PROVIDER_PRIORITY_APPLICATION);

        this.services = new Services();
        this.people = new People();
        this._addActions();
        this.set_accels_for_action('app.quit', ['<Control>q']);
        this.set_accels_for_action('window.close', ['<Control>w']);
    }

    vfunc_activate() {
        let win = this.active_window;
        if (!win) {
            win = new BalaurWindow(this);
            // A household tablet: fill the screen.
            win.maximize();
        }
        win.present();
    }

    // A search result chosen in the overview: the service opens itself (no
    // Balaur window).
    activateResult(id, _terms) {
        const {kind, key} = parseId(id);
        if (kind === 'service')
            this._openService(key);
    }

    // The provider's own row in the overview: the app, on Home.
    launchSearch(_terms) {
        this.activate();
        this.active_window?.showPage('home');
    }

    // Show a failure where the user is looking.
    toast(text) {
        log(`Balaur: ${text}`);
        this.active_window?.toast?.(text);
    }

    // Run an async call; on failure, toast its message. Resolves to success.
    async _try(promise) {
        try {
            await promise;
            return true;
        } catch (e) {
            this.toast(e.message);
            return false;
        }
    }

    _addActions() {
        const add = (name, type, handler) => {
            const action = new Gio.SimpleAction({
                name,
                parameter_type: type ? new GLib.VariantType(type) : null,
            });
            action.connect('activate', (_action, param) => handler(param?.deepUnpack()));
            this.add_action(action);
        };

        add('quit', null, () => this.quit());
        add('open-service', 's', name => this._openService(name));
    }

    async _openService(name) {
        const service = this.services.find(name);
        if (!service) {
            this.toast(`No service called ${name}`);
            return;
        }
        await this._try(this.services.open(service, this.active_window));
    }
});
