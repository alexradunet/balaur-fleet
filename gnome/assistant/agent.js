// The daemon's side of the agent: the installed pi (https://pi.dev) in RPC
// mode, started by the launcher in $BALAUR_AGENT with the home role's extension
// (gnome/home-agent/, gnome/CONTRACT.md "The agent"). JSON lines on its
// stdin/stdout (pi's docs/rpc.md); its stderr goes to our journal.
//
//   get_state, get_available_models  →  response      once, after start-up: "ready"
//   prompt  →  response, events ...  →  agent_settled  the answer is the last assistant message
//   abort, new_session, set_model    →  response
//   prompt "/mcp reconnect homeassistant"  →  response (handled)   when a new conversation starts, with house devices
//
// The model's tools do not pass through here: the extension calls the daemon
// over D-Bus (AgentTool, AgentContext in dbus.js). So this class only starts
// the child, asks, aborts and forgets, and starts it again when it goes away or
// stops answering.

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

import {Cancelled} from './http.js';
import {errText, log, scope, writeAll} from './util.js';

const READY_TIMEOUT_MS = 60000;
// pi answers get_state as soon as its RPC loop runs; on the tablet that takes a few seconds.
const START_COMMAND_TIMEOUT_MS = 45000;
const COMMAND_TIMEOUT_MS = 10000;
// After an abort (Stop, or the question's timeout) pi settles at once; one that
// does not is hung and is replaced.
const ABORT_GRACE_MS = 5000;
// A child that exits at once is started again after 3 s, then 6 s and so on up to
// 5 minutes; one that stayed ready for a minute starts the sequence over.
const RESTART_DELAY_MS = 3000;
const RESTART_DELAY_MAX_MS = 5 * 60 * 1000;
const STABLE_MS = 60000;
const TEST_TIMEOUT_MS = 60000;
// pi connects the Home Assistant MCP server once, at its start, and never retries a
// first connection that failed: a new conversation asks it to (for a few seconds at
// most; the question does not wait longer).
const RECONNECT_PROMPT = '/mcp reconnect homeassistant';
const RECONNECT_TIMEOUT_MS = 4000;
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

/** Whether the launcher gives pi the house devices (the test balaur-home-agent makes). */
function houseDevicesConfigured() {
    const url = GLib.getenv('BALAUR_HOME_ASSISTANT_URL');
    const token = GLib.getenv('BALAUR_HOME_ASSISTANT_TOKEN_FILE');
    return !!url && !!token && GLib.access(token, 4) === 0; // R_OK
}

/** Resolves like the promise, or rejects with error() as soon as the cancellable fires. */
function untilCancelled(promise, cancellable, error) {
    return new Promise((resolve, reject) => {
        const cid = cancellable.connect(() => reject(error()));
        promise.then(resolve, reject).finally(() => {
            if (cid)
                cancellable.disconnect(cid);
        });
    });
}

export class Agent {
    /**
     * argv: the launcher (default [$BALAUR_AGENT or "balaur-home-agent"]).
     * env(): resolves to the environment variables to add (model, keys).
     * onReady(ready): {models: {providers: [...]}, error?} for the Models property.
     * houseDevices(): whether pi has the house devices (default: from the environment).
     * abortGraceMs, startTimeoutMs: how long to wait for a hung child (the tests shorten them).
     */
    constructor({argv = null, env = async () => ({}), onReady = () => {}, houseDevices = houseDevicesConfigured,
        abortGraceMs = ABORT_GRACE_MS, startTimeoutMs = START_COMMAND_TIMEOUT_MS} = {}) {
        this.argv = argv ?? [GLib.getenv('BALAUR_AGENT') || 'balaur-home-agent'];
        this.env = env;
        this.onReady = onReady;
        this.houseDevices = houseDevices;
        this.abortGraceMs = abortGraceMs;
        this.startTimeoutMs = startTimeoutMs;
        this.proc = null;
        this.starting = null; // the spawn in progress: env() is async
        this.ready = null; // the ready record once pi has answered
        this.readyWaiters = [];
        this.pending = new Map(); // command or prompt id -> {resolve}
        this.nextId = 0;
        this.writeChain = Promise.resolve();
        this.generation = 0;
        this.stopping = false;
        this.restartId = 0;
        this.backoffMs = RESTART_DELAY_MS;
        this.readyAt = 0; // monotonic ms: when the child became ready
        this.newConversation = false; // nothing asked since the child started or forgot
        this.turnId = null; // id of the prompt being answered
        this.last = null; // its last assistant message so far
        this.lastTurn = 0;
        this.provider = '';
    }

    /** Starts the child (if not running) and asks what it runs on. Use whenReady(). */
    async start() {
        while (this.starting)
            await this.starting; // eslint-disable-line no-await-in-loop
        if (this.proc || this.stopping)
            return;
        const gen = ++this.generation;
        this.starting = this._spawn(gen);
        let proc;
        try {
            proc = await this.starting;
        } finally {
            this.starting = null;
        }
        if (!proc)
            return;
        if (gen !== this.generation) {
            proc.force_exit(); // stop() came meanwhile
            return;
        }
        this.proc = proc;
        if (this.restartId) {
            GLib.source_remove(this.restartId);
            this.restartId = 0;
        }
        this.stdin = proc.get_stdin_pipe();
        this.turnId = null;
        this.lastTurn = 0;
        this.newConversation = true;
        this._readLoop(proc, gen);
        proc.wait_async(null).then(() => {
            if (gen !== this.generation)
                return;
            const why = proc.get_if_signaled() ? `killed by signal ${proc.get_term_sig()}` : `exited with status ${proc.get_exit_status()}`;
            this._lost(`agent ${why}`);
        }).catch(() => {});

        const [state, models] = await Promise.all([
            this._command({type: 'get_state'}, this.startTimeoutMs),
            this._command({type: 'get_available_models'}, this.startTimeoutMs),
        ]);
        if (proc !== this.proc)
            return; // it went away meanwhile; _lost has told everyone
        if (state.timedOut || models.timedOut) {
            this._kill('agent: no answer at start-up; starting it again'); // _lost restarts it
            return;
        }
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
        this.readyAt = GLib.get_monotonic_time() / 1000;
        this.onReady(ready);
        for (const w of this.readyWaiters.splice(0))
            w.resolve(ready);
        log(`agent: pi is ready (model ${this.provider}/${ready.model || '?'})`);
    }

    /** Spawns the launcher with the environment from env(); null when it cannot, or when stop() came meanwhile. */
    async _spawn(gen) {
        try {
            const launcher = new Gio.SubprocessLauncher({flags: Gio.SubprocessFlags.STDIN_PIPE | Gio.SubprocessFlags.STDOUT_PIPE});
            for (const [k, v] of Object.entries(await this.env()))
                launcher.setenv(k, v ?? '', true);
            if (gen !== this.generation)
                return null;
            return launcher.spawnv(this.argv);
        } catch (e) {
            this._failReady(`cannot start ${this.argv[0]}: ${errText(e)}`);
            this._scheduleRestart();
            return null;
        }
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
                try {
                    this._handle(msg);
                } catch (e) {
                    log(`agent: ${msg?.type}: ${errText(e)}`);
                }
            }
        } catch (e) {
            // Nobody reads its output now, and a child whose pipe fills up stops.
            if (gen === this.generation)
                this._kill(`agent: read: ${errText(e)}`);
        }
    }

    _handle(msg) {
        switch (msg.type) {
        case 'response': {
            if (msg.command === 'prompt') {
                const p = this.pending.get(msg.id);
                if (p?.slashCommand) {
                    // A slash command is handled without a run: the response is all there is.
                    this.pending.delete(msg.id);
                    p.resolve(msg);
                    break;
                }
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

    /** Queues a message for the child; false (nothing sent) when there is none. */
    _send(msg) {
        const stdin = this.stdin;
        if (!stdin)
            return false;
        const bytes = enc.encode(`${JSON.stringify(msg)}\n`);
        this.writeChain = this.writeChain.then(() => writeAll(stdin, bytes)).catch(e => log(`agent: write: ${errText(e)}`));
        return true;
    }

    /**
     * Sends one command; resolves to its response. Never rejects: success is false
     * when the child went away, and timedOut is set when it did not answer in time.
     */
    _command(msg, timeoutMs = COMMAND_TIMEOUT_MS) {
        const id = `c${++this.nextId}`;
        return new Promise(resolve => {
            let timer = 0;
            const done = r => {
                if (timer)
                    GLib.source_remove(timer);
                timer = 0;
                resolve(r.type === 'response' ? r : {success: false, error: r.message ?? 'the agent failed'});
            };
            this.pending.set(id, {resolve: done});
            if (!this._send({...msg, id})) {
                this.pending.delete(id);
                done({type: 'error', message: 'the agent is not running'});
                return;
            }
            timer = GLib.timeout_add(GLib.PRIORITY_DEFAULT, timeoutMs, () => {
                timer = 0;
                this.pending.delete(id);
                resolve({success: false, timedOut: true, error: `the agent did not answer ${msg.type}`});
                return GLib.SOURCE_REMOVE;
            });
        });
    }

    /** Kills a child that does not answer and starts another (now: a question asked next must not go to the dying one). */
    _kill(why) {
        const proc = this.proc;
        if (!proc)
            return;
        this.generation++; // its exit is expected now
        this._lost(why);
        proc.force_exit();
    }

    _failReady(message) {
        for (const w of this.readyWaiters.splice(0))
            w.reject(new Error(message));
    }

    _lost(why) {
        log(why);
        if (this.readyAt && GLib.get_monotonic_time() / 1000 - this.readyAt >= STABLE_MS)
            this.backoffMs = RESTART_DELAY_MS;
        this.readyAt = 0;
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
        const delay = this.backoffMs;
        this.backoffMs = Math.min(delay * 2, RESTART_DELAY_MAX_MS);
        this.restartId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, delay, () => {
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
        const c = sc.cancellable;
        const stopError = () => (sc.timedOut() ? new Error(`the model did not answer within ${timeoutMs / 1000}s`) : new Cancelled());
        const stopped = () => {
            if (c.is_cancelled())
                throw stopError();
        };
        try {
            stopped();
            this.backoffMs = RESTART_DELAY_MS; // a question starts the child at once
            const ready = await untilCancelled(this.whenReady(), c, stopError);
            if (ready.error)
                throw new Error(ready.error);
            if (this.lastTurn && Date.now() - this.lastTurn > HISTORY_TTL_MS)
                await untilCancelled(this._forget(), c, stopError);
            if (this.newConversation && this.houseDevices()) {
                this.newConversation = false;
                await untilCancelled(this._reconnectHouse(), c, stopError);
            }
            this.newConversation = false;
            stopped();
            const id = `p${++this.nextId}`;
            this.turnId = id;
            this.last = null;
            const result = new Promise(resolve => this.pending.set(id, {resolve}));
            // Stop the model; pi still settles (the last message says "aborted"). A pi that
            // does not is hung: the question ends here and the child is replaced.
            let graceId = 0;
            const cid = c.connect(() => {
                this._send({type: 'abort'});
                graceId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, this.abortGraceMs, () => {
                    graceId = 0;
                    this._settle(id, {type: 'error', id, message: 'the agent did not stop', aborted: true});
                    this._kill('agent: no answer to an abort; starting it again');
                    return GLib.SOURCE_REMOVE;
                });
            });
            if (!this._send({type: 'prompt', id, message: text}))
                this._settle(id, {type: 'error', id, message: 'the agent is not running'});
            let r;
            try {
                r = await result;
            } finally {
                c.disconnect(cid);
                if (graceId)
                    GLib.source_remove(graceId);
                if (this.turnId === id)
                    this.turnId = null;
            }
            if (r.type === 'reply') {
                this.lastTurn = Date.now();
                return r.text ?? '';
            }
            if (sc.timedOut())
                throw stopError();
            if (r.aborted || cancellable?.is_cancelled())
                throw new Cancelled();
            throw new Error(r.message || 'the agent failed');
        } finally {
            sc.release();
        }
    }

    async _forget() {
        this.lastTurn = 0;
        this.newConversation = true;
        const r = await this._command({type: 'new_session'});
        if (!r.success)
            log(`agent: new_session: ${r.error}`);
    }

    /** Asks pi to connect Home Assistant's MCP server again; waits a few seconds at most and never fails. */
    async _reconnectHouse() {
        const id = `p${++this.nextId}`;
        const answered = new Promise(resolve => this.pending.set(id, {resolve, slashCommand: true}));
        if (!this._send({type: 'prompt', id, message: RECONNECT_PROMPT})) {
            this.pending.delete(id);
            return;
        }
        let timer = 0;
        const timedOut = new Promise(resolve => {
            timer = GLib.timeout_add(GLib.PRIORITY_DEFAULT, RECONNECT_TIMEOUT_MS, () => {
                timer = 0;
                resolve(null);
                return GLib.SOURCE_REMOVE;
            });
        });
        const r = await Promise.race([answered, timedOut]);
        if (timer)
            GLib.source_remove(timer);
        if (!r) {
            this.pending.delete(id);
            log('agent: Home Assistant reconnect: no answer');
        } else if (r.type !== 'response' || !r.success) {
            log(`agent: Home Assistant reconnect: ${r.error ?? r.message ?? 'failed'}`);
        }
    }

    /** Changes the model of the running agent: "" when done, else the error. */
    async setModel(id) {
        if (!this.ready)
            return ''; // not started: it takes the setting at start-up
        const r = await this._command({type: 'set_model', provider: this.provider, modelId: id});
        return r.success ? '' : r.error || 'the model was not changed';
    }

    /** One tiny request with the current settings (`<launcher> --test`): "" when fine, else the error. */
    async test(timeoutMs = TEST_TIMEOUT_MS) {
        let timer = 0, timedOut = false;
        try {
            const launcher = new Gio.SubprocessLauncher({flags: Gio.SubprocessFlags.STDOUT_SILENCE | Gio.SubprocessFlags.STDERR_PIPE});
            for (const [k, v] of Object.entries(await this.env()))
                launcher.setenv(k, v ?? '', true);
            const proc = launcher.spawnv([...this.argv, '--test']);
            timer = GLib.timeout_add(GLib.PRIORITY_DEFAULT, timeoutMs, () => {
                timer = 0;
                timedOut = true;
                proc.force_exit();
                return GLib.SOURCE_REMOVE;
            });
            const [, stderr] = await proc.communicate_utf8_async(null, null);
            if (timedOut)
                return `the model did not answer within ${timeoutMs / 1000}s`;
            if (proc.get_successful())
                return '';
            return (stderr ?? '').trim().split('\n').pop() || 'the model did not answer';
        } catch (e) {
            return errText(e);
        } finally {
            if (timer)
                GLib.source_remove(timer);
        }
    }

    /** Stops the child (closing its stdin asks it to exit) and starts a new one. */
    async restart() {
        await this.stop();
        this.stopping = false;
        this.backoffMs = RESTART_DELAY_MS;
        await this.start();
    }

    async stop() {
        this.stopping = true;
        this.generation++; // a spawn in progress is dropped; a running child's exit is expected now
        if (this.restartId) {
            GLib.source_remove(this.restartId);
            this.restartId = 0;
        }
        const proc = this.proc;
        if (!proc)
            return;
        this.proc = null;
        this.ready = null;
        this.readyAt = 0;
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
