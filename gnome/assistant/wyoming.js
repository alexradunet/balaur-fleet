// A minimal client for the Wyoming protocol (github.com/rhasspy/wyoming), which
// the local openWakeWord server speaks over TCP. Only the wake word is
// detected on this machine; speech goes to Mistral (mistral.js).
//
// Every event is one JSON header line, then `data_length` bytes of JSON data,
// then `payload_length` bytes of binary payload (raw PCM for audio chunks):
//
//	{"type":"audio-chunk","version":"1.9.0","data_length":40,"payload_length":2560}\n
//	{"channels":1,"rate":16000,"width":2}<2560 bytes of PCM>

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

import {marshal, sorted} from './gojson.js';
import {concatBytes, errText, log, writeAll} from './util.js';

const WYOMING_VERSION = '1.9.0';
const MAX_PART = 16 << 20;
const enc = new TextEncoder();
const dec = new TextDecoder();

/** One event as bytes, the way the Go writeEvent lays it out. */
export function encodeEvent({type, data = null, payload = null}) {
    const d = data && Object.keys(data).length > 0 ? enc.encode(marshal(sorted(data))) : new Uint8Array(0);
    const p = payload ?? new Uint8Array(0);
    const header = {type, version: WYOMING_VERSION};
    if (d.length)
        header.data_length = d.length;
    if (p.length)
        header.payload_length = p.length;
    return concatBytes([enc.encode(`${marshal(header)}\n`), d, p]);
}

/** Buffered reader of events from a Gio.InputStream. */
export class EventReader {
    constructor(stream) {
        this.stream = stream;
        this.buf = new Uint8Array(0);
    }

    async _fill(cancellable) {
        const bytes = await this.stream.read_bytes_async(65536, GLib.PRIORITY_DEFAULT, cancellable);
        const chunk = bytes.toArray();
        if (chunk.length === 0)
            throw new Error('connection closed');
        this.buf = concatBytes([this.buf, chunk]);
    }

    async _line(cancellable) {
        let i;
        while ((i = this.buf.indexOf(10)) < 0)
            await this._fill(cancellable); // eslint-disable-line no-await-in-loop
        const line = this.buf.subarray(0, i);
        this.buf = this.buf.subarray(i + 1);
        return dec.decode(line);
    }

    async _exactly(n, cancellable) {
        while (this.buf.length < n)
            await this._fill(cancellable); // eslint-disable-line no-await-in-loop
        const out = this.buf.slice(0, n);
        this.buf = this.buf.subarray(n);
        return out;
    }

    /** The next event: {type, data, payload}. */
    async read(cancellable = null) {
        let h;
        try {
            h = JSON.parse(await this._line(cancellable));
        } catch (e) {
            if (e instanceof SyntaxError)
                throw new Error(`wyoming header: ${e.message}`);
            throw e;
        }
        const dl = h.data_length ?? 0, pl = h.payload_length ?? 0;
        if (dl < 0 || dl > MAX_PART || pl < 0 || pl > MAX_PART)
            throw new Error('wyoming: event too large');
        // Older peers inline the data in the header.
        const data = {...h.data ?? {}};
        if (dl > 0) {
            let extra;
            try {
                extra = JSON.parse(dec.decode(await this._exactly(dl, cancellable)));
            } catch (e) {
                if (e instanceof SyntaxError)
                    throw new Error(`wyoming data: ${e.message}`);
                throw e;
            }
            Object.assign(data, extra);
        }
        const payload = pl > 0 ? await this._exactly(pl, cancellable) : null;
        return {type: h.type, data, payload};
    }
}

/** "host:port" or "tcp://host:port" -> [host, port]. */
function parseURI(uri) {
    const addr = uri.replace(/^tcp:\/\//, '');
    const i = addr.lastIndexOf(':');
    return [addr.slice(0, i).replace(/^\[|\]$/g, ''), Number(addr.slice(i + 1))];
}

const FORMAT = {rate: 16000, width: 2, channels: 1};

/**
 * Feeds microphone audio to an openWakeWord server and reports detections.
 * `dead` turns true when the connection fails either way (a write fails, or
 * the server closes it, e.g. because it restarted); the router then opens a
 * new stream.
 */
export class WakeStream {
    static async open(uri, names, onDetection) {
        const [host, port] = parseURI(uri);
        const client = new Gio.SocketClient({timeout: 3});
        const conn = await client.connect_to_host_async(host, port, null);
        // The 3 s timeout is for connecting only: reads wait for a detection as long as it takes.
        conn.get_socket().set_timeout(0);
        try {
            // Like Go's default: send each 80 ms chunk at once, no Nagle delay.
            conn.get_socket().set_option(6 /* IPPROTO_TCP */, 1 /* TCP_NODELAY */, 1);
        } catch {}
        const ws = new WakeStream(conn, onDetection);
        ws._send({type: 'detect', data: {names: [...names]}});
        ws._send({type: 'audio-start', data: FORMAT});
        ws._readLoop();
        return ws;
    }

    constructor(conn, onDetection) {
        this.conn = conn;
        this.onDetection = onDetection;
        this.cancellable = new Gio.Cancellable();
        this.dead = false;
        this.reason = '';
        this.pending = 0;
        this.chain = Promise.resolve();
    }

    _fail(why) {
        if (!this.dead) {
            this.dead = true;
            this.reason = why;
        }
    }

    _send(ev) {
        const bytes = encodeEvent(ev);
        this.pending++;
        // Writes are queued one after the other: Gio allows one pending write per stream.
        this.chain = this.chain.then(async () => {
            if (this.dead)
                return;
            try {
                await writeAll(this.conn.get_output_stream(), bytes, this.cancellable);
            } catch (e) {
                this._fail(errText(e));
            }
        }).finally(() => this.pending--);
    }

    feed(pcm) {
        // The server is not keeping up (Go's write would block and the mic
        // would drop frames): drop this one rather than queue without end.
        if (this.pending > 25)
            return;
        this._send({type: 'audio-chunk', data: FORMAT, payload: pcm});
    }

    async _readLoop() {
        const reader = new EventReader(this.conn.get_input_stream());
        try {
            for (;;) {
                const ev = await reader.read(this.cancellable); // eslint-disable-line no-await-in-loop
                if (ev.type === 'detection')
                    this.onDetection(typeof ev.data.name === 'string' ? ev.data.name : '');
            }
        } catch (e) {
            this._fail(errText(e));
        }
    }

    close() {
        this._fail('closed');
        this.cancellable.cancel();
        try {
            this.conn.close(null);
        } catch (e) {
            log(`wake word server: close: ${errText(e)}`);
        }
    }
}
