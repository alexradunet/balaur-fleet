// The voice pipeline. One loop (run) does one thing at a time:
//
//	wake word ─► listen (VAD) ─► transcribe ─► think (agent + tools) ─► speak ─┐
//	    ▲                                                                      │
//	    └──────────────── follow-up when the reply was a question ◄────────────┘
//
// Typed requests (D-Bus Ask) and ringing timers/reminders go through the
// same loop. Saying the wake word interrupts whatever is going on (speech, a
// ringing timer, a slow answer) and starts listening again. A port of
// assistant/assistant.go (the former Go service, in git history); the model and its tools live in the agent process.

import GLib from 'gi://GLib';
import Gio from 'gi://Gio';

import {Agent} from './agent.js';
import {Cancelled} from './http.js';
import {Mic, Player, earconAlarm, earconDone, earconError, earconListen, getVolume, pulseDevice, setVolume} from './audio.js';
import {clock, longDate, localZone, marshal, nowString, sorted} from './gojson.js';
import {detectLang, isNoise, isStop, normLang, sentences, spoken} from './lang.js';
import {Mistral} from './mistral.js';
import {LLM_KEYS} from './settings.js';
import {Timers} from './timers.js';
import {runTool} from './tools.js';
import {NoiseFloor, Utterance, defaultVAD, frameRMS} from './vad.js';
import {WakeStream} from './wyoming.js';
import {debugEnabled, errText, log, logText, monoMs, nowUs, sleep} from './util.js';

const LOG_MAX = 20;
const REMINDER_POLL_MS = 10000;
// GNOME's volume slider has no event we can hear without another process, so
// the volume is read again now and then, and when a tool is about to change it.
const VOLUME_POLL_MS = 30000;
const WAKE_RETRY_MS = 3000;
// Kept in the state directory: a microphone the household turned off stays off after a restart.
const MUTE_FILE = 'mute.json';

/** What is said when an alarm goes off (alarmText in assistant.go). */
export function alarmText(al) {
    const ro = al.lang === 'ro';
    if (al.kind === 'reminder')
        return ro ? `Îți amintesc: ${al.text}` : `Reminder: ${al.text}`;
    if (al.text)
        return ro ? `Timpul a expirat pentru ${al.text}.` : `Your ${al.text} timer is done.`;
    return ro ? 'Timpul a expirat.' : "Time's up.";
}

export class Assistant {
    /**
     * cfg: the config JSON; store: Store; settings: Settings.
     * Options: notifier ({send(id, kind, text), withdraw(id)}, the alarm
     * notifications); tests: agent, mic, player, mistral.
     */
    constructor(cfg, store, settings, opts = {}) {
        this.cfg = cfg;
        this.store = store;
        this.settings = settings;
        this.listeners = new Set();
        this.notifier = opts.notifier ?? null;

        this.state = 'idle';
        this.caption = '';
        this.lastErr = '';
        this.lastLang = cfg.defaultLanguage;
        this.exchanges = [];
        this.volume = cfg.audio.volume;
        this.models = '{"providers":[]}';
        this.apiKeysJSON = '{}';

        this.floor = new NoiseFloor();
        this.recorder = null; // the utterance being recorded, if listening
        this.ws = null;
        this.wsConnecting = false;
        this.wsRetryAt = 0;
        this.cancelCur = null;
        this.turn = null; // {lang, typed} of the question being answered
        this.wakePending = false;
        this.textQueue = [];
        this.alarms = [];
        this.wakeLoop = null;
        this.sources = [];

        this.timers = new Timers(t => this._alarm({kind: 'timer', text: t.label, lang: t.lang}), store);
        this.mic = opts.mic ?? new Mic(cfg.audio.input, f => this._onFrame(f));
        this.player = opts.player ?? new Player(cfg.audio.output);
        this.mistral = opts.mistral ?? new Mistral(settings.speechBaseUrl, '');
        this.agent = opts.agent ?? new Agent({
            env: () => this._agentEnv(),
            onReady: r => this._agentReady(r),
        });
        store.onChange = () => this.changed();
    }

    // ---- change notification (D-Bus PropertiesChanged, debounced) ----

    onChange(fn) {
        this.listeners.add(fn);
    }

    changed() {
        if (this.changeId)
            return;
        this.changeId = GLib.idle_add(GLib.PRIORITY_DEFAULT, () => {
            this.changeId = 0;
            for (const fn of this.listeners)
                fn();
            return GLib.SOURCE_REMOVE;
        });
    }

    setState(s, caption = this.caption) {
        if (s === this.state && caption === this.caption)
            return;
        this.state = s;
        this.caption = s === 'idle' ? '' : caption;
        this.changed();
    }

    /** The public state: "muted" when the microphone is off and nothing else is going on. */
    get publicState() {
        return this.state === 'idle' && this.mic.muted ? 'muted' : this.state;
    }

    setError(e) {
        this.lastErr = e ? errText(e) : '';
        this.changed();
    }

    // ---- start-up ----

    async start() {
        // Before the microphone opens.
        if (this._savedMuted()) {
            log('microphone: muted, as it was left');
            this.mic.setMuted(true);
        }
        await this._refreshSpeech();
        this.mic.start();
        this.agent.start();
        this.timers.start();
        this.sources.push(GLib.timeout_add(GLib.PRIORITY_DEFAULT, REMINDER_POLL_MS, () => {
            this._ringDueReminders();
            return GLib.SOURCE_CONTINUE; // a source that throws is removed: never let it
        }));
        if (pulseDevice(this.cfg.audio.output)[1]) {
            // A desktop session keeps its own volume (GNOME's slider): follow it
            // instead of imposing ours.
            this.refreshVolume();
            this.sources.push(GLib.timeout_add(GLib.PRIORITY_DEFAULT, VOLUME_POLL_MS, () => {
                this.refreshVolume();
                return GLib.SOURCE_CONTINUE;
            }));
        } else {
            this.setVolume(this.cfg.audio.volume).catch(e => log(`volume: ${errText(e)}`));
        }
        this.apiKeysJSON = marshal(sorted(await this.settings.apiKeys()));
        this._run();
    }

    /** Reminders whose time has come ring once, even when saving the rest failed (the store retries the save). */
    _ringDueReminders() {
        try {
            for (const r of this.store.TakeDue(nowUs()))
                this._alarm({kind: 'reminder', text: r.text, lang: r.lang ?? ''});
        } catch (e) {
            log(`reminders: ${errText(e)}`);
        }
    }

    async shutdown() {
        for (const id of this.sources)
            GLib.source_remove(id);
        this.sources = [];
        this.timers.stop();
        this.stop();
        this.mic.stop();
        this.ws?.close();
        await this.agent.stop();
    }

    // ---- settings, keys and the agent ----

    async _refreshSpeech() {
        this.mistral.base = this.settings.speechBaseUrl.replace(/\/+$/, '');
        this.mistral.key = await this.settings.apiKey('mistral');
        if (!this.mistral.key)
            log('no Mistral API key (set one in the app, or `sudo balaur-assistant-login`); speech will fail');
    }

    /** What the launcher and pi's extension read (gnome/home-agent/). */
    async _agentEnv() {
        const s = this.settings;
        return {
            BALAUR_ASSISTANT_CONFIG: GLib.getenv('BALAUR_ASSISTANT_CONFIG') ?? '',
            BALAUR_LLM_MODEL: s.llmModel,
            MISTRAL_API_KEY: await s.apiKey('mistral'),
            BALAUR_SPEECH_BASE_URL: s.speechBaseUrl,
        };
    }

    _agentReady(r) {
        this.agentInfo = r;
        this._publishModels();
        this.setError(r.error ?? '');
    }

    /**
     * The models to choose from, plus what an empty llm-model setting means
     * here, for the app: the config file's model when the agent has it, else
     * the one the agent started with.
     */
    _publishModels() {
        const r = this.agentInfo;
        if (!r)
            return;
        const ids = (r.models?.providers ?? []).flatMap(p => p.models.map(m => m.id));
        const configured = this.cfg.llm?.model ?? '';
        const model = ids.includes(configured) ? configured : r.model || '';
        this.models = marshal({...(r.models ?? {providers: []}), defaults: {model}});
    }

    /** GSettings keys changed (settings.js). */
    async settingsChanged(keys) {
        await this._refreshSpeech();
        log(`settings: ${keys.join(', ')} changed`);
        this._publishModels();
        const llm = keys.filter(k => LLM_KEYS.includes(k));
        if (llm.length === 1 && llm[0] === 'llm-model') {
            // pi changes its model while it runs.
            const error = await this.agent.setModel(this.settings.llmModel);
            if (error)
                log(`agent: ${error}`);
        } else if (llm.length > 0) {
            this._restartAgentWhenIdle();
        }
        this.changed();
    }

    async setApiKey(provider, key) {
        await this.settings.setApiKey(provider, key);
        this.apiKeysJSON = marshal(sorted(await this.settings.apiKeys()));
        if (provider === 'mistral')
            await this._refreshSpeech();
        if (provider === 'mistral') // the agent has it in its environment, for web search
            this._restartAgentWhenIdle();
        this.changed();
    }

    /**
     * The agent takes its settings at start-up: restart it, once per
     * batch of changes, and never in the middle of a turn (the loop calls
     * this again when the turn is over).
     */
    _restartAgentWhenIdle(request = true) {
        if (request)
            this.agentRestartPending = true;
        if (!this.agentRestartPending || this.busy)
            return;
        this.agentRestartPending = false;
        log('restarting the agent with the new settings');
        this.agent.restart().catch(e => log(`agent: ${errText(e)}`));
    }

    testModel() {
        return this.agent.test();
    }

    async _toolCall(name, args) {
        const res = await runTool(this, name, args, this.turn ?? {lang: this.lastLang});
        // The arguments carry what people said and asked to be remembered.
        log(`tool ${name}(${debugEnabled() ? JSON.stringify(args) : Object.keys(args ?? {}).join(', ')})`);
        return JSON.stringify(res ?? null);
    }

    // ---- what pi's extension asks over D-Bus (gnome/home-agent/) ----

    /** The context of the question being answered, for its system prompt. */
    agentContext() {
        if (!this.turn)
            throw new Error('no question is being answered');
        return JSON.stringify({...this.context(this.turn.typed), lang: this.turn.lang ?? ''});
    }

    /** Runs one of the model's daemon-side tools; the result as JSON text. */
    agentTool(name, args) {
        if (!this.turn)
            throw new Error('no question is being answered');
        let parsed;
        try {
            parsed = JSON.parse(args || '{}');
        } catch {
            throw new Error('bad arguments: not JSON');
        }
        return this._toolCall(name, parsed);
    }

    /** The per-turn context the system prompt is built from (gnome/home-agent/prompt.ts). */
    context(typed) {
        const now = GLib.DateTime.new_now_local();
        return {
            name: this.cfg.name,
            location: this.cfg.location?.name ?? '',
            date: longDate(now),
            time: clock(now),
            zone: localZone().get_identifier() || GLib.getenv('TZ') || 'Local',
            typed,
            memories: this.store.Memories().map(m => ({id: m.id, fact: m.fact})),
        };
    }

    // ---- volume ----

    /** Reads the session's volume again (what GNOME's slider says); keeps the old value when it cannot. */
    async refreshVolume() {
        try {
            const v = await getVolume(this.cfg.audio.output);
            if (v !== this.volume) {
                this.volume = v;
                this.changed();
            }
        } catch {}
    }

    async setVolume(v) {
        v = Math.max(0, Math.min(100, Math.round(v)));
        await setVolume(this.cfg.audio.output, this.cfg.audio.card, v);
        this.volume = v;
        this.changed();
    }

    // ---- interruptible work ----

    /** Starts an interruptible piece of work (listening, speaking, ringing). */
    begin() {
        this.cancelCur?.cancel();
        this.cancelCur = new Gio.Cancellable();
        return this.cancelCur;
    }

    end() {
        this.cancelCur?.cancel();
        this.cancelCur = null;
        this.setState('idle');
    }

    /** Interrupts whatever is going on (speech, ringing, listening). */
    stop() {
        this.cancelCur?.cancel();
    }

    /**
     * Whether the household left the microphone off. A file that exists but
     * cannot be read counts as off: a tap turns it on, a wrong guess the other
     * way listens to a house that said no.
     */
    _savedMuted() {
        try {
            return this.store.readState(MUTE_FILE)?.muted === true;
        } catch (e) {
            log(`microphone: cannot read ${MUTE_FILE} (${errText(e)}); staying muted`);
            return true;
        }
    }

    setMuted(m) {
        if (m !== this.mic.muted) {
            try {
                this.store.writeState(MUTE_FILE, {muted: m});
            } catch (e) {
                log(`microphone: cannot save ${MUTE_FILE} (${errText(e)}); it is on again after a restart`);
            }
        }
        this.mic.setMuted(m);
        if (m) {
            this.stop();
            this.ws?.close();
            this.ws = null;
        }
        this.changed();
    }

    // ---- microphone routing + wake word ----

    /**
     * Each mic frame goes either to the recorder (while listening) or to the
     * wake word server (the rest of the time, including while speaking).
     */
    _onFrame(f) {
        if (this.recorder) {
            // The wake word server keeps a window of recent audio: resuming the
            // same stream after listening would find the old wake word again.
            if (this.ws) {
                this.ws.close();
                this.ws = null;
            }
            this.recorder.push(f);
            return;
        }
        if (this.state === 'idle')
            this.floor.update(frameRMS(f));
        if (this.ws?.dead) {
            log(`wake word server: ${this.ws.reason}`);
            this.ws.close();
            this.ws = null;
        }
        if (!this.ws) {
            this._connectWake();
            return; // frames during the connection are dropped
        }
        this.ws.feed(f);
    }

    _connectWake() {
        if (this.wsConnecting || monoMs() < this.wsRetryAt)
            return;
        this.wsConnecting = true;
        WakeStream.open(this.cfg.wake.uri, this.cfg.wake.words, name => {
            log(`wake word: ${name}`);
            this.onWake();
        }).then(ws => {
            this.wsConnecting = false;
            if (this.recorder || this.mic.muted)
                ws.close();
            else
                this.ws = ws;
        }).catch(e => {
            this.wsConnecting = false;
            log(`wake word server: ${errText(e)}`);
            this.wsRetryAt = monoMs() + WAKE_RETRY_MS;
        });
    }

    onWake() {
        this.stop();
        this.wakePending = true;
        this._kick();
    }

    // ---- the main loop ----

    _kick() {
        const w = this.wakeLoop;
        this.wakeLoop = null;
        w?.();
    }

    async _run() {
        for (;;) {
            let job;
            if (this.wakePending) {
                this.wakePending = false;
                job = () => this.voiceTurn();
            } else if (this.textQueue.length) {
                const req = this.textQueue.shift();
                job = () => this.textTurn(req.text, req.speak).then(req.resolve, req.reject);
            } else if (this.alarms.length) {
                const al = this.alarms.shift();
                job = () => this.ring(al);
            } else {
                await new Promise(r => (this.wakeLoop = r)); // eslint-disable-line no-await-in-loop
                continue;
            }
            this.busy = true;
            try {
                await job(); // eslint-disable-line no-await-in-loop
            } catch (e) {
                logError(e, 'assistant');
                this.setState('idle');
            } finally {
                this.busy = false;
            }
            this._restartAgentWhenIdle(false);
        }
    }

    _alarm(al) {
        al.id = `alarm-${GLib.uuid_string_random().slice(0, 8)}`;
        this.alarms.push(al);
        this.notifier?.send(al.id, al.kind, alarmText(al));
        this.changed();
        this._kick();
    }

    /** A typed request; resolves to the reply (D-Bus Ask). */
    ask(text, speak) {
        return new Promise((resolve, reject) => {
            this.textQueue.push({text, speak, resolve, reject});
            this._kick();
        });
    }

    /** Records until the speaker stops, or the cancellable fires. */
    _record(vcfg, cancellable) {
        return new Promise(resolve => {
            const u = new Utterance(this.floor, vcfg);
            let cid = 0;
            const finish = r => {
                if (!this.recorder)
                    return;
                this.recorder = null;
                if (cid)
                    cancellable.disconnect(cid);
                resolve(r);
            };
            this.recorder = {push: f => {
                const r = u.push(f);
                if (r)
                    finish(r);
            }};
            if (cancellable.is_cancelled())
                finish(u.nothing());
            else
                cid = cancellable.connect(() => GLib.idle_add(GLib.PRIORITY_DEFAULT, () => {
                    finish(u.nothing());
                    return GLib.SOURCE_REMOVE;
                }));
        });
    }

    async _earcon(pcm, cancellable) {
        try {
            await this.player.playPCM(pcm, cancellable);
        } catch (e) {
            log(`earcon: ${errText(e)}`);
        }
    }

    async voiceTurn() {
        const ictx = this.begin();
        try {
            for (let followUps = 0; followUps < 3 && !ictx.is_cancelled(); followUps++) {
                this.setState('listening', '');
                if (followUps === 0)
                    await this._earcon(earconListen, ictx); // eslint-disable-line no-await-in-loop
                const vcfg = followUps > 0 ? {...defaultVAD, startTimeout: 4000} : defaultVAD;
                const {pcm, heard, peak, threshold} = await this._record(vcfg, ictx); // eslint-disable-line no-await-in-loop
                log(`listened: speech ${heard} (peak level ${peak.toFixed(0)}, threshold ${threshold.toFixed(0)})`);
                if (!heard) {
                    if (!ictx.is_cancelled() && followUps === 0)
                        await this._earcon(earconDone, ictx); // eslint-disable-line no-await-in-loop
                    return;
                }

                this.setState('thinking', '');
                const start = monoMs();
                const secs = () => ((monoMs() - start) / 1000).toFixed(1);
                let tr;
                try {
                    tr = await this.mistral.transcribe(this.settings.sttModel, pcm, '', ictx); // eslint-disable-line no-await-in-loop
                } catch (e) {
                    await this.fail(ictx, 'speech-to-text', e); // eslint-disable-line no-await-in-loop
                    return;
                }
                log(`heard (${tr.language}, ${secs()}s): ${logText(tr.text)}`);
                // Language detection on a second of audio is shaky ("Cât e ceasul?"
                // came out as Turkish): when the STT names neither Romanian nor
                // English, ask again in the language of the conversation. A reply
                // in either is kept as it is.
                if (normLang(tr.language) === '') {
                    const lang = this.lastLang;
                    try {
                        const tr2 = await this.mistral.transcribe(this.settings.sttModel, pcm, lang, ictx); // eslint-disable-line no-await-in-loop
                        log(`heard again as ${lang} (${secs()}s): ${logText(tr2.text)}`);
                        if (tr2.text)
                            tr = {text: tr2.text, language: lang};
                    } catch (e) {
                        if (ictx.is_cancelled() || e instanceof Cancelled)
                            return; // Stop during the second try ends the turn
                        log(`speech-to-text (again): ${errText(e)}; keeping the first transcript`);
                    }
                }
                const text = tr.text;
                if (isNoise(text))
                    return;
                if (isStop(text, followUps > 0)) {
                    await this._earcon(earconDone, ictx); // eslint-disable-line no-await-in-loop
                    return;
                }
                const lang = this.pickLang(normLang(tr.language), text);
                this.setState('thinking', text);
                let reply;
                try {
                    reply = await this.converse(text, lang, false, ictx); // eslint-disable-line no-await-in-loop
                } catch (e) {
                    await this.fail(ictx, 'assistant', e); // eslint-disable-line no-await-in-loop
                    return;
                }
                this.record({heard: text, reply, typed: false, lang});
                log(`reply (${secs()}s): ${logText(reply)}`);
                if (!await this.speak(reply, lang, ictx)) // eslint-disable-line no-await-in-loop
                    return;
                // Only keep listening without the wake word if the assistant asked something.
                if (!reply.trim().endsWith('?'))
                    return;
            }
        } finally {
            if (this.cancelCur === ictx)
                this.end();
            else
                this.setState('idle');
        }
    }

    async textTurn(text, speak) {
        this.setState('thinking', text);
        try {
            const lang = this.pickLang('', text);
            let reply;
            try {
                // As in Go, a typed question is not interrupted by Stop or the wake word.
                reply = await this.converse(text, lang, true, null);
            } catch (e) {
                this.setError(e);
                throw e;
            }
            this.record({heard: text, reply, typed: true, lang});
            if (speak) {
                const ictx = this.begin();
                await this.speak(reply, lang, ictx);
                this.end();
            }
            return reply;
        } finally {
            this.setState('idle');
        }
    }

    /** Asks the agent; returns the reply cleaned for speech. */
    async converse(text, lang, typed, cancellable) {
        this.turn = {lang, typed};
        try {
            const reply = spoken(await this.agent.ask(text, cancellable));
            if (!reply)
                throw new Error('the model gave no answer');
            return reply;
        } finally {
            this.turn = null;
        }
    }

    pickLang(reported, text) {
        let lang = reported;
        const l = detectLang(text);
        if (l && (lang === '' || (lang !== 'ro' && lang !== 'en')))
            lang = l;
        if (lang !== 'ro' && lang !== 'en')
            lang = this.lastLang;
        this.lastLang = lang;
        return lang;
    }

    record(e) {
        this.exchanges.push({at: nowString(), heard: e.heard ?? '', reply: e.reply, typed: e.typed ?? false, lang: e.lang});
        if (this.exchanges.length > LOG_MAX)
            this.exchanges = this.exchanges.slice(-LOG_MAX);
        this.lastErr = '';
        this.changed();
    }

    async fail(ictx, what, e) {
        if (ictx?.is_cancelled() || e instanceof Cancelled)
            return; // interrupted, not an error
        log(`${what}: ${errText(e)}`);
        this.setError(`${what}: ${errText(e)}`);
        await this._earcon(earconError, ictx);
    }

    // ---- speaking ----

    /** The configured voice for the reply's language ("" = the API's default). */
    voiceFor(text, lang) {
        return this.settings.voice(detectLang(text) || lang);
    }

    /**
     * Synthesises sentence by sentence, so the first one plays while the next
     * is being made. Resolves true when everything was said.
     */
    async speak(text, lang, ictx) {
        text = text.trim();
        if (!text)
            return true;
        this.setState('speaking', text);
        const voice = this.voiceFor(text, lang);
        const queue = [];
        let producing = true, synthErr = null, waiter = null;
        const wake = () => {
            const w = waiter;
            waiter = null;
            w?.();
        };
        const produce = (async () => {
            for (const s of sentences(text)) {
                if (ictx.is_cancelled())
                    break;
                const t0 = monoMs();
                try {
                    const p = await this.mistral.speak(this.settings.ttsModel, voice, s, ictx); // eslint-disable-line no-await-in-loop
                    log(`voice: ${[...s].length} chars in ${((monoMs() - t0) / 1000).toFixed(1)}s`);
                    queue.push(p);
                } catch (e) {
                    synthErr = e;
                    break;
                } finally {
                    wake();
                }
            }
            producing = false;
            wake();
        })();
        const source = {
            next: async () => {
                while (!queue.length && producing)
                    await new Promise(r => (waiter = r)); // eslint-disable-line no-await-in-loop
                return queue.shift() ?? null;
            },
        };
        let perr = null;
        try {
            await this.player.play(source, ictx);
        } catch (e) {
            perr = e;
        }
        await produce;
        if (ictx.is_cancelled())
            return false;
        if (synthErr) {
            await this.fail(ictx, 'text-to-speech', synthErr);
            return false;
        }
        if (perr) {
            log(`playback: ${errText(perr)}`);
            this.setError(`playback: ${errText(perr)}`);
            return false;
        }
        return true;
    }

    /** Plays an alarm until the wake word, Stop, or a few repetitions. */
    async ring(al) {
        const ictx = this.begin();
        const text = alarmText(al);
        try {
            this.setState('ringing', text);
            this.record({reply: text, lang: al.lang});
            const repeats = al.kind === 'reminder' ? 2 : 5;
            for (let i = 0; i < repeats && !ictx.is_cancelled(); i++) {
                this.setState('ringing', text);
                try {
                    await this.player.playPCM(earconAlarm, ictx); // eslint-disable-line no-await-in-loop
                } catch (e) {
                    if (!ictx.is_cancelled())
                        log(`alarm: ${errText(e)}`);
                }
                await this.speak(text, al.lang, ictx); // eslint-disable-line no-await-in-loop
                this.setState('ringing', text);
                await sleep(3000, ictx); // eslint-disable-line no-await-in-loop
            }
        } finally {
            // Stopped by someone: the notification has done its job.
            if (ictx.is_cancelled())
                this.notifier?.withdraw(al.id);
            if (this.cancelCur === ictx)
                this.end();
            else
                this.setState('idle');
        }
    }

    // ---- the Snapshot (the Status of assistant.go) ----

    snapshot() {
        const lists = new Map([...this.store.Lists()]);
        return marshal({
            name: this.cfg.name,
            state: this.publicState,
            muted: this.mic.muted,
            volume: this.volume,
            wakeWord: this.cfg.wake.words.join(', '),
            model: this.settings.llmModel,
            error: this.lastErr || undefined,
            log: this.exchanges,
            timers: this.timers.list(),
            reminders: this.store.Reminders(),
            lists,
            listOrder: this.store.ListNames(),
            memories: this.store.Memories(),
        });
    }
}
