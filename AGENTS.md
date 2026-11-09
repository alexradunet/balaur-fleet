# Balaur

**Loose ends from the last session: docs/HANDOFF-LOOSE-ENDS.md** (delete it and this line when the list is empty).

These are the instructions for every agent that works on this repository: Claude Code
(`CLAUDE.md` imports this file) and pi, the fleet's OS agent (it reads this file
itself). The procedures are skills in `.agents/skills/`, listed at the end; load the
one that fits before you start.

One flake configures every machine at home (the fleet). README.md explains the
layout. In short: every `.nix` file under `modules/` is a flake-parts module,
loaded automatically by import-tree (files or directories starting with `_` are
skipped). The **dendritic pattern** works like this:

- A file is a feature (an *aspect*) and defines `flake.modules.nixos.<aspect>` (and/or
  `flake.modules.homeManager.<aspect>`) together with that feature's `balaur.*` options.
- A host is `modules/hosts/<hostname>.nix`. It registers itself in the fleet
  (`fleet.<hostname>`), defines `flake.nixosConfigurations.<hostname>`, and lists its aspects.
- Including an aspect is what turns it on. There are no `enable` flags.
- flake-parts' `flake.modules` has no dedup key: import each aspect **once**, from
  the host. Aspects never import each other. When one aspect reads another's options,
  it must still work without that aspect: `cfg.camera.screenTimeout or 0`, `cfg ? tablet`.
- Our own packages (`pkgs/`) are one overlay (`modules/flake/packages.nix`) that `base`
  puts into every machine's nixpkgs: an aspect says `pkgs.balaur-app`, never
  `callPackage ../pkgs/...` (the kernel modules are the exception: they follow the kernel).
- Machine-generated files (`hardware-configuration.nix`) live in `hosts/<hostname>/`,
  outside `modules/`, so import-tree doesn't load them.
- Machines reach each other at `fleet.<host>.address`, the tailnet name (`balaur`), and
  themselves at `127.0.0.1`. Never dial `lanIp` or `<name>.local`: those are for devices
  outside the tailnet (the TV). Accepting every address (known_hosts, qBittorrent's
  ServerDomains) is fine.
- `nix fmt` before committing (nixfmt; `nix flake check` fails on unformatted files).
  Scripts are `pkgs.writeShellApplication` (shellchecked, `runtimeInputs`), and units
  run them with `lib.getExe`.

## Checking a change

Skill `check-change`. In short: `nix flake check --no-build` evaluates every host; a
refactor leaves every host's `drvPath` unchanged; build what you touched with
`nixos-rebuild build --flake .#<host>` and read `nix store diff-closures`. A change to
a shared aspect (base, fleet, home, network, secrets, dev, agent, auto-deploy)
affects every host: check them all. GitHub Actions runs the same evaluation on every
push (`.github/workflows/check.yml`); it reports, it does not stop a deploy.

## Deploying: push, and every machine follows

`main` on GitHub is the fleet's one source of truth; every machine is a copy of it.
The `auto-deploy` aspect (on every machine) checks `main` every 5 minutes and, on a
new commit, switches to its own configuration at that commit and fast-forwards its
clone. So work from whichever machine you are at — laptop, zmeu or balaur — and
deploying is `git push`. Skill `deploy` has the whole routine.

- The development sessions live in herdr on balaur (`dev-host`); `dev` on any machine
  attaches to them, and a deploy does not restart them.
- Each machine builds its own system, and the heavy builds go to the fleet's builders
  (zmeu first; fleet.nix). So editing on balaur is fine: the Duet only evaluates.
- `balaur-fleet-status` shows every machine's deployed commit, state and failed units.
- A commit that fails is retried after 15 minutes and an hour, then left until the
  next push; a switch that loses GitHub is rolled back. Push a fix rather than wait.
- Other agents and the user may be pushing too: `git pull --rebase` before `git push`,
  never force-push, and never commit or revert changes in the working tree you did
  not make.
- A secret change must reach GitHub in the same push as, or before, anything that
  needs it, or the machines switch to a config they cannot decrypt.
- The admin is not a trusted Nix user (base.nix), so `--target-host` cannot copy a
  closure built elsewhere. By hand, for a machine that cannot follow GitHub: SSH to
  it and `sudo nixos-rebuild switch --flake github:alexradunet/balaur-fleet#<host>`.

## Secrets

Skill `secrets`. They are sops files in `secrets/`, decrypted at activation into
`/run/secrets` with each machine's SSH host key: `secrets/balaur.yaml` for what more
than one machine needs, `secrets/hosts/<host>.yaml` (`balaur.secrets.hostFile`) for
what one machine needs. A machine without the `secrets` aspect keeps its few keys in
`/var/lib/secrets` (`balaur-assistant-login`, `balaur-photos-login`).

## The user

- Prefers European providers and lean CPU use.
- On the Duet, everything on screen is GNOME-native (GJS, libadwaita).
- Build the new piece next to the old one, and switch over only once it works.
- Verify by exercising the thing (the unit runs, the page answers), not by reading
  the config.
- The repo is **public**: never commit secrets, keys, tokens or personal data beyond
  what is already there (names, the email in `modules/home.nix`, LAN/tailnet IPs).

## Skills

In `.agents/skills/<name>/SKILL.md`. Claude Code sees them through `.claude/skills/`
(a link per skill); pi through its settings (agent.nix). A new skill needs both the
folder and the link, or `nix flake check` fails (`checks.skills`).

| Skill | When |
|---|---|
| `check-change` | before committing anything: which hosts to evaluate or build, and how to read the result |
| `deploy` | committing, pushing and following the machines until the change runs everywhere |
| `fleet-status` | a machine is behind, a unit failed, something misbehaves on one machine |
| `add-aspect` | a new feature or service: the file, its options, `balaur.services`, the web UI |
| `add-machine` | a new machine joins the fleet (run on that machine) |
| `secrets` | adding, changing, rotating or moving a secret; a new machine's recipients |
| `update-inputs` | `nix flake update`: nixpkgs, home-manager, the agents, aminte |
