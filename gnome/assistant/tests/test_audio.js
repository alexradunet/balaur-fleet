// Capture and playback pipelines with test elements in place of PipeWire
// (audiotestsrc, fakesink), the mic watchdog, earcons, volume parsing.

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

import {eq, ok, until} from './assert.js';
import {MAX_BUFFER_MS, Mic, Player, earconListen, parseWpctlVolume, pulseDevice, splitPCM} from '../audio.js';
import {monoMs, sleep} from '../util.js';

const silence = ms => ({rate: 24000, channels: 1, data: new Uint8Array(Math.round(24000 * ms / 1000) * 2)});

export const tests = {
    // pipewiresink drops oversized buffers without a word: everything played
    // must go out in small pieces that add up to the whole, frame-aligned.
    playerSplitsAudioIntoSmallBuffers() {
        const pcm = {rate: 22050, channels: 2, data: new Uint8Array(earconListen.data.length * 2).map((_, i) => i & 0xff)};
        const parts = splitPCM(pcm, MAX_BUFFER_MS);
        const max = Math.round(22050 * MAX_BUFFER_MS / 1000) * 4;
        ok(parts.length > 1, `${parts.length} part(s)`);
        ok(parts.every(p => p.length <= max && p.length % 4 === 0), 'a part is too big or not frame-aligned');
        eq(parts.reduce((n, p) => n + p.length, 0), pcm.data.length);
        eq(parts[parts.length - 1].at(-1), pcm.data.at(-1));
    },

    async playerPlaysAChunkedStreamInRealTime() {
        const p = new Player('pulse', {sink: 'fakesink sync=true'});
        const chunks = [silence(200), silence(200)];
        const t0 = monoMs();
        await p.play({next: async () => {
            await sleep(20);
            return chunks.shift() ?? null;
        }});
        const took = monoMs() - t0;
        ok(took >= 350 && took < 2000, `played 400 ms of audio in ${took.toFixed(0)} ms`);
    },

    async playerStopsAtOnceWhenCancelled() {
        const p = new Player('pulse', {sink: 'fakesink sync=true'});
        const c = new Gio.Cancellable();
        const t0 = monoMs();
        sleep(150).then(() => c.cancel());
        await p.playPCM(silence(3000), c);
        ok(monoMs() - t0 < 1000, 'cancel did not stop playback');
    },

    async playerRejectsAFormatChange() {
        const p = new Player('pulse', {sink: 'fakesink sync=false'});
        const chunks = [silence(50), {rate: 16000, channels: 1, data: new Uint8Array(320)}];
        let err = null;
        try {
            await p.play({next: async () => chunks.shift() ?? null});
        } catch (e) {
            err = e;
        }
        ok(err && /format changed/.test(err.message), `error ${err?.message}`);
    },

    async micDeliversFramesAndMutes() {
        const frames = [];
        const mic = new Mic('pulse:balaur-mic', f => frames.push(f), {source: 'audiotestsrc is-live=true wave=sine'});
        mic.start();
        await until(() => frames.length >= 5, 3000, 'mic frames');
        ok(frames.every(f => f.length === 2560), 'frames are 80 ms of 16 kHz mono S16LE');
        mic.setMuted(true);
        eq(mic.pipeline, null, 'muting closes the pipeline');
        const n = frames.length;
        await sleep(300);
        eq(frames.length, n, 'no frames while muted');
        mic.setMuted(false);
        await until(() => frames.length > n + 3, 3000, 'frames after unmuting');
        mic.stop();
    },

    async micWatchdogRestartsASilentCapture() {
        // An appsrc nobody feeds: connected but silent, as after a PipeWire restart.
        let starts = 0;
        const mic = new Mic('pulse', () => {}, {source: 'appsrc is-live=true format=time caps=audio/x-raw,format=S16LE,rate=16000,channels=1,layout=interleaved'});
        const orig = mic._startCapture.bind(mic);
        mic._startCapture = () => {
            starts++;
            orig();
        };
        mic.start();
        await until(() => starts >= 2, 9000, 'a restart after 5 s without audio');
        mic.stop();
    },

    earconsAndVolume() {
        eq(earconListen.rate, 22050);
        eq(earconListen.data.length, (Math.trunc(22050 * 70 / 1000) + Math.trunc(22050 * 110 / 1000)) * 2);
        eq(parseWpctlVolume('Volume: 0.45\n'), 45);
        eq(parseWpctlVolume('Volume: 0.70 [MUTED]\n'), 0);
        eq(parseWpctlVolume('Volume: 1.20\n'), 100);
        eq(pulseDevice('pulse:balaur-mic')[0], 'balaur-mic');
        eq(pulseDevice('hw:0,7')[1], false);
    },
};

// On the real session (BALAUR_TEST_PIPEWIRE=1, run as the household user):
// the actual PipeWire elements, playing silence only.
if (GLib.getenv('BALAUR_TEST_PIPEWIRE') === '1') {
    tests.pipewireSinkPlaysSilenceToTheEnd = async () => {
        const p = new Player('pulse');
        const t0 = monoMs();
        await p.playPCM(silence(500));
        const took = monoMs() - t0;
        ok(took >= 400 && took < 3000, `500 ms of silence took ${took.toFixed(0)} ms`);
    };
    tests.pipewireSrcBalaurMicDeliversFrames = async () => {
        const frames = [];
        const mic = new Mic('pulse:balaur-mic', f => frames.push(f));
        mic.start();
        await until(() => frames.length >= 10, 5000, 'frames from balaur-mic');
        mic.stop();
    };
}
