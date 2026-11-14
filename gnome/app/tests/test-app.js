// Tests for the app's parts that need no GTK: format.js, the overview's search
// (search.js) and who opens what (access.js): `gjs -m tests/test-app.js`.
// Run by the package build (pkgs/balaur-app.nix).

import System from 'system';

import {escape} from '../src/format.js';
import {fold, matches, parseId, resultIds, search, searchItems} from '../src/search.js';
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

// the overview's search (search.js)
eq(fold('Pâine Ședință'), 'paine sedinta', 'fold diacritics');
eq(matches(['mil'], 'oat milk'), true, 'word prefix');
eq(matches(['ilk'], 'oat milk'), false, 'not mid-word');
eq(matches(['paine'], 'Pâine neagră'), true, 'without diacritics');
eq(matches(['oat', 'MILK'], 'oat milk'), true, 'every term, any case');
eq(matches(['oat', 'bread'], 'oat milk'), false, 'a term missing');

const svc = [
    {name: 'Jellyfin', description: 'Films & series', icon: '🎬', desktopId: 'org.jellyfin.JellyfinDesktop.desktop', group: 'Media'},
    {name: 'Torrents', description: 'Downloads', icon: 'folder-download-symbolic', host: 'pc'},
    {name: 'Milkman', description: 'A service starting like milk'},
    {name: 'Oat Milk Co', description: 'Another milk'},
    {name: 'Pâinea', description: 'The bakery'},
];
const items = searchItems(svc);
eq(items.map(i => i.id), ['service:Jellyfin', 'service:Torrents', 'service:Milkman', 'service:Oat Milk Co',
    'service:Pâinea'], 'every service, in order');
eq(items[0].icon, null, 'an emoji is not an icon');
eq(items[0].desktopId, 'org.jellyfin.JellyfinDesktop.desktop', 'the app to take the icon from');
eq(items[1].icon, 'folder-download-symbolic', 'an icon name is');
eq(items[1].description, 'Downloads · On pc', 'another machine says so');
eq(items[2].description, 'A service starting like milk', 'this machine says nothing');
eq(search(items, ['milk']).map(i => i.id), ['service:Milkman', 'service:Oat Milk Co'], 'name prefix first');
eq(search(items, ['paine']).map(i => i.id), ['service:Pâinea'], 'diacritics');
eq(search(items, ['media']).map(i => i.id), ['service:Jellyfin'], 'by group');
eq(search(items, ['downloads']).map(i => i.id), ['service:Torrents'], 'by description');
eq(resultIds(items, ['when', 'is', 'sunset']), [], 'nothing found');
eq(resultIds(items, ['oat', 'milk']), ['service:Oat Milk Co'], 'every term');
eq(parseId('service:Jellyfin'), {kind: 'service', key: 'Jellyfin'}, 'parse id');
eq(parseId('service:a:b'), {kind: 'service', key: 'a:b'}, 'parse id keeps the rest');
eq(parseId('nothing'), {kind: '', key: 'nothing'}, 'parse id without a kind');

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
