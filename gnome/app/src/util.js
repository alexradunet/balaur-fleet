// Small helpers shared by the pages. The ones that need no GTK (times,
// escaping, address checks) live in format.js, so they can be tested headless.

import Gtk from 'gi://Gtk?version=4.0';
import Adw from 'gi://Adw?version=1';

export {
    clockText, escape, formatCountdown, formatWhen, listTitle, parseTime, secondsUntil,
} from './format.js';

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
