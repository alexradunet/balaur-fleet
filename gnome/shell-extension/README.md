# balaur@balaur.local

GNOME Shell 50 extension for the Duet's built-in screen. It follows the
`org.balaur.Assistant` service on the session bus (API in `../CONTRACT.md`):

- **Overlay**: while the assistant is listening, thinking, speaking or ringing,
  a large animated orb (blue breathing, violet with orbiting dots, green, amber)
  with the caption under it, centred over everything on the primary monitor.
  Tap it to `Stop()`. The dimmed area around it lets taps through and nothing
  takes keyboard focus. Hidden when idle, muted or when the daemon is not running.
- **Quick Settings toggle** "Assistant": on = microphone on (`Muted` false).
  Subtitle "Listening for Hey Jarvis" / "Microphone off" / "Not running"
  (greyed out). A crossed-out mic shows in the top bar while muted.
- **Ambient screen**: after `idleSeconds` without input (Mutter's idle monitor), a full-screen
  clock, date, weather, the running timers and the next reminder over a Jellyfin photo slideshow,
  between the windows and the notification banners. Any input ends it. Held back while a window
  is full screen or another app inhibits idle. Config: `/etc/duet/ambient.json` (`modules/tablet.nix`;
  `BALAUR_AMBIENT_CONFIG` overrides the path for testing).

| File | What |
|---|---|
| `assistant.js` | D-Bus XML, `AssistantClient` (one `GDBusProxy` that also follows the name owner), text helpers. No Shell imports. |
| `overlay.js`, `stylesheet.css` | The orb overlay (St widgets + Clutter transitions, no per-frame JS). |
| `toggle.js` | Quick Settings toggle and top-bar indicator. |
| `ambient.js` | The ambient screen: idle watch, full-screen clock, weather, timers, reminders, photo crossfade. |
| `ambient-data.js`, `tests/test-ambient.js` | Its Shell-free side: `/etc/duet/ambient.json`, Open-Meteo, Jellyfin photos, time and layout helpers; tested in the package build. |
| `extension.js` | Glue: `enable()` / `disable()`. |
| `tools/mock-assistant.js` | Fake daemon: owns the name, cycles idle → listening → thinking → speaking → idle (an alarm every fourth round), honours `Muted`, `Stop`, `Ask`, lists, etc. Refuses to start if the name is taken. |
| `tools/watch-assistant.js` | Prints what the extension would show, using `AssistantClient`. |

Packaged by `pkgs/duet-shell-extension.nix`. No GSettings.

## Try it

```sh
nix shell nixpkgs#gjs
gjs -m tools/mock-assistant.js [--no-cycle] [--quit-after 60]   # fake daemon
gjs -m tools/watch-assistant.js                                  # what the UI would show
gdbus call --session -d org.balaur.Assistant -o /org/balaur/Assistant \
  -m org.balaur.Assistant1.Ask "hello" true
```

Run the mock as the household user (see `../CONTRACT.md`) only briefly, and
never while the real daemon is up: it refuses to start when the name is taken.

To see the extension itself without touching a live session, start a headless
`gnome-shell --headless --wayland --no-x11 --virtual-monitor 2160x1350` in its
own `dbus-run-session` with a throwaway `HOME`/`XDG_*`, the extension copied to
`$XDG_DATA_HOME/gnome-shell/extensions/`, and `GSETTINGS_BACKEND=keyfile`
listing it in `org/gnome/shell/enabled-extensions`. Keep `XDG_RUNTIME_DIR`
short (e.g. `mktemp -d /tmp/dt.XXXXXX`): the Wayland socket path must be under
108 bytes.
