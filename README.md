# Balaur

*Balaur* is the many-headed dragon of Romanian folklore: one body, many heads. This repo
is the body: one flake that configures every machine at home, each one a head with its
own purpose. They share a common base and know about each other.

The first head is **balaur**, a **Lenovo Yoga Duet 7 (13ITL6)** turned into an opinionated,
fully declarative NixOS home server. The detachable-tablet laptop becomes an appliance:
the built-in touchscreen is a household tablet running stock GNOME, everything on it is
GNOME-native, and the battery is the UPS.

The second is **laptop**, a **Lenovo Yoga Pro 7 14APH8**: the personal machine, and where
the fleet is built and deployed from. It shares the base, the admin's environment and the
voice assistant, and runs none of the house services.

## Layout: the dendritic pattern

Every `.nix` file under `modules/` is a [flake-parts](https://flake.parts) module and is
loaded automatically ([import-tree](https://github.com/vic/import-tree)); files or
directories starting with `_` are skipped. A file is named after a feature (an *aspect*),
not a machine: it defines `flake.modules.nixos.<aspect>`, together with that feature's
`balaur.*` options. A host is a file under `modules/hosts/` that lists the aspects it runs
and sets its own choices. Adding a feature = adding a file. Giving a machine that feature =
adding its name to that host's list. Adding a machine: [CLAUDE.md](CLAUDE.md), "Adding a machine".

```
flake.nix                 inputs; outputs = every file under modules/
modules/
  flake/                  flake wiring: packages, checks, dev shell
  hosts/balaur.nix        balaur = these aspects + its own settings (account, voices, ...)
  hosts/laptop.nix        laptop = its aspects + its own settings (locales, printing, ...)
  hardware/yoga-duet-7.nix  the Duet's firmware and CPU bits (Intel)
  hardware/yoga-pro-7.nix   the laptop's firmware and CPU bits (AMD)
  fleet.nix               the registry: every machine, its IPs and keys; SSH trust, remote builds
  home.nix                home-manager: the admin's shell, git, gh, the same on every machine
  secrets.nix             sops-nix: secrets encrypted in the repo, decrypted with each machine's host key
  base.nix                boot, admin account, SSH, Nix, housekeeping; the `balaur.services` registry
  network.nix             NetworkManager, Tailscale (+ SSH), <host>.local (mDNS)
  always-on.nix           a laptop as a server: never sleep, ignore lid, battery = UPS, 80% charge cap
  gnome.nix               GNOME itself: GDM, the session, PipeWire, and the canonical apps (Firefox + its add-ons, Ptyxis)
  tablet.nix              GNOME as a household tablet: auto-login, OSK, rotation, apps, web apps, the Balaur app + Shell extension, ambient screen
  desktop.nix             GNOME as a personal desktop: a normal login, the Balaur app + Shell extension, the GNOME apps it drops
  assistant.nix           the voice assistant, a service of a GNOME session
  camera.nix              the Duet's front camera: patched kernel modules + RGB-IR relay, movement wakes the screen
  media.nix               Jellyfin: watches what `torrents` downloaded, /srv/media
  torrents.nix            qBittorrent + FileList search (aspect `torrents`, balaur only), and
                          `balaur-torrent` + the magnet handler (aspect `torrents-client`, anywhere)
  adblock.nix             AdGuard Home: network-wide ad/tracker blocking on :53, UI on :3000
  home-assistant.nix      Home Assistant: devices and automations, https://home.<domain> and :8123
  web.nix                 https://<domain>: the home page of every machine's web UIs, tailnet only (Caddy, DNS-challenge cert)
  files.nix               Syncthing: a 200 GiB volume of its own at /srv/files, paired from the registry
  agent.nix               pi, the OS agent on every machine: the fleet's models, machines and services; `balaur-ask`; roles (`pi-aminte`)
  dev.nix                 Claude Code + herdr (from numtide/llm-agents.nix, daily updates), gh, ripgrep
  gaming.nix              Battle.net (WoW: Forever) on GE-Proton via umu-launcher, `wow-addons` (instawow); laptop only
hosts/<hostname>/         machine-generated files only (hardware-configuration.nix)
pkgs/                     our packages, built by the aspects and exposed as flake packages
gnome/                    everything GNOME-facing, in GJS; gnome/CONTRACT.md is how the pieces talk
  assistant/              the assistant daemon: PipeWire audio, wake word, Voxtral speech, D-Bus org.balaur.Assistant
  agent/                  its brain, on the pi SDK (TypeScript): the model and its tools
  app/                    "Balaur", a libadwaita app: assistant, lists, timers, memory, home services
  shell-extension/        the assistant's orb over every app, the mic toggle in Quick Settings, the ambient screen
camera/                   Go (stdlib only) RGB-IR camera pipeline: raw IPU6 frames -> webcam
```

## What you get

| Where | What |
|---|---|
| Built-in screen | GNOME, logged in by itself as a household account (`balaur.tablet.user`, `home`) that never locks. Apps run full screen; swipe up for the app switcher. The on-screen keyboard pops up on touch (English and Romanian), and the screen follows rotation. Dock: **Balaur**, **Firefox** (uBlock Origin), **Jellyfin**, **Gelly** (Jellyfin music). **AdGuard Home** and **qBittorrent** (and **Syncthing** with the `files` aspect) are installed as GNOME web apps. **Snapshot** shows the front camera. Admin tools sit in an **Admin** folder, with a **Developer terminal** that asks for the admin password. |
| Screen on/off | GNOME blanks the screen after `balaur.camera.screenTimeout` (2 minutes) idle, and never locks. Movement in front of the camera counts as activity: it keeps the screen on and wakes it (`0` = always on). The relay looks at 3 frames a second for this, and runs its full image pipeline only while an app uses the webcam (`balaur.camera.tuning.idleFps`). |
| AI (aspects `ai-gateway`, `ai`, `strata`) | One entryway for every model call in the fleet: `http://balaur:4000/v1` (OpenAI-compatible; `OPENAI_BASE_URL` points there on every machine), with a page at **https://ai.balaur.space** to see the tiers and the last requests and to change the route and the remote model. Model `balaur` answers from zmeu's RTX 5060 Ti (Strata, Qwen3.8-Flash-Next) when it is on, loaded and free, else from Mistral; `balaur-local` and `balaur-remote` pick one. Strata stops while a game runs on zmeu. |
| Voice (aspect `assistant`) | Say **“Hey Jarvis”**, then speak Romanian or English. Only the wake word runs on this machine; after it, Mistral (EU) transcribes what you said (Voxtral) and speaks the answer (Voxtral TTS), and an agent built on the pi SDK decides what to do: timers and reminders (GNOME notifications with a Stop button), the house **shopping** and **tasks** lists, memory, weather, news and web search. Its orb and captions show over every app; tap it to stop. The mic toggle is in Quick Settings. |
| The Balaur app | **Assistant** (the conversation, type to ask, mic, volume, and **Assistant settings**: provider, model, server and API keys, kept in GNOME settings and the GNOME Keyring), **Lists**, **Timers & reminders**, **Memory**, and **Home**: every service with its live state and a button that opens its app. |
| Ad blocking (aspect `adblock`) | AdGuard Home as the LAN DNS server, with European upstreams (Quad9, DNS4EU) and Samsung TV ad/ACR-tracking rules. Set it as the router's DNS 1 (keep a public DNS 2 so the network survives the box being off). |

Adding a service = an aspect that appends to `balaur.services`: it shows on the Balaur app's Home
page with its live systemd state, and an `appIcon` installs its web UI as a GNOME web app.

## Install

On a Duet that already runs NixOS (graphical installer, "erase disk"): follow **[docs/SETUP.md](docs/SETUP.md)**. It is the piece-by-piece guide: inspect, clone, copy your `hardware-configuration.nix`, set your user/SSH key, `nixos-rebuild build`, then `nixos-rebuild boot` and reboot.

The config imports `hosts/balaur/hardware-configuration.nix` (your installer-generated file) when it exists, so no disk layout is assumed.

## First-boot checklist

- **Tailscale + SSH**: run `sudo tailscale up` once (or set `balaur.network.tailscale.authKeyFile`). SSH is OpenSSH, reachable over the tailnet (`ssh balaur` from any machine whose key is in the registry) and on the LAN. Tailscale SSH is deliberately off (`modules/network.nix` says why). Password login is off (`balaur.ssh.passwordAuth`): the `userKeys` in the fleet registry are authorized on every machine. Set `balaur.ssh.lan = false` to make Tailscale the only way in.
- **Local recovery** (Tailscale or network down): attach a keyboard to the Duet and press Ctrl+Alt+F3 for a login console (`balaur` user, `sudo` available), or pick an older generation in the boot menu (last 10 kept). From there you can fix the config and rebuild.
- Service ports are open on the LAN and fully open on `tailscale0`. This is a home-LAN design; do not port-forward it.

## Opinions you may want to change

- **Battery as UPS**: at 7% the machine powers off cleanly; charge is capped at 80% where firmware allows (`balaur.power.chargeLimit`, `null` to disable).
- **Never sleeps**; lid ignored; power button needs a long press.
- **An open household screen**: quiet boot with Plymouth, straight into the household desktop, no password, no lock screen. The admin account is only reachable over SSH or the Developer terminal (password).
- **The assistant's brain has only its own tools**: pi's built-in tools (shell, files) are excluded and checked at every start and turn, so nothing it reads on the web can make it run commands.

## Developing

```bash
nix develop                                   # Go, GJS, Node 22, libadwaita
cd camera && go test ./...                    # the RGB-IR pipeline (Go standard library only)
cd gnome/agent && npm test                    # the pi SDK agent
nix build .#balaur-assistant && ./result/libexec/balaur-assistant-tests
nix build .#balaur-app && ./result/bin/balaur-app # the app; see gnome/app/README.md for a mock assistant
```
How the GNOME pieces talk to each other is in [gnome/CONTRACT.md](gnome/CONTRACT.md); each
directory under `gnome/` has a short README.

## Status

Running on the Duet: GNOME, the assistant (wake word, Voxtral, the pi agent), the Balaur app
and Shell extension, camera wake, AdGuard Home and the media services. Next steps: [docs/ROADMAP.md](docs/ROADMAP.md).
