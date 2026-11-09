// GSettings over the config file, debounced changes: a new model is set on the
// running agent, anything else of the agent's restarts it, once and never mid-turn.

import {eq, ok, until} from './assert.js';
import {makeAssistant, memorySettings} from './helpers.js';
import {sleep} from '../util.js';

export const tests = {
    async fallbacksAndVoices() {
        const a = makeAssistant();
        const s = a.settings;
        eq(s.llmModel, 'm1', 'config llm.model when GSettings has none');
        eq(s.speechBaseUrl, 'https://api.mistral.ai/v1');
        a.cfg.tts.voices = {ro: 'v-ro', en: 'v-en'};
        eq(a.voiceFor('Hello there, what is the time?', 'ro'), 'v-en', 'the text decides the voice');
        eq(a.voiceFor('...', 'ro'), 'v-ro');
        await a.shutdown();
    },

    async theAgentGetsItsModelAndTheMistralKeyOnly() {
        const a = makeAssistant();
        eq(Object.keys(await a._agentEnv()).sort().join(),
            'BALAUR_ASSISTANT_CONFIG,BALAUR_LLM_MODEL,BALAUR_SPEECH_BASE_URL,MISTRAL_API_KEY');
        await a.shutdown();
    },

    async debouncedModelChangeAndRestartNotMidTurn() {
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
        const models = [];
        a.agent.restart = async () => restarts.push(Date.now());
        a.agent.setModel = async id => (models.push(id), '');
        const origChanged = a.settingsChanged.bind(a);
        a.settings = new (a.settings.constructor)(a.cfg, keys => {
            batches.push(keys);
            origChanged(keys);
        }, {gsettings: gs, keyring: false, debounceMs: 150});
        // Typing "balaur-local" one key at a time.
        for (const ch of 'balaur-local') {
            gs.set_string('llm-model', (gs.get_string('llm-model') + ch));
            await sleep(20); // eslint-disable-line no-await-in-loop
        }
        gs.set_string('voice-ro', 'v1');
        await until(() => batches.length > 0, 2000, 'the batch');
        await sleep(300);
        eq(batches.length, 1, 'one batch');
        ok(batches[0].includes('llm-model') && batches[0].includes('voice-ro'), `keys ${batches[0]}`);
        eq(models.join(), 'balaur-local', 'the model is set once, on the running agent');
        eq(restarts.length, 0, 'a new model needs no restart');
        eq(a.settings.llmModel, 'balaur-local');

        // The speech server is in the agent's environment (web search): a restart,
        // and mid-turn it waits for the turn to end.
        a.busy = true;
        gs.set_string('speech-base-url', 'https://example.invalid/v1');
        await sleep(400);
        eq(restarts.length, 0, 'no restart during a turn');
        a.busy = false;
        a._restartAgentWhenIdle(false);
        eq(restarts.length, 1, 'restarted once idle');
        await a.shutdown();
    },
};
