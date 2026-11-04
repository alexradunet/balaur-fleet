// A tiny test runner: imports every test_*.js next to it and runs each
// exported test (an async function) in turn on a GLib main loop.
//   gjs -m tests/run.js [name-filter]
// Exit status 0 when everything passed.

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import System from 'system';

const dir = GLib.path_get_dirname(GLib.filename_from_uri(import.meta.url)[0]);
const filter = System.programArgs[0] ?? '';

async function main() {
    const files = [];
    const en = Gio.File.new_for_path(dir).enumerate_children('standard::name', Gio.FileQueryInfoFlags.NONE, null);
    for (let info; (info = en.next_file(null));) {
        const n = info.get_name();
        if (n.startsWith('test_') && n.endsWith('.js'))
            files.push(n);
    }
    files.sort();
    let pass = 0, fail = 0;
    for (const f of files) {
        const mod = await import(`./${f}`); // eslint-disable-line no-await-in-loop
        for (const [name, fn] of Object.entries(mod.tests ?? {})) {
            const full = `${f.replace(/\.js$/, '')}: ${name}`;
            if (filter && !full.includes(filter))
                continue;
            const t0 = GLib.get_monotonic_time();
            try {
                await fn(); // eslint-disable-line no-await-in-loop
                pass++;
                print(`ok    ${full} (${((GLib.get_monotonic_time() - t0) / 1000).toFixed(0)} ms)`);
            } catch (e) {
                fail++;
                print(`FAIL  ${full}\n      ${e?.message ?? e}\n${(e?.stack ?? '').split('\n').slice(0, 4).map(l => `        ${l}`).join('\n')}`);
            }
        }
    }
    print(`\n${pass} passed, ${fail} failed`);
    return fail ? 1 : 0;
}

const loop = new GLib.MainLoop(null, false);
let status = 1;
main().then(s => (status = s), e => printerr(e)).finally(() => loop.quit());
loop.run();
System.exit(status);
