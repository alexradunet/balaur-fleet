// Tests for ambient-data.js (no Shell, no network): `gjs -m tests/test-ambient.js`.
// Run by the package build (pkgs/duet-shell-extension.nix).

import GLib from 'gi://GLib';
import System from 'system';

import {
    JellyfinPhotos, clockText, countdown, coverRect, describeWeather, loadConfig,
    nextReminder, parseWeather, readSecret, timersOf, weatherLine, weatherUrl, whenText,
} from '../ambient-data.js';

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
eq(loadConfig(`${tmp}/missing.json`), {idleSeconds: 60, location: null, photos: null}, 'missing config = defaults');
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

GLib.spawn_command_line_sync(`rm -rf ${tmp}`);
if (failed) {
    print(`${failed} failed`);
    System.exit(1);
}
print('ambient-data: all passed');
