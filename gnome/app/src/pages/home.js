// Home page: the household's services (from services.json), each with its
// live systemd state and an Open button (its GNOME app, or its web page).
// Doesn't need the assistant, so it works when the assistant is down.

import GObject from 'gi://GObject';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Gtk from 'gi://Gtk?version=4.0';
import Gdk from 'gi://Gdk?version=4.0';
import Adw from 'gi://Adw?version=1';

import {UnitWatcher} from '../systemd.js';
import {escape} from '../util.js';

const KIND_CLASS = {ok: 'success', busy: 'warning', bad: 'error', off: 'dim-label', unknown: 'dim-label'};

export const HomePage = GObject.registerClass(
class HomePage extends Adw.Bin {
    constructor(app) {
        super();
        this._app = app;
        this._services = app.services;
        this._watchers = [];
        this._page = null;

        this._empty = new Adw.StatusPage({icon_name: 'go-home-symbolic', title: 'No services'});
        this._stack = new Gtk.Stack();
        this._stack.add_named(this._empty, 'empty');
        this.child = this._stack;

        this._services.connect('changed', () => this._build());
        this._build();
    }

    _build() {
        for (const w of this._watchers)
            w.destroy();
        this._watchers = [];
        if (this._page)
            this._stack.remove(this._page);
        this._page = new Adw.PreferencesPage();
        this._stack.add_named(this._page, 'services');

        const list = this._services.list;
        this._empty.description = this._services.problem ?? 'services.json lists no services.';
        this._stack.visible_child_name = list.length ? 'services' : 'empty';

        // Sections in the order they first appear.
        const groups = new Map();
        for (const s of list) {
            const title = s.group || 'Services';
            if (!groups.has(title)) {
                const group = new Adw.PreferencesGroup({title: escape(title)});
                const box = new Gtk.ListBox({selection_mode: Gtk.SelectionMode.NONE,
                    css_classes: ['boxed-list', 'duet-touch-list']});
                group.add(box);
                this._page.add(group);
                groups.set(title, box);
            }
            groups.get(title).append(this._row(s));
        }
    }

    _row(s) {
        const row = new Adw.ActionRow({
            title: escape(s.name),
            subtitle: escape(s.description ?? ''),
        });
        row.add_prefix(this._icon(s));

        if (s.unit) {
            const pill = new Gtk.Label({valign: Gtk.Align.CENTER, css_classes: ['duet-state']});
            row.add_suffix(pill);
            const watcher = new UnitWatcher(s.unit);
            const sync = () => {
                const st = watcher.status;
                pill.label = st.label;
                pill.tooltip_text = st.detail;
                pill.css_classes = ['duet-state', KIND_CLASS[st.kind]];
            };
            watcher.connect('changed', sync);
            sync();
            this._watchers.push(watcher);
        }

        if (this._services.canOpen(s)) {
            const open = new Gtk.Button({
                label: 'Open',
                valign: Gtk.Align.CENTER,
                css_classes: ['pill'],
                tooltip_text: this._services.appInfo(s)
                    ? `Open ${this._services.appInfo(s).get_display_name()}` : s.url,
                action_name: 'app.open-service',
                action_target: new GLib.Variant('s', s.name),
            });
            row.add_suffix(open);
            row.activatable_widget = open; // the whole row opens it
        }
        return row;
    }

    // services.json's icon may be an icon name, a file, or (as on the old web
    // dashboard) an emoji. Real icons look best, so prefer: a named/file
    // icon, then the GNOME app's own icon, then the emoji.
    _icon(s) {
        const size = 32;
        const icon = s.icon ?? '';
        if (icon.startsWith('/') && GLib.file_test(icon, GLib.FileTest.EXISTS))
            return new Gtk.Image({gicon: Gio.FileIcon.new(Gio.File.new_for_path(icon)), pixel_size: size});
        const theme = Gtk.IconTheme.get_for_display(Gdk.Display.get_default());
        if (/^[\w.-]+$/.test(icon) && theme.has_icon(icon))
            return new Gtk.Image({icon_name: icon, pixel_size: size});
        const appIcon = this._services.appInfo(s)?.get_icon();
        if (appIcon)
            return new Gtk.Image({gicon: appIcon, pixel_size: size});
        if (icon)
            return new Gtk.Label({label: icon, css_classes: ['duet-emoji'], width_request: size});
        return new Gtk.Image({icon_name: 'application-x-executable-symbolic', pixel_size: size});
    }
});
