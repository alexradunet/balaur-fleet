# Roadmap

Where the Duet is going next, as agreed on 2026-11-04. The direction holds for all of it:
**as GNOME-native as possible**. Use GNOME's own mechanism before writing code; everything
GNOME-facing is GJS (`gnome/`).

## Done

- Stock GNOME as a household tablet: auto-login `home`, no lock, on-screen keyboard (en + ro), rotation.
- Voice assistant in the session: GJS daemon (PipeWire, wake word, Voxtral) + the fleet's pi in its home role.
- Balaur app (libadwaita) and Shell extension.
- Web UIs as GNOME web apps; Snapshot for the camera; camera movement keeps the screen awake.
- Web dashboard, Samsung TV integration and the Go assistant removed; the GJS voice assistant ("Hey Jarvis") removed 2026-11-14.
- Ambient screen (2026-11-04, Shell extension): after 1 min untouched, a clock, date, weather, the running
  timers and the next reminder (gone with the assistant) over a Jellyfin photo slideshow; a touch ends it, camera movement keeps it up.
  Photos need a Jellyfin API key: `sudo balaur-photos-login` (docs/SETUP.md, Stage 12).
- Ambient screen, 2026-11-10: the machines (Tailscale) and services (systemd, or a probe on other machines)
  on the side; photos from `photos` in the Syncthing folder, so any machine can add them.

## Next

Nothing agreed yet.

## Parked

- Video calls (Jitsi link, Meet or Signal), not decided.

## Watch

- **qBittorrent** quit right after every start from the 2026-11-04 15:10 boot until a manual run
  rewrote its state. It has run normally since, reboot included; the cause was not found (a stale
  lockfile was ruled out). If it happens again, look at it before restarting anything: its log
  (`/var/lib/qBittorrent/qBittorrent/data/logs/qbittorrent.log`) and config files as they are then.
