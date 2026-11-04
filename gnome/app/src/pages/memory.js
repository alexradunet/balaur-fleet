// Memory page: the facts the assistant keeps about the household (it uses
// them in every answer), a row to teach it a new one, and Forget buttons.

import GObject from 'gi://GObject';
import GLib from 'gi://GLib';
import Gtk from 'gi://Gtk?version=4.0';
import Adw from 'gi://Adw?version=1';

import {AssistantGate} from '../gate.js';
import {actionIconButton, placeholderRow, clearChildren} from '../util.js';

export const MemoryPage = GObject.registerClass(
class MemoryPage extends Adw.Bin {
    constructor(app) {
        super();
        this._app = app;
        this._assistant = app.assistant;
        this._key = null;

        const page = new Adw.PreferencesPage();

        // Adding sits on top: the list can get long.
        const addGroup = new Adw.PreferencesGroup();
        const addBox = new Gtk.ListBox({selection_mode: Gtk.SelectionMode.NONE,
            css_classes: ['boxed-list', 'duet-touch-list']});
        this._entry = new Adw.EntryRow({title: 'Add a fact, e.g. “Ana is allergic to nuts”',
            show_apply_button: true});
        const submit = () => {
            const fact = this._entry.text.trim();
            if (!fact)
                return;
            this._entry.text = '';
            this._app.activate_action('memory-add', new GLib.Variant('s', fact));
        };
        this._entry.connect('apply', submit);
        this._entry.connect('entry-activated', submit);
        addBox.append(this._entry);
        addGroup.add(addBox);
        page.add(addGroup);

        this._group = new Adw.PreferencesGroup();
        this._box = new Gtk.ListBox({selection_mode: Gtk.SelectionMode.NONE,
            css_classes: ['boxed-list', 'duet-touch-list']});
        this._group.add(this._box);
        page.add(this._group);

        this.child = new AssistantGate(this._assistant, page);
        this._assistant.connect('changed', () => this._sync());
        this._sync();
    }

    _sync() {
        const a = this._assistant;
        this._group.title = `What ${a.name} remembers`;
        this._group.description = 'Used in every answer. Tell it “remember that…”, or add facts here.';
        const memories = a.snapshot.memories;
        const key = JSON.stringify(memories);
        if (key === this._key)
            return;
        this._key = key;
        clearChildren(this._box);
        if (!memories.length)
            this._box.append(placeholderRow('Nothing yet'));
        for (const m of memories) {
            const row = new Adw.ActionRow({title: GLib.markup_escape_text(m.fact ?? '', -1)});
            row.add_suffix(actionIconButton('user-trash-symbolic', 'Forget', 'app.memory-remove',
                new GLib.Variant('s', m.id)));
            this._box.append(row);
        }
    }
});
