// Timers & reminders page: running timers with a live countdown, upcoming
// reminders with when they go off, each with a cancel button.
//
// Timers come with their end time, so the countdown ticks locally once a
// second (only while any timer exists) instead of asking the daemon.

import GObject from 'gi://GObject';
import GLib from 'gi://GLib';
import Gtk from 'gi://Gtk?version=4.0';
import Adw from 'gi://Adw?version=1';

import {AssistantGate} from '../gate.js';
import {actionIconButton, clearChildren, formatCountdown, formatWhen, parseTime, secondsUntil} from '../util.js';

const REPEAT_TEXT = {daily: 'every day', weekly: 'every week'};

export const TimersPage = GObject.registerClass(
class TimersPage extends Adw.Bin {
    constructor(app) {
        super();
        this._assistant = app.assistant;
        this._key = null;
        this._countdowns = []; // [{label, ends: GLib.DateTime}]
        this._tick = 0;

        this._page = new Adw.PreferencesPage();
        this._timers = new Adw.PreferencesGroup({title: 'Timers'});
        this._timerBox = new Gtk.ListBox({selection_mode: Gtk.SelectionMode.NONE,
            css_classes: ['boxed-list', 'duet-touch-list']});
        this._timers.add(this._timerBox);
        this._reminders = new Adw.PreferencesGroup({title: 'Reminders'});
        this._reminderBox = new Gtk.ListBox({selection_mode: Gtk.SelectionMode.NONE,
            css_classes: ['boxed-list', 'duet-touch-list']});
        this._reminders.add(this._reminderBox);
        this._page.add(this._timers);
        this._page.add(this._reminders);

        this._empty = new Adw.StatusPage({icon_name: 'alarm-symbolic',
            title: 'No timers or reminders'});
        this._stack = new Gtk.Stack();
        this._stack.add_named(this._page, 'items');
        this._stack.add_named(this._empty, 'empty');

        this.child = new AssistantGate(this._assistant, this._stack);
        this._assistant.connect('changed', () => this._sync());
        this.connect('destroy', () => this._stopTicking());
        this._sync();
    }

    _sync() {
        const s = this._assistant.snapshot;
        const key = JSON.stringify([s.timers, s.reminders]);
        if (key === this._key)
            return;
        this._key = key;

        const name = this._assistant.name;
        this._empty.description = `Say “${this._assistant.wakePhrase}, set a timer for ten minutes” ` +
            `or “remind me tomorrow at nine to call the bank”. ${name}'s alarms show up here.`;
        this._stack.visible_child_name = s.timers.length || s.reminders.length ? 'items' : 'empty';

        this._timers.visible = s.timers.length > 0;
        clearChildren(this._timerBox);
        this._countdowns = [];
        for (const t of s.timers) {
            const ends = parseTime(t.ends);
            const row = new Adw.ActionRow({
                title: GLib.markup_escape_text(t.label || 'Timer', -1),
                subtitle: ends ? `Rings at ${ends.format('%H:%M:%S')}` : '',
            });
            row.add_prefix(new Gtk.Image({icon_name: 'preferences-system-time-symbolic',
                pixel_size: 24}));
            const count = new Gtk.Label({css_classes: ['title-2', 'numeric'], valign: Gtk.Align.CENTER});
            row.add_suffix(count);
            row.add_suffix(actionIconButton('window-close-symbolic', 'Cancel timer',
                'app.timer-cancel', new GLib.Variant('s', t.id)));
            this._timerBox.append(row);
            if (ends)
                this._countdowns.push({label: count, ends});
            else if (typeof t.remaining_seconds === 'number')
                count.label = formatCountdown(t.remaining_seconds);
        }

        this._reminders.visible = s.reminders.length > 0;
        clearChildren(this._reminderBox);
        for (const r of s.reminders) {
            const when = formatWhen(parseTime(r.at));
            const repeat = REPEAT_TEXT[r.repeat] ?? r.repeat;
            const row = new Adw.ActionRow({
                title: GLib.markup_escape_text(r.text || 'Reminder', -1),
                subtitle: [when, repeat].filter(Boolean).join(' · '),
            });
            row.add_prefix(new Gtk.Image({icon_name: 'alarm-symbolic', pixel_size: 24}));
            row.add_suffix(actionIconButton('window-close-symbolic', 'Cancel reminder',
                'app.reminder-cancel', new GLib.Variant('s', r.id)));
            this._reminderBox.append(row);
        }

        this._updateCountdowns();
        if (this._countdowns.length)
            this._startTicking();
        else
            this._stopTicking();
    }

    _updateCountdowns() {
        for (const c of this._countdowns)
            c.label.label = formatCountdown(secondsUntil(c.ends));
    }

    _startTicking() {
        if (this._tick)
            return;
        this._tick = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 1000, () => {
            this._updateCountdowns();
            return GLib.SOURCE_CONTINUE;
        });
    }

    _stopTicking() {
        if (this._tick)
            GLib.source_remove(this._tick);
        this._tick = 0;
    }
});
