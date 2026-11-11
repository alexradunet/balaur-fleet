// Lists page: one group per house list (in the daemon's listOrder), items
// checked off with a tap, a row to add to each, remove buttons, and
// "Clear done" in the group's header.
//
// Groups and their "Add" rows live as long as the list does, and only the
// item rows are rebuilt on each change, so text being typed (and the
// on-screen keyboard's focus) survives updates arriving meanwhile.

import GObject from 'gi://GObject';
import GLib from 'gi://GLib';
import Gtk from 'gi://Gtk?version=4.0';
import Adw from 'gi://Adw?version=1';

import {AssistantGate} from '../gate.js';
import {actionIconButton, placeholderRow, clearChildren, escape, listTitle} from '../util.js';

export const ListsPage = GObject.registerClass(
class ListsPage extends Adw.Bin {
    constructor(app) {
        super();
        this._app = app;
        this._assistant = app.assistant;
        this._groups = new Map(); // list name -> {group, box, entry, clear, key}
        this._order = '';

        this._page = new Adw.PreferencesPage();
        this._empty = new Adw.StatusPage({
            icon_name: 'checkbox-checked-symbolic',
            title: 'No lists yet',
            description: `Ask ${escape(this._assistant.name)} to put something on the shopping list.`,
        });
        this._stack = new Gtk.Stack();
        this._stack.add_named(this._page, 'lists');
        this._stack.add_named(this._empty, 'empty');

        this.child = new AssistantGate(this._assistant, this._stack);
        this._assistant.connect('changed', () => this._sync());
        this._sync();
    }

    _sync() {
        const s = this._assistant.snapshot;
        this._stack.visible_child_name = s.listOrder.length ? 'lists' : 'empty';
        this._empty.description = `Ask ${escape(this._assistant.name)} to put something on the shopping list.`;

        // Groups: drop lists that went away, (re)order when the order changed.
        const order = s.listOrder.join('\n');
        if (order !== this._order) {
            this._order = order;
            for (const [name, g] of this._groups) {
                this._page.remove(g.group);
                if (!s.listOrder.includes(name))
                    this._groups.delete(name);
            }
            for (const name of s.listOrder)
                this._page.add(this._group(name).group);
        }

        for (const name of s.listOrder)
            this._fill(this._group(name), name, s.lists[name]);
    }

    _group(name) {
        let g = this._groups.get(name);
        if (g)
            return g;
        const title = listTitle(name);
        const group = new Adw.PreferencesGroup({title: escape(title)});
        const clear = new Gtk.Button({
            label: 'Clear done',
            css_classes: ['flat', 'balaur-touch-button'],
            valign: Gtk.Align.CENTER,
            action_name: 'app.list-clear-done',
            action_target: new GLib.Variant('s', name),
        });
        group.header_suffix = clear;

        const box = new Gtk.ListBox({selection_mode: Gtk.SelectionMode.NONE,
            css_classes: ['boxed-list', 'balaur-touch-list']});
        const entry = new Adw.EntryRow({title: `Add to ${escape(title)}`, show_apply_button: true});
        const submit = () => {
            const text = entry.text.trim();
            if (!text)
                return;
            entry.text = '';
            this._app.activate_action('list-add', new GLib.Variant('(ss)', [name, text]));
        };
        entry.connect('apply', submit);
        entry.connect('entry-activated', submit);
        box.append(entry);
        group.add(box);

        g = {group, box, entry, clear, key: null};
        this._groups.set(name, g);
        return g;
    }

    _fill(g, name, items) {
        // Skip the rebuild when nothing in this list changed.
        const key = JSON.stringify(items);
        if (key === g.key)
            return;
        g.key = key;
        g.clear.visible = items.some(it => it.done);
        clearChildren(g.box, [g.entry]);
        if (!items.length)
            g.box.insert(placeholderRow('Empty'), 0);
        items.forEach((it, i) => g.box.insert(this._itemRow(g, name, it), i));
    }

    _itemRow(g, list, it) {
        const row = new Adw.ActionRow({
            // Done items are struck through, like a paper list.
            title: it.done ? `<s>${escape(it.text)}</s>` : escape(it.text),
            subtitle: escape([it.assignee, it.due].filter(Boolean).join(' · ')),
            use_markup: true,
        });
        if (it.done)
            row.add_css_class('dim-label');
        const check = new Gtk.CheckButton({active: it.done, valign: Gtk.Align.CENTER,
            css_classes: ['selection-mode']});
        check.update_property([Gtk.AccessibleProperty.LABEL], [`Done: ${it.text}`]);
        check.connect('toggled', async () => {
            if (await this._app.listSetDone(list, it.id, check.active))
                return;
            // The daemon kept the old state, so the snapshot did not change and
            // nothing would redraw the box: rebuild the rows from the snapshot.
            g.key = null;
            this._sync();
        });
        row.add_prefix(check);
        row.activatable_widget = check; // tap anywhere on the row to tick it
        row.add_suffix(actionIconButton('user-trash-symbolic', 'Remove', 'app.list-remove',
            new GLib.Variant('(ss)', [list, it.id])));
        return row;
    }
});
