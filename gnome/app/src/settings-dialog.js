// "Assistant settings": which chat model the assistant uses, where it is
// served from, the API keys, and Mistral's speech settings (gnome/CONTRACT.md,
// "Settings: model, server, API key").
//
// Plain settings live in GSettings (org.balaur.Assistant, shipped by the daemon
// package) and are bound straight to the rows; the daemon watches them and
// applies changes live. API keys never pass through GSettings or this app's
// memory longer than the Apply tap: they go to the daemon (SetApiKey), which
// keeps them in the GNOME Keyring and only tells us whether one is stored.

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
                    'the assistant package. API keys can still be set below.',
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
            description: 'The model that understands and answers. The list comes from the assistant.',
        });

        this._providerIds = [];
        this._providerRow = new Adw.ComboRow({title: 'Provider', model: stringList([])});
        this._providerRow.connect('notify::selected', () => this._providerPicked());
        group.add(this._providerRow);

        this._modelIds = [];
        this._modelRow = new Adw.ComboRow({title: 'Model', model: stringList([])});
        this._modelRow.connect('notify::selected', () => this._modelPicked());
        group.add(this._modelRow);

        // Any model id, for ones the catalog doesn't know (or a custom server).
        this._modelEntry = new Adw.EntryRow({title: 'Model id'});
        group.add(this._modelEntry);

        this._baseUrl = new Adw.EntryRow({title: 'Server address (empty: the provider’s default)',
            input_purpose: Gtk.InputPurpose.URL});
        group.add(this._baseUrl);

        this._chatKey = this._keyRow('API key', () => this._provider);
        group.add(this._chatKey.row);

        if (this._settings) {
            this._settings.bind('llm-model', this._modelEntry, 'text', Gio.SettingsBindFlags.DEFAULT);
            this._settings.bind('llm-base-url', this._baseUrl, 'text', Gio.SettingsBindFlags.DEFAULT);
            this._settings.connect('changed::llm-provider', () => this._syncFromAssistant());
            this._settings.connect('changed::llm-model', () => this._syncModelRow());
        } else {
            for (const row of [this._providerRow, this._modelRow, this._modelEntry, this._baseUrl])
                row.sensitive = false;
        }
        return group;
    }

    get _provider() {
        return this._settings?.get_string('llm-provider') || 'mistral';
    }

    get _providerInfo() {
        return this._assistant.providers.find(p => p.id === this._provider) ?? null;
    }

    // Rebuild the pickers from the daemon's catalog and the current settings.
    _syncFromAssistant() {
        const providers = this._assistant.providers;
        const current = this._provider;
        const ids = providers.map(p => p.id);
        const names = providers.map(p => p.name || p.id);
        if (!ids.includes(current)) { // keep a provider the catalog doesn't list
            ids.push(current);
            names.push(current);
        }
        if (ids.join('\n') !== this._providerIds.join('\n')) {
            this._syncing = true;
            this._providerIds = ids;
            this._providerRow.model = stringList(names);
            this._syncing = false;
        }
        this._syncing = true;
        this._providerRow.selected = ids.indexOf(current);
        this._syncing = false;
        this._providerRow.subtitle = providers.length ? ''
            : this._assistant.available ? 'The assistant hasn’t reported its models yet'
                : 'The assistant isn’t running: type the model id below';

        this._syncModelRow();
        for (const k of this._keyRows)
            k.sync();
    }

    _syncModelRow() {
        const models = this._providerInfo?.models ?? [];
        const ids = models.map(m => m.id);
        const key = `${this._provider}\n${ids.join('\n')}`;
        if (key !== this._modelKey) { // rebuild only when the choices changed
            this._modelKey = key;
            this._syncing = true;
            this._modelIds = [...ids, null]; // null: "Other"
            this._modelRow.model = stringList([...models.map(m => m.name || m.id), 'Other']);
            this._syncing = false;
        }
        const model = this._settings?.get_string('llm-model') ?? '';
        const i = ids.indexOf(model);
        this._syncing = true;
        this._modelRow.selected = i >= 0 ? i : this._modelIds.length - 1;
        this._syncing = false;
    }

    _providerPicked() {
        if (this._syncing || !this._settings)
            return;
        const id = this._providerIds[this._providerRow.selected];
        if (!id || id === this._provider)
            return;
        this._settings.set_string('llm-provider', id);
        // A model id from another provider would only fail; take the new
        // provider's first model when the current one isn't among its own.
        const models = (this._assistant.providers.find(p => p.id === id)?.models ?? []).map(m => m.id);
        if (models.length && !models.includes(this._settings.get_string('llm-model')))
            this._settings.set_string('llm-model', models[0]);
    }

    _modelPicked() {
        if (this._syncing || !this._settings)
            return;
        const id = this._modelIds[this._modelRow.selected];
        if (id) // "Other" leaves the typed id alone
            this._settings.set_string('llm-model', id);
        else
            this._modelEntry.grab_focus();
    }

    // ---- speech ----

    _speechGroup() {
        const group = new Adw.PreferencesGroup({
            title: 'Speech (Mistral)',
            description: 'Hearing and speaking always use Mistral (Voxtral) with the Mistral key.',
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
                row.title = baseTitle === 'API key' ? `API key for ${provider}` : baseTitle;
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
            subtitle: 'Sends one small request with the settings above'});
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
