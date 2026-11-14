# Balaur (org.balaur.Balaur)

The household's libadwaita app on the built-in screen, written in GJS (no
build step). Pages: **Home** (the home's services with live systemd state and
an Open button), and on a machine that names its people **People** (who of the
household opens which service). With Home alone the window has no tabs.

Layout follows the window: header-bar tabs in landscape, a bottom tab bar
below 860 sp (portrait). Style follows the system dark/light setting.

It is also a **search provider** for GNOME's overview: typing finds the home's
services, ignoring case and diacritics, and a result opens the service itself.
The Shell starts the app for this by D-Bus activation, without a window; it
quits a minute after the last search. Try it without the Shell:

```sh
gdbus call --session -d org.balaur.Balaur -o /org/balaur/Balaur/SearchProvider \
  -m org.gnome.Shell.SearchProvider2.GetInitialResultSet "['films']"
```

## Files

- `src/main.js`: entry point (`gjs -m src/main.js`).
- `src/application.js`: the app and its actions; every user action is an
  `app.*` action, and failures become toasts there.
- `src/window.js`: window, view stack, breakpoint.
- `src/systemd.js`: unit state from systemd (system bus, or the session bus
  for `user:` units).
- `src/reach.js`: for another machine's service (`host` set), whether its
  `url` answers, since its unit is out of reach.
- `src/services.js`: reads `/etc/balaur/services.json` (`$BALAUR_SERVICES`
  overrides) and opens a service (its `desktopId` app, else its `url`).
- `src/people.js`: reads `/etc/balaur/people.json` (`$BALAUR_PEOPLE` overrides);
  `src/access.js`: who opens what, without GTK (tested headless). The People
  page only shows it: the gate is Caddy's and the tailnet's (`modules/web.nix`).
- `src/service-icon.js`: a service's picture, for Home and People.
- `src/search.js`: what the overview's search finds, without GTK (tested
  headless); `src/search-provider.js` answers `org.gnome.Shell.SearchProvider2`
  with it. `data/org.balaur.Balaur.search-provider.ini` and
  `data/org.balaur.Balaur.service` tell the Shell and D-Bus where it is.
- `src/format.js`: the helpers without GTK (markup escaping), tested headless.
- `src/pages/*.js`, `src/style.css`: the pages.
- `tests/test-app.js`: the headless tests (`gjs -m gnome/app/tests/test-app.js`;
  the package's check phase runs them).
- `data/`: desktop file and icon. Packaged by `pkgs/balaur-app.nix`.

`icon` in services.json may be an icon name, an absolute file path or an
emoji; with an emoji, the `desktopId` app's own icon is preferred when there
is one.

## Trying it

```sh
nix build .#balaur-app
BALAUR_SERVICES=gnome/app/tools/services.example.json \
  BALAUR_PEOPLE=gnome/app/tools/people.example.json ./result/bin/balaur-app
```

The app's actions are on the bus, so they can be poked without touching the
screen, e.g.:

```sh
gdbus call --session -d org.balaur.Balaur -o /org/balaur/Balaur -m org.gtk.Actions.Activate \
  open-service "[<'Jellyfin'>]" '{}'
```

`tools/screenshot.js <dir>` opens the app, saves a PNG of every page in
landscape and portrait, and quits (run it with `GDK_BACKEND=broadway` and
`gtk4-broadwayd` to stay off the real screen; needs the same
`GI_TYPELIB_PATH` as the packaged launcher).
