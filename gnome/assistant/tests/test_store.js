// The state files (TestStore in assistant_test.go) and byte compatibility
// with what the Go service writes.

import GLib from 'gi://GLib';

import {deepEq, eq, ok, tempDir} from './assert.js';
import {Store} from '../store.js';
import {marshal, nowString, parseTime, rfc3339} from '../gojson.js';
import {nowUs} from '../util.js';

const read = (dir, name) => new TextDecoder().decode(GLib.file_get_contents(GLib.build_filenamev([dir, name]))[1]);
const write = (dir, name, s) => GLib.file_set_contents(GLib.build_filenamev([dir, name]), s);

export const tests = {
    store() {
        const dir = tempDir();
        const s = new Store(dir);
        s.AddItems('cumpărături', ['Lapte', 'ouă', 'lapte']);
        s.AddItems('Tasks', ['duce gunoiul'], 'Alex');
        eq(s.Lists().get('shopping').length, 2, 'no duplicate');
        const [removed, missing] = s.RemoveItems('shopping', ['oua', 'pâine']);
        eq(removed.length, 1);
        eq(missing.length, 1);
        s.Remember('Alex likes coffee without sugar.');
        const minuteAgo = GLib.DateTime.new_now_local().add_minutes(-1);
        s.AddReminder({text: 'pastila', at: rfc3339(minuteAgo), repeat: 'daily'});
        s.AddReminder({text: 'once', at: rfc3339(minuteAgo)});
        const due = s.TakeDue(nowUs());
        eq(due.length, 2, 'due');
        eq(s.Reminders().length, 1, 'left');
        ok(parseTime(s.Reminders()[0].at) > nowUs(), 'daily moved to tomorrow');

        // Everything survives a reopen; no temp files are left behind.
        const s2 = new Store(dir);
        eq(s2.Lists().get('shopping').length, 1);
        eq(s2.Lists().get('tasks').length, 1);
        eq(s2.Lists().get('tasks')[0].assignee, 'Alex');
        eq(s2.Memories().length, 1);
        eq(s2.Reminders().length, 1);
        const names = [];
        const d = GLib.Dir.open(dir, 0);
        for (let n; (n = d.read_name());)
            names.push(n);
        deepEq(names.sort(), ['house.json', 'memory.json', 'reminders.json']);
    },

    goHouseJsonRoundTripsByteForByte() {
        // What Go's json.MarshalIndent wrote: HTML-safe escapes, sorted map keys,
        // omitempty fields, nanosecond times, an extra list.
        const golden = `{
  "bricolaj": [
    {
      "id": "0a1b2c3d",
      "text": "șurubelniță \\u003c5mm\\u003e \\u0026 cuie",
      "done": true,
      "added": "2026-11-04T16:13:20.123456789+02:00"
    }
  ],
  "shopping": [
    {
      "id": "deadbeef",
      "text": "lapte",
      "done": false,
      "added": "2026-11-03T09:00:00+02:00"
    }
  ],
  "tasks": [
    {
      "id": "cafe0001",
      "text": "duce gunoiul",
      "done": false,
      "assignee": "Alex",
      "due": "2026-11-05",
      "added": "2026-11-03T09:00:01.5+02:00"
    }
  ]
}`;
        const dir = tempDir();
        write(dir, 'house.json', golden);
        const s = new Store(dir);
        s._save('house.json');
        eq(read(dir, 'house.json'), golden, 'rewritten house.json');
        // A change and its undo give the same bytes again.
        s.SetDone('shopping', 'deadbeef', true);
        s.SetDone('shopping', 'deadbeef', false);
        eq(read(dir, 'house.json'), golden, 'after done/undone');
    },

    liveDefaultFile() {
        // The household's file as the Go service left it.
        const dir = tempDir();
        const golden = '{\n  "shopping": [],\n  "tasks": []\n}';
        write(dir, 'house.json', golden);
        const s = new Store(dir);
        s._save('house.json');
        eq(read(dir, 'house.json'), golden);
        deepEq(s.ListNames(), ['shopping', 'tasks']);
    },

    newItemsLookLikeGo() {
        const dir = tempDir();
        const s = new Store(dir);
        s.AddItems('Lista de cumpărături', ['pâine']);
        const it = JSON.parse(read(dir, 'house.json')).shopping[0];
        deepEq(Object.keys(it), ['id', 'text', 'done', 'added']);
        ok(/^[0-9a-f]{8}$/.test(it.id), `id ${it.id}`);
        ok(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(\.\d+)?([+-]\d\d:\d\d|Z)$/.test(it.added), `added ${it.added}`);
        ok(Math.abs(parseTime(it.added) - parseTime(nowString())) < 5e6, 'added is now');
        s.ClearDone('bricolaj'); // a list that does not exist stays absent
        deepEq(Object.keys(JSON.parse(read(dir, 'house.json'))), ['shopping', 'tasks']);
    },

    marshalLikeGo() {
        eq(marshal({a: '<&>\u2028', b: [1, 2], c: new Map([['z', 1], ['a', null]])}),
            '{"a":"\\u003c\\u0026\\u003e\\u2028","b":[1,2],"c":{"a":null,"z":1}}');
        eq(marshal({x: [], y: {}}, '  '), '{\n  "x": [],\n  "y": {}\n}');
    },
};
