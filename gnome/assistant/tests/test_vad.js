// End-of-speech detection (TestVAD in assistant_test.go).

import {eq, ok, tone} from './assert.js';
import {NoiseFloor, Utterance, defaultVAD} from '../vad.js';

function record(frames, floor) {
    const u = new Utterance(floor, defaultVAD);
    for (const f of frames) {
        const r = u.push(f);
        if (r)
            return r;
    }
    return null;
}

export const tests = {
    speechThenSilence() {
        const frames = [...tone(150, 500), ...tone(3000, 1500), ...tone(150, 2000)];
        const floor = new NoiseFloor();
        floor.update(150 / Math.SQRT2);
        const r = record(frames, floor);
        ok(r?.heard, 'speech not detected');
        const secs = r.pcm.length / 2 / 16000;
        // 1.5 s speech + up to 0.4 s lead-in + ~0.9 s trailing silence.
        ok(secs >= 2 && secs <= 3, `utterance length ${secs}s`);
    },

    onlyNoiseGivesUp() {
        const floor = new NoiseFloor();
        floor.update(150 / Math.SQRT2);
        const r = record(tone(150, 6000), floor);
        ok(r, 'never gave up');
        eq(r.heard, false, 'noise taken for speech');
    },
};
