#!/usr/bin/env -S gjs -m
// A fake org.balaur.Assistant for developing the Shell extension and the app
// without the real daemon (gnome/CONTRACT.md has the API).
//
// It owns the name on the session bus, implements every property and method
// with in-memory data, and cycles State idle -> listening -> thinking ->
// speaking -> idle (with an alarm "ringing" every fourth round) on a timer.
// Muted pauses the cycle (State "muted"); Stop() returns to idle; Ask()
// thinks, then "speaks" a canned reply.
//
//   gjs -m tools/mock-assistant.js [--no-cycle] [--quit-after SECONDS]
//
// --no-cycle      stay idle unless Ask() is called
// --quit-after N  exit after N seconds (handy in scripts)
//
// It refuses to start if the name is already owned (e.g. by the real daemon).

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GLibUnix from 'gi://GLibUnix';
import System from 'system';

import {BUS_NAME, OBJECT_PATH, INTERFACE_NAME, INTERFACE_XML, ERROR_FAILED}
    from '../assistant.js';

const args = ARGV.slice();
const cycle = !args.includes('--no-cycle');
const quitIdx = args.indexOf('--quit-after');
const quitAfter = quitIdx >= 0 ? Number(args[quitIdx + 1]) : 0;

const EXCHANGES = [
    {heard: 'Cum va fi vremea mâine?', lang: 'ro',
        reply: 'Mâine la București va fi însorit, cu maxime de 14 grade și vânt slab din sud-est.'},
    {heard: 'Add milk to the shopping list', lang: 'en',
        reply: 'Done, milk is on the shopping list.'},
    {heard: 'Tell me something long', lang: 'en',
        reply: 'This is a deliberately long reply so you can check how the overlay wraps and trims captions. '.repeat(5).trim()},
];
const ALARM = 'Pasta timer is done!';

// Steps of one round: [state, seconds, caption(exchange)]
const ROUND = [
    ['idle', 4, () => ''],
    ['listening', 3, () => ''],
    ['thinking', 2.5, ex => ex.heard],
    ['speaking', 5, ex => ex.reply],
];

// RFC 3339 with a "+02:00" offset, like Go's time.Time in JSON.
const inSeconds = s => GLib.DateTime.new_now_local().add_seconds(s).format('%Y-%m-%dT%H:%M:%S%:z');
const now = () => inSeconds(0);
let nextId = 1;
const newId = () => `m${nextId++}`;

const store = {
    log: [],
    timers: [{id: 't1', label: 'pasta', ends: inSeconds(300), remaining_seconds: 300}],
    reminders: [{id: newId(), text: 'Call grandma', at: inSeconds(3 * 3600)}],
    lists: {
        shopping: [{id: newId(), text: 'bread', done: false, added: now()}],
        tasks: [{id: newId(), text: 'water the plants', done: true, added: now()}],
    },
    listOrder: ['shopping', 'tasks'],
    memories: [{id: newId(), fact: 'The cat is called Mitzi.', added: now()}],
};

function fail(invocation, message) {
    invocation.return_dbus_error(ERROR_FAILED, message);
}

function listOf(name) {
    const l = store.lists[name];
    if (!l)
        throw new Error(`no list called "${name}"`);
    return l;
}

class Assistant {
    constructor() {
        this._state = 'idle';
        this._caption = '';
        this._muted = false;
        this._volume = 60;
        this._error = '';
        this._round = 0;
        this._step = 0;
        this._timer = 0;
        this.dbus = null; // the Gio.DBusExportedObject, set after wrapping
    }

    // --- properties -----------------------------------------------------
    get State() { return this._state; }
    get Caption() { return this._caption; }
    get Muted() { return this._muted; }
    set Muted(v) {
        if (v === this._muted)
            return;
        this._muted = v;
        print(`Muted = ${v}`);
        this._changed({Muted: new GLib.Variant('b', v)});
        if (v)
            this._go('muted', '');
        else
            this._go('idle', '');
        this._schedule(v ? 0 : 1);
    }

    get Volume() { return this._volume; }
    set Volume(v) {
        this._volume = Math.max(0, Math.min(100, v));
        this._changed({Volume: new GLib.Variant('u', this._volume)});
    }

    get Name() { return 'Jarvis'; }
    get WakeWord() { return 'hey_jarvis'; }
    get Error() { return this._error; }
    get Snapshot() { return JSON.stringify(store); }

    // --- methods ----------------------------------------------------------
    // *Async variants get the invocation, so they can reply later or with
    // the contract's error name.
    AskAsync([text, speak], invocation) {
        if (this._muted && speak) {
            // Still answer typed questions while muted, just silently.
            speak = false;
        }
        const reply = `You asked: "${text}". This is the mock assistant.`;
        this._stopCycle();
        this._go('thinking', text);
        this._timer = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 1500, () => {
            this._timer = 0;
            store.log.push({at: now(), heard: text, reply, typed: true, lang: 'en'});
            this._snapshotChanged();
            invocation.return_value(new GLib.Variant('(s)', [reply]));
            if (speak) {
                this._go('speaking', reply);
                this._timer = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, 4, () => {
                    this._timer = 0;
                    this._go(this._muted ? 'muted' : 'idle', '');
                    this._schedule(1);
                    return GLib.SOURCE_REMOVE;
                });
            } else {
                this._go(this._muted ? 'muted' : 'idle', '');
                this._schedule(1);
            }
            return GLib.SOURCE_REMOVE;
        });
    }

    Stop() {
        print('Stop()');
        this._stopCycle();
        this._go(this._muted ? 'muted' : 'idle', '');
        this._step = 0;
        this._round++;
        this._schedule(ROUND[0][1]);
    }

    ListAddAsync([list, text], invocation) {
        this._edit(invocation, () => listOf(list).push(
            {id: newId(), text, done: false, added: now()}));
    }

    ListSetDoneAsync([list, id, done], invocation) {
        this._edit(invocation, () => {
            const item = listOf(list).find(i => i.id === id);
            if (!item)
                throw new Error(`no item ${id}`);
            item.done = done;
        });
    }

    ListRemoveAsync([list, id], invocation) {
        this._edit(invocation, () => {
            store.lists[list] = listOf(list).filter(i => i.id !== id);
        });
    }

    ListClearDoneAsync([list], invocation) {
        this._edit(invocation, () => {
            store.lists[list] = listOf(list).filter(i => !i.done);
        });
    }

    MemoryAddAsync([fact], invocation) {
        this._edit(invocation, () => store.memories.push({id: newId(), fact, added: now()}));
    }

    MemoryRemoveAsync([id], invocation) {
        this._edit(invocation, () => {
            store.memories = store.memories.filter(m => m.id !== id);
        });
    }

    TimerCancelAsync([id], invocation) {
        this._edit(invocation, () => {
            store.timers = store.timers.filter(t => t.id !== id);
        });
    }

    ReminderCancelAsync([id], invocation) {
        this._edit(invocation, () => {
            store.reminders = store.reminders.filter(r => r.id !== id);
        });
    }

    // --- internals --------------------------------------------------------
    _edit(invocation, fn) {
        try {
            fn();
        } catch (e) {
            fail(invocation, e.message);
            return;
        }
        this._snapshotChanged();
        invocation.return_value(null);
    }

    _changed(props) {
        this.dbus?.get_connection()?.emit_signal(null, OBJECT_PATH,
            'org.freedesktop.DBus.Properties', 'PropertiesChanged',
            new GLib.Variant('(sa{sv}as)', [INTERFACE_NAME, props, []]));
    }

    _snapshotChanged() {
        this._changed({Snapshot: new GLib.Variant('s', this.Snapshot)});
    }

    _go(state, caption) {
        const props = {};
        if (state !== this._state)
            props.State = new GLib.Variant('s', (this._state = state));
        if (caption !== this._caption)
            props.Caption = new GLib.Variant('s', (this._caption = caption));
        if (Object.keys(props).length) {
            print(`State = ${state}${caption ? `  "${caption.slice(0, 60)}"` : ''}`);
            this._changed(props);
        }
    }

    _stopCycle() {
        if (this._timer)
            GLib.source_remove(this._timer);
        this._timer = 0;
    }

    _schedule(seconds) {
        this._stopCycle();
        if (!cycle || this._muted || seconds <= 0)
            return;
        this._timer = GLib.timeout_add(GLib.PRIORITY_DEFAULT, seconds * 1000, () => {
            this._timer = 0;
            this._advance();
            return GLib.SOURCE_REMOVE;
        });
    }

    _advance() {
        // Every fourth round is an alarm instead of a conversation.
        if (this._step === 1 && this._round % 4 === 3) {
            this._go('ringing', ALARM);
            this._step = 0;
            this._round++;
            this._schedule(6);
            return;
        }
        const ex = EXCHANGES[this._round % EXCHANGES.length];
        const [state, secs, caption] = ROUND[this._step];
        this._go(state, caption(ex));
        if (state === 'speaking') {
            store.log.push({at: now(), heard: ex.heard, reply: ex.reply, typed: false, lang: ex.lang});
            this._snapshotChanged();
        }
        this._step = (this._step + 1) % ROUND.length;
        if (this._step === 0)
            this._round++;
        this._schedule(secs);
    }
}

const impl = new Assistant();
const exported = Gio.DBusExportedObject.wrapJSObject(INTERFACE_XML, impl);
impl.dbus = exported;

const loop = new GLib.MainLoop(null, false);
let status = 0;

Gio.bus_own_name_on_connection(Gio.DBus.session, BUS_NAME,
    Gio.BusNameOwnerFlags.DO_NOT_QUEUE,
    () => {
        print(`Owning ${BUS_NAME}; cycle ${cycle ? 'on' : 'off'}. Ctrl+C to quit.`);
        impl._schedule(1);
    },
    () => {
        printerr(`${BUS_NAME} is already owned (the real daemon?) or the bus went away.`);
        status = 1;
        loop.quit();
    });
exported.export(Gio.DBus.session, OBJECT_PATH);

for (const sig of [2, 15]) { // SIGINT, SIGTERM: release the name cleanly
    GLibUnix.signal_add(GLib.PRIORITY_DEFAULT, sig, () => {
        loop.quit();
        return GLib.SOURCE_REMOVE;
    });
}
if (quitAfter > 0) {
    GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, quitAfter, () => {
        loop.quit();
        return GLib.SOURCE_REMOVE;
    });
}

loop.run();
exported.unexport();
System.exit(status);
