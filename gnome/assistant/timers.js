// Countdown timers. Each ends at a wall-clock time, kept in the state directory
// (timers.json) so a restart does not lose it, and checked against the clock
// rather than waited for with one long timeout: GLib's timeouts do not advance
// while the machine is suspended, a laptop's 10-minute timer would ring late.

import GLib from 'gi://GLib';

import {fold} from './lang.js';
import {localTime, rfc3339, sorted} from './gojson.js';
import {newID} from './store.js';
import {errText, log, nowUs} from './util.js';

const FILE = 'timers.json';
// The longest wait between two looks at the clock: after a suspend a timer is at most this late.
const MAX_WAIT_MS = 5000;

export class Timers {
    /**
     * fire(timer) is called when one ends; it is already removed then.
     * state: {readState(name), writeState(name, value)} (the Store), or null to keep timers in memory only.
     */
    constructor(fire, state = null, {maxWaitMs = MAX_WAIT_MS} = {}) {
        this.all = new Map();
        this.fire = fire;
        this.state = state;
        this.maxWaitMs = maxWaitMs;
        this.source = 0;
    }

    /** Takes back the timers of the last run; those that ended meanwhile ring at once, once. */
    start() {
        let saved;
        try {
            saved = this.state?.readState(FILE);
        } catch (e) {
            log(`timers: cannot read ${FILE} (${errText(e)}); starting without them`);
        }
        for (const t of Array.isArray(saved) ? saved : []) {
            if (typeof t?.id === 'string' && typeof t.label === 'string' && Number.isFinite(t.ends))
                this.all.set(t.id, {id: t.id, label: t.label, ends: t.ends, lang: typeof t.lang === 'string' ? t.lang : ''});
        }
        this._arm();
    }

    stop() {
        if (this.source)
            GLib.source_remove(this.source);
        this.source = 0;
    }

    add(ms, label, lang) {
        const t = {id: newID(), label, ends: nowUs() + ms * 1000, lang};
        this.all.set(t.id, t);
        this._save();
        this._arm();
        return t;
    }

    _save() {
        try {
            this.state?.writeState(FILE, [...this.all.values()].map(({id, label, ends, lang}) => ({id, label, ends, lang})));
        } catch (e) {
            log(`timers: cannot save ${FILE} (${errText(e)}); they stop at a restart`);
        }
    }

    // One look at the clock when the next timer is due, or after maxWaitMs if that is later.
    _arm() {
        this.stop();
        if (this.all.size === 0)
            return;
        const next = Math.min(...[...this.all.values()].map(t => t.ends));
        const wait = Math.max(0, Math.min(this.maxWaitMs, Math.ceil((next - nowUs()) / 1000)));
        this.source = GLib.timeout_add(GLib.PRIORITY_DEFAULT, wait, () => {
            this.source = 0;
            this._tick();
            return GLib.SOURCE_REMOVE;
        });
    }

    _tick() {
        const now = nowUs();
        const due = [...this.all.values()].filter(t => t.ends <= now).sort((a, b) => a.ends - b.ends);
        for (const t of due)
            this.all.delete(t.id);
        if (due.length > 0)
            this._save();
        this._arm();
        for (const t of due) {
            try {
                this.fire(t);
            } catch (e) {
                log(`timers: ringing ${t.id}: ${errText(e)}`);
            }
        }
    }

    /** Running timers, soonest first, as the Go list(): a map per timer (keys sorted when marshalled). */
    list() {
        const now = nowUs();
        return [...this.all.values()].sort((a, b) => a.ends - b.ends).map(t => sorted({
            id: t.id,
            label: t.label,
            ends: rfc3339(localTime(t.ends)),
            remaining_seconds: Math.round((t.ends - now) / 1e6),
        }));
    }

    /** Cancels by id, by label (accents and case ignored), or all; returns how many. */
    cancel(id, label, all) {
        let n = 0;
        for (const [k, t] of this.all) {
            if (all || (id && t.id === id) || (label && fold(t.label) === fold(label))) {
                this.all.delete(k);
                n++;
            }
        }
        if (n > 0) {
            this._save();
            this._arm();
        }
        return n;
    }
}
