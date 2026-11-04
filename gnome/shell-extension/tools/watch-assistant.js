#!/usr/bin/env -S gjs -m
// Prints what the extension would show, using the extension's own
// AssistantClient: one line per change, including the daemon coming and
// going. Exercises the D-Bus side of the extension without GNOME Shell.
//
//   gjs -m tools/watch-assistant.js [--toggle-mute-after N] [--stop-after N] [--quit-after N]

import GLib from 'gi://GLib';

import {AssistantClient, ACTIVE_STATES, describe, overlayTitle, trimCaption}
    from '../assistant.js';

const opt = name => {
    const i = ARGV.indexOf(name);
    return i >= 0 ? Number(ARGV[i + 1]) : 0;
};

const loop = new GLib.MainLoop(null, false);
const client = new AssistantClient(s => {
    const overlay = s.running && !s.muted && ACTIVE_STATES.includes(s.state)
        ? `overlay "${overlayTitle(s.state)}" ${JSON.stringify(trimCaption(s.caption).slice(0, 70))}`
        : 'overlay hidden';
    print(`running=${s.running} state=${s.state} muted=${s.muted} | toggle "${describe(s)}" | ${overlay}`);
});
client.start();

const after = (secs, fn) => secs > 0 && GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, secs, () => {
    fn();
    return GLib.SOURCE_REMOVE;
});
after(opt('--toggle-mute-after'), () => {
    print('-> setMuted(' + !client.status.muted + ')');
    client.setMuted(!client.status.muted);
});
after(opt('--stop-after'), () => {
    print('-> stop()');
    client.stop();
});
after(opt('--quit-after'), () => loop.quit());

loop.run();
client.destroy();
