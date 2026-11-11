// Mistral's audio endpoints against a fake server (TestMistralAudioAndSearch;
// web search moved to the agent) and WAV parsing (TestParseWAVFloat).

import GLib from 'gi://GLib';
import Soup from 'gi://Soup?version=3.0';

import {eq, ok, rejects, throws} from './assert.js';
import {Mistral, parseWAV, wavFile} from '../mistral.js';

function fakeMistral(speechAsJSON, errors) {
    const server = new Soup.Server();
    const reply = (msg, status, type, bytes) => {
        msg.set_status(status, null);
        msg.set_response(type, Soup.MemoryUse.COPY, bytes);
    };
    const json = v => new TextEncoder().encode(JSON.stringify(v));
    server.add_handler(null, (_s, msg, path) => {
        if (msg.get_request_headers().get_one('Authorization') !== 'Bearer k') {
            reply(msg, 401, 'text/plain', new TextEncoder().encode('unauthorized'));
            return;
        }
        const body = msg.get_request_body().flatten();
        if (path === '/v1/audio/transcriptions') {
            const mp = Soup.Multipart.new_from_message(msg.get_request_headers(), body);
            const fields = {};
            for (let i = 0; i < mp.get_length(); i++) {
                const [, headers, part] = mp.get_part(i);
                const [, , params] = headers.get_content_disposition();
                fields[params.name] = part.toArray();
            }
            const p = parseWAV(fields.file);
            if (p.rate !== 16000 || p.data.length !== 32000)
                errors.push(`uploaded wav: rate ${p.rate}, ${p.data.length} bytes`);
            const model = new TextDecoder().decode(fields.model);
            if (model !== 'voxtral')
                errors.push(`model ${model}`);
            reply(msg, 200, 'application/json', json({text: ' Cât e ceasul? ', language: 'ro'}));
        } else if (path === '/v1/audio/speech') {
            const req = JSON.parse(new TextDecoder().decode(body.toArray()));
            if (req.input !== 'Bună' || req.voice_id !== 'v-ro' || req.response_format !== 'wav')
                errors.push(`speech request ${JSON.stringify(req)}`);
            const wav = wavFile(new Uint8Array(480), 24000, 1);
            if (speechAsJSON)
                reply(msg, 200, 'application/json', json({audio_data: GLib.base64_encode(wav)}));
            else
                reply(msg, 200, 'audio/wav', wav);
        } else {
            reply(msg, 404, 'text/plain', new Uint8Array(0));
        }
    });
    server.listen_local(0, Soup.ServerListenOptions.IPV4_ONLY);
    const uri = server.get_uris()[0];
    return {server, base: `http://127.0.0.1:${uri.get_port()}/v1`};
}

export const tests = {
    async audioBothResponseKinds() {
        for (const asJSON of [false, true]) {
            const errors = [];
            const {server, base} = fakeMistral(asJSON, errors);
            const m = new Mistral(`${base}/`, 'k');
            const tr = await m.transcribe('voxtral', new Uint8Array(32000), ''); // eslint-disable-line no-await-in-loop
            eq(tr.text, 'Cât e ceasul?');
            eq(tr.language, 'ro');
            const p = await m.speak('tts', 'v-ro', 'Bună'); // eslint-disable-line no-await-in-loop
            eq(p.rate, 24000, `speak (json=${asJSON})`);
            eq(p.channels, 1);
            eq(p.data.length, 480);
            eq(errors.join('; '), '');
            server.disconnect();
        }
    },

    async errorsCarryTheStatus() {
        const {server, base} = fakeMistral(false, []);
        const m = new Mistral(base, 'wrong');
        await rejects(m.speak('tts', '', 'x'), /\/v1\/audio\/speech: 401 Unauthorized: unauthorized/);
        server.disconnect();
    },

    // channels = 0 made splitPCM step by zero bytes: an endless loop on the main loop.
    parseWAVRejectsNonsenseHeaders() {
        const wav = (channels, rate, bits) => {
            const b = wavFile(new Uint8Array(480), 24000, 1);
            const dv = new DataView(b.buffer);
            dv.setUint16(22, channels, true);
            dv.setUint32(24, rate, true);
            dv.setUint16(34, bits, true);
            return b;
        };
        eq(parseWAV(wav(1, 24000, 16)).rate, 24000);
        for (const [c, r, bits] of [[0, 24000, 16], [1, 0, 16], [1, 24000, 0], [1, 24000, 13]])
            throws(() => parseWAV(wav(c, r, bits)), /bad WAV header/, `${c} channels, ${r} Hz, ${bits} bits`);
    },

    parseWAVFloat() {
        // A streamed float WAV: unknown lengths (0xFFFFFFFF).
        const data = new Float32Array([0, 0.5, -1]);
        const b = new Uint8Array(44 + 12);
        const dv = new DataView(b.buffer);
        const ascii = (o, s) => [...s].forEach((c, i) => (b[o + i] = c.charCodeAt(0)));
        ascii(0, 'RIFF');
        dv.setUint32(4, 0xFFFFFFFF, true);
        ascii(8, 'WAVEfmt ');
        [[16, 4], [3, 2], [1, 2], [24000, 4], [96000, 4], [4, 2], [32, 2]].reduce((o, [v, n]) => {
            if (n === 4)
                dv.setUint32(o, v, true);
            else
                dv.setUint16(o, v, true);
            return o + n;
        }, 16);
        ascii(36, 'data');
        dv.setUint32(40, 0xFFFFFFFF, true);
        new Uint8Array(b.buffer, 44).set(new Uint8Array(data.buffer));
        const p = parseWAV(b);
        eq(p.data.length, 6);
        eq(new DataView(p.data.buffer).getInt16(2, true), Math.trunc(32767 / 2));
        ok(p.rate === 24000);
    },
};
