// HTTP through libsoup 3, with a total deadline per request (Go's
// http.Client.Timeout / context.WithTimeout) on top of the caller's cancellation.

import GLib from 'gi://GLib';
import Soup from 'gi://Soup?version=3.0';
import Gio from 'gi://Gio';

import {isCancelledError, scope} from './util.js';

Gio._promisify(Soup.Session.prototype, 'send_and_read_async');

let session = null;
function getSession() {
    session ??= new Soup.Session({timeout: 0, idle_timeout: 60});
    return session;
}

/** Thrown when the caller cancelled (Stop, the wake word): not an error to report. */
export class Cancelled extends Error {
    constructor() {
        super('cancelled');
        this.name = 'Cancelled';
    }
}

/**
 * Sends a request and reads the whole response.
 * opts: {method, url, headers: {}, body: Uint8Array|string, contentType, message (a prepared Soup.Message)}
 * Returns {status, statusText ("401 Unauthorized"), contentType, body: Uint8Array}.
 */
export async function request(opts, cancellable = null, timeoutMs = 60000) {
    const method = opts.method ?? 'GET';
    let msg = opts.message;
    if (!msg) {
        msg = Soup.Message.new(method, opts.url);
        if (!msg)
            throw new Error(`bad URL: ${opts.url}`);
        if (opts.body !== undefined) {
            const b = typeof opts.body === 'string' ? new TextEncoder().encode(opts.body) : opts.body;
            msg.set_request_body_from_bytes(opts.contentType ?? 'application/octet-stream', new GLib.Bytes(b));
        }
    }
    const h = msg.get_request_headers();
    for (const [k, v] of Object.entries(opts.headers ?? {}))
        h.replace(k, v);

    const sc = scope(cancellable, timeoutMs);
    try {
        const bytes = await getSession().send_and_read_async(msg, GLib.PRIORITY_DEFAULT, sc.cancellable);
        const status = msg.get_status();
        return {
            status,
            statusText: `${status} ${msg.get_reason_phrase() ?? ''}`.trim(),
            contentType: msg.get_response_headers().get_one('Content-Type') ?? '',
            body: bytes?.toArray() ?? new Uint8Array(0),
        };
    } catch (e) {
        if (sc.timedOut())
            throw new Error(`${method} ${msg.get_uri().get_path()}: timed out after ${timeoutMs / 1000}s`);
        if (isCancelledError(e))
            throw new Cancelled();
        throw e;
    } finally {
        sc.release();
    }
}

export function bodyText(res) {
    return new TextDecoder().decode(res.body);
}
