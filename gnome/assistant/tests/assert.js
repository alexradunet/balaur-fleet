// Assertions for the tests (no framework).

import GLib from 'gi://GLib';

export function ok(v, msg = 'expected a true value') {
    if (!v)
        throw new Error(msg);
}

export function eq(a, b, msg = '') {
    if (a !== b)
        throw new Error(`${msg ? `${msg}: ` : ''}got ${JSON.stringify(a)}, want ${JSON.stringify(b)}`);
}

export function deepEq(a, b, msg = '') {
    const x = JSON.stringify(a), y = JSON.stringify(b);
    if (x !== y)
        throw new Error(`${msg ? `${msg}: ` : ''}got ${x}, want ${y}`);
}

export async function rejects(p, re, msg = 'expected a failure') {
    try {
        await p;
    } catch (e) {
        if (re && !re.test(e.message))
            throw new Error(`${msg}: wrong error ${JSON.stringify(e.message)}`);
        return e;
    }
    throw new Error(msg);
}

/** A fresh temporary directory. */
export function tempDir() {
    return GLib.dir_make_tmp('balaur-assistant-test-XXXXXX');
}

/** Waits until cond() is true (polling the main loop), or fails after ms. */
export function until(cond, ms = 3000, what = 'condition') {
    return new Promise((resolve, reject) => {
        const t0 = GLib.get_monotonic_time();
        GLib.timeout_add(GLib.PRIORITY_DEFAULT, 10, () => {
            if (cond()) {
                resolve();
                return GLib.SOURCE_REMOVE;
            }
            if (GLib.get_monotonic_time() - t0 > ms * 1000) {
                reject(new Error(`timed out waiting for ${what}`));
                return GLib.SOURCE_REMOVE;
            }
            return GLib.SOURCE_CONTINUE;
        });
    });
}

/** 16 kHz frames of a sine tone at amplitude amp for ms milliseconds (tone() in assistant_test.go). */
export function tone(amp, ms) {
    const frames = [];
    const samples = Math.floor(ms / 1000 * 16000);
    let cur = new Uint8Array(2560), n = 0;
    let dv = new DataView(cur.buffer);
    for (let i = 0; i < samples; i++) {
        dv.setInt16(2 * n, Math.trunc(amp * Math.sin(2 * Math.PI * 300 * i / 16000)), true);
        if (++n === 1280) {
            frames.push(cur);
            cur = new Uint8Array(2560);
            dv = new DataView(cur.buffer);
            n = 0;
        }
    }
    return frames;
}
