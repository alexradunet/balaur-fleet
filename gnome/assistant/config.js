// The assistant's configuration: the JSON file Nix writes
// ($DUET_ASSISTANT_CONFIG, the schema of Config in assistant/assistant.go),
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
        llm: {baseUrl: '', model: '', temperature: null},
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
    const path = GLib.getenv('DUET_ASSISTANT_CONFIG');
    if (!path)
        return defaultConfig();
    const [, bytes] = GLib.file_get_contents(path);
    return parseConfig(new TextDecoder().decode(bytes));
}

/**
 * The Mistral key from systemd's LoadCredential= (never the store or the
 * environment of other processes); $DUET_ASSISTANT_LLM_KEY for development.
 */
export function credentialKey() {
    const dir = GLib.getenv('CREDENTIALS_DIRECTORY');
    if (dir) {
        try {
            const [, b] = GLib.file_get_contents(GLib.build_filenamev([dir, 'llm-key']));
            return new TextDecoder().decode(b).trim();
        } catch {}
    }
    return GLib.getenv('DUET_ASSISTANT_LLM_KEY') ?? '';
}
