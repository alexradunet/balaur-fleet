# Roadmap

Where the Duet is going next, as agreed on 2026-11-04. The direction holds for all of it:
**as GNOME-native as possible**. Use GNOME's own mechanism before writing code; everything
GNOME-facing is GJS (`gnome/`, see [gnome/CONTRACT.md](../gnome/CONTRACT.md)).

## Done

- Stock GNOME as a household tablet: auto-login `home`, no lock, on-screen keyboard (en + ro), rotation.
- Voice assistant in the session: GJS daemon (PipeWire, wake word, Voxtral) + agent on the pi SDK.
- Duet app (libadwaita) and Shell extension (orb overlay, mic toggle); settings for model, server and keys.
- Web UIs as GNOME web apps; Snapshot for the camera; camera movement keeps the screen awake.
- Web dashboard, Samsung TV integration and the Go assistant removed.

## Next

1. **Ambient idle screen** (in the Shell extension). When nobody uses the Duet: a big clock and
   date, weather, a photo slideshow from Jellyfin's photo library, the running timers and the next
   reminder (all from `org.duet.Assistant`). It gives way to the normal desktop on touch, and on
   movement in front of the camera (`duet-presence`). Open choices: exactly what it shows, the
   photo source, and when it appears (after idle, before GNOME blanks the screen).
2. **Media ducks while the assistant listens or speaks.** Jellyfin and Gelly turn down, then back
   up: PipeWire/WirePlumber roles (the assistant's stream already has `media.role=Assistant`) or
   MPRIS pause and resume.
3. **Music by voice.** "Pune niște jazz" plays from the Jellyfin library on the Duet, as an agent
   tool (Jellyfin's API, playing in Jellyfin Desktop / Gelly or `jellyfin-mpv-shim`).

## Parked

- Video calls (Jitsi link, Meet or Signal), not decided.

## Watch

- **qBittorrent** quit right after every start from the 2026-11-04 15:10 boot until a manual run
  rewrote its state. It has run normally since, reboot included; the cause was not found (a stale
  lockfile was ruled out). If it happens again, look at it before restarting anything: its log
  (`/var/lib/qBittorrent/qBittorrent/data/logs/qbittorrent.log`) and config files as they are then.
- "Hey Jarvis" scores 0.2-0.9 for our voices; the threshold is 0.35 (`duet-wake-test` to retune).

## When development is done

- Turn passwordless sudo back off: `security.sudo.wheelNeedsPassword = false` in
  `hosts/duet/default.nix` (added in `38d1a38`).
