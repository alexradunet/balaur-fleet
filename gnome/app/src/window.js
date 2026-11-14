// The main window: its pages in an AdwViewStack, Home first. Wide (landscape)
// shows the page switcher in the header bar; narrow (portrait) moves it to a
// bar at the bottom, within reach of thumbs. With Home alone (no people named)
// there is nothing to switch: the header shows the app name and no bar.

import GObject from 'gi://GObject';
import Gio from 'gi://Gio';
import Gtk from 'gi://Gtk?version=4.0';
import Adw from 'gi://Adw?version=1';

import {HomePage} from './pages/home.js';
import {PeoplePage} from './pages/people.js';

export const BalaurWindow = GObject.registerClass(
class BalaurWindow extends Adw.ApplicationWindow {
    constructor(app) {
        super({
            application: app,
            title: 'Balaur',
            icon_name: 'org.balaur.Balaur',
            default_width: 1080,
            default_height: 720,
            width_request: 360,
            height_request: 400,
        });

        const stack = new Adw.ViewStack({vexpand: true});
        this._stack = stack;
        stack.add_titled_with_icon(new HomePage(app), 'home', 'Home', 'go-home-symbolic');
        // Only on a machine whose configuration names people (the shared tablet).
        const peoplePage = stack.add_titled_with_icon(new PeoplePage(app), 'people', 'People',
            'system-users-symbolic');

        // Header: the switcher when wide, the app name when narrow.
        const switcher = new Adw.ViewSwitcher({stack, policy: Adw.ViewSwitcherPolicy.WIDE});
        const title = new Adw.WindowTitle({title: 'Balaur', visible: false});
        const titleBox = new Gtk.Box();
        titleBox.append(switcher);
        titleBox.append(title);
        const loneTitle = new Adw.WindowTitle({title: 'Balaur'});
        const header = new Adw.HeaderBar({title_widget: titleBox});
        // Main menu, GNOME style.
        const menu = new Gio.Menu();
        menu.append('Quit', 'app.quit');
        header.pack_end(new Gtk.MenuButton({icon_name: 'open-menu-symbolic', menu_model: menu,
            primary: true, tooltip_text: 'Main Menu'}));

        const bar = new Adw.ViewSwitcherBar({stack});

        this._toasts = new Adw.ToastOverlay({child: stack});
        const view = new Adw.ToolbarView({content: this._toasts});
        view.add_top_bar(header);
        view.add_bottom_bar(bar);
        this.content = view;

        // Portrait (narrower than 860 sp) uses the bottom bar.
        const narrow = new Adw.Breakpoint({
            condition: Adw.BreakpointCondition.parse('max-width: 860sp'),
        });
        narrow.add_setter(switcher, 'visible', false);
        narrow.add_setter(title, 'visible', true);
        narrow.add_setter(bar, 'reveal', true);
        this.add_breakpoint(narrow);

        const syncPeople = () => {
            const people = app.people.list.length > 0;
            peoplePage.visible = people;
            header.title_widget = people ? titleBox : loneTitle;
            bar.visible = people;
        };
        app.people.connect('changed', syncPeople);
        syncPeople();
    }

    showPage(name) {
        this._stack.visible_child_name = name;
    }

    toast(text) {
        this._toasts.add_toast(new Adw.Toast({title: text, use_markup: false, timeout: 5}));
    }
});
