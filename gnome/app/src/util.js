// Small helpers shared by the pages.

import GLib from 'gi://GLib';
import Gtk from 'gi://Gtk?version=4.0';
import Adw from 'gi://Adw?version=1';

// RFC 3339 from the daemon (Go writes nanoseconds, which JS' Date.parse
// doesn't promise to read) -> GLib.DateTime in local time, or null.
export function parseTime(iso) {
    if (!iso)
        return null;
    const dt = GLib.DateTime.new_from_iso8601(iso, null);
    return dt ? dt.to_local() : null;
}

// Seconds from now until `dt` (negative once past).
export function secondsUntil(dt) {
    return dt.difference(GLib.DateTime.new_now_local()) / 1e6;
}

// 754 -> "12:34", 3754 -> "1:02:34".
export function formatCountdown(seconds) {
    const s = Math.max(0, Math.ceil(seconds));
    const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), r = s % 60;
    const p = n => String(n).padStart(2, '0');
    return h ? `${h}:${p(m)}:${p(r)}` : `${m}:${p(r)}`;
}

// "16:30" today, "Thu 16:30" this week, "Thu 12 Nov, 16:30" later.
export function formatWhen(dt) {
    if (!dt)
        return '';
    const now = GLib.DateTime.new_now_local();
    const days = (dt.difference(now) / 1e6) / 86400;
    if (dt.get_year() === now.get_year() && dt.get_day_of_year() === now.get_day_of_year())
        return dt.format('%H:%M');
    if (days >= -1 && days < 6)
        return dt.format('%a %H:%M');
    return dt.format('%a %e %b, %H:%M').replace(/\s+/g, ' ');
}

// List keys from the daemon ("shopping") -> group titles.
const LIST_TITLES = {shopping: 'Shopping', tasks: 'Tasks', todo: 'To do'};
export function listTitle(name) {
    return LIST_TITLES[name] ?? name.charAt(0).toUpperCase() + name.slice(1);
}

// A round, flat icon button sized for fingers, bound to an app action.
export function actionIconButton(iconName, tooltip, actionName, target) {
    return new Gtk.Button({
        icon_name: iconName,
        tooltip_text: tooltip,
        valign: Gtk.Align.CENTER,
        css_classes: ['flat', 'circular', 'balaur-touch-button'],
        action_name: actionName,
        action_target: target,
    });
}

// A dimmed, non-interactive row for "nothing here".
export function placeholderRow(text) {
    const row = new Adw.ActionRow({title: text, activatable: false, selectable: false});
    row.add_css_class('dim-label');
    return row;
}

// Remove every child of a Gtk.ListBox (or any widget with get_first_child),
// except the ones in `keep`.
export function clearChildren(box, keep = []) {
    let child = box.get_first_child();
    while (child) {
        const next = child.get_next_sibling();
        if (!keep.includes(child))
            box.remove(child);
        child = next;
    }
}

export function escape(text) {
    return GLib.markup_escape_text(text ?? '', -1);
}
