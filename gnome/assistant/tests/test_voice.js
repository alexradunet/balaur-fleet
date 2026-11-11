// The voice turn (wake word to speech) with stand-ins for the recorder, the
// speech server and the speaker: what is transcribed again, what ends a turn,
// and Stop during each step.

import GLib from 'gi://GLib';

import {deepEq, eq, ok, until} from './assert.js';
import {FakePlayer, makeAssistant} from './helpers.js';
import {Cancelled} from '../http.js';
import {logText} from '../util.js';

/**
 * An assistant whose recorder hears a fixed clip and whose model answers with
 * answer(text); transcripts[i] is what the speech server says for the i-th
 * call (a function gets (lang, cancellable) and may throw or wait).
 */
function voiceAssistant(transcripts, answer = () => 'Gata.', player = null) {
    const a = makeAssistant({player});
    const calls = [], asked = [];
    a._record = async () => ({pcm: new Uint8Array(3200), heard: true, peak: 1000, threshold: 100});
    a.mistral = {
        transcribe: async (_model, _pcm, lang, cancellable) => {
            calls.push(lang);
            const t = transcripts[Math.min(calls.length, transcripts.length) - 1];
            return typeof t === 'function' ? t(lang, cancellable) : t;
        },
        speak: async () => ({rate: 24000, channels: 1, data: new Uint8Array(480)}),
    };
    a.converse = async text => {
        asked.push(text);
        return answer(text, asked.length);
    };
    return {a, calls, asked};
}

export const tests = {
    // Voxtral said English: that is a language we speak, however few words of our lists it holds.
    async anEnglishTranscriptIsKeptInARomanianConversation() {
        const {a, calls, asked} = voiceAssistant([{text: 'Turn off kitchen lights', language: 'en'}]);
        eq(a.lastLang, 'ro');
        await a.voiceTurn();
        eq(calls.length, 1, 'transcribed once');
        deepEq(asked, ['Turn off kitchen lights']);
        eq(a.lastLang, 'en');
        await a.shutdown();
    },

    async aTranscriptInAnotherLanguageIsAskedAgainInTheConversationLanguage() {
        const {a, calls, asked} = voiceAssistant([
            {text: 'Bir sonraki videoda görüşürüz.', language: 'tr'},
            {text: 'Cât e ceasul?', language: 'ro'},
        ]);
        await a.voiceTurn();
        deepEq(calls, ['', 'ro']);
        deepEq(asked, ['Cât e ceasul?']);
        await a.shutdown();
    },

    async anEmptySecondTranscriptKeepsTheFirst() {
        const {a, calls, asked} = voiceAssistant([
            {text: 'Cât e ceasul?', language: 'tr'},
            {text: '', language: 'ro'},
        ]);
        await a.voiceTurn();
        eq(calls.length, 2);
        deepEq(asked, ['Cât e ceasul?']);
        await a.shutdown();
    },

    async aFailedSecondTranscriptionKeepsTheFirst() {
        const {a, asked} = voiceAssistant([
            {text: 'Cât e ceasul?', language: 'tr'},
            () => {
                throw new Error('503 busy');
            },
        ]);
        await a.voiceTurn();
        deepEq(asked, ['Cât e ceasul?']);
        await a.shutdown();
    },

    // Stop while the second transcription runs ends the turn: the first, wrong transcript is not sent to the model.
    async stopDuringTheSecondTranscriptionEndsTheTurn() {
        let second = false;
        const {a, asked} = voiceAssistant([
            {text: 'Bir sonraki videoda görüşürüz.', language: 'tr'},
            (_lang, cancellable) => new Promise((_resolve, reject) => {
                second = true;
                cancellable.connect(() => reject(new Cancelled()));
            }),
        ]);
        const turn = a.voiceTurn();
        await until(() => second, 2000, 'the second transcription');
        a.stop();
        await turn;
        deepEq(asked, [], 'nothing was asked');
        eq(a.state, 'idle');
        await a.shutdown();
    },

    async anAcknowledgementAnswersAQuestionButDoesNotStartOne() {
        // The assistant asks; "Bine" is the answer.
        let {a, asked} = voiceAssistant([
            {text: 'Adaugă lapte', language: 'ro'},
            {text: 'Bine', language: 'ro'},
        ], (_t, n) => (n === 1 ? 'Să adaug și ouă?' : 'Am adăugat ouă.'));
        await a.voiceTurn();
        deepEq(asked, ['Adaugă lapte', 'Bine'], '"Bine" went on to the model');
        await a.shutdown();
        // Out of the blue it ends the turn.
        ({a, asked} = voiceAssistant([{text: 'Bine', language: 'ro'}]));
        await a.voiceTurn();
        deepEq(asked, []);
        await a.shutdown();
        // And a real stop word ends a follow-up.
        ({a, asked} = voiceAssistant([
            {text: 'Adaugă lapte', language: 'ro'},
            {text: 'Stop', language: 'ro'},
        ], () => 'Să adaug și ouă?'));
        await a.voiceTurn();
        deepEq(asked, ['Adaugă lapte']);
        await a.shutdown();
    },

    // Stop while the reply is being spoken: playback ends at once and the state goes back to idle.
    async stopWhileSpeakingReturnsToIdle() {
        const player = new FakePlayer({chunkMs: 400});
        const {a} = voiceAssistant([{text: 'Spune ceva', language: 'ro'}],
            () => 'Prima propoziție. A doua propoziție. A treia propoziție.', player);
        const turn = a.voiceTurn();
        await until(() => a.state === 'speaking', 3000, 'the reply to be spoken');
        await until(() => player.played.length >= 2, 3000, 'the first sentence to play');
        a.stop();
        const t0 = GLib.get_monotonic_time();
        await turn;
        ok((GLib.get_monotonic_time() - t0) / 1000 < 300, 'the turn ended at once');
        eq(a.state, 'idle');
        eq(player.played.length, 2, 'the earcon and the first sentence only');
        await a.shutdown();
    },

    async theJournalGetsLengthsNotWords() {
        eq(logText('Ana e alergică'), '14 chars');
        GLib.setenv('BALAUR_ASSISTANT_DEBUG', '1', true);
        try {
            eq(logText('Ana'), '"Ana"');
        } finally {
            GLib.unsetenv('BALAUR_ASSISTANT_DEBUG');
        }
    },
};
