// A service's picture, for the Home and People pages.

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Gtk from 'gi://Gtk?version=4.0';
import Gdk from 'gi://Gdk?version=4.0';

// services.json's icon may be an icon name, a file, or (as on the old web
// dashboard) an emoji. Real icons look best, so prefer: a named/file icon,
// then the GNOME app's own icon, then the emoji. `services` is the Services
// object, which knows the service's GNOME app.
export function serviceIcon(services, s, size = 32) {
    const icon = s.icon ?? '';
    if (icon.startsWith('/') && GLib.file_test(icon, GLib.FileTest.EXISTS))
        return new Gtk.Image({gicon: Gio.FileIcon.new(Gio.File.new_for_path(icon)), pixel_size: size});
    const theme = Gtk.IconTheme.get_for_display(Gdk.Display.get_default());
    if (/^[\w.-]+$/.test(icon) && theme.has_icon(icon))
        return new Gtk.Image({icon_name: icon, pixel_size: size});
    const appIcon = services.appInfo(s)?.get_icon();
    if (appIcon)
        return new Gtk.Image({gicon: appIcon, pixel_size: size});
    if (icon)
        return new Gtk.Label({label: icon, css_classes: ['balaur-emoji'], width_request: size});
    return new Gtk.Image({icon_name: 'application-x-executable-symbolic', pixel_size: size});
}
