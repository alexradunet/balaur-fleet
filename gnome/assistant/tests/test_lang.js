// Language heuristics and reply cleaning (TestDetectLang, TestSentencesAndSpoken,
// TestIsStopAndNoise, TestLooksRoOrEn in assistant_test.go).

import {deepEq, eq, ok} from './assert.js';
import {detectLang, fold, isNoise, isStop, looksRoOrEn, normLang, sentences, spoken} from '../lang.js';

export const tests = {
    detectLang() {
        const cases = {
            'Adaugă lapte pe lista de cumpărături': 'ro',
            'cat e ceasul': 'ro',
            "What's the weather tomorrow?": 'en',
            'Set a timer for ten minutes': 'en',
            'Bună dimineața! Astăzi va fi soare.': 'ro',
        };
        for (const [input, want] of Object.entries(cases))
            eq(detectLang(input), want, input);
    },

    sentencesAndSpoken() {
        const got = sentences('Gata. Am adăugat 2.5 kg de mere! Mai vrei ceva?');
        deepEq(got, ['Gata.', 'Am adăugat 2.5 kg de mere!', 'Mai vrei ceva?']);
        eq(spoken('<think>hmm</think>**Sure!**\n- one\n- two [link](http://x)'), 'Sure! one two link');
    },

    isStopAndNoise() {
        for (const s of ['Stop.', 'gata!', 'Lasă', 'never mind', 'Mulțumesc.'])
            ok(isStop(s), `isStop(${s})`);
        ok(!isStop('stop the music in the kitchen'), 'long sentence taken as stop');
        ok(isNoise('Mulțumesc pentru vizionare!'), 'noise phrase');
        ok(!isNoise('Cât e ceasul?'), 'real question taken as noise');
        ok(isNoise(' . '), 'empty is noise');
    },

    looksRoOrEn() {
        const cases = {
            'Bir sonraki videoda görüşürüz.': false, // what STT made of "Cât e ceasul?"
            'Cât e ceasul?': true,
            "What's the weather like tomorrow?": true,
            'Adaugă lapte și ouă pe listă.': true,
            'Ciao, come stai oggi amico': false,
            'Mihai': true,
        };
        for (const [input, want] of Object.entries(cases))
            eq(looksRoOrEn(input), want, input);
    },

    normLangAndFold() {
        eq(normLang('Romanian'), 'ro');
        eq(normLang('en-US'), 'en');
        eq(normLang('tr'), '');
        eq(fold(' Cumpărături Țară '), 'cumparaturi tara');
    },
};
