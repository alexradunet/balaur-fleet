# Yoga Duet 7 home server

An opinionated, fully declarative NixOS home server for the **Lenovo Yoga Duet 7 (13ITL6)**.
The detachable-tablet laptop becomes an appliance: the built-in touchscreen is a household
tablet running stock GNOME, everything on it is GNOME-native, and the battery is the UPS.

```
flake.nix                 nixos-26.05, one host: nixosConfigurations.duet
hosts/duet/               the only per-install choices (hostname, timezone, SSH keys)
modules/                  the opinions
  power.nix               never sleep, ignore lid, battery = UPS, 80% charge cap
  network.nix             Tailscale (+ SSH), duet.local (mDNS)
  files.nix               Syncthing (opt-in: duet.files.enable)
  media.nix               Jellyfin + qBittorrent with FileList search (`sudo duet-filelist-login` once), /srv/media (opt-in: duet.media.enable)
  adblock.nix             AdGuard Home: network-wide ad/tracker blocking on :53, UI on :3000 (opt-in: duet.adblock.enable)
  desktop.nix             GNOME tablet: auto-login, OSK, rotation, apps, web apps, the Duet app + Shell extension
  assistant.nix           the voice assistant, a service of the GNOME session (opt-in: duet.assistant.enable)
  camera.nix              front camera: patched kernel modules + RGB-IR relay, movement wakes the screen (opt-in: duet.camera.enable)
  dev.nix                 Claude Code + pi + herdr (from numtide/llm-agents.nix, daily updates), gh, ripgrep
gnome/                    everything GNOME-facing, in GJS; gnome/CONTRACT.md is how the pieces talk
  assistant/              the assistant daemon: PipeWire audio, wake word, Voxtral speech, D-Bus org.duet.Assistant
  agent/                  its brain, on the pi SDK (TypeScript): the model and its tools
  app/                    "Duet", a libadwaita app: assistant, lists, timers, memory, home services
  shell-extension/        the assistant's orb over every app, the mic toggle in Quick Settings
camera/                   Go (stdlib only) RGB-IR camera pipeline: raw IPU6 frames -> webcam
```

## What you get

| Where | What |
|---|---|
| Built-in screen | GNOME, logged in by itself as a household account (`duet.desktop.user`, `home`) that never locks. Apps run full screen; swipe up for the app switcher. The on-screen keyboard pops up on touch (English and Romanian), and the screen follows rotation. Dock: **Duet**, **Firefox** (uBlock Origin), **Jellyfin**, **Gelly** (Jellyfin music). **AdGuard Home** and **qBittorrent** (and **Syncthing** with `duet.files`) are installed as GNOME web apps. **Snapshot** shows the front camera. Admin tools sit in an **Admin** folder, with a **Developer terminal** that asks for the admin password. |
| Screen on/off | GNOME blanks the screen after `duet.camera.screenTimeout` (2 minutes) idle, and never locks. Movement in front of the camera counts as activity: it keeps the screen on and wakes it (`0` = always on). The relay looks at 3 frames a second for this, and runs its full image pipeline only while an app uses the webcam (`duet.camera.tuning.idleFps`). |
| Voice (opt-in `duet.assistant.enable`) | Say **“Hey Jarvis”**, then speak Romanian or English. Only the wake word runs on this machine; after it, Mistral (EU) transcribes what you said (Voxtral) and speaks the answer (Voxtral TTS), and an agent built on the pi SDK decides what to do: timers and reminders (GNOME notifications with a Stop button), the house **shopping** and **tasks** lists, memory, weather, news and web search. Its orb and captions show over every app; tap it to stop. The mic toggle is in Quick Settings. |
| The Duet app | **Assistant** (the conversation, type to ask, mic, volume, and **Assistant settings**: provider, model, server and API keys, kept in GNOME settings and the GNOME Keyring), **Lists**, **Timers & reminders**, **Memory**, and **Home**: every service with its live state and a button that opens its app. |
| Ad blocking (opt-in `duet.adblock.enable`) | AdGuard Home as the LAN DNS server, with European upstreams (Quad9, DNS4EU) and Samsung TV ad/ACR-tracking rules. Set it as the router's DNS 1 (keep a public DNS 2 so the network survives the box being off). |

Adding a service = a module that appends to `duet.services`: it shows on the Duet app's Home
page with its live systemd state, and an `appIcon` installs its web UI as a GNOME web app.

## Install

On a Duet that already runs NixOS (graphical installer, "erase disk"): follow **[docs/SETUP.md](docs/SETUP.md)**. It is the piece-by-piece guide: inspect, clone, copy your `hardware-configuration.nix`, set your user/SSH key, `nixos-rebuild build`, then `nixos-rebuild boot` and reboot.

The config imports `hosts/duet/hardware-configuration.nix` (your installer-generated file) when it exists, so no disk layout is assumed.

## First-boot checklist

- **Tailscale + SSH**: run `sudo tailscale up` once (or set `duet.network.tailscale.authKeyFile`). Tailscale SSH is always on, so `ssh duet` works from any tailnet device using your tailnet identity (allow it in your tailnet ACL); regular sshd is reachable over the tailnet too. SSH is also open on the LAN. For now both use your account password; later add `duet.sshKeys` and set `duet.ssh.passwordAuth = false`. Set `duet.ssh.lan = false` to make Tailscale the only way in.
- **Local recovery** (Tailscale or network down): attach a keyboard to the Duet and press Ctrl+Alt+F3 for a login console (`duet` user, `sudo` available), or pick an older generation in the boot menu (last 10 kept). From there you can fix the config and rebuild.
- Service ports are open on the LAN and fully open on `tailscale0`. This is a home-LAN design; do not port-forward it.

## Opinions you may want to change

- **Battery as UPS**: at 7% the machine powers off cleanly; charge is capped at 80% where firmware allows (`duet.power.chargeLimit`, `null` to disable).
- **Never sleeps**; lid ignored; power button needs a long press.
- **An open household screen**: quiet boot with Plymouth, straight into the household desktop, no password, no lock screen. The admin account is only reachable over SSH or the Developer terminal (password).
- **The assistant's brain has only its own tools**: pi's built-in tools (shell, files) are excluded and checked at every start and turn, so nothing it reads on the web can make it run commands.

## Developing

```bash
nix develop                                   # Go, GJS, Node 22, libadwaita
cd camera && go test ./...                    # the RGB-IR pipeline (Go standard library only)
cd gnome/agent && npm test                    # the pi SDK agent
nix build .#duet-assistant && ./result/libexec/duet-assistant-tests
nix build .#duet-app && ./result/bin/duet-app # the app; see gnome/app/README.md for a mock assistant
```
How the GNOME pieces talk to each other is in [gnome/CONTRACT.md](gnome/CONTRACT.md); each
directory under `gnome/` has a short README.

## Status

Running on the Duet: GNOME, the assistant (wake word, Voxtral, the pi agent), the Duet app
and Shell extension, camera wake, AdGuard Home and the media services.
