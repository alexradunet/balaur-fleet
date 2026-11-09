// A stand-in for the agent (`pi --mode rpc`) in the tests: the commands and events agent.js uses.
//   prompt "bold"   -> "**Added.** done" (markdown, for the cleaning before speech)
//   prompt "slow"   -> waits for abort, then an aborted message and agent_settled
//   prompt "fail"   -> an assistant message with stopReason "error" ("boom")
//   prompt "/x"     -> handled without a run (no agent_settled)
//   anything else   -> "echo: <text>" (with " (new)" on the first prompt of a session)
// With --test as an argument it is the launcher's one-shot test: exit 0, or 1
// with "no such model" on stderr when BALAUR_LLM_MODEL is "bad".

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GioUnix from 'gi://GioUnix';
import System from 'system';

if (System.programArgs.includes('--test')) {
    if (GLib.getenv('BALAUR_LLM_MODEL') === 'bad') {
        printerr('warming up\nno such model');
        System.exit(1);
    }
    System.exit(0);
}

const out = new GioUnix.OutputStream({fd: 1, close_fd: false});
const send = m => out.write_all(new TextEncoder().encode(`${JSON.stringify(m)}\n`), null);
const input = new Gio.DataInputStream({base_stream: new GioUnix.InputStream({fd: 0, close_fd: false})});
input.set_newline_type(Gio.DataStreamNewlineType.LF);

let model = GLib.getenv('BALAUR_LLM_MODEL') || 'm1';
let fresh = true; // no prompt yet in this session
let slow = false;

const respond = (m, data = undefined, error = '') =>
    send({id: m.id, type: 'response', command: m.type, success: !error, ...(error ? {error} : {data})});
const answer = (text, stopReason = 'stop', extra = {}) => {
    send({type: 'message_end', message: {role: 'assistant', content: text ? [{type: 'text', text}] : [], stopReason, ...extra}});
    send({type: 'agent_settled', aborted: stopReason === 'aborted'});
};

const loop = new GLib.MainLoop(null, false);
function next() {
    input.read_line_async(GLib.PRIORITY_DEFAULT, null, (_s, res) => {
        const [line] = input.read_line_finish_utf8(res);
        if (line === null) {
            loop.quit();
            return;
        }
        const m = JSON.parse(line);
        switch (m.type) {
        case 'get_state':
            respond(m, {model: {provider: 'faux', id: model}});
            break;
        case 'get_available_models':
            respond(m, {models: [{provider: 'faux', id: 'm1', name: 'M1'}, {provider: 'faux', id: 'm2', name: 'M2'}, {provider: 'other', id: 'x', name: 'X'}]});
            break;
        case 'set_model':
            if (['m1', 'm2'].includes(m.modelId)) {
                model = m.modelId;
                respond(m, {});
            } else {
                respond(m, undefined, `Model not found: ${m.provider}/${m.modelId}`);
            }
            break;
        case 'new_session':
            fresh = true;
            respond(m, {cancelled: false});
            break;
        case 'abort':
            respond(m);
            if (slow) {
                slow = false;
                answer('', 'aborted');
            }
            break;
        case 'prompt':
            if (m.message.startsWith('/')) {
                respond(m, {disposition: 'handled'});
                break;
            }
            respond(m, {disposition: 'started'});
            send({type: 'message_end', message: {role: 'user', content: [{type: 'text', text: m.message}]}});
            if (m.message === 'slow') {
                slow = true;
            } else if (m.message === 'bold') {
                answer('**Added.** done');
            } else if (m.message === 'fail') {
                answer('', 'error', {errorMessage: 'boom'});
            } else {
                answer(`echo: ${m.message}${fresh ? ' (new)' : ''} [${model}]`);
                fresh = false;
            }
            break;
        default:
            respond(m, undefined, `unknown command ${m.type}`);
        }
        next();
    });
}
next();
loop.run();
