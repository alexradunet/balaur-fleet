// What the daemon keeps across a restart besides the household's files: the
// microphone switch and the running timers, and reminders that fail to save.

import GLib from 'gi://GLib';

import {deepEq, eq, ok, tempDir, until} from './assert.js';
import {makeAssistant} from './helpers.js';
import {marshal, rfc3339} from '../gojson.js';
import {Store} from '../store.js';
import {Timers} from '../timers.js';
import {nowUs} from '../util.js';

const path = (dir, name) => GLib.build_filenamev([dir, name]);
const readJSON = (dir, name) => JSON.parse(new TextDecoder().decode(GLib.file_get_contents(path(dir, name))[1]));

export const tests = {
    // A microphone the household turned off must not capture again after a crash or a login.
    async muteSurvivesARestartAndIsAppliedBeforeCapture() {
        const dir = tempDir();
        let a = makeAssistant({dir});
        await a.start();
        eq(a.mic.startedMuted, false, 'on by default');
        a.setMuted(true);
        await a.shutdown();

        a = makeAssistant({dir});
        await a.start();
        eq(a.mic.startedMuted, true, 'muted before capture began');
        eq(a.publicState, 'muted');
        a.setMuted(false);
        await a.shutdown();

        a = makeAssistant({dir});
        await a.start();
        eq(a.mic.startedMuted, false, 'turned on again by the household');
        await a.shutdown();
    },

    async anUnreadableMuteFileKeepsTheMicrophoneOff() {
        const dir = tempDir();
        GLib.file_set_contents(path(dir, 'mute.json'), '{broken');
        const a = makeAssistant({dir});
        await a.start();
        eq(a.mic.startedMuted, true);
        await a.shutdown();
    },

    async timersSurviveARestart() {
        const dir = tempDir();
        const t1 = new Timers(() => {}, new Store(dir));
        const t = t1.add(10 * 60 * 1000, 'pasta', 'ro');
        t1.stop();
        deepEq(Object.keys(readJSON(dir, 'timers.json')[0]), ['id', 'label', 'ends', 'lang']);

        const fired = [];
        const t2 = new Timers(x => fired.push(x), new Store(dir));
        t2.start();
        const [listed] = JSON.parse(marshal(t2.list()));
        eq(listed.id, t.id);
        eq(listed.label, 'pasta');
        ok(listed.remaining_seconds > 590 && listed.remaining_seconds <= 600, `${listed.remaining_seconds} s left`);
        deepEq(Object.keys(listed), ['ends', 'id', 'label', 'remaining_seconds'], 'the Snapshot shape');
        eq(t2.cancel(t.id, '', false), 1);
        deepEq(readJSON(dir, 'timers.json'), [], 'a cancelled timer is gone from disk');
        eq(fired.length, 0);
        t2.stop();
    },

    // It ended while the daemon was down: it rings at start, once.
    async aTimerThatEndedMeanwhileRingsOnceAtStart() {
        const dir = tempDir();
        GLib.file_set_contents(path(dir, 'timers.json'), JSON.stringify([
            {id: 'old1', label: 'ou', ends: nowUs() - 60e6, lang: 'ro'},
            {id: 'new1', label: 'later', ends: nowUs() + 3600e6, lang: 'en'},
        ]));
        const fired = [];
        const t = new Timers(x => fired.push(x), new Store(dir));
        t.start();
        await until(() => fired.length > 0, 2000, 'the late timer to ring');
        eq(fired[0].id, 'old1');
        eq(fired[0].lang, 'ro');
        eq(t.list().length, 1, 'the other one keeps running');
        t.stop();

        const again = [];
        const t2 = new Timers(x => again.push(x), new Store(dir));
        t2.start();
        eq(JSON.parse(marshal(t2.list())).map(x => x.id).join(), 'new1', 'not rung a second time after a restart');
        t2.stop();
        eq(again.length, 0);
    },

    // GLib's timeouts stand still while the machine sleeps: the end is a wall-clock time, looked at often.
    async timersFireByTheWallClock() {
        const fired = [];
        const t = new Timers(x => fired.push(x), null, {maxWaitMs: 100});
        const timer = t.add(3600 * 1000, 'sleepy', 'en');
        timer.ends = nowUs() + 150e3; // the clock moved on while the process was suspended
        await until(() => fired.length > 0, 2000, 'the timer to ring on the wall clock');
        eq(fired[0].label, 'sleepy');
        eq(t.list().length, 0);
        t.stop();
    },

    async aBrokenTimersFileStartsEmpty() {
        const dir = tempDir();
        GLib.file_set_contents(path(dir, 'timers.json'), 'not json');
        const t = new Timers(() => {}, new Store(dir));
        t.start();
        eq(t.list().length, 0);
        t.stop();
    },

    // TakeDue drops reminders from memory before saving; a save that fails must not lose them.
    async aFailedSaveStillRingsTheReminderOnceAndIsRetried() {
        const dir = tempDir();
        const s = new Store(dir);
        const past = GLib.DateTime.new_now_local().add_minutes(-1);
        const r = s.AddReminder({text: 'pastila', at: rfc3339(past), repeat: ''});
        const write = s._write.bind(s);
        let failing = true;
        s._write = (name, bytes) => {
            if (failing)
                throw new Error('No space left on device');
            write(name, bytes);
        };
        const due = s.TakeDue(nowUs());
        deepEq(due.map(x => x.id), [r.id], 'taken for ringing though saving failed');
        deepEq(s.TakeDue(nowUs()), [], 'not due twice');
        failing = false;
        deepEq(s.TakeDue(nowUs()), [], 'the retry finds nothing new');
        eq(readJSON(dir, 'reminders.json').length, 0, 'and has saved the removal');
    },

    async theReminderPollRingsAndSurvivesAFailingStore() {
        const a = makeAssistant();
        const past = GLib.DateTime.new_now_local().add_minutes(-1);
        a.store.AddReminder({text: 'pastila', at: rfc3339(past), repeat: '', lang: 'ro'});
        a.store._write = () => {
            throw new Error('disk full');
        };
        a._ringDueReminders();
        eq(a.alarms.length, 1, 'rung');
        eq(a.alarms[0].text, 'pastila');
        a.store.TakeDue = () => {
            throw new Error('anything');
        };
        a._ringDueReminders(); // a source that throws is removed: this must not
        await a.shutdown();
    },
};
