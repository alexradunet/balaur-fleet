// The daemon side of pi's RPC mode against a fake pi (fake-pi.js), and the two
// D-Bus methods pi's extension calls for the question being answered.

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

import {eq, ok, rejects, until} from './assert.js';
import {gjsBinary, makeAssistant} from './helpers.js';
import {PiAgent} from '../pi-agent.js';
import {Cancelled} from '../http.js';
import {sleep} from '../util.js';

const here = GLib.path_get_dirname(GLib.filename_from_uri(import.meta.url)[0]);
const fakePiArgv = () => [gjsBinary(), '-m', GLib.build_filenamev([here, 'fake-pi.js'])];

export const tests = {
    async readyPromptAndErrors() {
        let ready = null;
        const agent = new PiAgent({argv: fakePiArgv(), env: async () => ({BALAUR_LLM_MODEL: 'm1'}), onReady: r => (ready = r)});
        const r = await agent.whenReady();
        eq(r.models.providers[0].id, 'faux');
        eq(r.models.providers.length, 1, 'only the provider it runs on');
        eq(r.models.providers[0].models.map(m => m.id).join(), 'm1,m2', 'the catalog, grouped by provider');
        ok(ready, 'onReady was called');
        eq(await agent.ask('hello', 'en', {}), 'echo: hello (new) [m1]');
        eq(await agent.ask('again', 'en', {}), 'echo: again [m1]', 'the conversation continues');
        await rejects(agent.ask('fail', 'en', {}), /boom/);
        await rejects(agent.ask('/model', 'en', {}), /did not take the question/);
        eq(await agent.ask('after', 'en', {}), 'echo: after [m1]', 'a refused prompt leaves it usable');
        await agent.stop();
    },

    async abortOnCancel() {
        const agent = new PiAgent({argv: fakePiArgv()});
        const c = new Gio.Cancellable();
        sleep(200).then(() => c.cancel());
        const e = await rejects(agent.ask('slow', 'en', {}, c), null);
        ok(e instanceof Cancelled, `got ${e}`);
        eq(await agent.ask('next', 'en', {}), 'echo: next (new) [m1]');
        await agent.stop();
    },

    async forgetsAfterAQuietPeriodAndOnReset() {
        const agent = new PiAgent({argv: fakePiArgv()});
        eq(await agent.ask('one', 'en', {}), 'echo: one (new) [m1]');
        agent.lastTurn = Date.now() - 6 * 60 * 1000;
        eq(await agent.ask('two', 'en', {}), 'echo: two (new) [m1]', 'a new session after 5 quiet minutes');
        eq(await agent.ask('three', 'en', {}), 'echo: three [m1]');
        agent.reset();
        eq(await agent.ask('four', 'en', {}), 'echo: four (new) [m1]', 'reset forgets');
        await agent.stop();
    },

    async changesTheModelWhileRunning() {
        const agent = new PiAgent({argv: fakePiArgv()});
        await agent.whenReady();
        eq(await agent.setModel('m2'), '');
        eq(await agent.ask('hi', 'en', {}), 'echo: hi (new) [m2]');
        ok((await agent.setModel('nope')).includes('Model not found'), 'an unknown model is an error, not a crash');
        await agent.stop();
    },

    async testRunsTheLauncher() {
        const good = new PiAgent({argv: fakePiArgv(), env: async () => ({BALAUR_LLM_MODEL: 'm1'})});
        eq(await good.test(), '');
        const bad = new PiAgent({argv: fakePiArgv(), env: async () => ({BALAUR_LLM_MODEL: 'bad'})});
        eq(await bad.test(), 'no such model', 'the last line it said');
    },

    async restartsAfterACrash() {
        const agent = new PiAgent({argv: fakePiArgv()});
        await agent.whenReady();
        agent.proc.force_exit();
        await until(() => agent.ready === null, 2000, 'the exit to be noticed');
        await until(() => agent.ready !== null, 6000, 'a restart');
        eq(await agent.ask('again', 'en', {}), 'echo: again (new) [m1]');
        await agent.stop();
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
