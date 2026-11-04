// A stand-in for duet-agent in the tests: speaks the same JSON lines.
//   prompt "add <item>"  -> tool_call house_list_add, then reply with its result
//   prompt "slow"        -> waits for abort, then {"type":"error","aborted":true}
//   prompt "fail"        -> {"type":"error","message":"boom"}
//   anything else        -> reply "echo: <text> @<context.time>"

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GioUnix from 'gi://GioUnix';

const out = new GioUnix.OutputStream({fd: 1, close_fd: false});
const send = m => out.write_all(new TextEncoder().encode(`${JSON.stringify(m)}\n`), null);
const input = new Gio.DataInputStream({base_stream: new GioUnix.InputStream({fd: 0, close_fd: false})});

const waiting = new Map(); // tool call id -> prompt
let slow = null;

send({type: 'ready', tools: ['house_list_add'], models: {providers: [{id: 'faux', name: 'Faux', models: [{id: 'm1', name: 'M1'}]}]},
    env: {provider: GLib.getenv('DUET_LLM_PROVIDER'), model: GLib.getenv('DUET_LLM_MODEL'), key: GLib.getenv('DUET_LLM_KEY')}});

const loop = new GLib.MainLoop(null, false);
function next() {
    input.read_line_async(GLib.PRIORITY_DEFAULT, null, (_s, res) => {
        const [line] = input.read_line_finish_utf8(res);
        if (line === null) {
            loop.quit();
            return;
        }
        const m = JSON.parse(line);
        if (m.type === 'prompt') {
            if (m.text.startsWith('add ')) {
                const id = `c${waiting.size + 1}`;
                waiting.set(id, m);
                send({type: 'tool_call', id, prompt: m.id, name: 'house_list_add', args: {list: 'shopping', items: [m.text.slice(4)]}});
            } else if (m.text === 'slow') {
                slow = m;
            } else if (m.text === 'fail') {
                send({type: 'error', id: m.id, message: 'boom'});
            } else {
                send({type: 'reply', id: m.id, text: `echo: ${m.text} @${m.context?.time}`, lang: m.lang});
            }
        } else if (m.type === 'tool_result') {
            const p = waiting.get(m.id);
            waiting.delete(m.id);
            send({type: 'reply', id: p.id, text: m.ok ? `**Added.** ${m.result}` : `Failed: ${m.error}`, lang: p.lang});
        } else if (m.type === 'abort' && slow?.id === m.id) {
            send({type: 'error', id: m.id, message: 'aborted', aborted: true});
            slow = null;
        } else if (m.type === 'test') {
            send({type: 'test_result', id: m.id, error: ''});
        }
        next();
    });
}
next();
loop.run();
