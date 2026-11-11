#!/usr/bin/env -S gjs -m
// Development aid: starts the app, shows each page in landscape and portrait
// sizes and saves PNGs of the window (and of the settings dialog) into the directory given as argument,
// then quits. Pair it with GDK_BACKEND=broadway (gtk4-broadwayd) to render
// without touching the real screen:
//
//   gtk4-broadwayd :5 &
//   GDK_BACKEND=broadway BROADWAY_DISPLAY=:5 gjs -m tools/screenshot.js /tmp/shots

import GLib from 'gi://GLib';
import Gtk from 'gi://Gtk?version=4.0';
import Gsk from 'gi://Gsk?version=4.0';
import Graphene from 'gi://Graphene';
import {programArgs} from 'system';

import {BalaurApplication} from '../src/application.js';

const outDir = programArgs[0] ?? '.';
GLib.mkdir_with_parents(outDir, 0o755);
const PAGES = ['assistant', 'lists', 'timers', 'memory', 'home'];
const SIZES = {landscape: [1080, 675], portrait: [675, 1080]};
// Optional style: BALAUR_SHOT_STYLE=dark
const style = GLib.getenv('BALAUR_SHOT_STYLE');

const wait = ms => new Promise(r => GLib.timeout_add(GLib.PRIORITY_DEFAULT, ms, () => {
    r();
    return GLib.SOURCE_REMOVE;
}));

// The widget may not have a frame ready right after a page switch (an empty
// snapshot); try again a few times.
async function capture(win, path) {
    const renderer = new Gsk.CairoRenderer();
    renderer.realize_for_display(win.get_display());
    try {
        for (let attempt = 0; attempt < 15; attempt++) {
            const w = win.get_width(), h = win.get_height();
            const snapshot = new Gtk.Snapshot();
            new Gtk.WidgetPaintable({widget: win}).snapshot(snapshot, w, h);
            const node = snapshot.to_node();
            if (node) {
                renderer.render_texture(node, new Graphene.Rect({
                    origin: new Graphene.Point({x: 0, y: 0}),
                    size: new Graphene.Size({width: w, height: h}),
                })).save_to_png(path);
                print(`saved ${path} (${w}x${h})`);
                return;
            }
            win.queue_draw();
            await wait(200);
        }
        print(`gave up on ${path}`);
    } finally {
        renderer.unrealize();
    }
}

const app = new BalaurApplication();
app.connect_after('activate', async () => {
    if (style === 'dark')
        app.style_manager.color_scheme = 4; // Adw.ColorScheme.FORCE_DARK
    const win = app.active_window;
    win.unmaximize();
    try {
        for (const [orientation, [w, h]] of Object.entries(SIZES)) {
            win.set_default_size(w, h);
            await wait(800);
            for (const page of PAGES) {
                win.showPage(page);
                await wait(700);
                await capture(win, `${outDir}/${orientation}-${page}${style ? `-${style}` : ''}.png`);
            }
            // The settings dialog, over the last page.
            app.activate_action('assistant-settings', null);
            await wait(900);
            await capture(app._settingsDialog ?? win, `${outDir}/${orientation}-settings${style ? `-${style}` : ''}.png`);
            app._settingsDialog?.close();
            await wait(400);
        }
    } catch (e) {
        logError(e);
    }
    app.quit();
});
await app.runAsync(['balaur-screenshot']);
