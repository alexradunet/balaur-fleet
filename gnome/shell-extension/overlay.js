// The assistant overlay: a big animated orb with the caption under it,
// shown over everything on the primary monitor while the assistant listens,
// thinks, speaks or rings. Tapping the card calls Stop().
//
// Cheap on the GPU by construction: the orb, halo and orbiting dots are
// plain St widgets whose look (gradients, glow) St renders once into cached
// textures; the motion is Clutter transitions on scale/opacity/rotation,
// which run on the compositor's frame clock in C. No JS runs per frame.
//
// Never in the way: the full-screen dim layer is not reactive, so taps on it
// fall through to the windows below, and nothing here can take key focus.
// Only the centred card receives input.

import Clutter from 'gi://Clutter';
import Graphene from 'gi://Graphene';
import Pango from 'gi://Pango';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import {ACTIVE_STATES, overlayTitle, trimCaption} from './assistant.js';

const FADE_MS = 220;

// Per-state motion. breathe: orb scale target (auto-reversing loop);
// halo: period of the ring that swells out of the orb (0 = none);
// spin: period of the orbiting dots (0 = none).
const MOTION = {
    listening: {breathe: 1.08, breatheMs: 1100, haloMs: 1800, spinMs: 0},
    thinking: {breathe: 0.94, breatheMs: 800, haloMs: 0, spinMs: 1300},
    speaking: {breathe: 1.14, breatheMs: 380, haloMs: 1100, spinMs: 0},
    ringing: {breathe: 1.18, breatheMs: 260, haloMs: 700, spinMs: 0},
};

export class AssistantOverlay {
    /** @param {() => void} onStop called when the card is tapped */
    constructor(onStop) {
        this._state = 'idle';
        this._shown = false;

        // Full-monitor dim layer; also the chrome root. Not reactive.
        this._root = new St.Widget({
            name: 'balaurAssistantOverlay',
            style_class: 'balaur-overlay',
            reactive: false,
            visible: false,
            opacity: 0,
            layout_manager: new Clutter.BinLayout(),
        });

        // The card: the only reactive part. A St.Button handles both mouse
        // clicks and touch taps; can_focus stays false so it never takes
        // keyboard focus from the app underneath.
        this._card = new St.Button({
            style_class: 'balaur-card',
            can_focus: false,
            reactive: true,
            x_align: Clutter.ActorAlign.CENTER,
            y_align: Clutter.ActorAlign.CENTER,
            pivot_point: new Graphene.Point({x: 0.5, y: 0.5}),
        });
        this._card.connect('clicked', () => onStop());
        this._root.add_child(this._card);

        const box = new St.BoxLayout({
            style_class: 'balaur-card-box',
            orientation: Clutter.Orientation.VERTICAL,
            x_expand: true,
        });
        this._card.set_child(box);

        // Orb stage: halo, dots and orb stacked and centred. Sizes live in
        // the stylesheet so St applies the monitor scale for us.
        const stage = new St.Widget({
            style_class: 'balaur-orb-stage',
            layout_manager: new Clutter.BinLayout(),
            x_align: Clutter.ActorAlign.CENTER,
        });
        box.add_child(stage);

        const centred = {
            x_align: Clutter.ActorAlign.CENTER,
            y_align: Clutter.ActorAlign.CENTER,
            pivot_point: new Graphene.Point({x: 0.5, y: 0.5}),
        };
        this._halo = new St.Widget({style_class: 'balaur-orb-halo', ...centred});
        this._spinner = new St.Widget({
            style_class: 'balaur-orb-spinner',
            layout_manager: new Clutter.BinLayout(),
            ...centred,
        });
        for (const [x, y, cls] of [
            [Clutter.ActorAlign.CENTER, Clutter.ActorAlign.START, 'balaur-dot'],
            [Clutter.ActorAlign.CENTER, Clutter.ActorAlign.END, 'balaur-dot small'],
        ]) {
            this._spinner.add_child(new St.Widget({
                // BinLayout only honours x/y_align on expanding children.
                style_class: cls, x_align: x, y_align: y, x_expand: true, y_expand: true,
            }));
        }
        this._orb = new St.Widget({style_class: 'balaur-orb', ...centred});
        stage.add_child(this._halo);
        stage.add_child(this._spinner);
        stage.add_child(this._orb);

        this._title = new St.Label({
            style_class: 'balaur-title',
            x_align: Clutter.ActorAlign.CENTER,
        });
        this._caption = new St.Label({
            style_class: 'balaur-caption',
            x_align: Clutter.ActorAlign.CENTER,
            x_expand: true,
        });
        const ct = this._caption.clutter_text;
        ct.line_wrap = true;
        ct.line_wrap_mode = Pango.WrapMode.WORD_CHAR;
        ct.ellipsize = Pango.EllipsizeMode.NONE;
        ct.line_alignment = Pango.Alignment.CENTER;
        this._hint = new St.Label({
            style_class: 'balaur-hint',
            text: 'Tap to stop',
            x_align: Clutter.ActorAlign.CENTER,
        });
        box.add_child(this._title);
        box.add_child(this._caption);
        box.add_child(this._hint);

        // Top chrome: above every window, popup and fullscreen app (an alarm
        // must be seen over a film). GNOME 50 is Wayland-only, so input
        // routing is just Clutter picking: only reactive actors (the card)
        // catch events, everything else falls through to what is below.
        Main.layoutManager.addTopChrome(this._root, {trackFullscreen: false});

        this._monitorsId = Main.layoutManager.connect('monitors-changed',
            () => this._place());
        this._place();

        // If the Shell tears the stage down without disabling us (shutdown),
        // later D-Bus updates must not touch disposed actors.
        this._root.connect('destroy', () => {
            this._root = this._card = this._orb = this._halo = this._spinner = null;
        });
    }

    destroy() {
        Main.layoutManager.disconnect(this._monitorsId);
        this._stopMotion();
        // Destroying a chrome actor removes it from uiGroup and untracks it.
        this._root?.destroy();
    }

    /** Follow a status snapshot from AssistantClient. */
    sync(status) {
        if (!this._root)
            return;
        const state = status.running ? status.state : 'idle';
        if (!ACTIVE_STATES.includes(state)) {
            this._hide();
            return;
        }

        this._title.text = overlayTitle(state);
        const caption = trimCaption(status.caption);
        this._caption.text = caption;
        this._caption.visible = caption !== '';
        this._caption.style_class = caption.length > 120 ? 'balaur-caption long' : 'balaur-caption';
        this._fitCaption();

        if (state !== this._state) {
            this._state = state;
            this._orb.style_class = `balaur-orb ${state}`;
            this._halo.style_class = `balaur-orb-halo ${state}`;
            this._startMotion(state);
        }
        this._show();
    }

    // Cover the primary monitor (it moves with rotation and hotplug).
    _place() {
        const m = Main.layoutManager.primaryMonitor;
        if (!m)
            return;
        this._root.set_position(m.x, m.y);
        this._root.set_size(m.width, m.height);
        this._captionMax = Math.round(m.width * 0.75);
        this._fitCaption();
    }

    // Short captions keep the card snug; long ones wrap at 3/4 of the
    // monitor width.
    _fitCaption() {
        this._caption.width = -1;
        const [, natural] = this._caption.get_preferred_width(-1);
        if (natural > this._captionMax)
            this._caption.width = this._captionMax;
    }

    _show() {
        if (this._shown)
            return;
        this._shown = true;
        this._root.remove_all_transitions();
        this._card.remove_all_transitions();
        this._root.show();
        this._card.set_scale(0.92, 0.92);
        this._root.ease({
            opacity: 255,
            duration: FADE_MS,
            mode: Clutter.AnimationMode.EASE_OUT_QUAD,
        });
        this._card.ease({
            scale_x: 1,
            scale_y: 1,
            duration: FADE_MS,
            mode: Clutter.AnimationMode.EASE_OUT_BACK,
        });
    }

    _hide() {
        if (!this._shown)
            return;
        this._shown = false;
        this._state = 'idle';
        this._root.remove_all_transitions();
        this._root.ease({
            opacity: 0,
            duration: FADE_MS,
            mode: Clutter.AnimationMode.EASE_IN_QUAD,
            onStopped: isFinished => {
                // Interrupted by a new _show(): leave it visible.
                if (!isFinished || this._shown || !this._root)
                    return;
                this._root.hide();
                this._stopMotion();
            },
        });
    }

    _startMotion(state) {
        this._stopMotion();
        const m = MOTION[state];

        // Orb breathing: scale up and back, forever.
        this._orb.ease({
            scale_x: m.breathe,
            scale_y: m.breathe,
            duration: m.breatheMs,
            mode: Clutter.AnimationMode.EASE_IN_OUT_SINE,
            repeatCount: -1,
            autoReverse: true,
        });

        // Halo: a ring that swells out of the orb and fades, forever.
        this._halo.visible = m.haloMs > 0;
        if (m.haloMs > 0) {
            this._halo.set_scale(0.85, 0.85);
            this._halo.opacity = 230;
            this._halo.ease({
                scale_x: 1.6,
                scale_y: 1.6,
                opacity: 0,
                duration: m.haloMs,
                mode: Clutter.AnimationMode.EASE_OUT_QUAD,
                repeatCount: -1,
            });
        }

        // Thinking: two dots circling the orb.
        this._spinner.visible = m.spinMs > 0;
        if (m.spinMs > 0) {
            this._spinner.rotation_angle_z = 0;
            this._spinner.ease({
                rotation_angle_z: 360,
                duration: m.spinMs,
                mode: Clutter.AnimationMode.LINEAR,
                repeatCount: -1,
            });
        }
    }

    // Remove the endless transitions so nothing animates while hidden.
    _stopMotion() {
        for (const a of [this._orb, this._halo, this._spinner]) {
            if (!a)
                continue;
            a.remove_all_transitions();
            a.set_scale(1, 1);
            a.rotation_angle_z = 0;
        }
    }
}
