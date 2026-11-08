// The daemon side of the agent protocol against a fake agent (fake-agent.js),
// and the text pipeline end to end: Ask -> agent -> daemon-side tool -> store.

import Gio from 'gi://Gio';

import {eq, ok, rejects, until} from './assert.js';
import {fakeAgentArgv, makeAssistant} from './helpers.js';
import {Agent} from '../agent.js';
import {Cancelled} from '../http.js';
import {sleep} from '../util.js';

export const tests = {
    async promptToolCallAndReply() {
        const calls = [];
        const agent = new Agent({
            argv: fakeAgentArgv(),
            env: async () => ({BALAUR_LLM_PROVIDER: 'faux', BALAUR_LLM_MODEL: 'm1', BALAUR_LLM_KEY: 'sekret'}),
            onToolCall: async (name, args, prompt) => {
                calls.push({name, args, prompt});
                return '{"added":["lapte"]}';
            },
        });
        const ready = await agent.whenReady();
        eq(ready.models.providers[0].id, 'faux');
        eq(ready.env.key, 'sekret', 'the key reaches the agent through its environment');
        eq(await agent.ask('hello', 'en', {time: '16:13'}), 'echo: hello @16:13');
        eq(await agent.ask('add lapte', 'ro', {}), '**Added.** {"added":["lapte"]}');
        eq(calls[0].name, 'house_list_add');
        eq(calls[0].args.items[0], 'lapte');
        ok(calls[0].prompt, 'tool call names its prompt');
        await rejects(agent.ask('fail', 'en', {}), /boom/);
        eq(await agent.test(), '');
        await agent.stop();
    },

    async abortOnCancel() {
        const agent = new Agent({argv: fakeAgentArgv(), onToolCall: async () => ''});
        const c = new Gio.Cancellable();
        sleep(200).then(() => c.cancel());
        const e = await rejects(agent.ask('slow', 'en', {}, c), null);
        ok(e instanceof Cancelled, `got ${e}`);
        await agent.stop();
    },

    async restartsAfterACrash() {
        const agent = new Agent({argv: fakeAgentArgv(), onToolCall: async () => ''});
        await agent.whenReady();
        agent.proc.force_exit();
        await until(() => agent.ready === null, 2000, 'the exit to be noticed');
        await until(() => agent.ready !== null, 6000, 'a restart');
        eq(await agent.ask('again', 'en', {time: 'x'}), 'echo: again @x');
        await agent.stop();
    },

    async askRunsTheToolOnTheStore() {
        const a = makeAssistant();
        a._run();
        const reply = await a.ask('add lapte', false);
        ok(reply.startsWith('Added. '), `spoken() cleaned the reply: ${reply}`);
        eq(a.store.Lists().get('shopping')[0].text, 'lapte');
        const snap = JSON.parse(a.snapshot());
        eq(snap.log.length, 1);
        eq(snap.log[0].heard, 'add lapte');
        eq(snap.log[0].typed, true);
        eq(snap.lists.shopping[0].text, 'lapte');
        eq(snap.state, 'idle');
        eq(snap.listOrder.join(), 'shopping,tasks');
        // Snapshot keys as the Go Status (error left out when empty).
        eq(Object.keys(snap).join(), 'name,state,muted,volume,wakeWord,model,log,timers,reminders,lists,listOrder,memories');
        eq(JSON.parse(a.models).providers[0].models[0].id, 'm1', 'the catalog from the ready record');
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
};
