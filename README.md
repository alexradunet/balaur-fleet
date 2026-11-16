# Balaur

*Balaur* is the many-headed dragon of Romanian folklore: one body, many heads. This repo
is the body: one flake that configures every machine at home, each one a head with its
own purpose. They share a common base and know about each other.

There are two heads. **server** (called `pc` until 2026-11-15), a **GMKtec NucBox EVO-X1**
on ethernet, is the home's always-on server, and it is headless. It runs every house
service: the AI entryway and the fleet's local LLM (on its Radeon iGPU), AdGuard, the web
front, the life log, Home Assistant, qBittorrent and DLNA, Orca's development sessions
and the Proton Drive mirror. Its admin page is Cockpit, and it builds for the other
machines.

**laptop**, a **Lenovo Yoga Pro 7 14APH8**, is the personal machine and the only one with
a desktop: stock GNOME, and everything on it GNOME-native. It shares the base and the
admin's environment, and runs none of the house services.

The first head, **tablet** (a Lenovo Yoga Duet 7), was the household screen and the home
server until 2026-11-15, when the server took its services over. It left the fleet that
day and waits for a new purpose; git history keeps its configuration.

Every machine follows `main` on GitHub by itself (`auto-deploy`): a push is a deploy.
`balaur-fleet-status` shows what each one runs.

## For agents

[AGENTS.md](AGENTS.md) is the repository's instructions for every agent: Claude Code
(through `CLAUDE.md`, which imports it) and the Balaur agent (pi), the owner's agent on every machine. The procedures —
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
  flake/                  flake wiring: the packages overlay, checks (tests.nix: the tests that boot machines), formatter, dev shell
  hosts/laptop.nix        laptop = its aspects + its own settings (account, roaming, ...)
  hosts/server.nix        server = its aspects + its own settings (builder, web, ...)
  hardware/yoga-pro-7.nix   the laptop's firmware and CPU bits (AMD)
  hardware/gmktec-evo-x1.nix, nvidia-egpu.nix  the server (the mini-PC, AMD); the NVIDIA card in a USB4 dock (the laptop)
  fleet.nix               the registry: every machine, its IPs and keys; SSH trust, remote builds
  auto-deploy.nix         every machine follows main: retries, roll back, `balaur-fleet-status`
  home.nix                home-manager: the admin's shell, git, gh, the same on every machine
  secrets.nix             sops-nix: shared and per-machine secrets, decrypted with each machine's host key
  base.nix                boot, admin account, SSH, Nix, housekeeping, locale + timezone, printing; the `balaur.services` registry
  network.nix             NetworkManager, Tailscale (+ SSH), <host>.local (mDNS)
  backup.nix              restic, nightly, of the state only one machine has (the server: into /srv/proton, which Proton Drive copies)
  proton-drive.nix        rclone, hourly: /srv/proton (the server) mirrored to all of Proton Drive, one way, nothing lost there
                          and `proton-drive-client`: that folder as /mnt/proton on a desktop (SSHFS)
  notify.nix              a failed unit or an ailing disk (smartd) is told to the owner through Home Assistant: its notifications, and the phones with its app
  never-sleep.nix         a machine on duty never sleeps (the server)
  gnome.nix               GNOME itself: GDM, the session, PipeWire, the canonical apps (Chromium + its add-ons, Ghostty), the Balaur app + Shell extension, one look and keyboards (US + RO), the ambient screen's settings
  desktop.nix             GNOME as a personal desktop: a normal login, the GNOME apps it drops
  dlna.nix                MiniDLNA: folders served as they are to the players on the home network (the server)
  torrents.nix            qBittorrent + FileList search (aspect `torrents`, the server), and
                          `balaur-torrent` + the magnet handler (aspect `torrents-client`, anywhere)
  adblock.nix             AdGuard Home: network-wide ad/tracker blocking on :53, UI on :3000
  home-assistant.nix      Home Assistant: devices and automations, https://home.<domain> and :8123
  web.nix                 https://<domain>: the home page of every machine's web UIs, tailnet only (Caddy, DNS-challenge cert); the owner's devices get all of it, the household's the `household` services
  files.nix               Syncthing: a 200 GiB volume of its own at /srv/files, paired from the registry
  agent.nix               the Balaur agent on every machine (`balaur`): pi with the fleet's models, machines and services, the life log as its memory; `balaur-think` (a harder question to Claude Code, on the Claude subscription); `balaur-ask`; set in `balaur.agent`
  dev.nix                 Claude Code + Orca (from numtide/llm-agents.nix, daily updates), gh, ripgrep
  orca-server.nix         Orca's runtime as a service from boot (the server): the development sessions, for the other machines' Orca to pair with
  cockpit.nix             Cockpit, the web admin page of a headless machine (the server)
  local-llm.nix           llama.cpp on the iGPU (Qwen3.6 35B-A3B, the server): the AI entryway's local tier
  gaming.nix              Battle.net (WoW: Forever) on GE-Proton via umu-launcher, `wow-addons` (instawow) and the CurseForge app; the laptop
  ai.nix                  the fleet's AI entryway on the server (`ai-gateway`: local GPU first, then a remote API: Mistral or Claude, also as `balaur-mistral` and `balaur-claude`) and its clients (`ai`)
  shorts.nix              Proof in Pictures: the humanshorts project's videos ready to post, each with its cover and caption, at https://shorts.<domain> (the server)
  lifelog.nix             lifelog, the life log as files: the keeper on the server (`lifelog`) and its web app at https://life.<domain>, the folder, `lifelog` and Obsidian on the laptop (`lifelog-client`)
hosts/<hostname>/         machine-generated files only (hardware-configuration.nix)
pkgs/                     our packages: one overlay (pkgs.<name> in every aspect), also flake packages
gnome/                    everything GNOME-facing, in GJS
  app/                    "Balaur", a libadwaita app: the home's services and its people
  shell-extension/        the Scenes menu in Quick Settings (Home Assistant), the ambient screen (photos, machines, services)
lifelog/                  the life log as markdown + CSV, synced by Syncthing, checked into git (the checker and its commands; web/: the web app, in Node.js)
```

## What you get

| Where | What |
|---|---|
| AI (aspects `ai-gateway`, `ai`, `local-llm`) | One entryway for every model call in the fleet: `http://server:4000/v1` (OpenAI-compatible; `OPENAI_BASE_URL` points there on every machine), with a page at **https://ai.balaur.space** to see the tiers and the last requests and to change the route and the remote model. Model `balaur` answers from the server's Radeon 890M (`local-llm`: Qwen3.6 35B-A3B on llama.cpp) when it is up and free, else from Mistral; `balaur-local` and `balaur-remote` pick one; the Balaur agent starts on `balaur-local`, so the life log stays in the house. |
| The Balaur app | **Home**: every service with its live state and a button that opens its app, and **People**: who of the household opens which service. GNOME's overview search finds the services too. Quick Settings has a **Scenes** menu with Home Assistant's scenes and scripts. |
| Ad blocking (aspect `adblock`) | AdGuard Home as the LAN DNS server, with European upstreams (Quad9, DNS4EU) and Samsung TV ad/ACR-tracking rules. Set it as the router's DNS 1 (keep a public DNS 2 so the network survives the box being off). |

Adding a service = an aspect that appends to `balaur.services`: it shows on the Balaur app's Home
page with its live systemd state, and on the home page at https://<domain>.

## Install

A new machine joins with the `add-machine` skill (`.agents/skills/add-machine/SKILL.md`),
run on that machine in a clone of the repository: it carries the install's settings over,
writes the host file and its registry entry, and switches it over safely. Each host imports
its own `hosts/<hostname>/hardware-configuration.nix` (the installer-generated file), so no
disk layout is assumed; it must exist and be `git add`ed, or the build fails. What is set up
by hand once after that (the agents and Orca, the Scenes menu, the ambient screen) is in
**[docs/SETUP.md](docs/SETUP.md)**.

## First-boot checklist

- **Tailscale + SSH**: run `sudo tailscale up` once (or set `balaur.network.tailscale.authKeyFile`). SSH is OpenSSH, reachable over the tailnet (`ssh server` from any machine whose key is in the registry) and on the LAN. Tailscale SSH is deliberately off (`modules/network.nix` says why). Password login is off (`balaur.ssh.passwordAuth`): the `userKeys` in the fleet registry are authorized on every machine. Set `balaur.ssh.lan = false` to make Tailscale the only way in.
- **Local recovery** (Tailscale or network down): attach a keyboard and a screen and press Ctrl+Alt+F3 for a login console (the admin account, `balaur.user`: `alex`; `sudo` asks for its password), or pick an older generation in the boot menu (last 10 kept). From there you can fix the config and rebuild. On the server, Cockpit (https://cockpit.balaur.space, or http://server:9090) has a terminal too while its network is up.
- Service ports are open on the LAN and fully open on `tailscale0`. This is a home-LAN design; do not port-forward it.

## Opinions you may want to change

- **The server never sleeps** (`never-sleep`), and its firmware powers it on when power returns.
- **Quiet boot** with Plymouth on every machine.

## Developing

```bash
nix develop                                   # Go, GJS, Node 22, libadwaita
cd lifelog && go test ./...                   # the life log's checker and commands (lifelog/README.md)
nix build .#balaur-app && ./result/bin/balaur-app # the app (gnome/app/README.md)
```
Each directory under `gnome/` has a short README.

## Status

On the laptop: GNOME, the Balaur app and Shell extension. On the server, headless: the AI
entryway and local model, AdGuard Home, the web front, qBittorrent and DLNA, the life log,
Home Assistant, Orca, the Proton Drive mirror and Cockpit. The tablet waits for a new
purpose. Next steps: [docs/ROADMAP.md](docs/ROADMAP.md).
