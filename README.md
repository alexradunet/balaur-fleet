# Balaur

*Balaur* is the many-headed dragon of Romanian folklore: one body, many heads. This repo
is the body: one flake that configures every machine at home, each one a head with its
own purpose. They share a common base and know about each other.

The first head is **tablet**, a **Lenovo Yoga Duet 7 (13ITL6)** turned into an opinionated,
fully declarative NixOS home server. The detachable-tablet laptop becomes an appliance:
the built-in touchscreen is a household tablet running stock GNOME, everything on it is
GNOME-native, and the battery is the UPS.

The second is **laptop**, a **Lenovo Yoga Pro 7 14APH8**: the personal machine. It shares
the base and the admin's environment, and runs none of the house
services.

The third is **pc**, a **GMKtec NucBox EVO-X1** with an RTX 5060 Ti on OCuLink: a gaming
desktop that streams its games to the rest of the tailnet, runs the fleet's local LLM
(Strata), and builds for the other machines.

Every machine follows `main` on GitHub by itself (`auto-deploy`): a push is a deploy.
`balaur-fleet-status` shows what each one runs.

## For agents

[AGENTS.md](AGENTS.md) is the repository's instructions for every agent: Claude Code
(through `CLAUDE.md`, which imports it) and pi, the fleet's OS agent. The procedures —
checking a change, deploying, adding an aspect or a machine, secrets, updating inputs,
diagnosing a machine — are [Agent Skills](https://agentskills.io) in `.agents/skills/`,
linked into `.claude/skills/` for Claude Code and given to pi through its settings.

## Layout: the dendritic pattern

Every `.nix` file under `modules/` is a [flake-parts](https://flake.parts) module and is
loaded automatically ([import-tree](https://github.com/vic/import-tree)); files or
directories starting with `_` are skipped. A file is named after a feature (an *aspect*),
not a machine: it defines `flake.modules.nixos.<aspect>`, together with that feature's
`balaur.*` options. A host is a file under `modules/hosts/` that lists the aspects it runs
and sets its own choices. Adding a feature = adding a file. Giving a machine that feature =
adding its name to that host's list. Adding a machine: the `add-machine` skill.

```
flake.nix                 inputs; outputs = every file under modules/
AGENTS.md                 the agents' instructions (CLAUDE.md imports it)
.agents/skills/           the agents' procedures, one folder each (linked from .claude/skills/)
.github/workflows/        CI: every host evaluates, formatting and skills checked
modules/
  flake/                  flake wiring: the packages overlay, checks, formatter, dev shell
  hosts/tablet.nix        tablet = these aspects + its own settings (account, voices, ...)
  hosts/laptop.nix        laptop = its aspects + its own settings (account, roaming, ...)
  hosts/pc.nix            pc = its aspects     + its own settings (builder, streaming, ...)
  hardware/yoga-duet-7.nix  the Duet's firmware and CPU bits (Intel)
  hardware/yoga-pro-7.nix   the laptop's firmware and CPU bits (AMD)
  hardware/gmktec-evo-x1.nix, nvidia-egpu.nix  the pc: the mini-PC (AMD) and its docked NVIDIA card
  fleet.nix               the registry: every machine, its IPs and keys; SSH trust, remote builds
  auto-deploy.nix         every machine follows main: retries, roll back, `balaur-fleet-status`
  home.nix                home-manager: the admin's shell, git, gh, the same on every machine
  secrets.nix             sops-nix: shared and per-machine secrets, decrypted with each machine's host key
  base.nix                boot, admin account, SSH, Nix, housekeeping, locale + timezone, printing; the `balaur.services` registry
  network.nix             NetworkManager, Tailscale (+ SSH), <host>.local (mDNS)
  backup.nix              restic, nightly and off-site, of the state only one machine has (waits for a repository)
  never-sleep.nix         a machine on duty never sleeps (the tablet, the pc)
  always-on.nix           a laptop as a server: ignore lid and power key, battery = UPS, 80% charge cap
  gnome.nix               GNOME itself: GDM, the session, PipeWire, the canonical apps (Firefox + its add-ons, Ghostty), the Balaur app + Shell extension, one look and keyboards (US + RO), the ambient screen's settings
  tablet.nix              GNOME as a household tablet: auto-login, OSK, rotation, apps, web apps, ambient screen
  desktop.nix             GNOME as a personal desktop: a normal login, the GNOME apps it drops
  camera.nix              the Duet's front camera: patched kernel modules + RGB-IR relay, movement wakes the screen
  media.nix               Jellyfin: watches what `torrents` downloaded, /srv/media
  dlna.nix                MiniDLNA: folders served as they are to the players on the home network (the pc)
  torrents.nix            qBittorrent + FileList search (aspect `torrents`, the tablet only), and
                          `balaur-torrent` + the magnet handler (aspect `torrents-client`, anywhere)
  adblock.nix             AdGuard Home: network-wide ad/tracker blocking on :53, UI on :3000
  home-assistant.nix      Home Assistant: devices and automations, https://home.<domain> and :8123
  web.nix                 https://<domain>: the home page of every machine's web UIs, tailnet only (Caddy, DNS-challenge cert); the owner's devices get all of it, the household's the `household` services
  files.nix               Syncthing: a 200 GiB volume of its own at /srv/files, paired from the registry
  agent.nix               pi, the OS agent on every machine: the fleet's models, machines and services; `balaur-ask`; roles (`pi-aminte`)
  dev.nix                 Claude Code + herdr (from numtide/llm-agents.nix, daily updates), gh, ripgrep; `dev` opens the sessions
  dev-host.nix            the one machine that holds the development sessions: herdr's server, from boot
  gaming.nix              Battle.net (WoW: Forever) on GE-Proton via umu-launcher, `wow-addons` (instawow); laptop and pc
  wow-market.nix          WoW Market: what to craft, buy and sell in WoW: Forever, from Auctionator's scans; http://pc:8790 on the tailnet (pc)
  steam.nix               Steam and GameMode, for a machine that plays locally (the pc)
  game-streaming.nix      Sunshine on the host (the pc), Moonlight on the clients, over the tailnet
  ai.nix                  the fleet's AI entryway on the tablet (`ai-gateway`: local GPU first, Mistral second) and its clients (`ai`)
  strata.nix              Strata: the local LLM on the pc's GPU, stopped while a game runs
  aminte.nix              aminte, the life log, served on the tablet (`aminte`), and its dev side (`aminte-dev`)
  memos.nix               Memos: the household's notes and lists, an account each, https://memos.<domain> (the tablet)
hosts/<hostname>/         machine-generated files only (hardware-configuration.nix)
pkgs/                     our packages: one overlay (pkgs.<name> in every aspect), also flake packages
gnome/                    everything GNOME-facing, in GJS
  app/                    "Balaur", a libadwaita app: the home's services and its people
  shell-extension/        the Scenes menu in Quick Settings (Home Assistant), the ambient screen (photos, machines, services)
camera/                   Go (stdlib only) RGB-IR camera pipeline: raw IPU6 frames -> webcam
```

## What you get

| Where | What |
|---|---|
| Built-in screen | GNOME, logged in by itself as a household account (`balaur.tablet.user`, `balaur` on the tablet) that never locks. Apps run full screen; swipe up for the app switcher. The on-screen keyboard pops up on touch (English and Romanian), and the screen follows rotation. Dock: **Balaur**, **Firefox** (uBlock Origin), **Jellyfin**, **Gelly** (Jellyfin music). **AdGuard Home** and **qBittorrent** (and **Syncthing** with the `files` aspect) are installed as GNOME web apps. **Snapshot** shows the front camera. Admin tools sit in an **Admin** folder, with a **Developer terminal** that asks for the admin password. |
| Screen on/off | GNOME blanks the screen after `balaur.camera.screenTimeout` (2 minutes by default, 15 on the tablet) idle, and never locks. Movement in front of the camera counts as activity: it keeps the screen on and wakes it (`0` = always on). The relay looks at 3 frames a second for this, and runs its full image pipeline only while an app uses the webcam (`balaur.camera.tuning.idleFps`). |
| AI (aspects `ai-gateway`, `ai`, `strata`) | One entryway for every model call in the fleet: `http://tablet:4000/v1` (OpenAI-compatible; `OPENAI_BASE_URL` points there on every machine), with a page at **https://ai.balaur.space** to see the tiers and the last requests and to change the route and the remote model. Model `balaur` answers from the pc's RTX 5060 Ti (Strata, Qwen3.8-Flash-Next) when it is on, loaded and free, else from Mistral; `balaur-local` and `balaur-remote` pick one. Strata stops while a game runs on the pc. |
| The Balaur app | **Home**: every service with its live state and a button that opens its app, and **People**: who of the household opens which service. GNOME's overview search finds the services too. Quick Settings has a **Scenes** menu with Home Assistant's scenes and scripts. |
| Ad blocking (aspect `adblock`) | AdGuard Home as the LAN DNS server, with European upstreams (Quad9, DNS4EU) and Samsung TV ad/ACR-tracking rules. Set it as the router's DNS 1 (keep a public DNS 2 so the network survives the box being off). |

Adding a service = an aspect that appends to `balaur.services`: it shows on the Balaur app's Home
page with its live systemd state, and an `appIcon` installs its web UI as a GNOME web app.

## Install

On a Duet that already runs NixOS (graphical installer, "erase disk"): follow **[docs/SETUP.md](docs/SETUP.md)**. It is the piece-by-piece guide: inspect, clone, copy your `hardware-configuration.nix`, set your user/SSH key, `nixos-rebuild build`, then `nixos-rebuild boot` and reboot.

The config imports `hosts/tablet/hardware-configuration.nix` (your installer-generated file), so no disk layout is assumed. It must exist and be `git add`ed, or the build fails.

## First-boot checklist

- **Tailscale + SSH**: run `sudo tailscale up` once (or set `balaur.network.tailscale.authKeyFile`). SSH is OpenSSH, reachable over the tailnet (`ssh tablet` from any machine whose key is in the registry) and on the LAN. Tailscale SSH is deliberately off (`modules/network.nix` says why). Password login is off (`balaur.ssh.passwordAuth`): the `userKeys` in the fleet registry are authorized on every machine. Set `balaur.ssh.lan = false` to make Tailscale the only way in.
- **Local recovery** (Tailscale or network down): attach a keyboard to the Duet and press Ctrl+Alt+F3 for a login console (the admin account, `balaur.user`: `alex`; `sudo` asks for its password), or pick an older generation in the boot menu (last 10 kept). From there you can fix the config and rebuild.
- Service ports are open on the LAN and fully open on `tailscale0`. This is a home-LAN design; do not port-forward it.

## Opinions you may want to change

- **Battery as UPS**: at 7% the machine powers off cleanly; charge is capped at 80% where firmware allows (`balaur.power.chargeLimit`, `null` to disable).
- **Never sleeps**; lid ignored; power button needs a long press.
- **An open household screen**: quiet boot with Plymouth, straight into the household desktop, no password, no lock screen. The admin account is only reachable over SSH or the Developer terminal (password).

## Developing

```bash
nix develop                                   # Go, GJS, Node 22, libadwaita
cd camera && go test ./...                    # the RGB-IR pipeline (Go standard library only)
nix build .#balaur-app && ./result/bin/balaur-app # the app (gnome/app/README.md)
```
Each directory under `gnome/` has a short README.

## Status

Running on the Duet: GNOME, the Balaur app
and Shell extension, camera wake, AdGuard Home and the media services. Next steps: [docs/ROADMAP.md](docs/ROADMAP.md).
