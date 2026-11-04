// End-of-speech detection by energy: an adaptive noise floor plus a margin.
// Good enough for a quiet room and a person speaking close to the laptop.
// A port of assistant/vad.go (the former Go service, in git history); the recorder is a push-driven state machine
// here (frames arrive from the GStreamer capture on the main loop).

export const MIC_RATE = 16000;
// 80 ms of 16 kHz mono 16-bit audio: the frame size openWakeWord works in.
export const FRAME_SAMPLES = 1280;
export const FRAME_BYTES = FRAME_SAMPLES * 2;
export const FRAME_MS = 80;

export function frameRMS(pcm) {
    const n = pcm.length >> 1;
    if (n === 0)
        return 0;
    const dv = new DataView(pcm.buffer, pcm.byteOffset, pcm.byteLength);
    let sum = 0;
    for (let i = 0; i < n; i++) {
        const s = dv.getInt16(2 * i, true);
        sum += s * s;
    }
    return Math.sqrt(sum / n);
}

/**
 * Follows background loudness: it drops quickly and rises slowly, so speech
 * does not drag it up but a fan switching on eventually does.
 */
export class NoiseFloor {
    constructor() {
        this.v = 0;
    }

    update(rms) {
        if (this.v === 0)
            this.v = rms;
        else if (rms < this.v)
            this.v = 0.9 * this.v + 0.1 * rms;
        else
            this.v = 0.995 * this.v + 0.005 * rms;
        this.v = Math.max(this.v, 50);
    }

    get() {
        return Math.max(this.v, 50);
    }
}

// 2.5x the background, and at least +120: a quiet room has a floor near 50.
export function speechThreshold(floor) {
    return Math.max(floor * 2.5, floor + 120);
}

// Milliseconds: give up if speech has not started by startTimeout; this much
// quiet after speech (endSilence) ends the utterance; maxLength caps it.
export const defaultVAD = {startTimeout: 5000, endSilence: 900, maxLength: 12000};

/**
 * One utterance being recorded. push() each frame; it returns null while
 * listening, then {pcm, heard, peak, threshold} once the speaker stopped (or
 * never started). pcm has a little lead-in before speech started.
 */
export class Utterance {
    constructor(floor, cfg = defaultVAD) {
        this.floor = floor;
        this.cfg = cfg;
        this.buf = [];
        this.started = false;
        this.loud = 0; // consecutive loud frames
        this.quiet = 0;
        this.elapsed = 0;
        this.speechStart = 0;
        this.peak = 0;
        this.th = speechThreshold(floor.get());
    }

    push(f) {
        const {cfg} = this;
        this.elapsed += FRAME_MS;
        this.buf.push(f);
        const rms = frameRMS(f);
        this.peak = Math.max(this.peak, rms);
        if (!this.started) {
            if (rms > this.th) {
                this.loud++;
                if (this.loud >= 2) { // 160 ms of sound: someone is talking
                    this.started = true;
                    this.speechStart = Math.max(0, this.buf.length - 2 - 5); // keep 400 ms before it
                }
            } else {
                this.loud = 0;
                this.floor.update(rms);
                this.th = speechThreshold(this.floor.get());
            }
            if (!this.started && this.elapsed >= cfg.startTimeout)
                return this.nothing();
            return null;
        }
        if (rms > this.th)
            this.quiet = 0;
        else
            this.quiet += FRAME_MS;
        if (this.quiet >= cfg.endSilence || this.elapsed >= cfg.maxLength + cfg.startTimeout ||
            (this.buf.length - this.speechStart) * FRAME_MS >= cfg.maxLength) {
            const frames = this.buf.slice(this.speechStart);
            const pcm = new Uint8Array(frames.reduce((n, b) => n + b.length, 0));
            let off = 0;
            for (const b of frames) {
                pcm.set(b, off);
                off += b.length;
            }
            return {pcm, heard: true, peak: this.peak, threshold: this.th};
        }
        return null;
    }

    nothing() {
        return {pcm: null, heard: false, peak: this.peak, threshold: this.th};
    }
}
