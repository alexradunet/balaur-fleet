# Handoff: register the laptop in Balaur

Written 2026-11-04 on duet, for the Claude Code session on the laptop. Read
`CLAUDE.md` first: it has the repo's rules and the step-by-step "Adding a machine".
This file adds the context behind them. **Delete it once the laptop is registered**
(and drop its pointer from CLAUDE.md).

## Where things stand

- **The repo.** Renamed to Balaur (the many-headed dragon of Romanian folklore: one
  repo, many machines). GitHub: `alexradunet/balaur-fleet`, **public**. On duet it is
  still cloned as `~/yoga-duet-7-home-server`; the folder name doesn't matter.
- **The dendritic pattern** (flake-parts + import-tree). It is live on duet as of
  `d3d9a10` and verified with nix-diff: duet's system was unchanged by the restructure.
- **The fleet registry** (`modules/fleet.nix`) and **home-manager** (`modules/home.nix`)
  are live on duet as of `cf364f7`.
  - duet is registered (`fleet.duet` in `modules/hosts/duet.nix`). Its host key is in
    every member's `/etc/ssh/ssh_known_hosts`.
  - Home-manager currently gives the admin bash, git (name `alex`, the user's email)
    and gh as git's credential helper.
- **duet's role.** The Lenovo Yoga Duet 7 in the living room is the home server and the
  household tablet: GNOME kiosk account `home`, a voice assistant, camera wake, Jellyfin,
  qBittorrent, AdGuard Home (the LAN's DNS 1). Tailnet `100.118.102.119`, LAN `192.168.50.233`.
- **Tailnet.** A Linux node called **`balaur`** (`100.83.235.103`) is on it, most likely
  this laptop. Check with `hostname` and `tailscale ip -4`. A node called `yoga` was
  offline; ask the user what it is (possibly an old name of the Duet).

## What the user wants

- **One repo for the whole fleet.** Every machine has the same experience: their
  shell, git, tools and (on desktops) GNOME settings, through `flake.modules.homeManager.*`.
- **Each machine keeps its own purpose.** The laptop gets different apps and is used
  for other things than the Duet.
- **The machines know about each other and can talk to each other.**
- **The user said yes to:**
  - home-manager for the shared environment;
  - a fleet registry for SSH trust between machines;
  - remote builds;
  - deploying any machine from any other;
  - secrets with sops.

## Your job on the laptop

1. Follow CLAUDE.md, "Adding a machine". Ask the user:
   - what the laptop is for and which apps they want (so far they've only said
     "different apps, other purposes");
   - whether they want the voice assistant there. Today it needs the `tablet` aspect,
     so a laptop version is new work.
2. **A personal GNOME desktop.** The laptop will most likely want GNOME, but not
   `tablet.nix`, which is the household kiosk (auto-login, no lock). First move the
   generic parts into a shared aspect, then build the laptop's desktop on top:
   - the generic parts are GDM, GNOME, PipeWire and the Firefox policies;
   - prove with nix-diff that duet's derivation is unchanged by the move.
3. Put the user's real dotfiles and GNOME preferences into homeManager aspects. Take
   them from what is on the laptop now. Don't invent any. Add laptop-only ones from
   the host file.
4. Add `fleet.<hostname>` with the laptop's tailnet IP, host key and user key. Offer
   `ssh-keygen -t ed25519` if the user has no key.
5. Build, `nixos-rebuild boot`, reboot, then commit and push. Then deploy duet from the
   laptop so duet learns the new machine:
   `nixos-rebuild switch --flake .#duet --target-host duet --sudo`.

## Next, once the laptop is in (agreed, not started)

- **Remote builds.** The laptop builds for duet, whose i5/i7-1165G7 is the weaker CPU.
  Add an optional builder field to the fleet entries and set `nix.buildMachines` from it.
  duet's root then needs SSH access to a builder account on the laptop.
- **sops-nix.** Both hosts' SSH keys become age recipients, plus an admin age key on the
  laptop. The repo is public, so ask the user whether encrypted secrets may live in it.
  Today's secrets stay where they are until then:
  - `/var/lib/secrets/duet-assistant-llm-key` (Mistral);
  - `/var/lib/qBittorrent/filelist.json`;
  - the Tailscale auth key, if any.
- **Syncthing between the machines.** The `files` aspect exists but no host uses it yet.
  The fleet registry could fill in the devices automatically.

## Names

- The GNOME app is **Balaur** (`org.balaur.Balaur`), the assistant `org.balaur.Assistant`, the
  Shell extension `balaur@balaur.local` (renamed 2026-11-04). Package, command and unit names
  (`duet-app`, `duet-assistant`, `/var/lib/duet-*`) stay: renaming them would need state
  migrations. The hostname `duet` stays: it names the device.

## How the user likes to work

- European providers. The assistant uses Mistral for speech-to-text, the model,
  text-to-speech and web search; only the wake word runs locally. Don't propose
  self-hosted speech or LLMs, or non-EU services, unless asked.
- Lean CPU use matters, especially on duet.
- On the Duet, everything on screen is GNOME-native: GJS, libadwaita, a Shell extension.
  Prefer GNOME's own mechanisms over custom code.
- Build the new piece next to the old one, and switch over only once it works.
- **duet has temporary passwordless sudo** for development (commit `38d1a38`, a line in
  `modules/hosts/duet.nix`). It must be reverted when the user says development is done.
  Don't copy it to the laptop unless the user asks.
- Public repo: no secrets, tokens or new personal data in commits.
