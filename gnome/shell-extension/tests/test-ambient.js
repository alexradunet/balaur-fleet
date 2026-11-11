// Tests for ambient-data.js, ambient-status.js's helpers, house.js and assistant.js's text helpers (no Shell, no network): `gjs -m tests/test-ambient.js`.
// Run by the package build (pkgs/balaur-shell-extension.nix).

import GLib from 'gi://GLib';
import System from 'system';

import {
    JellyfinPhotos, clockText, countdown, coverRect, decodeSize, describeWeather, isPhotoName,
    listPhotos, loadConfig, nextReminder, parseWeather, readSecret, refreshDue, shuffled, timersOf,
    weatherLine, weatherUrl, whenText,
} from '../ambient-data.js';
import {wakePhrase} from '../assistant.js';
import {machinesOf, seenText, servicesOf, systemText, unitKind} from '../ambient-status.js';
import {actionsOf, callOf, iconOf, loadHouse} from '../house.js';

let failed = 0;
function eq(actual, expected, what) {
    const a = JSON.stringify(actual), e = JSON.stringify(expected);
    if (a !== e) {
        failed++;
        print(`FAIL ${what}: got ${a}, want ${e}`);
    }
}

const tmp = GLib.dir_make_tmp('ambient-XXXXXX');
const write = (name, text) => {
    const p = `${tmp}/${name}`;
    GLib.file_set_contents(p, text);
    return p;
};

// config
eq(loadConfig(`${tmp}/missing.json`), {idleSeconds: 60, location: null, photos: null, status: null}, 'missing config = defaults');
eq(loadConfig(write('a.json', '{"idleSeconds": 90, "photos": {"server": "http://x"}}')).idleSeconds, 90, 'config overrides');
eq(loadConfig(write('b.json', '{nope')).idleSeconds, 60, 'broken config = defaults');
eq(readSecret(write('key', 'abc123\n')), 'abc123', 'secret first line');
eq(readSecret(`${tmp}/nokey`), '', 'missing secret');

// weather
eq(describeWeather(0, true), ['Clear', 'weather-clear-symbolic'], 'clear day');
eq(describeWeather(2, false), ['Partly cloudy', 'weather-few-clouds-night-symbolic'], 'cloudy night');
eq(describeWeather(3, false), ['Overcast', 'weather-overcast-symbolic'], 'no night variant for overcast');
eq(describeWeather(63, true)[1], 'weather-showers-symbolic', 'rain');
eq(describeWeather(1234, true)[0], '', 'unknown code');
eq(weatherUrl({latitude: 44.4268, longitude: 26.1025}).includes('latitude=44.4268&longitude=26.1025'), true, 'weather url');
const w = parseWeather({
    current: {temperature_2m: 11.6, weather_code: 3, is_day: 1},
    daily: {temperature_2m_max: [15.2], temperature_2m_min: [5.5], precipitation_probability_max: [40]},
});
eq(w, {temp: 12, words: 'Overcast', icon: 'weather-overcast-symbolic', high: 15, low: 6, rain: 40}, 'parse weather');
eq(weatherLine(w), 'Overcast · 15° / 6° · rain 40%', 'weather line');
eq(weatherLine({...w, rain: 5}), 'Overcast · 15° / 6°', 'low rain chance left out');
eq(parseWeather({error: true}), null, 'unusable weather');

// photos
eq(JellyfinPhotos.imageUrl('http://127.0.0.1:8096', 'ab/c', 2560, 1600),
    'http://127.0.0.1:8096/Items/ab%2Fc/Images/Primary?fillWidth=2560&fillHeight=1600&quality=85', 'image url');
eq(coverRect(4000, 3000, 1280, 800), {x: 0, y: -80, width: 1280, height: 960}, 'cover: 4:3 photo on 16:10');
eq(coverRect(1000, 2000, 1280, 800), {x: 0, y: -880, width: 1280, height: 2560}, 'cover: portrait photo');
eq(coverRect(1600, 1000, 800, 1280), {x: -624, y: 0, width: 2048, height: 1280}, 'cover: rotated screen');

// when a refresh is due: slower to retry while there is nothing to show, never once per tick
eq(refreshDue(0, 5e6, false, 30, 60), true, 'refresh: never tried');
eq(refreshDue(1e6, 30e6, false, 30, 60), false, 'refresh: no value yet waits the retry time, not the interval');
eq(refreshDue(1e6, 61e6, false, 30, 60), true, 'refresh: no value, retry time over');
eq(refreshDue(1e6, 29e6, true, 30, 60), false, 'refresh: value, interval not over');
eq(refreshDue(1e6, 31e6, true, 30, 60), true, 'refresh: value, interval over');

// wake word (the daemon publishes a comma-separated list, with model versions)
eq(wakePhrase({wakeWord: 'hey_jarvis', name: 'Jarvis'}), 'Hey Jarvis', 'wake phrase');
eq(wakePhrase({wakeWord: 'hey_jarvis_v0.1', name: 'Jarvis'}), 'Hey Jarvis', 'wake phrase: version dropped');
eq(wakePhrase({wakeWord: 'hey_jarvis_v0.1, alexa', name: 'Jarvis'}), 'Hey Jarvis', 'wake phrase: first of a list');
eq(wakePhrase({wakeWord: '', name: 'Jarvis'}), 'Hey Jarvis', 'wake phrase: from the name');
eq(wakePhrase({wakeWord: '', name: ''}), 'the wake word', 'wake phrase: nothing known');

// timers and reminders
eq(countdown(0), '0:00', 'countdown zero');
eq(countdown(-5), '0:00', 'countdown negative');
eq(countdown(245.2), '4:06', 'countdown rounds up');
eq(countdown(3723), '1:02:03', 'countdown hours');
const snap = {
    timers: [
        {id: 't2', label: 'oven', ends: '2026-11-04T16:40:00+02:00'},
        {id: 't1', label: '', ends: '2026-11-04T16:30:00+02:00'},
        {id: 't3', label: 'bad', ends: 'nope'},
    ],
    reminders: [
        {id: 'r1', text: 'past', at: '2026-11-04T10:00:00+02:00'},
        {id: 'r3', text: 'later', at: '2026-11-06T09:00:00+02:00'},
        {id: 'r2', text: 'call mom', at: '2026-11-04T18:00:00+02:00'},
    ],
};
eq(timersOf(snap).map(t => [t.id, t.label]), [['t1', 'Timer'], ['t2', 'oven']], 'timers sorted, unnamed, bad dropped');
eq(timersOf(null), [], 'no snapshot, no timers');
const nowMs = Date.parse('2026-11-04T16:00:00+02:00');
eq(nextReminder(snap, nowMs)?.text, 'call mom', 'next reminder');
eq(nextReminder({reminders: [{text: 'x', at: '2026-11-04T10:00:00+02:00'}]}, nowMs), null, 'only past reminders');

// clock text (in a fixed zone, so the test doesn't depend on the machine's)
const tz = GLib.TimeZone.new_identifier('Europe/Bucharest');
const at = GLib.DateTime.new(tz, 2026, 11, 4, 14, 5, 0);
eq(clockText(at, true), '14:05', '24h clock');
eq(clockText(at, false).replace(/\s+/g, ' ').trim(), '2:05 PM', '12h clock');
GLib.setenv('TZ', 'Europe/Bucharest', true);
const now = GLib.DateTime.new_local(2026, 11, 4, 16, 0, 0);
const ms = (d, h) => GLib.DateTime.new_local(2026, 11, d, h, 0, 0).to_unix() * 1000;
eq(whenText(ms(4, 18), now, true), '18:00', 'today');
eq(whenText(ms(5, 9), now, true), 'Tomorrow 09:00', 'tomorrow');
eq(whenText(ms(20, 9), now, true).endsWith('Nov 09:00'), true, 'far away');


// photos from a folder
eq(['a.JPG', 'b.jpeg', 'c.png', 'd.webp', 'e.heic', '.f.jpg', 'notes.txt'].filter(isPhotoName),
    ['a.JPG', 'b.jpeg', 'c.png', 'd.webp'], 'photo names: images, no hidden files');
eq(shuffled([1, 2, 3, 4], () => 0), [2, 3, 4, 1], 'shuffle is a permutation');
eq(shuffled([1, 2, 3, 4]).sort(), [1, 2, 3, 4], 'shuffle keeps everything');
eq(decodeSize(8160, 6120, 2160, 1350), {width: 2880, height: 2160}, 'decode: 50 MP covers the screen either way');
eq(decodeSize(800, 600, 2160, 1350), {width: 800, height: 600}, 'decode: never upscaled');
GLib.mkdir_with_parents(`${tmp}/photos/2026/.stversions`, 0o755);
write('photos/a.jpg', '');
write('photos/2026/b.png', '');
write('photos/2026/.stversions/old.jpg', '');
write('photos/.syncthing.c.jpg.tmp', '');
write('photos/readme.txt', '');
const loop = GLib.MainLoop.new(null, false);
let listed = null, missing = null;
Promise.all([listPhotos(`${tmp}/photos`), listPhotos(`${tmp}/nope`)])
    .then(([a, b]) => {
        listed = a.map(p => p.slice(tmp.length)).sort();
        missing = b;
    })
    .catch(e => print(`FAIL listPhotos: ${e.message}`))
    .finally(() => loop.quit());
loop.run();
eq(listed, ['/photos/2026/b.png', '/photos/a.jpg'], 'list photos: recursive, skips Syncthing files');
eq(missing, [], 'list photos: missing folder');

// machines and services (ambient-status.js)
const ts = {
    Self: {HostName: 'tablet', DNSName: 'tablet.x.ts.net.', Online: true},
    Peer: {
        k1: {HostName: 'Cico S25', DNSName: 'phone.x.ts.net.', Online: false, LastSeen: '2026-11-09T21:00:00Z'},
        k2: {HostName: 'balaur', DNSName: 'netcup.x.ts.net.', Online: true, LastSeen: '0001-01-01T00:00:00Z'},
        k3: {HostName: 'laptop', DNSName: '', Online: false, LastSeen: '0001-01-01T00:00:00Z'},
    },
};
eq(machinesOf(ts).map(m => [m.name, m.online, m.self]),
    [['tablet', true, true], ['laptop', false, false], ['netcup', true, false], ['phone', false, false]],
    'machines: self first, tailnet names, sorted');
eq(machinesOf(ts)[3].lastSeenMs, Date.parse('2026-11-09T21:00:00Z'), 'machines: last seen');
eq(machinesOf(ts)[1].lastSeenMs, 0, 'machines: year 1 = never');
eq(machinesOf(null), [], 'machines: nothing');
const t0 = Date.parse('2026-11-10T12:00:00Z');
eq(seenText(t0 - 20e3, t0), 'seen 1 min ago', 'seen: just now');
eq(seenText(t0 - 15 * 3600e3, t0), 'seen 15 h ago', 'seen: hours');
eq(seenText(t0 - 72 * 3600e3, t0), 'seen 3 days ago', 'seen: days');
eq(seenText(0, t0), 'offline', 'seen: never');
eq(['active', 'activating', 'failed', 'inactive', 'weird'].map(a => unitKind('loaded', a)),
    ['ok', 'busy', 'bad', 'off', 'unknown'], 'unit kinds');
eq(unitKind('not-found', 'inactive'), 'off', 'unit not installed');
eq(systemText('running', 0), {kind: 'ok', text: 'all running'}, 'system running');
eq(systemText('degraded', 2), {kind: 'bad', text: '2 failed'}, 'system degraded');
eq(servicesOf([
    {name: 'Jellyfin', unit: 'jellyfin.service', url: 'http://127.0.0.1:8096', host: null},
    {name: 'Assistant', unit: 'user:balaur-assistant.service', url: null, host: null},
    {name: 'Syncthing', unit: '', url: 'http://pc:8384', host: 'pc'},
    {name: 'Nothing', unit: '', url: null, host: null},
]), [
    {label: 'Jellyfin', unit: 'jellyfin.service', user: false, url: 'http://127.0.0.1:8096', host: null},
    {label: 'Assistant', unit: 'balaur-assistant.service', user: true, url: null, host: null},
    {label: 'Syncthing · pc', unit: '', user: false, url: 'http://pc:8384', host: 'pc'},
], 'services: units, user units, other machines, nothing to show dropped');
eq(servicesOf(null), [], 'services: no file');

// house.js: Home Assistant's scenes and scripts for Quick Settings
eq(loadHouse(`${tmp}/nope.json`), null, 'house: no file');
eq(loadHouse(write('house-bad.json', '{"url": 1}')), null, 'house: no url');
eq(loadHouse(write('house.json', '{"url": "http://127.0.0.1:8123/", "tokenFile": "/run/secrets/t"}')),
    {url: 'http://127.0.0.1:8123', tokenFile: '/run/secrets/t'}, 'house: trailing slash dropped');
eq(actionsOf(null), [], 'house: no states');
eq(actionsOf([
    {entity_id: 'light.lamp', state: 'on', attributes: {friendly_name: 'Lamp'}},
    {entity_id: 'script.film_mode', state: 'off', attributes: {friendly_name: 'Film mode', icon: 'mdi:movie'}},
    {entity_id: 'scene.night', state: '2026-11-10T22:00:00', attributes: {friendly_name: 'night', icon: 'mdi:weather-night'}},
    {entity_id: 'scene.Evening', state: 'unknown', attributes: {friendly_name: 'Evening'}},
    {entity_id: 'scene.gone', state: 'unavailable', attributes: {}},
    {entity_id: 'scene.no_name', state: 'unknown', attributes: {}},
    {state: 'on'},
]).map(a => [a.entityId, a.name, a.icon]), [
    ['scene.Evening', 'Evening', 'preferences-desktop-wallpaper-symbolic'],
    ['scene.night', 'night', 'night-light-symbolic'],
    ['scene.no_name', 'no name', 'preferences-desktop-wallpaper-symbolic'],
    ['script.film_mode', 'Film mode', 'video-display-symbolic'],
], 'house: scenes then scripts, by name, without the unavailable');
eq(callOf({domain: 'scene', entityId: 'scene.night'}),
    {path: '/api/services/scene/turn_on', body: {entity_id: 'scene.night'}}, 'house: a scene call');
eq(iconOf('script', null), 'system-run-symbolic', 'house: a script without an icon');
GLib.spawn_command_line_sync(`rm -rf ${tmp}`);
if (failed) {
    print(`${failed} failed`);
    System.exit(1);
}
print('ambient-data: all passed');
