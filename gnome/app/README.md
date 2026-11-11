# Balaur (org.balaur.Balaur)

The household's libadwaita app on the built-in screen, written in GJS (no
build step). Pages: **Assistant** (conversation, type to ask, Stop, mic
switch, volume), **Lists**, **Timers** (timers & reminders), **Memory**, **Home**
(services with live systemd state and an Open button). It talks to the
assistant daemon over the session bus (`org.balaur.Assistant`, see
`../CONTRACT.md`); the assistant pages show "Assistant isn't running" while it
is away, Home keeps working.

Layout follows the window: header-bar tabs in landscape, a bottom tab bar
below 720 sp (portrait). Style follows the system dark/light setting.

It is also a **search provider** for GNOME's overview: typing finds the home's
services (a result opens the service itself), list items, memories, timers and
reminders (a result opens the app on that page), ignoring case and diacritics;
three words or more also offer "Ask <name>", which asks the assistant. The Shell
starts the app for this by D-Bus activation, without a window; it quits a minute
after the last search. Try it without the Shell:

```sh
gdbus call --session -d org.balaur.Balaur -o /org/balaur/Balaur/SearchProvider \
  -m org.gnome.Shell.SearchProvider2.GetInitialResultSet "['milk']"
```

## Files

- `src/main.js`: entry point (`gjs -m src/main.js`).
- `src/application.js`: the app and its actions; every user action is an
  `app.*` action, and failures become toasts there.
- `src/window.js`: window, view stack, breakpoint.
- `src/assistant.js`: D-Bus client for `org.balaur.Assistant1`.
- `src/systemd.js`: unit state from systemd (system bus, or the session bus
  for `user:` units).
- `src/reach.js`: for another machine's service (`host` set), whether its
  `url` answers, since its unit is out of reach.
- `src/services.js`: reads `/etc/balaur/services.json` (`$BALAUR_SERVICES`
  overrides) and opens a service (its `desktopId` app, else its `url`).
- `src/search.js`: what the overview's search finds, without GTK (tested
  headless); `src/search-provider.js` answers `org.gnome.Shell.SearchProvider2`
  with it. `data/org.balaur.Balaur.search-provider.ini` and
  `data/org.balaur.Balaur.service` tell the Shell and D-Bus where it is.
- `src/format.js`: the helpers without GTK (times in the desktop's clock format,
  markup escaping, the speech address check), tested headless.
- `src/util.js`: widget helpers for the pages (and the re-exports of format.js).
- `src/pages/*.js`, `src/style.css`: the pages.
- `src/settings-dialog.js`: "Assistant Settings" (gear on the Assistant page,
  or the main menu): the chat model (one of the agent's) and Mistral speech settings
  in GSettings `org.balaur.Assistant`, the Mistral key via the daemon's
  `SetApiKey` (never shown or read back), and a Test button (`TestModel`). Text
  rows save on Apply, not while typing; the speech address must be `https://`
  (or `http://` to this machine) or empty, which means the machine's default.
- `tests/test-app.js`: the headless tests (`gjs -m gnome/app/tests/test-app.js`;
  the package's check phase runs them).
- `data/`: desktop file and icon. Packaged by `pkgs/balaur-app.nix`.

`icon` in services.json may be an icon name, an absolute file path or an
emoji; with an emoji, the `desktopId` app's own icon is preferred when there
is one.

## Trying it

```sh
nix build --impure --expr 'let p = (builtins.getFlake (toString ./.)).inputs.nixpkgs.legacyPackages.x86_64-linux; in p.callPackage ./pkgs/balaur-app.nix {}'
gjs -m gnome/app/tools/mock-assistant.js &      # fake daemon; logs "CALL ..." per method
BALAUR_SERVICES=gnome/app/tools/services.example.json ./result/bin/balaur-app
```

The app's actions are on the bus, so they can be poked without touching the
screen, e.g.:

```sh
gdbus call --session -d org.balaur.Balaur -o /org/balaur/Balaur -m org.gtk.Actions.Activate \
  list-add "[<('shopping', 'eggs')>]" '{}'
```

The GSettings schema ships with the daemon. To try the settings dialog
without it, compile the daemon's own schema into a temporary directory and
point GLib at it:

```sh
schemas=$(mktemp -d)
glib-compile-schemas --targetdir="$schemas" gnome/assistant
GSETTINGS_SCHEMA_DIR="$schemas" GSETTINGS_BACKEND=memory ./result/bin/balaur-app
```

Without the schema the dialog says so and only the API key rows work.

`tools/screenshot.js <dir>` opens the app, saves a PNG of every page and of the settings dialog in
landscape and portrait, and quits (run it with `GDK_BACKEND=broadway` and
`gtk4-broadwayd` to stay off the real screen; needs the same
`GI_TYPELIB_PATH` as the packaged launcher).
