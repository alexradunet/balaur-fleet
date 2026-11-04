// Countdown timers, in memory: a restart drops them (as in the Go code).

import GLib from 'gi://GLib';

import {fold} from './lang.js';
import {localTime, rfc3339, sorted} from './gojson.js';
import {newID} from './store.js';
import {nowUs} from './util.js';

export class Timers {
    /** fire(timer) is called when one ends; it is already removed then. */
    constructor(fire) {
        this.all = new Map();
        this.fire = fire;
    }

    add(ms, label, lang) {
        const t = {id: newID(), label, ends: nowUs() + ms * 1000, lang, source: 0};
        t.source = GLib.timeout_add(GLib.PRIORITY_DEFAULT, ms, () => {
            t.source = 0;
            this.all.delete(t.id);
            this.fire(t);
            return GLib.SOURCE_REMOVE;
        });
        this.all.set(t.id, t);
        return t;
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
                if (t.source)
                    GLib.source_remove(t.source);
                this.all.delete(k);
                n++;
            }
        }
        return n;
    }
}
