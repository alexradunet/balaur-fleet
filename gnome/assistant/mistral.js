// Mistral's audio APIs (the chat model and its tools are pi's, see agent.js):
//
//	POST /v1/audio/transcriptions   speech to text (Voxtral), multipart
//	POST /v1/audio/speech           text to speech (Voxtral TTS)
//
// Only audio recorded after the wake word is sent; nothing is stored here.
// A port of the audio half of assistant/mistral.go (the former Go service, in git history).

import GLib from 'gi://GLib';
import Soup from 'gi://Soup?version=3.0';

import {bodyText, request} from './http.js';
import {log, monoMs, truncate} from './util.js';
import {MIC_RATE} from './vad.js';

export class Mistral {
    constructor(baseURL, key) {
        this.base = (baseURL ?? '').replace(/\/+$/, '');
        this.key = key;
    }

    async _do(opts, cancellable, timeoutMs) {
        const t0 = monoMs();
        const path = GLib.Uri.parse(opts.url, GLib.UriFlags.NONE).get_path();
        const headers = {...opts.headers ?? {}};
        if (this.key)
            headers.Authorization = `Bearer ${this.key}`;
        try {
            const res = await request({...opts, headers}, cancellable, timeoutMs);
            if (Math.floor(res.status / 100) !== 2)
                throw new Error(`${opts.method ?? 'POST'} ${path}: ${res.statusText}: ${truncate(bodyText(res), 300)}`);
            return res;
        } finally {
            log(`mistral ${path}: ${((monoMs() - t0) / 1000).toFixed(2)}s`);
        }
    }

    /**
     * Sends 16 kHz mono 16-bit PCM; returns {text, language}. lang forces the
     * language; empty lets the model detect it.
     */
    async transcribe(model, pcm, lang, cancellable = null) {
        const mp = Soup.Multipart.new('multipart/form-data');
        mp.append_form_string('model', model);
        if (lang)
            mp.append_form_string('language', lang);
        mp.append_form_file('file', 'speech.wav', 'audio/wav', new GLib.Bytes(wavFile(pcm, MIC_RATE, 1)));
        const url = `${this.base}/audio/transcriptions`;
        const message = Soup.Message.new_from_multipart(url, mp);
        const res = await this._do({method: 'POST', url, message}, cancellable, 30000);
        let out;
        try {
            out = JSON.parse(bodyText(res));
        } catch (e) {
            throw new Error(`transcription: bad response: ${e.message}`);
        }
        return {text: String(out.text ?? '').trim(), language: String(out.language ?? '')};
    }

    /**
     * Turns text into audio: {rate, channels, data}. The API returns either the
     * audio file itself or JSON with it base64-encoded; both are accepted.
     */
    async speak(model, voice, text, cancellable = null) {
        const body = {model, input: text, response_format: 'wav'};
        if (voice)
            body.voice_id = voice;
        const res = await this._do({
            method: 'POST', url: `${this.base}/audio/speech`,
            body: JSON.stringify(body), contentType: 'application/json',
        }, cancellable, 60000);
        let b = res.body;
        if (res.contentType.includes('json') || (b.length > 0 && b[0] === 0x7b)) {
            let j;
            try {
                j = JSON.parse(bodyText(res));
            } catch (e) {
                throw new Error(`speech: bad response: ${e.message}`);
            }
            const enc = ['audio_data', 'audio', 'data'].map(k => j[k]).find(s => typeof s === 'string' && s !== '');
            if (!enc)
                throw new Error(`speech: no audio in response: ${truncate(bodyText(res), 200)}`);
            b = GLib.base64_decode(enc);
        }
        return parseWAV(b);
    }
}

/** Wraps 16-bit PCM in a WAV header. */
export function wavFile(pcm, rate, channels) {
    const out = new Uint8Array(44 + pcm.length);
    const dv = new DataView(out.buffer);
    const ascii = (off, s) => [...s].forEach((c, i) => (out[off + i] = c.charCodeAt(0)));
    ascii(0, 'RIFF');
    dv.setUint32(4, 36 + pcm.length, true);
    ascii(8, 'WAVEfmt ');
    dv.setUint32(16, 16, true);
    dv.setUint16(20, 1, true); // PCM
    dv.setUint16(22, channels, true);
    dv.setUint32(24, rate, true);
    dv.setUint32(28, rate * channels * 2, true);
    dv.setUint16(32, channels * 2, true);
    dv.setUint16(34, 16, true);
    ascii(36, 'data');
    dv.setUint32(40, pcm.length, true);
    out.set(pcm, 44);
    return out;
}

/**
 * Reads 16-bit integer or 32-bit float WAV into 16-bit PCM. A data chunk
 * with an unknown length (streamed WAV) runs to the end of the file.
 */
export function parseWAV(b) {
    const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
    const tag = (off) => String.fromCharCode(...b.subarray(off, off + 4));
    if (b.length < 12 || tag(0) !== 'RIFF' || tag(8) !== 'WAVE')
        throw new Error('speech: not a WAV file');
    let format = 0, channels = 0, bits = 0, rate = 0;
    for (let p = 12; p + 8 <= b.length;) {
        const id = tag(p);
        let size = dv.getUint32(p + 4, true);
        const bodyOff = p + 8;
        const bodyLen = b.length - bodyOff;
        if (size > bodyLen)
            size = bodyLen;
        if (id === 'fmt ') {
            if (size < 16)
                throw new Error('speech: short fmt chunk');
            format = dv.getUint16(bodyOff, true);
            channels = dv.getUint16(bodyOff + 2, true);
            rate = dv.getUint32(bodyOff + 4, true);
            bits = dv.getUint16(bodyOff + 14, true);
            if (format === 0xFFFE && size >= 26) // WAVE_FORMAT_EXTENSIBLE: real format in the sub-GUID
                format = dv.getUint16(bodyOff + 24, true);
        } else if (id === 'data') {
            const data = b.subarray(bodyOff, bodyOff + size);
            if (format === 1 && bits === 16)
                return {rate, channels, data: data.slice(0, Math.floor(data.length / 2) * 2)};
            if (format === 3 && bits === 32) {
                const n = Math.floor(data.length / 4);
                const out = new Uint8Array(n * 2);
                const src = new DataView(data.buffer, data.byteOffset, data.byteLength);
                const dst = new DataView(out.buffer);
                for (let i = 0; i < n; i++) {
                    const f = src.getFloat32(4 * i, true);
                    dst.setInt16(2 * i, Math.trunc(Math.max(-1, Math.min(1, f)) * 32767), true);
                }
                return {rate, channels, data: out};
            }
            throw new Error(`speech: unsupported WAV (format ${format}, ${bits} bits)`);
        }
        p += 8 + size + (size % 2);
    }
    throw new Error('speech: WAV without data');
}
