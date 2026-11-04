// Wraps an assistant-backed page: shows the page while org.balaur.Assistant is
// on the bus, and a status page saying so while it isn't. Home doesn't use
// it, so services stay usable when the assistant is down.

import GObject from 'gi://GObject';
import Gtk from 'gi://Gtk?version=4.0';
import Adw from 'gi://Adw?version=1';

export const AssistantGate = GObject.registerClass(
class AssistantGate extends Gtk.Stack {
    constructor(assistant, content) {
        super({transition_type: Gtk.StackTransitionType.CROSSFADE});
        this.add_named(content, 'content');
        this.add_named(new Adw.StatusPage({
            icon_name: 'microphone-disabled-symbolic',
            title: "Assistant isn't running",
            description: 'Its conversation, lists, timers and memory show up here ' +
                'as soon as the assistant service is back. Home still works.',
        }), 'offline');
        const sync = () => {
            this.visible_child_name = assistant.available ? 'content' : 'offline';
        };
        assistant.connect('notify::available', sync);
        sync();
    }
});
