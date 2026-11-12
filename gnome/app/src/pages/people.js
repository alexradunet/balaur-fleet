// People page: who of the household opens which service. The people on top,
// each with a picture; then every service that has a page, with the same
// pictures beside it, faded for whoever does not get in. It only shows what
// the system's configuration decided (access.js); nothing is changed here.

import GObject from 'gi://GObject';
import Gtk from 'gi://Gtk?version=4.0';
import Adw from 'gi://Adw?version=1';

import {ROLE_TEXT, canOpen, countFor, faceText, loginText, openable} from '../access.js';
import {serviceIcon} from '../service-icon.js';
import {escape} from '../util.js';

export const PeoplePage = GObject.registerClass(
class PeoplePage extends Adw.Bin {
    constructor(app) {
        super();
        this._people = app.people;
        this._services = app.services;
        this._page = null;

        this._empty = new Adw.StatusPage({
            icon_name: 'system-users-symbolic',
            title: 'Nobody yet',
            description: 'This machine’s configuration names no people.',
        });
        this._stack = new Gtk.Stack();
        this._stack.add_named(this._empty, 'empty');
        this.child = this._stack;

        this._people.connect('changed', () => this._build());
        this._services.connect('changed', () => this._build());
        this._build();
    }

    _build() {
        if (this._page)
            this._stack.remove(this._page);
        this._page = new Adw.PreferencesPage();
        this._stack.add_named(this._page, 'people');

        const people = this._people.list;
        const services = openable(this._services.list);
        this._stack.visible_child_name = people.length ? 'people' : 'empty';

        const who = new Adw.PreferencesGroup({
            title: 'People',
            description: 'Who can open what. A faded picture beside a service means not that person.',
        });
        const whoBox = this._listBox();
        for (const p of people) {
            const row = new Adw.ActionRow({
                title: escape(p.name),
                subtitle: escape(ROLE_TEXT[p.role] ?? p.role),
            });
            row.add_prefix(this._avatar(p, 40));
            row.add_suffix(new Gtk.Label({
                label: `${countFor(p, services)} of ${services.length}`,
                valign: Gtk.Align.CENTER,
                css_classes: ['dim-label', 'numeric'],
            }));
            whoBox.append(row);
        }
        who.add(whoBox);
        this._page.add(who);

        // The services in the Home page's sections, in the order they first appear.
        const groups = new Map();
        for (const s of services) {
            const title = s.group || 'Services';
            if (!groups.has(title)) {
                const group = new Adw.PreferencesGroup({title: escape(title)});
                const box = this._listBox();
                group.add(box);
                this._page.add(group);
                groups.set(title, box);
            }
            groups.get(title).append(this._serviceRow(s, people));
        }
    }

    _listBox() {
        return new Gtk.ListBox({selection_mode: Gtk.SelectionMode.NONE,
            css_classes: ['boxed-list', 'balaur-touch-list']});
    }

    _serviceRow(s, people) {
        const row = new Adw.ActionRow({
            title: escape(s.name),
            subtitle: escape(loginText(s)),
        });
        row.add_prefix(serviceIcon(this._services, s));

        const faces = new Gtk.Box({spacing: 8, valign: Gtk.Align.CENTER});
        for (const p of people) {
            const face = this._avatar(p, 32);
            const opens = canOpen(p, s);
            if (!opens)
                face.add_css_class('balaur-no-access');
            // A screen reader gets no fading: say it.
            face.tooltip_text = `${p.name} ${opens ? 'can open' : 'cannot open'} ${s.name}`;
            faces.append(face);
        }
        row.add_suffix(faces);
        return row;
    }

    // The same picture everywhere for one person: libadwaita colours it by the
    // name. The screen is not a person, so it gets a display instead of initials.
    _avatar(p, size) {
        const avatar = new Adw.Avatar({size, text: faceText(p, this._people.list),
            show_initials: p.role !== 'screen'});
        if (p.role === 'screen')
            avatar.icon_name = 'video-display-symbolic';
        return avatar;
    }
});
