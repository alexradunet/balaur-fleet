// The daemon's side of the agent protocol (gnome/CONTRACT.md, "The agent"):
// spawns `balaur-agent` (path in $BALAUR_AGENT) with Gio.Subprocess and speaks
// JSON lines on its stdin/stdout; its stderr goes to our journal.
//
//   ready        {tools, models, error?}            once, after start-up
//   prompt   →   tool_call* ← → tool_result*   ←   reply | error
//   abort, reset, test → test_result

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

import {Cancelled} from './http.js';
import {errText, log, scope, writeAll} from './util.js';

const READY_TIMEOUT_MS = 60000;
const RESTART_DELAY_MS = 3000;
const enc = new TextEncoder();
const dec = new TextDecoder();

export class Agent {
    /**
     * argv: the command (default [$BALAUR_AGENT or "balaur-agent"]).
     * env(): resolves to the environment variables to add (model, keys).
     * onToolCall(name, args, promptId): resolves to the result JSON text, or throws.
     * onReady(ready): the ready record (catalog for the Models property).
     */
    constructor({argv = null, env = async () => ({}), onToolCall, onReady = () => {}}) {
        this.argv = argv ?? [GLib.getenv('BALAUR_AGENT') || 'balaur-agent'];
        this.env = env;
        this.onToolCall = onToolCall;
        this.onReady = onReady;
        this.proc = null;
        this.ready = null; // the ready record once received
        this.readyWaiters = [];
        this.pending = new Map(); // prompt/test id -> {resolve, reject}
        this.nextId = 0;
        this.writeChain = Promise.resolve();
        this.generation = 0;
        this.stopping = false;
        this.restartId = 0;
    }

    /** Starts the child (if not running). Returns at once; use whenReady(). */
    async start() {
        if (this.proc || this.stopping)
            return;
        const gen = ++this.generation;
        const launcher = new Gio.SubprocessLauncher({flags: Gio.SubprocessFlags.STDIN_PIPE | Gio.SubprocessFlags.STDOUT_PIPE});
        try {
            for (const [k, v] of Object.entries(await this.env()))
                launcher.setenv(k, v ?? '', true);
            this.proc = launcher.spawnv(this.argv);
        } catch (e) {
            this._failReady(`cannot start ${this.argv[0]}: ${errText(e)}`);
            this._scheduleRestart();
            return;
        }
        const proc = this.proc;
        this.stdin = proc.get_stdin_pipe();
        this._readLoop(proc, gen);
        proc.wait_async(null).then(() => {
            if (gen !== this.generation)
                return;
            const why = proc.get_if_signaled() ? `killed by signal ${proc.get_term_sig()}` : `exited with status ${proc.get_exit_status()}`;
            this._lost(`agent ${why}`);
        }).catch(() => {});
    }

    async _readLoop(proc, gen) {
        const input = new Gio.DataInputStream({base_stream: proc.get_stdout_pipe(), close_base_stream: true});
        input.set_newline_type(Gio.DataStreamNewlineType.LF); // never split on U+2028
        try {
            for (;;) {
                const [line] = await input.read_line_async(GLib.PRIORITY_DEFAULT, null); // eslint-disable-line no-await-in-loop
                if (line === null)
                    break;
                if (gen !== this.generation)
                    return;
                const text = dec.decode(line).replace(/\r$/, '');
                if (!text.trim())
                    continue;
                let msg;
                try {
                    msg = JSON.parse(text);
                } catch (e) {
                    log(`agent: bad line: ${errText(e)}`);
                    continue;
                }
                this._handle(msg);
            }
        } catch (e) {
            if (gen === this.generation)
                log(`agent: read: ${errText(e)}`);
        }
    }

    _handle(msg) {
        switch (msg.type) {
        case 'ready':
            this.ready = msg;
            if (msg.error)
                log(`agent: ${msg.error}`);
            this.onReady(msg);
            for (const w of this.readyWaiters.splice(0))
                w.resolve(msg);
            break;
        case 'tool_call':
            this._toolCall(msg);
            break;
        case 'reply':
        case 'error':
        case 'test_result': {
            const p = this.pending.get(msg.id);
            if (p) {
                this.pending.delete(msg.id);
                p.resolve(msg);
            }
            break;
        }
        default:
            log(`agent: unknown record ${JSON.stringify(msg.type)}`);
        }
    }

    async _toolCall(msg) {
        let reply;
        try {
            const result = await this.onToolCall(msg.name, msg.args ?? {}, msg.prompt);
            reply = {type: 'tool_result', id: msg.id, ok: true, result};
        } catch (e) {
            reply = {type: 'tool_result', id: msg.id, ok: false, error: errText(e)};
        }
        this._send(reply);
    }

    _send(msg) {
        const stdin = this.stdin;
        if (!stdin)
            return;
        const bytes = enc.encode(`${JSON.stringify(msg)}\n`);
        this.writeChain = this.writeChain.then(() => writeAll(stdin, bytes)).catch(e => log(`agent: write: ${errText(e)}`));
    }

    _failReady(message) {
        for (const w of this.readyWaiters.splice(0))
            w.reject(new Error(message));
    }

    _lost(why) {
        log(why);
        this.proc = null;
        this.stdin = null;
        this.ready = null;
        this._failReady(why);
        for (const [id, p] of this.pending) {
            this.pending.delete(id);
            p.resolve({type: 'error', id, message: why});
        }
        this._scheduleRestart();
    }

    _scheduleRestart() {
        if (this.stopping || this.restartId)
            return;
        this.restartId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, RESTART_DELAY_MS, () => {
            this.restartId = 0;
            this.start();
            return GLib.SOURCE_REMOVE;
        });
    }

    /** Resolves to the ready record (starting the child if needed). */
    whenReady(timeoutMs = READY_TIMEOUT_MS) {
        if (this.ready)
            return Promise.resolve(this.ready);
        this.start();
        return new Promise((resolve, reject) => {
            const w = {resolve, reject};
            this.readyWaiters.push(w);
            GLib.timeout_add(GLib.PRIORITY_DEFAULT, timeoutMs, () => {
                const i = this.readyWaiters.indexOf(w);
                if (i >= 0) {
                    this.readyWaiters.splice(i, 1);
                    reject(new Error('the agent did not start in time'));
                }
                return GLib.SOURCE_REMOVE;
            });
        });
    }

    async _request(msg, cancellable) {
        const ready = await this.whenReady();
        if (ready.error && msg.type === 'prompt')
            throw new Error(ready.error);
        const id = msg.id;
        const result = new Promise(resolve => this.pending.set(id, {resolve}));
        let cid = 0;
        if (cancellable) {
            cid = cancellable.connect(() => {
                // Stop the model; the agent still answers (an "aborted" error).
                this._send({type: 'abort', id});
            });
        }
        this._send(msg);
        try {
            return await result;
        } finally {
            if (cid)
                cancellable.disconnect(cid);
        }
    }

    /**
     * Asks one question; resolves to the reply text. Throws Cancelled when the
     * cancellable fired, an Error with the agent's message otherwise.
     * context: the per-turn context for the system prompt (see assistant.js).
     */
    async ask(text, lang, context, cancellable = null, timeoutMs = 180000) {
        const sc = scope(cancellable, timeoutMs);
        try {
            const id = `p${++this.nextId}`;
            const r = await this._request({type: 'prompt', id, text, lang, context}, sc.cancellable);
            if (r.type === 'reply')
                return r.text ?? '';
            if (sc.timedOut())
                throw new Error(`the model did not answer within ${timeoutMs / 1000}s`);
            if (r.aborted || cancellable?.is_cancelled())
                throw new Cancelled();
            throw new Error(r.message || 'the agent failed');
        } finally {
            sc.release();
        }
    }

    /** One tiny request with the current settings: "" when fine, else the error. */
    async test() {
        try {
            const ready = await this.whenReady();
            if (ready.error)
                return ready.error;
            const r = await this._request({type: 'test', id: `t${++this.nextId}`}, null);
            return r.type === 'test_result' ? r.error ?? '' : r.message ?? 'the agent failed';
        } catch (e) {
            return errText(e);
        }
    }

    reset() {
        if (this.ready)
            this._send({type: 'reset'});
    }

    /** Stops the child (closing its stdin asks it to exit); optionally starts a new one. */
    async restart() {
        await this.stop();
        this.stopping = false;
        await this.start();
    }

    async stop() {
        this.stopping = true;
        if (this.restartId) {
            GLib.source_remove(this.restartId);
            this.restartId = 0;
        }
        const proc = this.proc;
        if (!proc)
            return;
        this.generation++; // its exit is expected now
        this.proc = null;
        this.ready = null;
        for (const [id, p] of this.pending) {
            this.pending.delete(id);
            p.resolve({type: 'error', id, message: 'the agent was restarted'});
        }
        try {
            this.stdin?.close(null);
        } catch {}
        this.stdin = null;
        let kill = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 3000, () => {
            kill = 0;
            proc.force_exit();
            return GLib.SOURCE_REMOVE;
        });
        try {
            await proc.wait_async(null);
        } catch {}
        if (kill)
            GLib.source_remove(kill);
    }
}
