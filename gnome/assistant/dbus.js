// The D-Bus API on the session bus: org.balaur.Assistant1 at /org/balaur/Assistant
// (gnome/CONTRACT.md). Properties announce changes with PropertiesChanged;
// methods fail with org.balaur.Assistant.Error.Failed and a human message.

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

import {errText, log} from './util.js';

export const OBJECT_PATH = '/org/balaur/Assistant';
export const ERROR_NAME = 'org.balaur.Assistant.Error.Failed';

export const IFACE_XML = `<node>
  <interface name="org.balaur.Assistant1">
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
    <method name="Ask">
      <arg name="text" type="s" direction="in"/>
      <arg name="speak" type="b" direction="in"/>
      <arg name="reply" type="s" direction="out"/>
    </method>
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
    <method name="AgentContext"><arg name="context" type="s" direction="out"/></method>
    <method name="AgentTool"><arg name="name" type="s" direction="in"/><arg name="args" type="s" direction="in"/><arg name="result" type="s" direction="out"/></method>
  </interface>
</node>`;

const PROPS = {
    State: 's', Caption: 's', Muted: 'b', Volume: 'u', Name: 's', WakeWord: 's', Error: 's', Snapshot: 's',
    Models: 's', ApiKeys: 's',
};

/** The JS object behind the interface (Gio.DBusExportedObject.wrapJSObject). */
class Service {
    constructor(a) {
        this.a = a;
    }

    get State() {
        return this.a.publicState;
    }

    get Caption() {
        return this.a.caption;
    }

    get Muted() {
        return this.a.mic.muted;
    }

    set Muted(m) {
        this.a.setMuted(m);
    }

    get Volume() {
        return this.a.volume;
    }

    set Volume(v) {
        this.a.setVolume(v).catch(e => {
            log(`volume: ${errText(e)}`);
            this.a.setError(`volume: ${errText(e)}`);
        });
    }

    get Name() {
        return this.a.cfg.name;
    }

    get WakeWord() {
        return this.a.cfg.wake.words.join(', ');
    }

    get Error() {
        return this.a.lastErr;
    }

    get Snapshot() {
        return this.a.snapshot();
    }

    get Models() {
        return this.a.models;
    }

    get ApiKeys() {
        return this.a.apiKeysJSON;
    }
}

// Each method: (assistant, ...args) -> value (or a promise of it); the
// reply is the out argument, if the method has one.
const METHODS = {
    Ask: {out: '(s)', run: (a, text, speak) => {
        if (!text.trim())
            throw new Error('empty');
        return a.ask(text, speak);
    }},
    Stop: {run: a => a.stop()},
    ListAdd: {run: (a, list, text) => {
        if (!text.trim())
            throw new Error('empty item');
        a.store.AddItems(list, [text]);
    }},
    ListSetDone: {run: (a, list, id, done) => {
        a.store.SetDone(list, id, done);
    }},
    ListRemove: {run: (a, list, id) => {
        a.store.RemoveItems(list, [id]);
    }},
    ListClearDone: {run: (a, list) => a.store.ClearDone(list)},
    MemoryAdd: {run: (a, fact) => {
        if (!fact.trim())
            throw new Error('empty fact');
        a.store.Remember(fact);
    }},
    MemoryRemove: {run: (a, id) => {
        a.store.Forget(id);
    }},
    TimerCancel: {run: (a, id) => {
        a.timers.cancel(id, '', false);
        a.changed();
    }},
    ReminderCancel: {run: (a, id) => {
        a.store.DeleteReminder(id);
    }},
    SetApiKey: {run: (a, provider, key) => a.setApiKey(provider.trim(), key.trim())},
    TestModel: {out: '(s)', run: a => a.testModel()},
    // For pi's extension (gnome/home-agent/), and only while a question is being answered.
    AgentContext: {out: '(s)', run: a => a.agentContext()},
    AgentTool: {out: '(s)', run: (a, name, args) => a.agentTool(name, args)},
};

/** Exports the interface for assistant a on connection; returns the exported object. */
export function exportAssistant(connection, a) {
    const service = new Service(a);
    for (const [name, m] of Object.entries(METHODS)) {
        // The Async form gets the invocation, so failures carry our error name.
        service[`${name}Async`] = async (params, invocation) => {
            try {
                const res = await m.run(a, ...params);
                invocation.return_value(m.out ? new GLib.Variant(m.out, [res ?? '']) : null);
            } catch (e) {
                invocation.return_dbus_error(ERROR_NAME, errText(e));
            }
        };
    }
    const impl = Gio.DBusExportedObject.wrapJSObject(IFACE_XML, service);
    impl.export(connection, OBJECT_PATH);

    // Announce what changed (compared with what was last announced).
    const last = {};
    for (const p of Object.keys(PROPS))
        last[p] = service[p];
    a.onChange(() => {
        for (const [p, sig] of Object.entries(PROPS)) {
            const v = service[p];
            if (v !== last[p]) {
                last[p] = v;
                impl.emit_property_changed(p, new GLib.Variant(sig, v));
            }
        }
    });
    return impl;
}
