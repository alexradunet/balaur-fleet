# Roadmap

Where the Duet is going next, as agreed on 2026-11-04. The direction holds for all of it:
**as GNOME-native as possible**. Use GNOME's own mechanism before writing code; everything
GNOME-facing is GJS (`gnome/`, see [gnome/CONTRACT.md](../gnome/CONTRACT.md)).

## Done

- Stock GNOME as a household tablet: auto-login `home`, no lock, on-screen keyboard (en + ro), rotation.
- Voice assistant in the session: GJS daemon (PipeWire, wake word, Voxtral) + the fleet's pi in its home role.
- Balaur app (libadwaita) and Shell extension (orb overlay, mic toggle); settings for model, server and keys.
- Web UIs as GNOME web apps; Snapshot for the camera; camera movement keeps the screen awake.
- Web dashboard, Samsung TV integration and the Go assistant removed.
- Ambient screen (2026-11-04, Shell extension): after 1 min untouched, a clock, date, weather, the running
  timers and the next reminder over a Jellyfin photo slideshow; a touch ends it, camera movement keeps it up.
  Photos need a Jellyfin API key: `sudo balaur-photos-login` (docs/SETUP.md, Stage 12).
- Ambient screen, 2026-11-10: the machines (Tailscale) and services (systemd, or a probe on other machines)
  on the side; photos from `photos` in the Syncthing folder, so any machine can add them.

## Next

1. **Media ducks while the assistant listens or speaks.** Jellyfin and Gelly turn down, then back
   up: PipeWire/WirePlumber roles (the assistant's stream already has `media.role=Assistant`) or
   MPRIS pause and resume.
2. **Music by voice.** "Pune niște jazz" plays from the Jellyfin library on the Duet, as an agent
   tool (Jellyfin's API, playing in Jellyfin Desktop / Gelly or `jellyfin-mpv-shim`).

## Parked

- Video calls (Jitsi link, Meet or Signal), not decided.

## Watch

- **qBittorrent** quit right after every start from the 2026-11-04 15:10 boot until a manual run
  rewrote its state. It has run normally since, reboot included; the cause was not found (a stale
  lockfile was ruled out). If it happens again, look at it before restarting anything: its log
  (`/var/lib/qBittorrent/qBittorrent/data/logs/qbittorrent.log`) and config files as they are then.
- "Hey Jarvis" scores 0.2-0.9 for our voices; the threshold is 0.35 (`balaur-wake-test` to retune).
