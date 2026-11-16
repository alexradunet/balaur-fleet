# balaur@balaur.local

GNOME Shell 50 extension for the Duet's built-in screen:

- **Ambient screen**: after `idleSeconds` without input (Mutter's idle monitor), a full-screen
  clock, date, weather, the fleet's machines and the home's services over a photo slideshow
  (a folder, the synced one on the tablet, or Jellyfin), between the windows and the
  notification banners. Any input ends it. Held back while a window is full screen or another
  app inhibits idle. Config: `/etc/balaur/ambient.json` (`modules/gnome.nix`, every GNOME machine;
  `BALAUR_AMBIENT_CONFIG` overrides the path for testing).
- **Quick Settings "Scenes"**: a menu of Home Assistant's scenes, then its scripts,
  fetched each time it opens; a tap runs one (`turn_on`), a failure is a notification.
  Only where `/etc/balaur/house.json` exists (`modules/gnome.nix`), with the household
  screen's non-admin Home Assistant token. Scenes are made in Home Assistant's UI.
  `BALAUR_HOUSE_CONFIG` overrides the path for testing.

| File | What |
|---|---|
| `scenes.js` | The Quick Settings "Scenes" menu. |
| `house.js` | Its Shell-free side: `/etc/balaur/house.json`, Home Assistant's states and service calls; tested with the ambient screen's helpers. |
| `ambient.js`, `stylesheet.css` | The ambient screen: idle watch, full-screen clock, weather, machines and services, photo crossfade; landscape and portrait layouts. |
| `ambient-status.js` | Machines (`tailscale status --json`) and services (`/etc/balaur/services.json`: systemd over D-Bus, a TCP probe for other machines), asked every 30 s while shown. |
| `ambient-data.js`, `tests/test-ambient.js` | Its Shell-free side: `/etc/balaur/ambient.json`, Open-Meteo, photos (a folder or Jellyfin), clock and layout helpers; tested in the package build, with `ambient-status.js`'s and `house.js`'s helpers. |
| `extension.js` | Glue: `enable()` / `disable()`. |

Packaged by `pkgs/balaur-shell-extension.nix`. No GSettings.

## Try it

The Shell-free helpers are tested by `nix build .#balaur-shell-extension`
(`tests/test-ambient.js`).

To see the extension itself without touching a live session, start a headless
`gnome-shell --headless --wayland --no-x11 --virtual-monitor 2160x1350` in its
own `dbus-run-session` with a throwaway `HOME`/`XDG_*`, the extension copied to
`$XDG_DATA_HOME/gnome-shell/extensions/`, and `GSETTINGS_BACKEND=keyfile`
listing it in `org/gnome/shell/enabled-extensions`. Keep `XDG_RUNTIME_DIR`
short (e.g. `mktemp -d /tmp/dt.XXXXXX`): the Wayland socket path must be under
108 bytes.
