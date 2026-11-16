// Quick Settings: a "Scenes" tile whose menu lists Home Assistant's scenes and
// scripts (house.js); a tap runs one. The list is fetched each time the menu
// opens, so a scene made in Home Assistant shows up without a restart.

import GObject from 'gi://GObject';
import Gio from 'gi://Gio';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
import {QuickMenuToggle, SystemIndicator} from 'resource:///org/gnome/shell/ui/quickSettings.js';

import {HomeAssistant} from './house.js';

const ICON = 'preferences-desktop-wallpaper-symbolic';

const ScenesToggle = GObject.registerClass(
class ScenesToggle extends QuickMenuToggle {
    _init(house) {
        super._init({title: 'Scenes', iconName: ICON, toggleMode: false});
        this._ha = new HomeAssistant(house);
        this._cancellable = null;
        this.menu.setHeader(ICON, 'Scenes', 'Home Assistant');
        this._items = new PopupMenu.PopupMenuSection();
        this.menu.addMenuItem(this._items);
        this._message('Opening…');

        // The tile itself opens the menu: there is nothing to switch on or off.
        this.connect('clicked', () => this.menu.open());
        this.menu.connect('open-state-changed', (_m, open) => {
            if (open)
                this._refresh();
            else
                this._cancellable?.cancel();
        });
    }

    _message(text) {
        this._items.removeAll();
        const item = new PopupMenu.PopupMenuItem(text, {reactive: false});
        this._items.addMenuItem(item);
    }

    async _refresh() {
        this._cancellable?.cancel();
        const cancellable = this._cancellable = new Gio.Cancellable();
        let actions;
        try {
            actions = await this._ha.actions(cancellable);
        } catch (e) {
            if (!cancellable.is_cancelled())
                this._message(`Home Assistant didn't answer (${e.message})`);
            return;
        }
        if (cancellable.is_cancelled())
            return;
        if (!actions.length) {
            this._message('No scenes yet: make them in Home Assistant');
            return;
        }
        this._items.removeAll();
        let lastDomain = null;
        for (const action of actions) {
            if (lastDomain && action.domain !== lastDomain)
                this._items.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
            lastDomain = action.domain;
            const item = new PopupMenu.PopupImageMenuItem(action.name, action.icon);
            item.connect('activate', () => this._run(action));
            this._items.addMenuItem(item);
        }
    }

    async _run(action) {
        // The menu item closes the Quick Settings; the house answers by itself.
        try {
            await this._ha.run(action);
        } catch (e) {
            Main.notifyError(`${action.name} didn't run`, e.message);
        }
    }

    destroy() {
        this._cancellable?.cancel();
        this._ha.destroy();
        super.destroy();
    }
});

export const ScenesIndicator = GObject.registerClass(
class ScenesIndicator extends SystemIndicator {
    /** @param {{url: string, tokenFile: string}} house */
    _init(house) {
        super._init();
        this.quickSettingsItems.push(new ScenesToggle(house));
    }

    destroy() {
        this.quickSettingsItems.forEach(item => item.destroy());
        this.quickSettingsItems = [];
        super.destroy();
    }
});
