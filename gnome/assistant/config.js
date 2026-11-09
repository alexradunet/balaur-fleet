// The assistant's configuration: the JSON file Nix writes
// ($BALAUR_ASSISTANT_CONFIG, the schema of Config in assistant/assistant.go (the former Go service, in git history)),
// decoded over the same defaults as the Go loadConfig.

import GLib from 'gi://GLib';

export function defaultConfig() {
    return {
        listen: '127.0.0.1:8770', // unused: there is no HTTP API any more
        name: 'Jarvis',
        defaultLanguage: 'ro',
        audio: {input: 'default', output: 'default', card: '0', volume: 70},
        wake: {uri: '127.0.0.1:10400', words: ['hey_jarvis']},
        stt: {model: 'voxtral-mini-transcribe-3-0'},
        tts: {model: 'voxtral-mini-tts-3-0', voices: {}},
        search: {model: ''},
        llm: {provider: '', server: '', baseUrl: '', model: '', temperature: null},
        location: {name: '', latitude: 0, longitude: 0},
        newsFeeds: [],
    };
}

// json.Unmarshal into a filled struct: objects merge field by field, maps
// gain keys, everything else (arrays included) is replaced.
function merge(into, from) {
    for (const [k, v] of Object.entries(from ?? {})) {
        if (v && typeof v === 'object' && !Array.isArray(v) && into[k] && typeof into[k] === 'object' && !Array.isArray(into[k]))
            merge(into[k], v);
        else
            into[k] = v;
    }
    return into;
}

export function parseConfig(text) {
    return merge(defaultConfig(), JSON.parse(text));
}

export function loadConfig() {
    const path = GLib.getenv('BALAUR_ASSISTANT_CONFIG');
    if (!path)
        return defaultConfig();
    const [, bytes] = GLib.file_get_contents(path);
    return parseConfig(new TextDecoder().decode(bytes));
}

/**
 * The Mistral key from a file, the fallback when the GNOME Keyring has none:
 * $BALAUR_ASSISTANT_KEY_FILE (written by `sudo balaur-assistant-login`; missing is
 * fine), or systemd's LoadCredential=; $BALAUR_ASSISTANT_LLM_KEY for development.
 */
export function credentialKey() {
    const dir = GLib.getenv('CREDENTIALS_DIRECTORY');
    const files = [GLib.getenv('BALAUR_ASSISTANT_KEY_FILE'), dir && GLib.build_filenamev([dir, 'llm-key'])];
    for (const f of files.filter(Boolean)) {
        try {
            const [, b] = GLib.file_get_contents(f);
            const key = new TextDecoder().decode(b).trim();
            if (key)
                return key;
        } catch {}
    }
    return GLib.getenv('BALAUR_ASSISTANT_LLM_KEY') ?? '';
}
