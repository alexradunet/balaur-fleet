// "Assistant settings": which chat model the assistant uses, the Mistral key,
// and Mistral's speech settings (gnome/CONTRACT.md, "Settings").
//
// Plain settings live in GSettings (org.balaur.Assistant, shipped by the daemon
// package); the daemon watches them and applies changes live. The API key never
// passes through GSettings or this app's memory longer than the Apply tap: it
// goes to the daemon (SetApiKey), which keeps it in the GNOME Keyring and only
// tells us whether one is stored.

import GObject from 'gi://GObject';
import Gio from 'gi://Gio';
import Gtk from 'gi://Gtk?version=4.0';
import Adw from 'gi://Adw?version=1';

const SCHEMA_ID = 'org.balaur.Assistant';

// The schema comes from the daemon package; without it Gio.Settings would
// abort the whole app, so look first.
function lookupSettings() {
    const source = Gio.SettingsSchemaSource.get_default();
    return source?.lookup(SCHEMA_ID, true) ? new Gio.Settings({schema_id: SCHEMA_ID}) : null;
}

// Display names for a combo row (ids are kept alongside, by index).
function stringList(items) {
    return Gtk.StringList.new(items);
}

export const AssistantSettingsDialog = GObject.registerClass(
class AssistantSettingsDialog extends Adw.PreferencesDialog {
    constructor(assistant) {
        super({title: 'Assistant Settings', search_enabled: false,
            content_width: 640, content_height: 720});
        this._assistant = assistant;
        this._settings = lookupSettings();
        this._keyRows = [];

        const page = new Adw.PreferencesPage();
        this.add(page);

        if (!this._settings) {
            const missing = new Adw.PreferencesGroup({
                title: 'Settings unavailable',
                description: `The settings schema ${SCHEMA_ID} isn't installed; it comes with ` +
                    'the assistant package. The Mistral key can still be set below.',
            });
            page.add(missing);
        }

        page.add(this._chatGroup());
        page.add(this._speechGroup());
        page.add(this._testGroup());

        this._changedId = assistant.connect('changed', () => this._syncFromAssistant());
        this.connect('closed', () => assistant.disconnect(this._changedId));
        this._syncFromAssistant();
    }

    // ---- chat model ----

    _chatGroup() {
        const group = new Adw.PreferencesGroup({
            title: 'Chat Model',
            description: 'The model that understands and answers, through the fleet’s AI entryway. ' +
                'Which machine or service is behind each name is set on the entryway’s page.',
        });

        this._modelIds = [];
        this._modelRow = new Adw.ComboRow({title: 'Model', model: stringList([])});
        this._modelRow.connect('notify::selected', () => this._modelPicked());
        group.add(this._modelRow);

        if (this._settings)
            this._settings.connect('changed::llm-model', () => this._syncModelRow());
        else
            this._modelRow.sensitive = false;
        return group;
    }

    // Rebuild the picker from the assistant's models and the current setting.
    _syncFromAssistant() {
        this._syncModelRow();
        for (const k of this._keyRows)
            k.sync();
    }

    _syncModelRow() {
        const models = this._assistant.providers.flatMap(p => p.models ?? []);
        const current = this._settings?.get_string('llm-model') || this._assistant.defaults.model || '';
        const ids = models.map(m => m.id);
        const names = models.map(m => m.name || m.id);
        if (current && !ids.includes(current)) { // keep a model the assistant doesn't list
            ids.push(current);
            names.push(current);
        }
        if (ids.join('\n') !== this._modelIds.join('\n')) { // rebuild only when the choices changed
            this._syncing = true;
            this._modelIds = ids;
            this._modelRow.model = stringList(names);
            this._syncing = false;
        }
        this._syncing = true;
        this._modelRow.selected = Math.max(0, ids.indexOf(current));
        this._syncing = false;
        this._modelRow.subtitle = models.length ? ''
            : this._assistant.available ? 'The assistant hasn’t reported its models yet'
                : 'The assistant isn’t running';
    }

    _modelPicked() {
        if (this._syncing || !this._settings)
            return;
        const id = this._modelIds[this._modelRow.selected];
        if (id && id !== this._settings.get_string('llm-model'))
            this._settings.set_string('llm-model', id);
    }

    // ---- speech ----

    _speechGroup() {
        const group = new Adw.PreferencesGroup({
            title: 'Speech (Mistral)',
            description: 'Hearing, speaking and web search use Mistral (Voxtral) with the Mistral key.',
        });
        const mistralKey = this._keyRow('Mistral API key', () => 'mistral');
        group.add(mistralKey.row);
        const fields = [
            ['speech-base-url', 'Speech server address', Gtk.InputPurpose.URL],
            ['stt-model', 'Speech-to-text model'],
            ['tts-model', 'Text-to-speech model'],
            ['voice-ro', 'Romanian voice (empty: default)'],
            ['voice-en', 'English voice (empty: default)'],
        ];
        for (const [key, title, purpose] of fields) {
            const row = new Adw.EntryRow({title, input_purpose: purpose ?? Gtk.InputPurpose.FREE_FORM});
            if (this._settings)
                this._settings.bind(key, row, 'text', Gio.SettingsBindFlags.DEFAULT);
            else
                row.sensitive = false;
            group.add(row);
        }
        return group;
    }

    // ---- API keys ----

    // A password row for one provider's key: Apply stores it, the trash
    // button deletes it, and a label says whether one is stored. The key
    // itself is never shown or read back.
    _keyRow(baseTitle, providerOf) {
        const row = new Adw.PasswordEntryRow({title: baseTitle, show_apply_button: true});
        const state = new Gtk.Label({valign: Gtk.Align.CENTER, css_classes: ['caption']});
        const clear = new Gtk.Button({icon_name: 'user-trash-symbolic', tooltip_text: 'Delete the stored key',
            valign: Gtk.Align.CENTER, css_classes: ['flat', 'circular']});
        row.add_suffix(state);
        row.add_suffix(clear);

        const store = async (key, done) => {
            const provider = providerOf();
            try {
                await this._assistant.setApiKey(provider, key);
                this._toast(done(provider));
            } catch (e) {
                this._toast(e.message);
            }
        };
        row.connect('apply', () => {
            const key = row.text.trim();
            row.text = ''; // don't keep the secret in the widget
            if (key)
                store(key, p => `Key for ${p} saved`);
        });
        clear.connect('clicked', () => store('', p => `Key for ${p} deleted`));

        const entry = {
            row,
            sync: () => {
                const provider = providerOf();
                const saved = Boolean(this._assistant.apiKeys[provider]);
                state.label = saved ? 'Key saved' : 'No key';
                state.css_classes = ['caption', saved ? 'success' : 'dim-label'];
                clear.visible = saved;
                row.title = baseTitle;
                row.sensitive = this._assistant.available;
            },
        };
        this._keyRows.push(entry);
        return entry;
    }

    // ---- test ----

    _testGroup() {
        const group = new Adw.PreferencesGroup();
        const row = new Adw.ActionRow({title: 'Try the chat model',
            subtitle: 'Sends one small request to the model chosen above'});
        this._spinner = new Adw.Spinner({visible: false, valign: Gtk.Align.CENTER});
        this._testButton = new Gtk.Button({label: 'Test', valign: Gtk.Align.CENTER,
            css_classes: ['suggested-action', 'pill']});
        this._testButton.connect('clicked', () => this._test());
        row.add_suffix(this._spinner);
        row.add_suffix(this._testButton);
        row.activatable_widget = this._testButton;
        group.add(row);
        return group;
    }

    async _test() {
        this._testButton.sensitive = false;
        this._spinner.visible = true;
        let message;
        try {
            const error = await this._assistant.testModel();
            message = error ? `Test failed: ${error}` : 'The model answered: all good';
        } catch (e) {
            message = `Test failed: ${e.message}`;
        } finally {
            this._testButton.sensitive = true;
            this._spinner.visible = false;
        }
        this._toast(message);
    }

    // High priority: the answer to what was just tapped shows at once instead
    // of queueing behind an older toast.
    _toast(text) {
        this.add_toast(new Adw.Toast({title: text, use_markup: false, timeout: 6,
            priority: Adw.ToastPriority.HIGH}));
    }
});
