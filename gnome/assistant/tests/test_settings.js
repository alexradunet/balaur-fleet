// GSettings over the config file, debounced changes, one agent restart per
// batch and never mid-turn.

import {eq, ok, until} from './assert.js';
import {makeAssistant, memorySettings} from './helpers.js';
import {sleep} from '../util.js';

export const tests = {
    async fallbacksAndVoices() {
        const a = makeAssistant();
        const s = a.settings;
        eq(s.llmProvider, 'mistral');
        eq(s.llmModel, 'm1', 'config llm.model when GSettings has none');
        eq(s.speechBaseUrl, 'https://api.mistral.ai/v1');
        a.cfg.tts.voices = {ro: 'v-ro', en: 'v-en'};
        eq(a.voiceFor('Hello there, what is the time?', 'ro'), 'v-en', 'the text decides the voice');
        eq(a.voiceFor('...', 'ro'), 'v-ro');
        await a.shutdown();
    },

    async configProviderAndItsServer() {
        const gs = memorySettings();
        if (!gs) {
            print('      (skipped: schema org.balaur.Assistant not installed; run through the package)');
            return;
        }
        const a = makeAssistant({gsettings: gs});
        const s = a.settings;
        a.cfg.llm.provider = 'balaur';
        a.cfg.llm.server = 'http://127.0.0.1:4000/v1';
        eq(s.llmProvider, 'balaur', 'config llm.provider when GSettings has none');
        eq(s.llmBaseUrl, 'http://127.0.0.1:4000/v1', 'the config server goes with the config provider');
        gs.set_string('llm-provider', 'mistral');
        eq(s.llmProvider, 'mistral', 'GSettings wins');
        eq(s.llmBaseUrl, '', 'a provider picked in the app keeps its own default server');
        await a.shutdown();
    },

    async debouncedRestartOncePerBatchAndNotMidTurn() {
        const gs = memorySettings();
        if (!gs) {
            print('      (skipped: schema org.balaur.Assistant not installed; run through the package)');
            return;
        }
        const a = makeAssistant({gsettings: gs});
        const batches = [];
        // As application.js wires it, with the test's short debounce.
        a.settings.gs.connect('changed', () => {});
        const restarts = [];
        a.agent.restart = async () => restarts.push(Date.now());
        const origChanged = a.settingsChanged.bind(a);
        a.settings = new (a.settings.constructor)(a.cfg, keys => {
            batches.push(keys);
            origChanged(keys);
        }, {gsettings: gs, keyring: false, debounceMs: 150});
        // Typing "mistral-large" one key at a time.
        for (const ch of 'mistral-large') {
            gs.set_string('llm-model', (gs.get_string('llm-model') + ch));
            await sleep(20); // eslint-disable-line no-await-in-loop
        }
        gs.set_string('voice-ro', 'v1');
        await until(() => batches.length > 0, 2000, 'the batch');
        await sleep(300);
        eq(batches.length, 1, 'one batch');
        ok(batches[0].includes('llm-model') && batches[0].includes('voice-ro'), `keys ${batches[0]}`);
        await until(() => restarts.length === 1, 1000, 'one restart');
        eq(a.settings.llmModel, 'mistral-large');

        // Mid-turn: the restart waits for the turn to end.
        a.busy = true;
        gs.set_string('llm-provider', 'openai');
        await sleep(400);
        eq(restarts.length, 1, 'no restart during a turn');
        a.busy = false;
        a._restartAgentWhenIdle(false);
        eq(restarts.length, 2, 'restarted once idle');
        await a.shutdown();
    },
};
