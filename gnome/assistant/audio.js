// Microphone capture and speaker playback through GStreamer, and the speaker
// volume. With the desktop (the normal case) everything goes through the
// session's PipeWire: capture from the `balaur-mic` node, playback to the
// default sink as media.role=Assistant (so WirePlumber can duck or route it),
// volume with wpctl. An ALSA device name in the config ("hw:0,7", no "pulse"
// prefix) uses alsasrc/alsasink and amixer instead, as the Go code did.

import GLib from 'gi://GLib';
import Gst from 'gi://Gst?version=1.0';
import GstApp from 'gi://GstApp?version=1.0'; // eslint-disable-line no-unused-vars

import {FRAME_BYTES, MIC_RATE} from './vad.js';
import {concatBytes, errText, log, monoMs, run, sleep} from './util.js';

Gst.init(null);

/**
 * Reports whether a configured device names the sound server, and which
 * source/sink ("" = the server's default): "pulse" or "pulse:<name>".
 */
export function pulseDevice(device) {
    if (device === 'pulse')
        return ['', true];
    if (device?.startsWith('pulse:'))
        return [device.slice('pulse:'.length), true];
    return ['', false];
}

// gst-launch syntax quoting for property values.
const q = s => `"${String(s).replace(/(["\\])/g, '\\$1')}"`;

// A sound server restart can leave a recorder connected but with no stream,
// silent rather than failing: restart capture after this long without audio.
const MIC_STALL_MS = 5000;
const MIC_RETRY_MS = 2000;
const POLL_MS = 40;

/**
 * Captures 16 kHz mono audio continuously (unless muted) and calls onFrame
 * with 80 ms frames (2560 bytes).
 *
 * The appsink is polled from the main loop rather than signalled: its
 * new-sample signal is emitted on a streaming thread, where JS cannot run.
 */
export class Mic {
    constructor(device, onFrame, {source = null} = {}) {
        this.device = device;
        this.onFrame = onFrame;
        this.sourceOverride = source; // tests: e.g. "audiotestsrc"
        this.muted = false;
        this.pipeline = null;
        this.sink = null;
        this.pollId = 0;
        this.retryId = 0;
        this.pending = new Uint8Array(0);
        this.lastAudio = 0;
        this.busWatch = false;
    }

    start() {
        if (!this.muted)
            this._startCapture();
    }

    setMuted(muted) {
        this.muted = muted;
        if (muted) {
            this._stopCapture();
            this._cancelRetry();
        } else if (!this.pipeline && !this.retryId) {
            this._startCapture();
        }
    }

    stop() {
        this._cancelRetry();
        this._stopCapture();
    }

    _sourceDesc() {
        if (this.sourceOverride)
            return this.sourceOverride;
        const [name, pulse] = pulseDevice(this.device);
        if (pulse) {
            return `pipewiresrc client-name=${q('Balaur assistant')}` +
                ` stream-properties=${q('props,media.name=(string)"Wake word",application.name=(string)"Balaur assistant"')}` +
                (name ? ` target-object=${q(name)}` : '');
        }
        return `alsasrc device=${q(this.device)}`;
    }

    _startCapture() {
        const desc = `${this._sourceDesc()} ! audioconvert ! audioresample ! ` +
            `audio/x-raw,format=S16LE,rate=${MIC_RATE},channels=1,layout=interleaved ! ` +
            'appsink name=sink sync=false max-buffers=100 drop=true emit-signals=false';
        try {
            this.pipeline = Gst.parse_launch(desc);
        } catch (e) {
            this._failed(`capture: ${errText(e)}`);
            return;
        }
        this.sink = this.pipeline.get_by_name('sink');
        const bus = this.pipeline.get_bus();
        bus.add_watch(GLib.PRIORITY_DEFAULT, (_bus, msg) => {
            if (msg.type === Gst.MessageType.ERROR) {
                const [err, debug] = msg.parse_error();
                this._failed(`${err.message}${debug ? ` (${debug.split('\n')[0]})` : ''}`);
                return GLib.SOURCE_REMOVE;
            }
            if (msg.type === Gst.MessageType.EOS) {
                this._failed('capture ended');
                return GLib.SOURCE_REMOVE;
            }
            return GLib.SOURCE_CONTINUE;
        });
        this.busWatch = true;
        this.pending = new Uint8Array(0);
        this.lastAudio = monoMs(); // the watchdog starts with the capture
        this.pipeline.set_state(Gst.State.PLAYING);
        this.pollId = GLib.timeout_add(GLib.PRIORITY_HIGH, POLL_MS, () => this._poll());
    }

    _poll() {
        if (!this.sink)
            return GLib.SOURCE_REMOVE;
        let sample;
        while ((sample = this.sink.try_pull_sample(0))) {
            const buf = sample.get_buffer();
            const data = buf.extract_dup(0, buf.get_size());
            if (data.length === 0)
                continue;
            this.lastAudio = monoMs();
            this.pending = this.pending.length ? concatBytes([this.pending, data]) : data;
            while (this.pending.length >= FRAME_BYTES) {
                const f = this.pending.slice(0, FRAME_BYTES);
                this.pending = this.pending.subarray(FRAME_BYTES);
                try {
                    this.onFrame(f);
                } catch (e) {
                    logError(e, 'mic frame');
                }
                if (!this.sink) // muted or restarted by the consumer
                    return GLib.SOURCE_REMOVE;
            }
        }
        if (monoMs() - this.lastAudio > MIC_STALL_MS) {
            this.pollId = 0;
            this._failed(`no audio for ${MIC_STALL_MS / 1000}s`);
            return GLib.SOURCE_REMOVE;
        }
        return GLib.SOURCE_CONTINUE;
    }

    _failed(why) {
        this._stopCapture();
        if (this.muted || this.retryId)
            return;
        log(`mic: ${why} (retrying)`);
        this.retryId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, MIC_RETRY_MS, () => {
            this.retryId = 0;
            if (!this.muted)
                this._startCapture();
            return GLib.SOURCE_REMOVE;
        });
    }

    _cancelRetry() {
        if (this.retryId) {
            GLib.source_remove(this.retryId);
            this.retryId = 0;
        }
    }

    _stopCapture() {
        if (this.pollId) {
            GLib.source_remove(this.pollId);
            this.pollId = 0;
        }
        if (this.pipeline) {
            if (this.busWatch)
                this.pipeline.get_bus().remove_watch();
            this.busWatch = false;
            // NULL closes the device: the stream (and GNOME's mic indicator) goes away.
            this.pipeline.set_state(Gst.State.NULL);
            this.pipeline = null;
            this.sink = null;
        }
    }
}

// pipewiresink silently drops a buffer bigger than PipeWire's own: an earcon
// or a TTS chunk pushed in one piece came out as nothing at all. So playback
// goes in buffers of at most this long.
export const MAX_BUFFER_MS = 20;

// How long after the last sample is handed over it is still coming out of the speakers.
const PLAYOUT_MARGIN_MS = 150;

/** Splits 16-bit PCM into views of at most `ms` each, on frame boundaries. */
export function splitPCM(pcm, ms) {
    const frame = 2 * pcm.channels;
    const step = Math.max(1, Math.round(pcm.rate * ms / 1000)) * frame;
    const parts = [];
    for (let off = 0; off < pcm.data.length; off += step)
        parts.push(pcm.data.subarray(off, Math.min(off + step, pcm.data.length)));
    return parts;
}

/**
 * Plays PCM ({rate, channels, data}) through a fresh pipeline per stream.
 * Callers serialise playback (only the pipeline loop speaks).
 */
export class Player {
    constructor(device, {sink = null} = {}) {
        this.device = device;
        this.sinkOverride = sink; // tests: "fakesink sync=true"
    }

    _sinkDesc() {
        if (this.sinkOverride)
            return this.sinkOverride;
        const [name, pulse] = pulseDevice(this.device);
        if (pulse) {
            return `pipewiresink client-name=${q('Balaur assistant')}` +
                ` stream-properties=${q('props,media.role=(string)Assistant,media.name=(string)Voice,application.name=(string)"Balaur assistant"')}` +
                (name ? ` target-object=${q(name)}` : '');
        }
        return `alsasink device=${q(this.device)}`;
    }

    /**
     * Plays everything from source (an object whose next() resolves to the
     * next PCM chunk, or null at the end) until it ends or the cancellable
     * fires, which stops the sound at once. Resolves when playback finished;
     * throws on errors (not on cancellation).
     */
    async play(source, cancellable = null) {
        if (cancellable?.is_cancelled())
            return;
        const first = await source.next();
        if (!first || cancellable?.is_cancelled())
            return;
        const pipeline = Gst.parse_launch(
            `appsrc name=src format=time is-live=false caps=${q(`audio/x-raw,format=S16LE,layout=interleaved,rate=${first.rate},channels=${first.channels}`)} ` +
            `! audioconvert ! audioresample ! ${this._sinkDesc()}`);
        const src = pipeline.get_by_name('src');
        let samples = 0, finished = false;
        let resolveDone, rejectDone;
        const done = new Promise((res, rej) => {
            resolveDone = res;
            rejectDone = rej;
        });
        const bus = pipeline.get_bus();
        bus.add_watch(GLib.PRIORITY_DEFAULT, (_bus, msg) => {
            if (msg.type === Gst.MessageType.EOS) {
                resolveDone();
                return GLib.SOURCE_REMOVE;
            }
            if (msg.type === Gst.MessageType.ERROR) {
                rejectDone(new Error(msg.parse_error()[0].message));
                return GLib.SOURCE_REMOVE;
            }
            return GLib.SOURCE_CONTINUE;
        });
        const cid = cancellable ? cancellable.connect(() => resolveDone()) : 0;
        const push = pcm => {
            for (const part of splitPCM(pcm, MAX_BUFFER_MS)) {
                const buf = Gst.Buffer.new_wrapped_bytes(new GLib.Bytes(part));
                const n = part.length / 2 / pcm.channels;
                buf.pts = Gst.util_uint64_scale(samples, Gst.SECOND, pcm.rate);
                buf.duration = Gst.util_uint64_scale(n, Gst.SECOND, pcm.rate);
                samples += n;
                src.push_buffer(buf);
            }
        };
        try {
            push(first);
            pipeline.set_state(Gst.State.PLAYING);
            const started = monoMs();
            // Feed the rest as it is synthesised; stop early on cancel or error.
            const feeding = (async () => {
                for (;;) {
                    const c = await Promise.race([source.next(), done.then(() => null)]); // eslint-disable-line no-await-in-loop
                    if (!c || finished || cancellable?.is_cancelled())
                        break;
                    if (c.rate !== first.rate || c.channels !== first.channels)
                        throw new Error('audio format changed mid-stream');
                    push(c);
                }
                src.end_of_stream();
            })();
            await Promise.all([feeding, done]);
            // EOS means PipeWire has the last buffer, not that it was heard: wait
            // until it has played out (plus PipeWire's latency), so callers that
            // record next (after the "listening" earcon) don't hear its tail.
            if (!cancellable?.is_cancelled() && !this.sinkOverride)
                await sleep(Math.max(0, started + samples * 1000 / first.rate + PLAYOUT_MARGIN_MS - monoMs()), cancellable);
        } finally {
            finished = true;
            if (cid)
                cancellable.disconnect(cid);
            bus.remove_watch();
            pipeline.set_state(Gst.State.NULL);
        }
    }

    /** Plays one buffer. */
    playPCM(pcm, cancellable = null) {
        let given = false;
        return this.play({next: async () => (given ? null : (given = true, pcm))}, cancellable);
    }
}

// ---- earcons ----

const TONE_RATE = 22050;

/** Renders a short sequence of soft sine notes ([Hz, ms], ...). */
export function tones(...notes) {
    const parts = [];
    for (const [freq, ms] of notes) {
        const samples = Math.trunc(TONE_RATE * ms / 1000);
        const out = new Uint8Array(samples * 2);
        const dv = new DataView(out.buffer);
        for (let i = 0; i < samples; i++) {
            // Short fade in/out so the notes don't click.
            const env = Math.min(1, Math.min(i, samples - i) / (TONE_RATE * 0.01));
            const v = freq > 0 ? 0.25 * env * Math.sin(2 * Math.PI * freq * i / TONE_RATE) : 0;
            dv.setInt16(2 * i, Math.trunc(v * 32767), true);
        }
        parts.push(out);
    }
    return {rate: TONE_RATE, channels: 1, data: concatBytes(parts)};
}

export const earconListen = tones([660, 70], [990, 110]);
export const earconDone = tones([990, 70], [660, 110]);
export const earconError = tones([330, 160], [0, 60], [330, 160]);
export const earconAlarm = tones([880, 150], [0, 80], [880, 150], [0, 80], [1175, 300], [0, 400]);

// ---- volume ----

/** wpctl's "Volume: 0.45 [MUTED]" -> 0-100 (0 when muted). */
export function parseWpctlVolume(out) {
    if (out.includes('[MUTED]'))
        return 0;
    const m = out.match(/Volume:\s*([0-9.]+)/);
    if (!m)
        throw new Error(`wpctl: no volume in ${JSON.stringify(out)}`);
    return Math.min(100, Math.round(Number(m[1]) * 100));
}

/** The session's output volume (0-100, 0 when muted). */
export async function getVolume(output) {
    const [name, pulse] = pulseDevice(output);
    if (!pulse)
        throw new Error('volume is only read from a sound server');
    return parseWpctlVolume(await run(['wpctl', 'get-volume', name || '@DEFAULT_AUDIO_SINK@']));
}

/**
 * Sets the speaker volume (0-100): the session's default sink (0 also
 * mutes it), else the ALSA card's Master control.
 */
export async function setVolume(output, card, percent) {
    percent = Math.max(0, Math.min(100, Math.round(percent)));
    const [name, pulse] = pulseDevice(output);
    if (pulse) {
        const target = name || '@DEFAULT_AUDIO_SINK@';
        await run(['wpctl', 'set-volume', target, `${percent}%`]);
        await run(['wpctl', 'set-mute', target, percent === 0 ? '1' : '0']);
        return;
    }
    await run(['amixer', '-q', '-c', card, 'sset', 'Master', `${percent}%`, percent === 0 ? 'mute' : 'unmute']);
}
