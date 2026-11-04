// Quick Settings: an "Assistant" toggle (checked = microphone on) plus a
// panel icon while the microphone is off, so a muted assistant is visible at
// a glance from across the room.

import GObject from 'gi://GObject';

import {QuickToggle, SystemIndicator} from 'resource:///org/gnome/shell/ui/quickSettings.js';

import {describe} from './assistant.js';

const AssistantToggle = GObject.registerClass(
class AssistantToggle extends QuickToggle {
    _init(onToggle) {
        super._init({
            title: 'Assistant',
            iconName: 'audio-input-microphone-symbolic',
            subtitle: 'Not running',
            reactive: false,
        });
        // Not toggle_mode: `checked` only ever mirrors the daemon's Muted
        // property, so the switch can't show a state the daemon isn't in.
        this.connect('clicked', () => onToggle(!this.checked));
    }
});

export const AssistantIndicator = GObject.registerClass(
class AssistantIndicator extends SystemIndicator {
    /** @param {(micOn: boolean) => void} onToggle */
    _init(onToggle) {
        super._init();

        this._mutedIcon = this._addIndicator();
        this._mutedIcon.icon_name = 'microphone-disabled-symbolic';
        this._mutedIcon.visible = false;

        this._toggle = new AssistantToggle(onToggle);
        this.quickSettingsItems.push(this._toggle);

        // If the Shell disposes us without disable() (shutdown), later D-Bus
        // updates must not touch dead actors.
        const forget = () => {
            this._toggle = this._mutedIcon = null;
        };
        this._toggle.connect('destroy', forget);
        this.connect('destroy', forget);
    }

    /** Follow a status snapshot from AssistantClient. */
    sync(status) {
        if (!this._toggle)
            return;
        // Insensitive (St's :insensitive style) while the daemon is absent.
        this._toggle.reactive = status.running;
        this._toggle.checked = status.running && !status.muted;
        this._toggle.iconName = this._toggle.checked
            ? 'audio-input-microphone-symbolic' : 'microphone-disabled-symbolic';
        this._toggle.subtitle = describe(status);
        this._mutedIcon.visible = status.running && status.muted;
    }

    destroy() {
        this.quickSettingsItems.forEach(item => item.destroy());
        this.quickSettingsItems = [];
        super.destroy();
    }
});
