// Small helpers shared by every file: logging, cancellation scopes (the GJS
// stand-in for Go's context.Context), sleeping, and promisified Gio calls.

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

// One line per event on stderr; journald adds the timestamps (as log.SetFlags(0) did).
export function log(...parts) {
    printerr(parts.join(' '));
}

export function errText(e) {
    return e?.message ?? String(e);
}

export function isCancelledError(e) {
    return e instanceof GLib.Error && e.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED);
}

/**
 * A child cancellable: cancelled when the parent is, or when timeoutMs passes.
 * Like context.WithCancel / WithTimeout. Call release() when done so the
 * parent does not keep a reference and the timer goes away.
 */
export function scope(parent = null, timeoutMs = 0) {
    const cancellable = new Gio.Cancellable();
    let parentId = 0, timerId = 0, timedOut = false;
    if (parent) {
        if (parent.is_cancelled())
            cancellable.cancel();
        else
            parentId = parent.connect(() => cancellable.cancel());
    }
    if (timeoutMs > 0) {
        timerId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, timeoutMs, () => {
            timerId = 0;
            timedOut = true;
            cancellable.cancel();
            return GLib.SOURCE_REMOVE;
        });
    }
    return {
        cancellable,
        timedOut: () => timedOut,
        release() {
            if (parentId) {
                parent.disconnect(parentId);
                parentId = 0;
            }
            if (timerId) {
                GLib.source_remove(timerId);
                timerId = 0;
            }
        },
    };
}

/** Resolves after ms, or as soon as the cancellable fires (never rejects). */
export function sleep(ms, cancellable = null) {
    return new Promise(resolve => {
        let id = 0, cid = 0;
        const done = () => {
            if (id)
                GLib.source_remove(id);
            if (cid)
                cancellable.disconnect(cid);
            id = cid = 0;
            resolve();
        };
        if (cancellable?.is_cancelled()) {
            resolve();
            return;
        }
        id = GLib.timeout_add(GLib.PRIORITY_DEFAULT, ms, () => {
            id = 0;
            done();
            return GLib.SOURCE_REMOVE;
        });
        if (cancellable)
            cid = cancellable.connect(() => GLib.idle_add(GLib.PRIORITY_DEFAULT, () => {
                done();
                return GLib.SOURCE_REMOVE;
            }));
    });
}

/** Microseconds since the epoch (the clock everything here compares). */
export function nowUs() {
    return GLib.get_real_time();
}

/** A monotonic clock in milliseconds, for durations. */
export function monoMs() {
    return GLib.get_monotonic_time() / 1000;
}

// Promise versions of the async Gio calls used here.
Gio._promisify(Gio.InputStream.prototype, 'read_bytes_async');
Gio._promisify(Gio.OutputStream.prototype, 'write_bytes_async');
Gio._promisify(Gio.DataInputStream.prototype, 'read_line_async', 'read_line_finish');
Gio._promisify(Gio.SocketClient.prototype, 'connect_to_host_async');
Gio._promisify(Gio.Subprocess.prototype, 'communicate_utf8_async');
Gio._promisify(Gio.Subprocess.prototype, 'wait_async');

/** Writes all of u8 (write_bytes_async may write only part of it). */
export async function writeAll(stream, u8, cancellable = null) {
    let off = 0;
    while (off < u8.length) {
        // eslint-disable-next-line no-await-in-loop
        const n = await stream.write_bytes_async(new GLib.Bytes(u8.subarray(off)), GLib.PRIORITY_DEFAULT, cancellable);
        if (n <= 0)
            throw new Error('short write');
        off += n;
    }
}

/** Runs a command, returns its stdout; throws with its output on failure. */
export async function run(argv, cancellable = null) {
    const proc = Gio.Subprocess.new(argv, Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_MERGE);
    const [out] = await proc.communicate_utf8_async(null, cancellable);
    if (!proc.get_successful())
        throw new Error(`${argv[0]}: exit ${proc.get_exit_status()}: ${(out ?? '').trim()}`);
    return out ?? '';
}

export function concatBytes(chunks) {
    let n = 0;
    for (const c of chunks)
        n += c.length;
    const out = new Uint8Array(n);
    let off = 0;
    for (const c of chunks) {
        out.set(c, off);
        off += c.length;
    }
    return out;
}

// strings.Trim(s, cutset): drop any of the cutset characters from both ends.
export function trimChars(s, cutset) {
    const chars = [...s];
    let a = 0, b = chars.length;
    while (a < b && cutset.includes(chars[a]))
        a++;
    while (b > a && cutset.includes(chars[b - 1]))
        b--;
    return chars.slice(a, b).join('');
}

// truncate as in the Go code (by characters here, never mid-character).
export function truncate(s, n) {
    const c = [...s];
    return c.length <= n ? s : `${c.slice(0, n).join('')}…`;
}
