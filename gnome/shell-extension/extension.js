// balaur@balaur.local: the Duet's household screen in GNOME Shell.
//
// - a Quick Settings "Scenes" menu: Home Assistant's scenes and scripts;
// - the ambient screen when nobody has touched the Duet for a while: clock,
//   weather, the machines and services, photos.

import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import {AmbientScreen} from './ambient.js';
import {loadHouse} from './house.js';
import {ScenesIndicator} from './scenes.js';

export default class BalaurExtension extends Extension {
    enable() {
        this._ambient = new AmbientScreen();

        // Home Assistant's scenes, where /etc/balaur/house.json exists.
        const house = loadHouse();
        if (house) {
            this._scenes = new ScenesIndicator(house);
            Main.panel.statusArea.quickSettings.addExternalIndicator(this._scenes);
        }
    }

    disable() {
        this._scenes?.destroy();
        this._scenes = null;
        this._ambient.destroy();
        this._ambient = null;
    }
}
