// The daemon as a Gio.Application (id org.duet.Assistant): owns the bus
// name, exports the D-Bus API, and sends the alarm notifications (which GNOME
// attributes to org.duet.Assistant.desktop) with a Stop button (app.stop).

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GLibUnix from 'gi://GLibUnix';
import GObject from 'gi://GObject';

import {Assistant} from './assistant.js';
import {loadConfig} from './config.js';
import {exportAssistant} from './dbus.js';
import {Settings} from './settings.js';
import {Store} from './store.js';
import {errText, log} from './util.js';

export const DuetAssistantApp = GObject.registerClass(
class DuetAssistantApp extends Gio.Application {
    _init() {
        super._init({application_id: 'org.duet.Assistant', flags: Gio.ApplicationFlags.DEFAULT_FLAGS});
        this.cfg = loadConfig();
        const dir = GLib.getenv('STATE_DIRECTORY') || GLib.build_filenamev([GLib.get_tmp_dir(), 'duet-assistant']);
        // A broken state file stops us, as in Go: better than overwriting the household's lists.
        this.store = new Store(dir.split(':')[0]);
        this.settings = new Settings(this.cfg, keys => this.assistant?.settingsChanged(keys).catch(e => log(`settings: ${errText(e)}`)));
        this.assistant = new Assistant(this.cfg, this.store, this.settings, {
            notifier: {
                send: (id, kind, text) => {
                    const n = new Gio.Notification();
                    n.set_title(kind === 'reminder' ? 'Reminder' : 'Timer');
                    n.set_body(text);
                    n.set_priority(Gio.NotificationPriority.URGENT);
                    n.set_category?.('alarm');
                    n.add_button('Stop', 'app.stop');
                    n.set_default_action('app.stop');
                    this.send_notification(id, n);
                },
                withdraw: id => this.withdraw_notification(id),
            },
        });
        this.exported = null;
    }

    vfunc_dbus_register(connection, path) {
        if (!super.vfunc_dbus_register(connection, path))
            return false;
        this.exported = exportAssistant(connection, this.assistant);
        return true;
    }

    vfunc_dbus_unregister(connection, path) {
        this.exported?.unexport();
        this.exported = null;
        super.vfunc_dbus_unregister(connection, path);
    }

    vfunc_startup() {
        super.vfunc_startup();
        this.hold(); // a service: runs until stopped
        const stop = new Gio.SimpleAction({name: 'stop'});
        stop.connect('activate', () => this.assistant.stop());
        this.add_action(stop);
        for (const sig of [2, 15]) { // SIGINT, SIGTERM
            GLibUnix.signal_add(GLib.PRIORITY_DEFAULT, sig, () => {
                log('stopping');
                this.assistant.shutdown().catch(() => {}).finally(() => this.quit());
                return GLib.SOURCE_REMOVE;
            });
        }
        const c = this.cfg;
        log(`duet-assistant "${c.name}" on the session bus as org.duet.Assistant ` +
            `(model ${this.settings.llmProvider}/${this.settings.llmModel}, wake word ${c.wake.words.join(', ')})`);
        this.assistant.start().catch(e => {
            logError(e, 'start');
            this.quit();
        });
    }

    vfunc_activate() {
        // Nothing to show: the app (org.duet.Duet) is the user interface.
    }
});
