// Tests for the app's helpers that need no GTK (format.js) and for the daemon
// client's pure parts (assistant.js): `gjs -m tests/test-app.js`.
// Run by the package build (pkgs/balaur-app.nix).

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import System from 'system';

import {
    clockText, escape, formatCountdown, formatWhen, listTitle, parseTime, speechUrlProblem,
} from '../src/format.js';
import {humanError, normalize} from '../src/assistant.js';

let failed = 0;
function eq(actual, expected, what) {
    const a = JSON.stringify(actual), e = JSON.stringify(expected);
    if (a !== e) {
        failed++;
        print(`FAIL ${what}: got ${a}, want ${e}`);
    }
}

// escape: what AdwPreferencesGroup titles and the like would otherwise parse
eq(escape('B&B <i>x</i>'), 'B&amp;B &lt;i&gt;x&lt;/i&gt;', 'escape markup');
eq(escape(null), '', 'escape null');
eq(escape(undefined), '', 'escape undefined');
eq(escape('plain'), 'plain', 'escape plain');

// countdown
eq(formatCountdown(754), '12:34', 'countdown minutes');
eq(formatCountdown(3754), '1:02:34', 'countdown hours');
eq(formatCountdown(-5), '0:00', 'countdown past');
eq(formatCountdown(0.2), '0:01', 'countdown rounds up');

// list titles
eq(listTitle('shopping'), 'Shopping', 'known list');
eq(listTitle('todo'), 'To do', 'known list todo');
eq(listTitle('garden'), 'Garden', 'other list capitalised');
eq(listTitle('B&B'), 'B&B', 'list title is not escaped');

// times
eq(parseTime(''), null, 'no time');
eq(parseTime('not a time'), null, 'bad time');
eq(parseTime('2026-11-04T16:13:20.123456789+02:00')?.to_unix(), GLib.DateTime.new_utc(2026, 11, 4, 14, 13, 20).to_unix(),
    'nanoseconds and offset');

const at = (d, h, m) => GLib.DateTime.new_local(2026, 11, d, h, m, 0);
const now = at(10, 14, 5);
eq(clockText(at(10, 9, 5), true), '09:05', '24 h clock');
eq(clockText(at(10, 9, 5), false), '9:05 AM', '12 h clock morning');
eq(clockText(at(10, 21, 30), false), '9:30 PM', '12 h clock evening');
eq(clockText(at(10, 21, 30), true, true), '21:30:00', '24 h with seconds');
eq(clockText(at(10, 21, 30), false, true), '9:30:00 PM', '12 h with seconds');
eq(formatWhen(null, now, true), '', 'no when');
eq(formatWhen(at(10, 18, 0), now, true), '18:00', 'today');
eq(formatWhen(at(10, 18, 0), now, false), '6:00 PM', 'today, 12 h');
eq(formatWhen(at(10, 1, 0), now, true), '01:00', 'earlier today');
eq(formatWhen(at(11, 9, 0), now, true), 'Tomorrow 09:00', 'tomorrow');
eq(formatWhen(at(11, 9, 0), now, false), 'Tomorrow 9:00 AM', 'tomorrow, 12 h');
eq(formatWhen(at(9, 9, 0), now, true), 'Yesterday 09:00', 'yesterday');
eq(formatWhen(at(13, 9, 0), now, true), 'Fri 09:00', 'this week');
eq(formatWhen(at(20, 9, 0), now, true), '20 Nov 09:00', 'later');
eq(formatWhen(GLib.DateTime.new_local(2027, 1, 5, 9, 0, 0), now, true), '5 Jan 2027 09:00', 'next year');
// just after midnight is still "tomorrow", however few hours away
eq(formatWhen(at(11, 0, 30), at(10, 23, 50), true), 'Tomorrow 00:30', 'midnight');

// the speech server address: where the Mistral key goes
eq(speechUrlProblem(''), '', 'empty means the default');
eq(speechUrlProblem('   '), '', 'blank means the default');
eq(speechUrlProblem('https://api.mistral.ai/v1'), '', 'https');
eq(speechUrlProblem('  https://api.mistral.ai/v1  '), '', 'https, spaces around');
eq(speechUrlProblem('HTTPS://Example.org'), '', 'https, upper case');
eq(speechUrlProblem('https://speech.example.eu:8443/v1/'), '', 'https with port');
eq(speechUrlProblem('http://127.0.0.1:8000/v1'), '', 'http to loopback');
eq(speechUrlProblem('http://localhost/v1'), '', 'http to localhost');
eq(speechUrlProblem('http://[::1]:8000'), '', 'http to ::1');
eq(speechUrlProblem('http://example.org/v1') !== '', true, 'http elsewhere');
eq(speechUrlProblem('http://tablet:8000') !== '', true, 'http to a tailnet name');
eq(speechUrlProblem('http://localhost.evil.example/v1') !== '', true, 'localhost as a prefix');
eq(speechUrlProblem('http://127.0.0.1.evil.example/v1') !== '', true, '127.0.0.1 as a prefix');
eq(speechUrlProblem('http://localhost@evil.example/v1') !== '', true, 'localhost as the user name');
eq(speechUrlProblem('ftp://example.org') !== '', true, 'other scheme');
eq(speechUrlProblem('api.mistral.ai/v1') !== '', true, 'no scheme');
eq(speechUrlProblem('https://') !== '', true, 'no host');
eq(speechUrlProblem('https:///v1') !== '', true, 'empty host');
eq(speechUrlProblem('https://exa mple.org') !== '', true, 'space in the host');
eq(speechUrlProblem('http') !== '', true, 'half typed');

// the daemon's snapshot, which may be missing pieces
const empty = {log: [], timers: [], reminders: [], lists: {}, listOrder: [], memories: []};
eq(normalize(null), empty, 'normalize null');
eq(normalize('nope'), empty, 'normalize a string');
eq(normalize({}), empty, 'normalize {}');
eq(normalize({log: null, timers: null, lists: null, listOrder: null}), empty, 'normalize nulls (Go empty slices)');
eq(normalize({lists: {a: [{id: '1'}]}, listOrder: ['a']}).lists, {a: [{id: '1'}]}, 'normalize keeps lists');
eq(normalize({lists: {a: [], b: null}, listOrder: ['b']}).listOrder, ['b', 'a'], 'normalize adds unordered lists');
eq(normalize({lists: {b: null}, listOrder: ['b', 'ghost']}).lists, {b: [], ghost: []}, 'normalize fills missing lists');
eq(normalize({memories: [{id: 'm', fact: 'x'}]}).memories, [{id: 'm', fact: 'x'}], 'normalize keeps memories');

// D-Bus errors, as the daemon's human text
const dbus = (name, text) => Gio.DBusError.new_for_dbus_error(name, text);
eq(humanError(dbus('org.balaur.Assistant.Error.Failed', "Mistral didn't answer")).message, "Mistral didn't answer",
    'remote error text only');
eq(humanError(dbus('org.freedesktop.DBus.Error.ServiceUnknown', 'x')).message, "The assistant isn't running",
    'daemon away (service unknown)');
eq(humanError(dbus('org.freedesktop.DBus.Error.NameHasNoOwner', 'x')).message, "The assistant isn't running",
    'daemon away (no owner)');
eq(humanError(new GLib.Error(GLib.quark_from_string('x'), 1, 'plain')).message, 'plain', 'other GLib error');
const own = new Error('mine');
eq(humanError(own) === own, true, 'JS errors pass through');

if (failed) {
    print(`${failed} failed`);
    System.exit(1);
}
print('all passed');
