// GSettings over the config file, debounced changes: a new model is set on the
// running agent, anything else of the agent's restarts it, once and never mid-turn.

import {eq, ok, until} from './assert.js';
import {makeAssistant, memorySettings} from './helpers.js';
import {sleep} from '../util.js';

// Tests that need the installed schema fail without it: run through the package
// (or with GSETTINGS_SCHEMA_DIR pointing at the compiled gnome/assistant schema).
function schemaSettings() {
    const gs = memorySettings();
    if (!gs)
        throw new Error('schema org.balaur.Assistant is not installed; run through the package');
    return gs;
}

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

    // The schema's keys are empty by default, so the config file (the Nix
    // options) is what an unset key means; a value in dconf wins over it.
    async emptySchemaKeysFallBackToTheConfigFile() {
        const gs = schemaSettings();
        const a = makeAssistant({gsettings: gs});
        eq(gs.get_string('speech-base-url'), '', 'the schema default is empty');
        a.cfg.llm.baseUrl = 'https://speech.example/v1';
        eq(a.settings.speechBaseUrl, 'https://speech.example/v1', 'the config file when the key is empty');
        gs.set_string('speech-base-url', 'https://other.example/v1');
        eq(a.settings.speechBaseUrl, 'https://other.example/v1', 'the key when set');
        gs.set_string('speech-base-url', '');
        eq((await a._agentEnv()).BALAUR_SPEECH_BASE_URL, 'https://speech.example/v1');
        await a.shutdown();
    },

    // What the empty llm-model key means: the config's model if the agent has it, else its own.
    async defaultModelIsTheConfigsWhenTheAgentHasIt() {
        const a = makeAssistant();
        const ready = model => ({models: {providers: [{id: 'faux', name: 'faux', models: [{id: 'm1', name: 'M1'}, {id: 'm2', name: 'M2'}]}]}, model});
        a._agentReady(ready('m2'));
        eq(JSON.parse(a.models).defaults.model, 'm1', "the config's llm.model, which the agent has");
        a.cfg.llm.model = 'gone';
        a._agentReady(ready('m2'));
        eq(JSON.parse(a.models).defaults.model, 'm2', "the agent's own when the config's is not among its models");
        a.cfg.llm.model = 'm2';
        a._agentReady(ready('m1'));
        await a.settingsChanged([]);
        eq(JSON.parse(a.models).defaults.model, 'm2', 'recomputed when settings change');
        await a.shutdown();
    },

    async theAgentGetsItsModelAndTheMistralKeyOnly() {
        const a = makeAssistant();
        eq(Object.keys(await a._agentEnv()).sort().join(),
            'BALAUR_ASSISTANT_CONFIG,BALAUR_LLM_MODEL,BALAUR_SPEECH_BASE_URL,MISTRAL_API_KEY');
        await a.shutdown();
    },

    async debouncedModelChangeAndRestartNotMidTurn() {
        const gs = schemaSettings();
        const a = makeAssistant({gsettings: gs});
        const batches = [];
        const restarts = [];
        const models = [];
        a.agent.restart = async () => restarts.push(Date.now());
        a.agent.setModel = async id => (models.push(id), '');
        // A turn that lasts until the test lets it go; the loop marks itself busy.
        let finishTurn = null;
        a.agent.ask = () => new Promise(resolve => (finishTurn = resolve));
        a._run();
        // As application.js wires it, with the test's short debounce.
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
        const turn = a.ask('a question', false);
        await until(() => finishTurn && a.busy, 2000, 'the turn to be under way');
        gs.set_string('speech-base-url', 'https://example.invalid/v1');
        await sleep(400);
        eq(restarts.length, 0, 'no restart during a turn');
        finishTurn('an answer');
        eq(await turn, 'an answer');
        await until(() => restarts.length > 0, 2000, 'the restart after the turn');
        eq(restarts.length, 1, 'restarted once, by the loop, when idle');
        await a.shutdown();
    },
};
