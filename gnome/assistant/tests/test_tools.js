// The daemon-side tools (what tools.go did), on a temp store.

import {deepEq, eq, ok, rejects} from './assert.js';
import {makeAssistant} from './helpers.js';
import {parseLocal, runTool} from '../tools.js';

export const tests = {
    async timers() {
        const a = makeAssistant();
        const t = await runTool(a, 'set_timer', {duration_seconds: 300, label: 'paste'}, {lang: 'ro'});
        ok(/^\d\d:\d\d:\d\d$/.test(t.ends_at), `ends_at ${t.ends_at}`);
        const list = await runTool(a, 'list_timers', {}, {});
        eq(list.length, 1);
        const json = JSON.parse(a.snapshot()).timers[0];
        eq(Object.keys(json).join(), 'ends,id,label,remaining_seconds');
        eq(json.remaining_seconds, 300);
        await rejects(runTool(a, 'set_timer', {duration_seconds: 0}, {}), /between 1 second and 24 hours/);
        await rejects(runTool(a, 'set_timer', {duration_seconds: '5'}, {}), /bad arguments/);
        deepEq(await runTool(a, 'cancel_timer', {label: 'Paște'}, {}), {cancelled: 1});
        await a.shutdown();
    },

    async remindersAndLists() {
        const a = makeAssistant();
        await rejects(runTool(a, 'add_reminder', {text: 'x', at: 'tomorrow'}, {}), /YYYY-MM-DD HH:MM/);
        await rejects(runTool(a, 'add_reminder', {text: 'x', at: '2001-01-01 10:00'}, {}), /in the past/);
        const r = await runTool(a, 'add_reminder', {text: 'pastila', at: '2099-01-02T08:00', repeat: 'none'}, {lang: 'ro'});
        eq(r.at, 'Fri 2099-01-02 08:00');
        eq(r.repeat, '');
        eq(a.store.Reminders()[0].lang, 'ro');
        eq((await runTool(a, 'list_reminders', {}, {}))[0].text, 'pastila');

        const add = await runTool(a, 'house_list_add', {list: 'Cumpărături', items: ['lapte', 'ouă']}, {});
        deepEq(add, {added: ['lapte', 'ouă'], list: 'shopping', open_items: 2});
        const rm = await runTool(a, 'house_list_remove', {list: 'shopping', items: ['oua', 'pâine']}, {});
        deepEq(rm, {not_found: ['pâine'], removed: ['ouă']});
        deepEq(await runTool(a, 'house_list_show', {}, {}), {shopping: [{text: 'lapte'}], tasks: null});
        const m = await runTool(a, 'remember', {fact: 'Ana is allergic to nuts.'}, {});
        deepEq(await runTool(a, 'forget', {id: m.id}, {}), {deleted: true});
        deepEq(await runTool(a, 'set_volume', {change: -20}, {}), {volume: 50});
        await rejects(runTool(a, 'rm_rf', {}, {}), /unknown tool/);
        await a.shutdown();
    },

    parseLocalDates() {
        ok(parseLocal('2026-11-04 9:05'), 'one-digit hour');
        eq(parseLocal('2026-02-30 10:00'), null);
        eq(parseLocal('2026-11-04 10:00:00'), null);
    },
};
