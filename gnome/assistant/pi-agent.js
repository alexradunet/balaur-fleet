// The daemon's side of pi's RPC mode (https://pi.dev, docs/rpc.md): the agent is
// the installed pi, started by the launcher in $BALAUR_AGENT with the home
// role's extension (gnome/home-agent/). JSON lines on its stdin/stdout:
//
//   get_state, get_available_models  →  response      once, after start-up: "ready"
//   prompt  →  response, events ...  →  agent_settled  the answer is the last assistant message
//   abort, new_session, set_model    →  response
//
// The model's tools do not pass through here: the extension calls the daemon
// over D-Bus (AgentTool, AgentContext in dbus.js). So this class only asks,
// aborts and forgets. It shares the child process handling with Agent (agent.js).

import Gio from 'gi://Gio';

import {Agent} from './agent.js';
import {Cancelled} from './http.js';
import {errText, log, scope} from './util.js';

// A quiet period after which the conversation starts afresh.
const HISTORY_TTL_MS = 5 * 60 * 1000;

/** Text of an assistant message's text blocks. */
function messageText(m) {
    if (typeof m?.content === 'string')
        return m.content;
    return (m?.content ?? []).filter(c => c.type === 'text').map(c => c.text).join('');
}

export class PiAgent extends Agent {
    /**
     * argv: the launcher (default [$BALAUR_AGENT]).
     * env(): resolves to the environment variables to add (model, keys).
     * onReady(ready): {models: {providers: [...]}} for the Models property.
     */
    constructor({argv = null, env = async () => ({}), onReady = () => {}}) {
        super({argv, env, onReady, onToolCall: async () => {
            throw new Error('tools go over D-Bus');
        }});
        this.turnId = null; // id of the prompt being answered
        this.last = null; // its last assistant message so far
        this.lastTurn = 0;
        this.provider = '';
    }

    async start() {
        const before = this.proc;
        await super.start();
        const proc = this.proc;
        if (!proc || proc === before)
            return;
        this.turnId = null;
        this.lastTurn = 0;
        const [state, models] = await Promise.all([
            this._command({type: 'get_state'}),
            this._command({type: 'get_available_models'}),
        ]);
        if (proc !== this.proc)
            return; // it went away meanwhile; _lost has told everyone
        const error = [state, models].find(r => !r.success)?.error ?? '';
        this.provider = state.data?.model?.provider ?? '';
        const providers = new Map();
        // Only the provider it runs on: the entryway's models. (A Mistral key in the
        // environment, there for web search, makes pi list Mistral's own too.)
        for (const m of (models.data?.models ?? []).filter(x => !this.provider || x.provider === this.provider)) {
            if (!providers.has(m.provider))
                providers.set(m.provider, {id: m.provider, name: m.provider, models: []});
            providers.get(m.provider).models.push({id: m.id, name: m.name ?? m.id});
        }
        const ready = {tools: [], models: {providers: [...providers.values()]}};
        if (error)
            ready.error = error;
        this._handle({type: 'ready', ...ready});
        log(`agent: pi is ready (model ${this.provider}/${state.data?.model?.id ?? '?'})`);
    }

    /** Sends one command; resolves to its response (success false when the child went away). */
    _command(msg) {
        const id = `c${++this.nextId}`;
        const result = new Promise(resolve => this.pending.set(id, {resolve}));
        this._send({...msg, id});
        return result.then(r => (r.type === 'response' ? r : {success: false, error: r.message ?? 'the agent failed'}));
    }

    _handle(msg) {
        switch (msg.type) {
        case 'ready':
            super._handle(msg);
            break;
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

    /**
     * Asks one question; resolves to the reply text. Throws Cancelled when the
     * cancellable fired, an Error with the agent's message otherwise. The
     * system prompt's context is not sent: the extension asks for it (AgentContext).
     */
    async ask(text, _lang, _context, cancellable = null, timeoutMs = 180000) {
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
}
