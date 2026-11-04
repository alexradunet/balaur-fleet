// org.duet.Duet: the household's companion app for the Duet home server.
//
// Every user action goes through an application action (app.list-add,
// app.stop, ...). Buttons bind to them directly, they are disabled while the
// assistant is away, failures become toasts in one place, and since GApplication
// exports its actions on the session bus they can be exercised from a shell
// too (see README.md).

import GObject from 'gi://GObject';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Gtk from 'gi://Gtk?version=4.0';
import Gdk from 'gi://Gdk?version=4.0';
import Adw from 'gi://Adw?version=1';

import {Assistant} from './assistant.js';
import {Services} from './services.js';
import {DuetWindow} from './window.js';
import {AssistantSettingsDialog} from './settings-dialog.js';

export const DuetApplication = GObject.registerClass(
class DuetApplication extends Adw.Application {
    constructor() {
        super({
            application_id: 'org.duet.Duet',
            flags: Gio.ApplicationFlags.DEFAULT_FLAGS,
        });
        GLib.set_application_name('Duet');
    }

    vfunc_startup() {
        super.vfunc_startup();

        const css = new Gtk.CssProvider();
        css.load_from_path(GLib.build_filenamev([
            GLib.path_get_dirname(GLib.filename_from_uri(import.meta.url)[0]), 'style.css']));
        Gtk.StyleContext.add_provider_for_display(Gdk.Display.get_default(), css,
            Gtk.STYLE_PROVIDER_PRIORITY_APPLICATION);

        this.assistant = new Assistant();
        this.services = new Services();
        this._addActions();
        this.set_accels_for_action('app.quit', ['<Control>q']);
        this.set_accels_for_action('window.close', ['<Control>w']);
    }

    vfunc_activate() {
        let win = this.active_window;
        if (!win) {
            win = new DuetWindow(this);
            // A household tablet: fill the screen.
            win.maximize();
        }
        win.present();
    }

    // Show a failure where the user is looking.
    toast(text) {
        log(`Duet: ${text}`);
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

    // Typed question. The answer arrives in the conversation log (Snapshot),
    // and is spoken too, as if asked aloud.
    ask(text) {
        return this._try(this.assistant.ask(text, true));
    }

    _addActions() {
        const a = this.assistant;
        const assistantActions = [];
        const add = (name, type, handler, needsAssistant = true) => {
            const action = new Gio.SimpleAction({
                name,
                parameter_type: type ? new GLib.VariantType(type) : null,
            });
            action.connect('activate', (_action, param) => handler(param?.deepUnpack()));
            this.add_action(action);
            if (needsAssistant)
                assistantActions.push(action);
        };

        add('quit', null, () => this.quit(), false);
        add('ask', 's', text => this.ask(text));
        add('stop', null, () => this._try(a.stop()));
        add('list-add', '(ss)', ([list, text]) => this._try(a.listAdd(list, text)));
        add('list-set-done', '(ssb)', ([list, id, done]) => this._try(a.listSetDone(list, id, done)));
        add('list-remove', '(ss)', ([list, id]) => this._try(a.listRemove(list, id)));
        add('list-clear-done', 's', list => this._try(a.listClearDone(list)));
        add('memory-add', 's', fact => this._try(a.memoryAdd(fact)));
        add('memory-remove', 's', id => this._try(a.memoryRemove(id)));
        add('timer-cancel', 's', id => this._try(a.timerCancel(id)));
        add('reminder-cancel', 's', id => this._try(a.reminderCancel(id)));
        add('open-service', 's', name => this._openService(name), false);
        add('assistant-settings', null, () => this._showSettings(), false);

        // Microphone on/off for the page's switch: state = mic on (= !Muted).
        const mic = new Gio.SimpleAction({name: 'microphone', state: new GLib.Variant('b', !a.muted)});
        mic.connect('change-state', (action, value) => {
            const on = value.unpack();
            action.set_state(value); // optimistic; the daemon's echo confirms
            this._try(a.setMuted(!on)).then(ok => {
                if (!ok)
                    action.set_state(new GLib.Variant('b', !a.muted));
            });
        });
        this.add_action(mic);
        assistantActions.push(mic);

        // Speaker volume 0-100, for the page's slider.
        const volume = new Gio.SimpleAction({name: 'volume', state: new GLib.Variant('u', a.volume),
            parameter_type: new GLib.VariantType('u')});
        volume.connect('change-state', (action, value) => {
            const v = Math.max(0, Math.min(100, value.unpack()));
            action.set_state(new GLib.Variant('u', v));
            this._try(a.setVolume(v));
        });
        volume.connect('activate', (action, value) => action.change_state(value));
        this.add_action(volume);
        assistantActions.push(volume);

        const sync = () => {
            for (const action of assistantActions)
                action.enabled = a.available;
            if (mic.state.unpack() !== !a.muted)
                mic.set_state(new GLib.Variant('b', !a.muted));
            if (volume.state.unpack() !== a.volume)
                volume.set_state(new GLib.Variant('u', a.volume));
        };
        a.connect('changed', sync);
        sync();
    }

    // One settings dialog at a time, over the current window.
    _showSettings() {
        if (this._settingsDialog)
            return;
        this._settingsDialog = new AssistantSettingsDialog(this.assistant);
        this._settingsDialog.connect('closed', () => {
            this._settingsDialog = null;
        });
        this._settingsDialog.present(this.active_window);
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
