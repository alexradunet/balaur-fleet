// The daemon side of the agent (pi's RPC mode) against a fake pi (fake-agent.js), the
// text pipeline end to end, and the two
// D-Bus methods pi's extension calls for the question being answered.

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

import {eq, ok, rejects, tempDir, until} from './assert.js';
import {fakeAgentArgv, makeAssistant} from './helpers.js';
import {Agent} from '../agent.js';
import {Cancelled} from '../http.js';
import {sleep} from '../util.js';

const dec = new TextDecoder();

/** An agent on the fake pi that logs every command it gets: [agent, () => the log's lines]. */
function loggedAgent(extraEnv = {}, options = {}) {
    const path = GLib.build_filenamev([tempDir(), 'commands']);
    const agent = new Agent({argv: fakeAgentArgv(), env: async () => ({BALAUR_FAKE_LOG: path, ...extraEnv}), ...options});
    const lines = () => (GLib.file_test(path, GLib.FileTest.EXISTS)
        ? dec.decode(GLib.file_get_contents(path)[1]).split('\n').filter(Boolean) : []);
    return [agent, lines];
}

const RECONNECT = 'prompt /mcp reconnect homeassistant';

export const tests = {
    async readyPromptAndErrors() {
        let ready = null;
        const agent = new Agent({argv: fakeAgentArgv(), env: async () => ({BALAUR_LLM_MODEL: 'm1'}), onReady: r => (ready = r)});
        const r = await agent.whenReady();
        eq(r.models.providers[0].id, 'faux');
        eq(r.models.providers.length, 1, 'only the provider it runs on');
        eq(r.models.providers[0].models.map(m => m.id).join(), 'm1,m2', 'the catalog, grouped by provider');
        ok(ready, 'onReady was called');
        eq(await agent.ask('hello'), 'echo: hello (new) [m1]');
        eq(await agent.ask('again'), 'echo: again [m1]', 'the conversation continues');
        await rejects(agent.ask('fail'), /boom/);
        await rejects(agent.ask('/model'), /did not take the question/);
        eq(await agent.ask('after'), 'echo: after [m1]', 'a refused prompt leaves it usable');
        await agent.stop();
    },

    async abortOnCancel() {
        const agent = new Agent({argv: fakeAgentArgv()});
        const c = new Gio.Cancellable();
        sleep(200).then(() => c.cancel());
        const e = await rejects(agent.ask('slow', c), null);
        ok(e instanceof Cancelled, `got ${e}`);
        eq(await agent.ask('next'), 'echo: next (new) [m1]');
        await agent.stop();
    },

    async forgetsAfterAQuietPeriod() {
        const agent = new Agent({argv: fakeAgentArgv()});
        eq(await agent.ask('one'), 'echo: one (new) [m1]');
        agent.lastTurn = Date.now() - 6 * 60 * 1000;
        eq(await agent.ask('two'), 'echo: two (new) [m1]', 'a new session after 5 quiet minutes');
        eq(await agent.ask('three'), 'echo: three [m1]');
        await agent.stop();
    },

    async changesTheModelWhileRunning() {
        const agent = new Agent({argv: fakeAgentArgv()});
        await agent.whenReady();
        eq(await agent.setModel('m2'), '');
        eq(await agent.ask('hi'), 'echo: hi (new) [m2]');
        ok((await agent.setModel('nope')).includes('Model not found'), 'an unknown model is an error, not a crash');
        await agent.stop();
    },

    async testRunsTheLauncher() {
        const good = new Agent({argv: fakeAgentArgv(), env: async () => ({BALAUR_LLM_MODEL: 'm1'})});
        eq(await good.test(), '');
        const bad = new Agent({argv: fakeAgentArgv(), env: async () => ({BALAUR_LLM_MODEL: 'bad'})});
        eq(await bad.test(), 'no such model', 'the last line it said');
    },

    async testGivesUpOnAChildThatHangs() {
        const hung = new Agent({argv: fakeAgentArgv(), env: async () => ({BALAUR_LLM_MODEL: 'hang'})});
        const t0 = GLib.get_monotonic_time();
        ok((await hung.test(400)).includes('did not answer within'), 'the deadline is an error');
        ok(GLib.get_monotonic_time() - t0 < 3e6, 'and comes at the deadline');
    },

    async restartsAfterACrash() {
        const agent = new Agent({argv: fakeAgentArgv()});
        await agent.whenReady();
        agent.proc.force_exit();
        await until(() => agent.ready === null, 2000, 'the exit to be noticed');
        await until(() => agent.ready !== null, 6000, 'a restart');
        eq(await agent.ask('again'), 'echo: again (new) [m1]');
        await agent.stop();
    },

    async restartsAfterACrashDuringAQuestion() {
        const agent = new Agent({argv: fakeAgentArgv()});
        await agent.whenReady();
        const asked = agent.ask('slow');
        const failed = rejects(asked, /killed by signal/);
        await until(() => agent.turnId !== null, 2000, 'the question to be sent');
        await sleep(150);
        agent.proc.force_exit();
        await failed;
        await until(() => agent.ready !== null, 6000, 'a restart');
        eq(await agent.ask('again'), 'echo: again (new) [m1]', 'the new child answers');
        await agent.stop();
    },

    async aSilentAgentEndsTheQuestionAndIsReplaced() {
        const agent = new Agent({argv: fakeAgentArgv(), abortGraceMs: 300});
        await agent.whenReady();
        const first = agent.proc;
        const t0 = GLib.get_monotonic_time();
        await rejects(agent.ask('mute', null, 300), /did not answer within/);
        const took = (GLib.get_monotonic_time() - t0) / 1000;
        ok(took >= 550 && took < 3000, `the timeout, then the grace period: ${took} ms`);
        await until(() => agent.ready === null, 2000, 'the hung child to be killed');
        eq(await agent.ask('later'), 'echo: later (new) [m1]', 'a fresh child answers');
        ok(agent.proc !== first, 'a new process');
        await agent.stop();
    },

    async stopOnASilentAgentIsCancelledAfterTheGrace() {
        const agent = new Agent({argv: fakeAgentArgv(), abortGraceMs: 300});
        await agent.whenReady();
        const c = new Gio.Cancellable();
        sleep(200).then(() => c.cancel());
        const t0 = GLib.get_monotonic_time();
        const e = await rejects(agent.ask('mute', c), null);
        ok(e instanceof Cancelled, `got ${e}`);
        ok((GLib.get_monotonic_time() - t0) / 1000 < 3000, 'within the grace period');
        eq(await agent.ask('later'), 'echo: later (new) [m1]');
        await agent.stop();
    },

    async aChildThatNeverAnswersAtStartIsKilledAndStartedAgain() {
        const [agent] = loggedAgent({BALAUR_FAKE_HANG: 'state'}, {startTimeoutMs: 300});
        const first = agent.start();
        await first;
        await until(() => agent.proc === null, 2000, 'the silent child to be killed');
        ok(agent.restartId !== 0, 'and a restart to be scheduled');
        await agent.stop();
    },

    async aCancelledQuestionIsNotSent() {
        const [agent, lines] = loggedAgent();
        await agent.whenReady();
        const c = new Gio.Cancellable();
        c.cancel();
        const e = await rejects(agent.ask('hello', c), null);
        ok(e instanceof Cancelled, `got ${e}`);
        await sleep(200);
        ok(!lines().some(l => l.startsWith('prompt') || l === 'abort '), `nothing reached the agent: ${lines()}`);
        eq(await agent.ask('hello'), 'echo: hello (new) [m1]', 'and it is usable');
        await agent.stop();
    },

    async stopWhileTheAgentStartsReturnsAtOnce() {
        const [agent, lines] = loggedAgent();
        const c = new Gio.Cancellable();
        sleep(10).then(() => c.cancel());
        const t0 = GLib.get_monotonic_time();
        const e = await rejects(agent.ask('hello', c), null);
        ok(e instanceof Cancelled, `got ${e}`);
        ok((GLib.get_monotonic_time() - t0) / 1000 < 150, 'without waiting for the agent');
        await agent.whenReady();
        ok(!lines().some(l => l.startsWith('prompt')), 'the question was never sent');
        await agent.stop();
    },

    async oneChildForConcurrentStarts() {
        let calls = 0;
        const agent = new Agent({argv: fakeAgentArgv(), env: async () => {
            calls++;
            await sleep(150);
            return {};
        }});
        await Promise.all([agent.start(), agent.start(), agent.whenReady()]);
        eq(calls, 1, 'env() asked once');
        const first = agent.proc;
        await agent.start();
        eq(agent.proc, first);
        await agent.stop();
    },

    async stopDuringTheEnvironmentLookupStartsNothing() {
        const agent = new Agent({argv: fakeAgentArgv(), env: async () => {
            await sleep(150);
            return {};
        }});
        const started = agent.start();
        await agent.stop();
        await started;
        eq(agent.proc, null, 'no child after stop');
        agent.stopping = false;
    },

    async backsOffWhenTheLauncherKeepsFailing() {
        const agent = new Agent({argv: ['/bin/sh', '-c', 'exit 1']});
        await agent.start();
        await until(() => agent.restartId !== 0, 2000, 'a restart to be scheduled');
        eq(agent.backoffMs, 6000, 'the next delay doubles');
        agent.backoffMs = 96000;
        await agent.restart(); // starts at once and starts the sequence over
        await until(() => agent.restartId !== 0, 2000, 'a restart to be scheduled');
        eq(agent.backoffMs, 6000, 'restart() begins again');
        agent.backoffMs = 96000;
        await agent.stop();
        const capped = new Agent({argv: ['/bin/true']});
        capped.backoffMs = 200000;
        capped._scheduleRestart();
        eq(capped.backoffMs, 300000, 'at most five minutes');
        await capped.stop();
    },

    async aChildThatWasStableStartsTheDelaysOver() {
        const agent = new Agent({argv: fakeAgentArgv()});
        await agent.whenReady();
        agent.backoffMs = 96000;
        agent.readyAt -= 61000;
        agent.proc.force_exit();
        await until(() => agent.restartId !== 0, 2000, 'the exit to be noticed');
        eq(agent.backoffMs, 6000, 'back to the first delay (and the next doubled)');
        await agent.stop();
    },

    async newConversationReconnectsTheHouseDevicesFirst() {
        const [agent, lines] = loggedAgent({}, {houseDevices: () => true});
        eq(await agent.ask('hello'), 'echo: hello (new) [m1]');
        const asked = lines().filter(l => l.startsWith('prompt') || l === 'new_session ');
        eq(asked.join('|'), `${RECONNECT}|prompt hello`, 'the reconnect, then the question');
        eq(await agent.ask('again'), 'echo: again [m1]');
        eq(lines().filter(l => l === RECONNECT).length, 1, 'not for a follow-up');
        agent.lastTurn = Date.now() - 6 * 60 * 1000;
        eq(await agent.ask('later'), 'echo: later (new) [m1]');
        const all = lines().filter(l => l.startsWith('prompt') || l === 'new_session ');
        eq(all.slice(3).join('|'), `new_session |${RECONNECT}|prompt later`, 'a new session reconnects again');
        await agent.stop();
    },

    async noReconnectWithoutHouseDevices() {
        const [agent, lines] = loggedAgent();
        await agent.ask('hello');
        agent.lastTurn = Date.now() - 6 * 60 * 1000;
        await agent.ask('later');
        ok(!lines().some(l => l.includes('/mcp')), `no reconnect: ${lines()}`);
        await agent.stop();
    },

    async aReconnectThatNeverAnswersDoesNotBlockTheQuestion() {
        const [agent, lines] = loggedAgent({BALAUR_FAKE_MCP: 'hang'}, {houseDevices: () => true});
        await agent.whenReady();
        const t0 = GLib.get_monotonic_time();
        eq(await agent.ask('hello'), 'echo: hello (new) [m1]');
        const took = (GLib.get_monotonic_time() - t0) / 1000;
        ok(took >= 3500 && took < 7000, `a few seconds at most: ${took} ms`);
        ok(lines().includes(RECONNECT), 'it was asked');
        eq(await agent.ask('again'), 'echo: again [m1]');
        await agent.stop();
    },

    async askGoesThroughTheAgentAndIsLogged() {
        const a = makeAssistant();
        a._run();
        const reply = await a.ask('bold', false);
        eq(reply, 'Added. done', 'spoken() cleaned the reply');
        const snap = JSON.parse(a.snapshot());
        eq(snap.log.length, 1);
        eq(snap.log[0].heard, 'bold');
        eq(snap.log[0].typed, true);
        eq(snap.state, 'idle');
        eq(snap.listOrder.join(), 'shopping,tasks');
        // Snapshot keys as the Go Status (error left out when empty).
        eq(Object.keys(snap).join(), 'name,state,muted,volume,wakeWord,model,log,timers,reminders,lists,listOrder,memories');
        const models = JSON.parse(a.models);
        eq(models.providers[0].models[0].id, 'm1', 'the models from the agent');
        eq(models.defaults.model, 'm1');
        await a.shutdown();
    },

    async askErrorsSetTheErrorProperty() {
        const a = makeAssistant();
        a._run();
        await rejects(a.ask('fail', false), /boom/);
        eq(a.lastErr, 'boom');
        eq(a.state, 'idle');
        await a.ask('ok now', false);
        eq(a.lastErr, '', 'a good answer clears the error');
        await a.shutdown();
    },

    async extensionCallsOnlyDuringAQuestion() {
        const a = makeAssistant();
        ok(rejectsSync(() => a.agentContext()).includes('no question'), 'no context outside a question');
        ok(rejectsSync(() => a.agentTool('house_list_add', '{}')).includes('no question'), 'no tool outside a question');
        a.turn = {lang: 'ro', typed: true};
        const ctx = JSON.parse(a.agentContext());
        eq(ctx.lang, 'ro');
        eq(ctx.typed, true);
        ok(ctx.date && ctx.time && Array.isArray(ctx.memories), 'the system prompt context');
        const res = JSON.parse(await a.agentTool('house_list_add', '{"list":"shopping","items":["lapte"]}'));
        ok(res, 'a result as JSON');
        eq(a.store.Lists().get('shopping')[0].text, 'lapte', 'the tool ran on the store');
        ok(rejectsSync(() => a.agentTool('house_list_add', '{not json')).includes('not JSON'));
        a.turn = null;
        await a.shutdown();
    },
};

function rejectsSync(fn) {
    try {
        fn();
    } catch (e) {
        return String(e.message);
    }
    return '';
}
