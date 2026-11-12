// Tests for the app's helpers that need no GTK (format.js) and for the daemon
// client's pure parts (assistant.js) and the overview's search (search.js): `gjs -m tests/test-app.js`.
// Run by the package build (pkgs/balaur-app.nix).

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import System from 'system';

import {
    clockText, escape, formatCountdown, formatWhen, listTitle, parseTime, speechUrlProblem,
} from '../src/format.js';
import {humanError, normalize} from '../src/assistant.js';
import {fold, isQuestion, matches, parseId, resultIds, search, searchItems} from '../src/search.js';
import {ROLE_TEXT, canOpen, countFor, faceText, loginText, openable} from '../src/access.js';

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


// the overview's search (search.js)
eq(fold('Pâine Ședință'), 'paine sedinta', 'fold diacritics');
eq(matches(['mil'], 'oat milk'), true, 'word prefix');
eq(matches(['ilk'], 'oat milk'), false, 'not mid-word');
eq(matches(['paine'], 'Pâine neagră'), true, 'without diacritics');
eq(matches(['oat', 'MILK'], 'oat milk'), true, 'every term, any case');
eq(matches(['oat', 'bread'], 'oat milk'), false, 'a term missing');
eq(isQuestion(['when', 'is']), false, 'two words are a lookup');
eq(isQuestion(['when', 'is', 'sunset']), true, 'three words are a question');

const snap = normalize({
    lists: {shopping: [{id: 'a', text: 'Oat milk', done: false}, {id: 'b', text: 'Pâine', done: true}]},
    listOrder: ['shopping'],
    memories: [{id: 'm1', fact: 'The wifi password is on the fridge'}],
    timers: [{id: 't1', label: 'pasta', ends: '2026-11-10T14:30:00+00:00'}],
    reminders: [{id: 'r1', text: 'Call the plumber', at: '2026-11-11T09:00:00+00:00'}],
});
const svc = [
    {name: 'Jellyfin', description: 'Films & series', icon: '🎬', desktopId: 'org.jellyfin.JellyfinDesktop.desktop', group: 'Media'},
    {name: 'Torrents', description: 'Downloads', icon: 'folder-download-symbolic', host: 'pc'},
    {name: 'Milkman', description: 'A service starting like milk'},
];
const items = searchItems(snap, svc, GLib.DateTime.new_utc(2026, 11, 10, 12, 0, 0).to_local());
eq(items.map(i => i.id), ['service:Jellyfin', 'service:Torrents', 'service:Milkman', 'list:shopping:a', 'list:shopping:b',
    'memory:m1', 'timer:t1', 'reminder:r1'], 'every item, in order');
eq(items[0].icon, null, 'an emoji is not an icon');
eq(items[1].icon, 'folder-download-symbolic', 'an icon name is');
eq(items[1].description, 'Downloads · On pc', 'another machine says so');
eq(items[4].description, 'Shopping list · done', 'a done item says so');
eq(search(items, ['milk']).map(i => i.id), ['service:Milkman', 'list:shopping:a'], 'name prefix first');
eq(search(items, ['shopping']).map(i => i.id), ['list:shopping:a', 'list:shopping:b'], 'by list name');
eq(search(items, ['paine']).map(i => i.id), ['list:shopping:b'], 'diacritics');
eq(search(items, ['media']).map(i => i.id), ['service:Jellyfin'], 'by group');
eq(search(items, ['timer']).map(i => i.id), ['timer:t1'], 'timers by the word');
eq(search(items, ['plumber']).map(i => i.id), ['reminder:r1'], 'reminders');
eq(search(items, ['wifi']).map(i => i.id), ['memory:m1'], 'memories');
eq(resultIds(items, ['when', 'is', 'sunset'], true), ['ask:when is sunset'], 'a question asks');
eq(resultIds(items, ['when', 'is', 'sunset'], false), [], 'not while the assistant is away');
eq(resultIds(items, ['milk'], true), ['service:Milkman', 'list:shopping:a'], 'a lookup does not ask');
eq(parseId('list:shopping:a:b'), {kind: 'list', key: 'shopping:a:b'}, 'parse id keeps the rest');
eq(parseId('ask:what: now'), {kind: 'ask', key: 'what: now'}, 'parse ask');

// who opens what (access.js): the People page
const alex = {name: 'Alex', role: 'owner'}, partner = {name: 'Ana', role: 'household'},
    screen = {name: 'Balaur', role: 'screen'};
const page = {name: 'Notes', url: 'http://127.0.0.1:5230', shared: true, login: true};
const mine = {name: 'Journal', url: 'http://127.0.0.1:7780', shared: false, login: true};
const open = {name: 'Ads', url: 'http://127.0.0.1:3000', shared: false};
const noPage = {name: 'Tailscale', url: null, shared: true};
eq(openable([page, noPage, null, mine]).map(s => s.name), ['Notes', 'Journal'], 'only what has a page');
eq([alex, partner, screen].map(p => canOpen(p, page)), [true, true, true], 'a shared service: everyone');
eq([alex, partner, screen].map(p => canOpen(p, mine)), [true, false, true], 'an owner service: not the household');
eq([alex, partner, screen].map(p => canOpen(p, open)), [true, false, true], 'shared missing means not shared');
eq([alex, partner, screen].map(p => canOpen(p, noPage)), [false, false, false], 'no page, nobody');
eq(canOpen({name: 'X', role: 'admin'}, page), false, 'an unknown role opens nothing');
eq(canOpen(null, page), false, 'nobody opens nothing');
eq(canOpen(partner, {...page, shared: 'yes'}), false, 'shared must be true itself');
eq([alex, partner, screen].map(p => countFor(p, [page, mine, open])), [3, 1, 3], 'how many each opens');
eq([loginText(page), loginText(open)], ['Asks for its own login', 'No login'], 'login text');
eq(Object.keys(ROLE_TEXT), ['owner', 'household', 'screen'], 'a text for every role');
const andreea = {name: 'Andreea', role: 'household'};
eq([alex, andreea, screen].map(p => faceText(p, [alex, andreea, screen])), ['A l', 'A n', 'Balaur'],
    'the same first letter: two letters each');
eq(faceText(alex, [alex, screen]), 'Alex', 'no clash, the name as it is');
eq(faceText({name: 'Ana Pop'}, [{name: 'alex'}]), 'Ana Pop', 'two words already tell apart');
eq(faceText({name: 'A'}, [{name: 'Al'}]), 'A', 'one letter has no second');

if (failed) {
    print(`${failed} failed`);
    System.exit(1);
}
print('all passed');
