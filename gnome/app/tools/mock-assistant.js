#!/usr/bin/env -S gjs -m
// A stand-in for the assistant daemon, to try the app without it: owns
// org.duet.Assistant on the session bus, implements the whole
// org.duet.Assistant1 API from gnome/CONTRACT.md on made-up state, and logs
// every call on stdout ("CALL ...") so a test can check what the app did.
//
//   gjs -m gnome/app/tools/mock-assistant.js
//
// Ask("fail ...") fails with org.duet.Assistant.Error.Failed, to see the
// app's error toast. Ask() walks State through thinking -> speaking -> idle.

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

const XML = `
<node>
  <interface name="org.duet.Assistant1">
    <property name="State" type="s" access="read"/>
    <property name="Caption" type="s" access="read"/>
    <property name="Muted" type="b" access="readwrite"/>
    <property name="Volume" type="u" access="readwrite"/>
    <property name="Name" type="s" access="read"/>
    <property name="WakeWord" type="s" access="read"/>
    <property name="Error" type="s" access="read"/>
    <property name="Snapshot" type="s" access="read"/>
    <property name="Models" type="s" access="read"/>
    <property name="ApiKeys" type="s" access="read"/>
    <method name="Ask"><arg name="text" type="s" direction="in"/><arg name="speak" type="b" direction="in"/><arg name="reply" type="s" direction="out"/></method>
    <method name="Stop"/>
    <method name="ListAdd"><arg name="list" type="s" direction="in"/><arg name="text" type="s" direction="in"/></method>
    <method name="ListSetDone"><arg name="list" type="s" direction="in"/><arg name="id" type="s" direction="in"/><arg name="done" type="b" direction="in"/></method>
    <method name="ListRemove"><arg name="list" type="s" direction="in"/><arg name="id" type="s" direction="in"/></method>
    <method name="ListClearDone"><arg name="list" type="s" direction="in"/></method>
    <method name="MemoryAdd"><arg name="fact" type="s" direction="in"/></method>
    <method name="MemoryRemove"><arg name="id" type="s" direction="in"/></method>
    <method name="TimerCancel"><arg name="id" type="s" direction="in"/></method>
    <method name="ReminderCancel"><arg name="id" type="s" direction="in"/></method>
    <method name="SetApiKey"><arg name="provider" type="s" direction="in"/><arg name="key" type="s" direction="in"/></method>
    <method name="TestModel"><arg name="error" type="s" direction="out"/></method>
  </interface>
</node>`;

const iso = secondsFromNow => GLib.DateTime.new_now_local().add_seconds(secondsFromNow).format_iso8601();
let nextId = 100;
const newId = () => `m${nextId++}`;

const house = {
    log: [
        {at: iso(-3600), heard: 'Cât e ceasul?', reply: 'E ora cinci și un sfert.', typed: false, lang: 'ro'},
        {at: iso(-600), heard: "What's the weather tomorrow?", reply: 'Tomorrow in Bucharest: sunny, 14 degrees, light wind from the north-east.', typed: true, lang: 'en'},
    ],
    timers: [
        {id: 't1', label: 'pasta', ends: iso(9 * 60 + 30), remaining_seconds: 570},
        {id: 't2', label: 'oven', ends: iso(3725), remaining_seconds: 3725},
    ],
    reminders: [
        {id: 'r1', text: 'Call the bank', at: iso(18 * 3600), lang: 'en'},
        {id: 'r2', text: 'Take out the recycling', at: iso(3 * 86400), repeat: 'weekly', lang: 'en'},
    ],
    lists: {
        shopping: [
            {id: 's1', text: 'milk', done: false, added: iso(-7200)},
            {id: 's2', text: 'bread', done: true, added: iso(-7000)},
            {id: 's3', text: 'olive oil', done: false, added: iso(-6000)},
        ],
        tasks: [
            {id: 'k1', text: 'Fix the bathroom tap', done: false, assignee: 'Alex', due: 'Saturday', added: iso(-86400)},
        ],
    },
    listOrder: ['shopping', 'tasks'],
    memories: [
        {id: 'f1', fact: 'Ana is allergic to nuts.', added: iso(-86400 * 10)},
        {id: 'f2', fact: 'The Wi-Fi password is on the fridge.', added: iso(-86400 * 3)},
    ],
};

const props = {State: 'idle', Caption: '', Muted: false, Volume: 60, Name: 'Jarvis',
    WakeWord: 'hey_jarvis_v0.1', Error: ''};

const fail = text => {
    const e = new Error(text);
    e.name = 'org.duet.Assistant.Error.Failed';
    return e;
};

// Settings (CONTRACT.md "Settings"): a small model catalog, and keys kept in
// memory only (the real daemon uses the GNOME Keyring). TestModel reads the
// app's GSettings when the schema is installed (GSETTINGS_SCHEMA_DIR), and
// fails for a provider without a key or a model called "broken".
const models = {providers: [
    {id: 'mistral', name: 'Mistral', models: [
        {id: 'mistral-medium-latest', name: 'Mistral Medium'},
        {id: 'mistral-small-latest', name: 'Mistral Small'},
        {id: 'mistral-large-latest', name: 'Mistral Large'},
    ]},
    {id: 'openai', name: 'OpenAI', models: [
        {id: 'gpt-5-mini', name: 'GPT-5 mini'},
        {id: 'gpt-5', name: 'GPT-5'},
    ]},
]};
const apiKeys = {mistral: true};

function settings() {
    const source = Gio.SettingsSchemaSource.get_default();
    return source?.lookup('org.duet.Assistant', true) ? new Gio.Settings({schema_id: 'org.duet.Assistant'}) : null;
}

let exported = null;

function changed(names) {
    const values = {};
    for (const n of names) {
        const sig = {State: 's', Caption: 's', Muted: 'b', Volume: 'u', Name: 's',
            WakeWord: 's', Error: 's', Snapshot: 's', Models: 's', ApiKeys: 's'}[n];
        values[n] = new GLib.Variant(sig, n === 'Snapshot' ? JSON.stringify(house) : n === 'Models' ? JSON.stringify(models) : n === 'ApiKeys' ? JSON.stringify(apiKeys) : props[n]);
    }
    exported.get_connection().emit_signal(null, '/org/duet/Assistant',
        'org.freedesktop.DBus.Properties', 'PropertiesChanged',
        new GLib.Variant('(sa{sv}as)', ['org.duet.Assistant1', values, []]));
}

function setState(state, caption = '') {
    props.State = state;
    props.Caption = caption;
    changed(['State', 'Caption']);
}

const later = (ms, fn) => GLib.timeout_add(GLib.PRIORITY_DEFAULT, ms, () => {
    fn();
    return GLib.SOURCE_REMOVE;
});

function list(name) {
    const items = house.lists[name];
    if (!items)
        throw fail(`No list called ${name}`);
    return items;
}

const impl = {
    get State() { return props.State; },
    get Caption() { return props.Caption; },
    get Muted() { return props.Muted; },
    set Muted(v) {
        print(`CALL Set Muted ${v}`);
        props.Muted = v;
        changed(['Muted']);
    },
    get Volume() { return props.Volume; },
    set Volume(v) {
        print(`CALL Set Volume ${v}`);
        props.Volume = Math.min(100, v);
        changed(['Volume']);
    },
    get Name() { return props.Name; },
    get WakeWord() { return props.WakeWord; },
    get Error() { return props.Error; },
    get Snapshot() { return JSON.stringify(house); },
    get Models() { return JSON.stringify(models); },
    get ApiKeys() { return JSON.stringify(apiKeys); },

    SetApiKey(provider, key) {
        print(`CALL SetApiKey ${provider} ${key ? `(${key.length} chars)` : '(delete)'}`);
        if (key)
            apiKeys[provider] = true;
        else
            delete apiKeys[provider];
        changed(['ApiKeys']);
    },
    TestModelAsync(_params, invocation) {
        const s = settings();
        const provider = s?.get_string('llm-provider') ?? 'mistral';
        const model = s?.get_string('llm-model') ?? '?';
        print(`CALL TestModel provider=${provider} model=${model} baseUrl=${s?.get_string('llm-base-url') ?? ''}`);
        let error = '';
        if (!apiKeys[provider])
            error = `No API key for ${provider}`;
        else if (model === 'broken')
            error = `${provider} says: model "broken" does not exist`;
        later(1500, () => invocation.return_value(new GLib.Variant('(s)', [error])));
    },

    AskAsync([text, speak], invocation) {
        print(`CALL Ask ${JSON.stringify(text)} speak=${speak}`);
        setState('thinking', text);
        later(1200, () => {
            if (text.startsWith('fail')) {
                setState('idle');
                invocation.return_dbus_error('org.duet.Assistant.Error.Failed',
                    "Mistral didn't answer (mock failure)");
                return;
            }
            const reply = `You asked: “${text}”. This is the mock assistant.`;
            house.log.push({at: iso(0), heard: text, reply, typed: true, lang: 'en'});
            changed(['Snapshot']);
            setState('speaking', reply);
            invocation.return_value(new GLib.Variant('(s)', [reply]));
            later(2500, () => {
                if (props.State === 'speaking')
                    setState('idle');
            });
        });
    },
    Stop() {
        print('CALL Stop');
        setState('idle');
    },
    ListAdd(name, text) {
        print(`CALL ListAdd ${name} ${JSON.stringify(text)}`);
        if (!house.lists[name]) {
            house.lists[name] = [];
            house.listOrder.push(name);
        }
        house.lists[name].push({id: newId(), text, done: false, added: iso(0)});
        changed(['Snapshot']);
    },
    ListSetDone(name, id, done) {
        print(`CALL ListSetDone ${name} ${id} ${done}`);
        const it = list(name).find(i => i.id === id);
        if (!it)
            throw fail('No such item');
        it.done = done;
        changed(['Snapshot']);
    },
    ListRemove(name, id) {
        print(`CALL ListRemove ${name} ${id}`);
        house.lists[name] = list(name).filter(i => i.id !== id);
        changed(['Snapshot']);
    },
    ListClearDone(name) {
        print(`CALL ListClearDone ${name}`);
        house.lists[name] = list(name).filter(i => !i.done);
        changed(['Snapshot']);
    },
    MemoryAdd(fact) {
        print(`CALL MemoryAdd ${JSON.stringify(fact)}`);
        house.memories.push({id: newId(), fact, added: iso(0)});
        changed(['Snapshot']);
    },
    MemoryRemove(id) {
        print(`CALL MemoryRemove ${id}`);
        house.memories = house.memories.filter(m => m.id !== id);
        changed(['Snapshot']);
    },
    TimerCancel(id) {
        print(`CALL TimerCancel ${id}`);
        house.timers = house.timers.filter(t => t.id !== id);
        changed(['Snapshot']);
    },
    ReminderCancel(id) {
        print(`CALL ReminderCancel ${id}`);
        house.reminders = house.reminders.filter(r => r.id !== id);
        changed(['Snapshot']);
    },
};

const loop = new GLib.MainLoop(null, false);
Gio.bus_own_name(Gio.BusType.SESSION, 'org.duet.Assistant', Gio.BusNameOwnerFlags.NONE,
    conn => {
        exported = Gio.DBusExportedObject.wrapJSObject(XML, impl);
        exported.export(conn, '/org/duet/Assistant');
    },
    () => print('READY org.duet.Assistant'),
    () => {
        printerr('Lost or could not own org.duet.Assistant');
        loop.quit();
    });
loop.run();
