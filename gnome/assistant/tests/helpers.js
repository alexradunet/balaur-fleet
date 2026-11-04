// Shared fixtures: an Assistant with stand-ins for the mic, the speaker and
// GSettings (in memory), and the fake agent.

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

import {tempDir} from './assert.js';
import {Agent} from '../agent.js';
import {Assistant} from '../assistant.js';
import {defaultConfig} from '../config.js';
import {Settings} from '../settings.js';
import {Store} from '../store.js';

const here = GLib.path_get_dirname(GLib.filename_from_uri(import.meta.url)[0]);

/** The gjs running us, to run the fake agent with. */
export function gjsBinary() {
    return GLib.file_read_link('/proc/self/exe');
}

export function fakeAgentArgv() {
    return [gjsBinary(), '-m', GLib.build_filenamev([here, 'fake-agent.js'])];
}

/** Gio.Settings for org.balaur.Assistant in memory, or null when the schema is not installed. */
export function memorySettings() {
    const schema = Gio.SettingsSchemaSource.get_default()?.lookup('org.balaur.Assistant', true);
    if (!schema)
        return null;
    return new Gio.Settings({settings_schema: schema, backend: Gio.memory_settings_backend_new()});
}

export class FakeMic {
    constructor() {
        this.muted = false;
    }

    start() {}

    stop() {}

    setMuted(m) {
        this.muted = m;
    }
}

export class FakePlayer {
    constructor() {
        this.played = [];
    }

    async play(source, cancellable) {
        for (let c; (c = await source.next());) // eslint-disable-line no-await-in-loop
            this.played.push(c);
        void cancellable;
    }

    playPCM(pcm, cancellable) {
        let given = false;
        return this.play({next: async () => (given ? null : (given = true, pcm))}, cancellable);
    }
}

/** An Assistant on a temp store with the fake agent; call a.shutdown() after. */
export function makeAssistant({gsettings = false, notifier = null} = {}) {
    const cfg = defaultConfig();
    cfg.audio.output = 'hw:9,9'; // not a sound server: no volume polling
    cfg.llm.model = 'm1';
    const store = new Store(tempDir());
    const settings = new Settings(cfg, () => {}, {gsettings, keyring: false, debounceMs: 100});
    let a;
    const agent = new Agent({
        argv: fakeAgentArgv(),
        env: () => a._agentEnv(),
        onToolCall: (name, args) => a._toolCall(name, args),
        onReady: r => a._agentReady(r),
    });
    a = new Assistant(cfg, store, settings, {agent, mic: new FakeMic(), player: new FakePlayer(), notifier});
    a.setVolume = async v => {
        a.volume = v;
        a.changed();
    };
    return a;
}
