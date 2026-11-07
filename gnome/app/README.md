# Duet (org.balaur.Balaur)

The household's libadwaita app on the built-in screen, written in GJS (no
build step). Pages: **Assistant** (conversation, type to ask, Stop, mic
switch, volume), **Lists**, **Timers** (timers & reminders), **Memory**, **Home**
(services with live systemd state and an Open button). It talks to the
assistant daemon over the session bus (`org.balaur.Assistant`, see
`../CONTRACT.md`); the assistant pages show "Assistant isn't running" while it
is away, Home keeps working.

Layout follows the window: header-bar tabs in landscape, a bottom tab bar
below 720 sp (portrait). Style follows the system dark/light setting.

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
- `src/services.js`: reads `/etc/duet/services.json` (`$DUET_SERVICES`
  overrides) and opens a service (its `desktopId` app, else its `url`).
- `src/pages/*.js`, `src/style.css`: the pages.
- `src/settings-dialog.js`: "Assistant Settings" (gear on the Assistant page,
  or the main menu): chat provider/model/server and Mistral speech settings
  bound to GSettings `org.balaur.Assistant`, API keys via the daemon's
  `SetApiKey` (never shown or read back), and a Test button (`TestModel`).
- `data/`: desktop file and icon. Packaged by `pkgs/duet-app.nix`.

`icon` in services.json may be an icon name, an absolute file path or an
emoji; with an emoji, the `desktopId` app's own icon is preferred when there
is one.

## Trying it

```sh
nix build --impure --expr 'let p = (builtins.getFlake (toString ./.)).inputs.nixpkgs.legacyPackages.x86_64-linux; in p.callPackage ./pkgs/duet-app.nix {}'
gjs -m gnome/app/tools/mock-assistant.js &      # fake daemon; logs "CALL ..." per method
DUET_SERVICES=gnome/app/tools/services.example.json ./result/bin/duet-app
```

The app's actions are on the bus, so they can be poked without touching the
screen, e.g.:

```sh
gdbus call --session -d org.balaur.Balaur -o /org/balaur/Balaur -m org.gtk.Actions.Activate \
  list-add "[<('shopping', 'eggs')>]" '{}'
```

The GSettings schema ships with the daemon. To try the settings dialog
without it, compile the test copy and point GLib at it:

```sh
glib-compile-schemas --targetdir=/tmp/duet-schemas gnome/app/tools
GSETTINGS_SCHEMA_DIR=/tmp/duet-schemas GSETTINGS_BACKEND=memory ./result/bin/duet-app
```

Without the schema the dialog says so and only the API key rows work.

`tools/screenshot.js <dir>` opens the app, saves a PNG of every page in
landscape and portrait, and quits (run it with `GDK_BACKEND=broadway` and
`gtk4-broadwayd` to stay off the real screen; needs the same
`GI_TYPELIB_PATH` as the packaged launcher).
