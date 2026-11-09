// What the app can change: the model, its server, the speech models and
// voices (GSettings org.balaur.Assistant, watched live), and API keys (GNOME
// Keyring through libsecret, schema org.balaur.Assistant.ApiKey, attribute
// "provider"). A setting left empty falls back to the config JSON; the
// Mistral key falls back to the systemd credential.

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

import {credentialKey} from './config.js';
import {errText, log} from './util.js';

const SCHEMA_ID = 'org.balaur.Assistant';
const KEYS = ['llm-provider', 'llm-model', 'llm-base-url', 'speech-base-url', 'stt-model', 'tts-model', 'voice-ro', 'voice-en'];
// Changing these restarts the agent (they are its start-up parameters).
export const LLM_KEYS = ['llm-provider', 'llm-model', 'llm-base-url', 'speech-base-url'];
const DEBOUNCE_MS = 1500;

let Secret = null;
try {
    Secret = (await import('gi://Secret?version=1')).default;
} catch (e) {
    log(`settings: no libsecret (${errText(e)}); API keys only from the credential file`);
}

export class Settings {
    /**
     * cfg: the config JSON. onChanged(keys) is called after GSettings keys
     * change. gsettings: a Gio.Settings to use (tests); otherwise the
     * installed schema, if any.
     */
    constructor(cfg, onChanged = () => {}, {gsettings = null, keyring = true, debounceMs = DEBOUNCE_MS} = {}) {
        this.cfg = cfg;
        this.gs = gsettings;
        if (this.gs === false) {
            this.gs = null; // tests: no GSettings at all
        } else if (!this.gs) {
            const schema = Gio.SettingsSchemaSource.get_default()?.lookup(SCHEMA_ID, true);
            if (schema)
                this.gs = new Gio.Settings({settings_schema: schema});
            else
                log(`settings: schema ${SCHEMA_ID} is not installed; using the config file only`);
        }
        // The app binds its text rows straight to these keys, so they change on
        // every keystroke: apply them as one batch once the typing stopped.
        this.pendingKeys = new Set();
        this.debounceId = 0;
        this.gs?.connect('changed', (_s, key) => {
            this.pendingKeys.add(key);
            if (this.debounceId)
                GLib.source_remove(this.debounceId);
            this.debounceId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, debounceMs, () => {
                this.debounceId = 0;
                const keys = [...this.pendingKeys];
                this.pendingKeys.clear();
                onChanged(keys);
                return GLib.SOURCE_REMOVE;
            });
        });
        this.secretSchema = keyring && Secret
            ? new Secret.Schema(`${SCHEMA_ID}.ApiKey`, Secret.SchemaFlags.NONE, {provider: Secret.SchemaAttributeType.STRING})
            : null;
    }

    _get(key) {
        return this.gs && KEYS.includes(key) ? this.gs.get_string(key) : '';
    }

    get llmProvider() {
        return this._get('llm-provider') || this.cfg.llm?.provider || 'mistral';
    }

    get llmModel() {
        return this._get('llm-model') || this.cfg.llm?.model || '';
    }

    get llmBaseUrl() {
        // The config's server belongs to the config's provider: one picked in the
        // app keeps its own default.
        const cfg = this.cfg.llm ?? {};
        return this._get('llm-base-url') ||
            (cfg.provider && this.llmProvider === cfg.provider ? cfg.server || '' : '');
    }

    get speechBaseUrl() {
        return this._get('speech-base-url') || this.cfg.llm?.baseUrl || 'https://api.mistral.ai/v1';
    }

    get sttModel() {
        return this._get('stt-model') || this.cfg.stt?.model || '';
    }

    get ttsModel() {
        return this._get('tts-model') || this.cfg.tts?.model || '';
    }

    /** The voice id for "ro"/"en" ("" = the API's default), as voiceFor in assistant.go. */
    voice(lang) {
        const voices = {...this.cfg.tts?.voices ?? {}};
        for (const l of ['ro', 'en']) {
            const v = this._get(`voice-${l}`);
            if (v)
                voices[l] = v;
        }
        if (Object.hasOwn(voices, lang))
            return voices[lang];
        return voices[this.cfg.defaultLanguage] ?? '';
    }

    // ---- API keys ----

    /** The key for a provider: the keyring, then (Mistral only) the credential file. */
    async apiKey(provider) {
        if (this.secretSchema) {
            try {
                const key = await new Promise((resolve, reject) => {
                    Secret.password_lookup(this.secretSchema, {provider}, null, (_o, res) => {
                        try {
                            resolve(Secret.password_lookup_finish(res));
                        } catch (e) {
                            reject(e);
                        }
                    });
                });
                if (key)
                    return key;
            } catch (e) {
                log(`keyring: ${errText(e)}`);
            }
        }
        return provider === 'mistral' ? credentialKey() : '';
    }

    /** Which providers have a key (never the key): {"mistral": true, ...}. */
    async apiKeys() {
        const out = {};
        if (this.secretSchema) {
            try {
                const items = await new Promise((resolve, reject) => {
                    // No UNLOCK flag: listing attributes must never prompt.
                    Secret.password_search(this.secretSchema, {}, Secret.SearchFlags.ALL, null, (_o, res) => {
                        try {
                            resolve(Secret.password_search_finish(res));
                        } catch (e) {
                            reject(e);
                        }
                    });
                });
                for (const it of items ?? []) {
                    const p = it.get_attributes()?.provider;
                    if (p)
                        out[p] = true;
                }
            } catch (e) {
                log(`keyring: ${errText(e)}`);
            }
        }
        if (!out.mistral && credentialKey())
            out.mistral = true;
        return out;
    }

    /** Stores a provider's key in the keyring; "" deletes it. */
    async setApiKey(provider, key) {
        if (!provider)
            throw new Error('no provider given');
        if (!this.secretSchema)
            throw new Error('the GNOME Keyring (libsecret) is not available');
        await new Promise((resolve, reject) => {
            const done = fn => (_o, res) => {
                try {
                    resolve(fn(res));
                } catch (e) {
                    reject(e);
                }
            };
            if (key) {
                Secret.password_store(this.secretSchema, {provider}, Secret.COLLECTION_DEFAULT,
                    `Balaur assistant: ${provider} API key`, key, null, done(r => Secret.password_store_finish(r)));
            } else {
                Secret.password_clear(this.secretSchema, {provider}, null, done(r => Secret.password_clear_finish(r)));
            }
        });
    }
}
