// Assistant page: what the assistant is doing (with Stop), the conversation
// (newest at the bottom), a box to type a question, and the microphone and
// speaker controls.

import GObject from 'gi://GObject';
import GLib from 'gi://GLib';
import Pango from 'gi://Pango';
import Gtk from 'gi://Gtk?version=4.0';
import Adw from 'gi://Adw?version=1';

import {AssistantGate} from '../gate.js';
import {parseTime, formatWhen, clearChildren, escape} from '../util.js';

// How much history to draw; the daemon keeps its own (short) log anyway.
const MAX_EXCHANGES = 60;

const STATE_TEXT = {
    listening: 'Listening…',
    thinking: 'Thinking…',
    speaking: 'Speaking…',
    ringing: 'Ringing',
};
const STATE_ICON = {
    idle: 'audio-input-microphone-symbolic',
    muted: 'microphone-disabled-symbolic',
    listening: 'microphone-sensitivity-high-symbolic',
    thinking: 'chat-message-new-symbolic',
    speaking: 'audio-volume-high-symbolic',
    ringing: 'alarm-symbolic',
};
// States where there is something to stop.
const BUSY = new Set(['listening', 'thinking', 'speaking', 'ringing']);

export const AssistantPage = GObject.registerClass(
class AssistantPage extends Adw.Bin {
    constructor(app) {
        super();
        this._app = app;
        this._assistant = app.assistant;
        this._logKey = null;
        this._volumeHold = 0; // timeout id while the user is moving the slider

        const page = new Gtk.Box({orientation: Gtk.Orientation.VERTICAL});

        // Last error from the daemon (e.g. the LLM is unreachable).
        this._banner = new Adw.Banner({use_markup: false}); // the daemon's error is plain text
        page.append(this._banner);

        page.append(this._buildStatus());
        page.append(this._buildLog());
        page.append(this._buildComposer());

        this.child = new AssistantGate(this._assistant, page);

        this._assistant.connect('changed', () => this._sync());
        this._sync();
    }

    _buildStatus() {
        const box = new Gtk.Box({spacing: 12, margin_top: 12, margin_bottom: 6,
            margin_start: 12, margin_end: 12});
        this._stateIcon = new Gtk.Image({pixel_size: 32, valign: Gtk.Align.CENTER});
        this._spinner = new Adw.Spinner({width_request: 32, height_request: 32, valign: Gtk.Align.CENTER});
        const texts = new Gtk.Box({orientation: Gtk.Orientation.VERTICAL, hexpand: true,
            valign: Gtk.Align.CENTER});
        this._stateLabel = new Gtk.Label({xalign: 0, css_classes: ['title-3'], wrap: true});
        this._captionLabel = new Gtk.Label({xalign: 0, css_classes: ['dim-label'], wrap: true,
            wrap_mode: Pango.WrapMode.WORD_CHAR});
        texts.append(this._stateLabel);
        texts.append(this._captionLabel);
        this._stopButton = new Gtk.Button({
            child: new Adw.ButtonContent({icon_name: 'media-playback-stop-symbolic', label: 'Stop'}),
            css_classes: ['destructive-action', 'pill'],
            valign: Gtk.Align.CENTER,
            action_name: 'app.stop',
        });
        box.append(this._stateIcon);
        box.append(this._spinner);
        box.append(texts);
        box.append(this._stopButton);
        box.append(new Gtk.Button({
            icon_name: 'emblem-system-symbolic',
            tooltip_text: 'Assistant settings',
            valign: Gtk.Align.CENTER,
            css_classes: ['flat', 'circular', 'balaur-touch-button'],
            action_name: 'app.assistant-settings',
        }));
        return new Adw.Clamp({maximum_size: 900, child: box});
    }

    _buildLog() {
        this._logBox = new Gtk.Box({orientation: Gtk.Orientation.VERTICAL, spacing: 6,
            margin_top: 12, margin_bottom: 12, margin_start: 12, margin_end: 12,
            valign: Gtk.Align.END});
        this._scroller = new Gtk.ScrolledWindow({
            vexpand: true,
            hscrollbar_policy: Gtk.PolicyType.NEVER,
            child: new Adw.Clamp({maximum_size: 900, child: this._logBox}),
        });
        // Stay at the bottom when new messages make the content taller.
        this._scroller.vadjustment.connect('notify::upper', adj => {
            if (this._stickToBottom)
                adj.value = adj.upper - adj.page_size;
        });
        this._scroller.vadjustment.connect('value-changed', adj => {
            this._stickToBottom = adj.value >= adj.upper - adj.page_size - 24;
        });
        this._stickToBottom = true;

        this._emptyLog = new Adw.StatusPage({icon_name: 'audio-input-microphone-symbolic',
            vexpand: true});
        this._logStack = new Gtk.Stack({vexpand: true});
        this._logStack.add_named(this._scroller, 'log');
        this._logStack.add_named(this._emptyLog, 'empty');
        return this._logStack;
    }

    _buildComposer() {
        const outer = new Gtk.Box({orientation: Gtk.Orientation.VERTICAL, spacing: 12,
            margin_top: 6, margin_bottom: 12, margin_start: 12, margin_end: 12});

        const ask = new Gtk.Box({spacing: 8});
        this._entry = new Gtk.Entry({hexpand: true, css_classes: ['balaur-ask'],
            input_hints: Gtk.InputHints.SPELLCHECK | Gtk.InputHints.UPPERCASE_SENTENCES});
        this._entry.connect('activate', () => this._submit());
        this._entry.connect('changed', () => this._syncSend());
        this._sendButton = new Gtk.Button({icon_name: 'go-up-symbolic', tooltip_text: 'Ask',
            css_classes: ['suggested-action', 'circular', 'balaur-touch-button'],
            valign: Gtk.Align.CENTER});
        this._sendButton.connect('clicked', () => this._submit());
        ask.append(this._entry);
        ask.append(this._sendButton);
        outer.append(ask);

        // Microphone switch and speaker volume, side by side.
        const controls = new Gtk.Box({spacing: 12});
        const micIcon = new Gtk.Image({icon_name: 'audio-input-microphone-symbolic'});
        const micLabel = new Gtk.Label({label: 'Microphone'});
        this._micSwitch = new Gtk.Switch({valign: Gtk.Align.CENTER,
            action_name: 'app.microphone', tooltip_text: 'Let the assistant hear the room'});
        micLabel.mnemonic_widget = this._micSwitch;
        controls.append(micIcon);
        controls.append(micLabel);
        controls.append(this._micSwitch);
        controls.append(new Gtk.Separator({orientation: Gtk.Orientation.VERTICAL,
            margin_start: 6, margin_end: 6}));

        this._volumeIcon = new Gtk.Image({icon_name: 'audio-volume-high-symbolic'});
        this._volume = new Gtk.Scale({
            hexpand: true,
            adjustment: new Gtk.Adjustment({lower: 0, upper: 100, step_increment: 5, page_increment: 10}),
            draw_value: false,
            tooltip_text: 'Assistant volume',
        });
        this._volume.update_property([Gtk.AccessibleProperty.LABEL], ['Assistant volume']);
        this._volumeValue = new Gtk.Label({width_chars: 4, xalign: 1, css_classes: ['numeric']});
        this._volume.connect('value-changed', () => this._volumeMoved());
        controls.append(this._volumeIcon);
        controls.append(this._volume);
        controls.append(this._volumeValue);
        outer.append(controls);

        return new Adw.Clamp({maximum_size: 900, child: outer});
    }

    // Text from the overview's search, ready to send or edit.
    prefill(text) {
        this._entry.text = text;
        this._entry.grab_focus();
        this._entry.set_position(-1);
    }

    _submit() {
        const text = this._entry.text.trim();
        if (!text)
            return;
        this._entry.text = '';
        this._stickToBottom = true;
        this._app.ask(text).then(ok => {
            // Give the question back so it can be retried without retyping.
            if (!ok && !this._entry.text)
                this._entry.text = text;
        });
    }

    _syncSend() {
        this._sendButton.sensitive = this._entry.text.trim() !== '' && this._assistant.available;
    }

    // Slider moved by the user: send it, a little debounced so dragging
    // doesn't flood the daemon, and ignore echoes from the daemon meanwhile.
    _volumeMoved() {
        const v = Math.round(this._volume.get_value());
        this._volumeValue.label = `${v}%`;
        this._volumeIcon.icon_name = volumeIcon(v);
        if (this._syncingVolume)
            return;
        if (this._volumeHold)
            GLib.source_remove(this._volumeHold);
        this._volumeHold = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 200, () => {
            this._volumeHold = 0;
            this._app.change_action_state('volume', new GLib.Variant('u', v));
            return GLib.SOURCE_REMOVE;
        });
    }

    _sync() {
        const a = this._assistant;
        if (!a.available)
            return;
        const state = a.muted && a.state === 'idle' ? 'muted' : a.state;

        this._banner.title = a.error;
        this._banner.revealed = a.error !== '';

        const thinking = state === 'thinking' || (a.asking && !BUSY.has(state));
        this._spinner.visible = thinking;
        this._stateIcon.visible = !thinking;
        this._stateIcon.icon_name = STATE_ICON[state] ?? STATE_ICON.idle;
        this._stateIcon.css_classes = state === 'ringing' ? ['error'] : BUSY.has(state) ? ['accent'] : ['dim-label'];
        if (state === 'muted')
            this._stateLabel.label = 'Microphone off · type below';
        else if (state === 'idle')
            this._stateLabel.label = a.asking ? 'Thinking…' : `Say “${a.wakePhrase}”`;
        else
            this._stateLabel.label = STATE_TEXT[state] ?? state;
        this._captionLabel.label = a.caption;
        this._captionLabel.visible = a.caption !== '';
        this._stopButton.visible = BUSY.has(state);

        this._entry.placeholder_text = `Ask ${a.name}…`;
        this._syncSend();

        if (!this._volumeHold) {
            this._syncingVolume = true;
            this._volume.set_value(a.volume);
            this._syncingVolume = false;
            this._volumeValue.label = `${a.volume}%`;
            this._volumeIcon.icon_name = volumeIcon(a.volume);
        }

        this._emptyLog.title = `Say “${a.wakePhrase}”`;
        this._emptyLog.description = `Or type a question below. ${escape(a.name)} answers out loud.`;
        this._renderLog(a.snapshot.log);
    }

    _renderLog(all) {
        const log = all.slice(-MAX_EXCHANGES);
        const last = log[log.length - 1];
        const key = `${log.length}|${last?.at}|${last?.reply}`;
        if (key === this._logKey)
            return;
        this._logKey = key;
        this._logStack.visible_child_name = log.length ? 'log' : 'empty';
        clearChildren(this._logBox);
        for (const x of log) {
            const when = formatWhen(parseTime(x.at));
            if (x.heard) {
                this._logBox.append(bubble(x.heard, 'you'));
                this._logBox.append(meta([when, x.typed ? 'typed' : 'spoken'].filter(Boolean).join(' · '),
                    Gtk.Align.END));
            }
            if (x.reply) {
                this._logBox.append(bubble(x.reply, 'bot'));
                if (!x.heard && when) // announcements (alarms) have no question
                    this._logBox.append(meta(when, Gtk.Align.START));
            }
        }
    }
});

function bubble(text, who) {
    const label = new Gtk.Label({
        label: text,
        wrap: true,
        wrap_mode: Pango.WrapMode.WORD_CHAR, // long URLs must wrap too
        xalign: 0,
        max_width_chars: 48,
    });
    const box = new Gtk.Box({
        halign: who === 'you' ? Gtk.Align.END : Gtk.Align.START,
        css_classes: ['balaur-bubble', who],
        margin_start: who === 'you' ? 48 : 0,
        margin_end: who === 'you' ? 0 : 48,
    });
    box.append(label);
    return box;
}

function meta(text, halign) {
    return new Gtk.Label({label: text, halign, css_classes: ['caption', 'dim-label'],
        margin_bottom: 6});
}

function volumeIcon(v) {
    if (v === 0)
        return 'audio-volume-muted-symbolic';
    if (v < 34)
        return 'audio-volume-low-symbolic';
    if (v < 67)
        return 'audio-volume-medium-symbolic';
    return 'audio-volume-high-symbolic';
}
