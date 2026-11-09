// The daemon's side of the agent: the installed pi (https://pi.dev) in RPC
// mode, started by the launcher in $BALAUR_AGENT with the home role's extension
// (gnome/home-agent/, gnome/CONTRACT.md "The agent"). JSON lines on its
// stdin/stdout (pi's docs/rpc.md); its stderr goes to our journal.
//
//   get_state, get_available_models  →  response      once, after start-up: "ready"
//   prompt  →  response, events ...  →  agent_settled  the answer is the last assistant message
//   abort, new_session, set_model    →  response
//
// The model's tools do not pass through here: the extension calls the daemon
// over D-Bus (AgentTool, AgentContext in dbus.js). So this class only starts
// the child, asks, aborts and forgets.

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

import {Cancelled} from './http.js';
import {errText, log, scope, writeAll} from './util.js';

const READY_TIMEOUT_MS = 60000;
const RESTART_DELAY_MS = 3000;
// A quiet period after which the conversation starts afresh.
const HISTORY_TTL_MS = 5 * 60 * 1000;
const enc = new TextEncoder();
const dec = new TextDecoder();

/** Text of an assistant message's text blocks. */
function messageText(m) {
    if (typeof m?.content === 'string')
        return m.content;
    return (m?.content ?? []).filter(c => c.type === 'text').map(c => c.text).join('');
}

export class Agent {
    /**
     * argv: the launcher (default [$BALAUR_AGENT or "balaur-home-agent"]).
     * env(): resolves to the environment variables to add (model, keys).
     * onReady(ready): {models: {providers: [...]}, error?} for the Models property.
     */
    constructor({argv = null, env = async () => ({}), onReady = () => {}}) {
        this.argv = argv ?? [GLib.getenv('BALAUR_AGENT') || 'balaur-home-agent'];
        this.env = env;
        this.onReady = onReady;
        this.proc = null;
        this.ready = null; // the ready record once pi has answered
        this.readyWaiters = [];
        this.pending = new Map(); // command or prompt id -> {resolve}
        this.nextId = 0;
        this.writeChain = Promise.resolve();
        this.generation = 0;
        this.stopping = false;
        this.restartId = 0;
        this.turnId = null; // id of the prompt being answered
        this.last = null; // its last assistant message so far
        this.lastTurn = 0;
        this.provider = '';
    }

    /** Starts the child (if not running) and asks what it runs on. Use whenReady(). */
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
        this.turnId = null;
        this.lastTurn = 0;
        this._readLoop(proc, gen);
        proc.wait_async(null).then(() => {
            if (gen !== this.generation)
                return;
            const why = proc.get_if_signaled() ? `killed by signal ${proc.get_term_sig()}` : `exited with status ${proc.get_exit_status()}`;
            this._lost(`agent ${why}`);
        }).catch(() => {});

        const [state, models] = await Promise.all([
            this._command({type: 'get_state'}),
            this._command({type: 'get_available_models'}),
        ]);
        if (proc !== this.proc)
            return; // it went away meanwhile; _lost has told everyone
        this.provider = state.data?.model?.provider ?? '';
        // Only the provider it runs on: the entryway's models. (A Mistral key in the
        // environment, there for web search, makes pi list Mistral's own too.)
        const providers = new Map();
        for (const m of (models.data?.models ?? []).filter(x => !this.provider || x.provider === this.provider)) {
            if (!providers.has(m.provider))
                providers.set(m.provider, {id: m.provider, name: m.provider, models: []});
            providers.get(m.provider).models.push({id: m.id, name: m.name ?? m.id});
        }
        const ready = {models: {providers: [...providers.values()]}, model: state.data?.model?.id ?? ''};
        const error = [state, models].find(r => !r.success)?.error;
        if (error) {
            ready.error = error;
            log(`agent: ${error}`);
        }
        this.ready = ready;
        this.onReady(ready);
        for (const w of this.readyWaiters.splice(0))
            w.resolve(ready);
        log(`agent: pi is ready (model ${this.provider}/${ready.model || '?'})`);
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
        case 'response': {
            if (msg.command === 'prompt') {
                // Accepted: the answer comes with agent_settled. Refused: that is the answer.
                const started = msg.success && ['started', 'queued'].includes(msg.data?.disposition ?? 'started');
                if (!started)
                    this._settle(msg.id, {type: 'error', id: msg.id, message: msg.error || 'the agent did not take the question'});
                break;
            }
            const p = this.pending.get(msg.id);
            if (p) {
                this.pending.delete(msg.id);
                p.resolve(msg);
            } else if (!msg.success) {
                log(`agent: ${msg.command}: ${msg.error}`);
            }
            break;
        }
        case 'message_end':
            if (this.turnId && msg.message?.role === 'assistant')
                this.last = msg.message;
            break;
        case 'agent_settled': {
            const id = this.turnId;
            const last = this.last;
            if (!id)
                break;
            let r;
            if (last?.stopReason === 'aborted' || (!last && msg.aborted))
                r = {type: 'error', id, message: 'aborted', aborted: true};
            else if (!last)
                r = {type: 'error', id, message: 'the model gave no answer'};
            else if (last.stopReason === 'error')
                r = {type: 'error', id, message: last.errorMessage || 'the model failed'};
            else
                r = {type: 'reply', id, text: messageText(last).trim()};
            this._settle(id, r);
            break;
        }
        case 'extension_error':
            log(`agent: extension: ${msg.error ?? JSON.stringify(msg)}`);
            break;
        default:
            // The other session events (streaming, tool execution) are not ours to act on.
        }
    }

    _settle(id, result) {
        if (this.turnId === id) {
            this.turnId = null;
            this.last = null;
        }
        const p = this.pending.get(id);
        if (p) {
            this.pending.delete(id);
            p.resolve(result);
        }
    }

    _send(msg) {
        const stdin = this.stdin;
        if (!stdin)
            return;
        const bytes = enc.encode(`${JSON.stringify(msg)}\n`);
        this.writeChain = this.writeChain.then(() => writeAll(stdin, bytes)).catch(e => log(`agent: write: ${errText(e)}`));
    }

    /** Sends one command; resolves to its response (success false when the child went away). */
    _command(msg) {
        const id = `c${++this.nextId}`;
        const result = new Promise(resolve => this.pending.set(id, {resolve}));
        this._send({...msg, id});
        return result.then(r => (r.type === 'response' ? r : {success: false, error: r.message ?? 'the agent failed'}));
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

    /**
     * Asks one question; resolves to the reply text. Throws Cancelled when the
     * cancellable fired, an Error with the agent's message otherwise. The
     * system prompt's context is not sent: the extension asks for it (AgentContext).
     */
    async ask(text, cancellable = null, timeoutMs = 180000) {
        const sc = scope(cancellable, timeoutMs);
        try {
            const ready = await this.whenReady();
            if (ready.error)
                throw new Error(ready.error);
            if (this.lastTurn && Date.now() - this.lastTurn > HISTORY_TTL_MS)
                await this._forget();
            const id = `p${++this.nextId}`;
            this.turnId = id;
            this.last = null;
            const result = new Promise(resolve => this.pending.set(id, {resolve}));
            // Stop the model; pi still settles (the last message says "aborted").
            const cid = sc.cancellable.connect(() => this._send({type: 'abort'}));
            this._send({type: 'prompt', id, message: text});
            let r;
            try {
                r = await result;
            } finally {
                sc.cancellable.disconnect(cid);
                if (this.turnId === id)
                    this.turnId = null;
            }
            if (r.type === 'reply') {
                this.lastTurn = Date.now();
                return r.text ?? '';
            }
            if (sc.timedOut())
                throw new Error(`the model did not answer within ${timeoutMs / 1000}s`);
            if (r.aborted || cancellable?.is_cancelled())
                throw new Cancelled();
            throw new Error(r.message || 'the agent failed');
        } finally {
            sc.release();
        }
    }

    async _forget() {
        this.lastTurn = 0;
        const r = await this._command({type: 'new_session'});
        if (!r.success)
            log(`agent: new_session: ${r.error}`);
    }

    /** Forgets the conversation. */
    reset() {
        if (this.ready)
            this._forget();
    }

    /** Changes the model of the running agent: "" when done, else the error. */
    async setModel(id) {
        if (!this.ready)
            return ''; // not started: it takes the setting at start-up
        const r = await this._command({type: 'set_model', provider: this.provider, modelId: id});
        return r.success ? '' : r.error || 'the model was not changed';
    }

    /** One tiny request with the current settings (`<launcher> --test`): "" when fine, else the error. */
    async test() {
        try {
            const launcher = new Gio.SubprocessLauncher({flags: Gio.SubprocessFlags.STDOUT_SILENCE | Gio.SubprocessFlags.STDERR_PIPE});
            for (const [k, v] of Object.entries(await this.env()))
                launcher.setenv(k, v ?? '', true);
            const proc = launcher.spawnv([...this.argv, '--test']);
            const [, stderr] = await proc.communicate_utf8_async(null, null);
            if (proc.get_successful())
                return '';
            return (stderr ?? '').trim().split('\n').pop() || 'the model did not answer';
        } catch (e) {
            return errText(e);
        }
    }

    /** Stops the child (closing its stdin asks it to exit) and starts a new one. */
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
