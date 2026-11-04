// balaur@balaur.local: the Duet's household screen in GNOME Shell.
//
// - an orb + caption overlay over everything while the assistant listens,
//   thinks, speaks or rings (tap = Stop);
// - a Quick Settings "Assistant" toggle for the microphone;
// - the ambient screen when nobody has touched the Duet for a while: clock,
//   weather, timers, the next reminder, photos from Jellyfin.
//
// All follow the org.balaur.Assistant D-Bus service (gnome/CONTRACT.md)
// through one AssistantClient, and cope with the service being absent.

import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import {AmbientScreen} from './ambient.js';
import {AssistantClient} from './assistant.js';
import {AssistantOverlay} from './overlay.js';
import {AssistantIndicator} from './toggle.js';

export default class BalaurExtension extends Extension {
    enable() {
        this._client = new AssistantClient(status => {
            this._ambient?.sync(status);
            this._overlay?.sync(status);
            this._indicator?.sync(status);
        });

        this._ambient = new AmbientScreen();
        this._overlay = new AssistantOverlay(() => this._client.stop());
        this._indicator = new AssistantIndicator(
            micOn => this._client.setMuted(!micOn));
        Main.panel.statusArea.quickSettings.addExternalIndicator(this._indicator);

        // Start in the "Not running" look until the proxy says otherwise.
        const initial = this._client.status;
        this._ambient.sync(initial);
        this._overlay.sync(initial);
        this._indicator.sync(initial);

        this._client.start();
    }

    disable() {
        // Client first, so no callback reaches the half-torn-down UI.
        this._client.destroy();
        this._client = null;
        this._indicator.destroy();
        this._indicator = null;
        this._overlay.destroy();
        this._overlay = null;
        this._ambient.destroy();
        this._ambient = null;
    }
}
