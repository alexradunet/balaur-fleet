// The daemon side of the agent (pi's RPC mode) against a fake pi (fake-agent.js), the
// text pipeline end to end, and the two
// D-Bus methods pi's extension calls for the question being answered.

import Gio from 'gi://Gio';

import {eq, ok, rejects, until} from './assert.js';
import {fakeAgentArgv, makeAssistant} from './helpers.js';
import {Agent} from '../agent.js';
import {Cancelled} from '../http.js';
import {sleep} from '../util.js';


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

    async forgetsAfterAQuietPeriodAndOnReset() {
        const agent = new Agent({argv: fakeAgentArgv()});
        eq(await agent.ask('one'), 'echo: one (new) [m1]');
        agent.lastTurn = Date.now() - 6 * 60 * 1000;
        eq(await agent.ask('two'), 'echo: two (new) [m1]', 'a new session after 5 quiet minutes');
        eq(await agent.ask('three'), 'echo: three [m1]');
        agent.reset();
        eq(await agent.ask('four'), 'echo: four (new) [m1]', 'reset forgets');
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

    async restartsAfterACrash() {
        const agent = new Agent({argv: fakeAgentArgv()});
        await agent.whenReady();
        agent.proc.force_exit();
        await until(() => agent.ready === null, 2000, 'the exit to be noticed');
        await until(() => agent.ready !== null, 6000, 'a restart');
        eq(await agent.ask('again'), 'echo: again (new) [m1]');
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
