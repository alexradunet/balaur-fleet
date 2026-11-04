// The Wyoming client (TestWyomingRoundTrip, TestWakeStream in assistant_test.go),
// plus reconnecting when the wake word server goes away.

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

import {deepEq, eq, ok, until} from './assert.js';
import {EventReader, WakeStream, encodeEvent} from '../wyoming.js';
import {concatBytes} from '../util.js';

const enc = new TextEncoder();

/** A one-connection fake server; handle(reader, output) runs per connection. */
function fakeServer(handle) {
    const service = new Gio.SocketService();
    const port = service.add_any_inet_port(null);
    const conns = [];
    service.connect('incoming', (_s, conn) => {
        conns.push(conn);
        handle(new EventReader(conn.get_input_stream()), conn.get_output_stream(), conn);
        return true;
    });
    service.start();
    return {uri: `tcp://127.0.0.1:${port}`, service, conns};
}

export const tests = {
    async roundTrip() {
        const ev = encodeEvent({type: 'audio-chunk', data: {rate: 16000, width: 2}, payload: new Uint8Array([1, 2, 3, 4])});
        const header = new TextDecoder().decode(ev.subarray(0, ev.indexOf(10)));
        eq(header, '{"type":"audio-chunk","version":"1.9.0","data_length":24,"payload_length":4}');
        // Older peers put data inline in the header.
        const all = concatBytes([ev, enc.encode('{"type":"transcript","data":{"text":"salut"}}\n')]);
        const r = new EventReader(Gio.MemoryInputStream.new_from_bytes(new GLib.Bytes(all)));
        const a = await r.read();
        eq(a.type, 'audio-chunk');
        eq(a.data.rate, 16000);
        deepEq([...a.payload], [1, 2, 3, 4]);
        const b = await r.read();
        eq(b.data.text, 'salut');
    },

    async wakeStreamDetects() {
        const seen = [];
        const srv = fakeServer(async (reader, out) => {
            for (let i = 0; i < 5; i++) // detect, audio-start, 3 chunks
                seen.push((await reader.read()).type); // eslint-disable-line no-await-in-loop
            out.write_all(encodeEvent({type: 'detection', data: {name: 'hey_jarvis'}}), null);
        });
        const hits = [];
        const ws = await WakeStream.open(srv.uri, ['hey_jarvis'], n => hits.push(n));
        for (let i = 0; i < 3; i++)
            ws.feed(new Uint8Array(2560));
        await until(() => hits.length > 0, 2000, 'a detection');
        deepEq(seen, ['detect', 'audio-start', 'audio-chunk', 'audio-chunk', 'audio-chunk']);
        eq(hits[0], 'hey_jarvis');
        ws.close();
        srv.service.stop();
    },

    async staysConnectedWhileNothingIsDetected() {
        // Detections are rare: a quiet connection must not time out (the 3 s
        // timeout is for connecting only).
        const srv = fakeServer(() => {});
        const ws = await WakeStream.open(srv.uri, ['hey_jarvis'], () => {});
        await new Promise(r => GLib.timeout_add(GLib.PRIORITY_DEFAULT, 3500, () => r()));
        ok(!ws.dead, `dropped: ${ws.reason}`);
        ws.close();
        srv.service.stop();
    },

    async deadWhenServerGoes() {
        const srv = fakeServer((_r, _o, conn) => {
            GLib.timeout_add(GLib.PRIORITY_DEFAULT, 50, () => {
                conn.close(null); // the server restarted
                return GLib.SOURCE_REMOVE;
            });
        });
        const ws = await WakeStream.open(srv.uri, ['hey_jarvis'], () => {});
        await until(() => {
            ws.feed(new Uint8Array(2560));
            return ws.dead;
        }, 3000, 'the stream to notice');
        ok(ws.reason, 'a reason');
        ws.close();
        srv.service.stop();
    },
};
