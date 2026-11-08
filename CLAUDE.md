# Balaur

**Loose ends from the last session: docs/HANDOFF-LOOSE-ENDS.md** (delete it and this line when the list is empty).

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
- Machine-generated files (`hardware-configuration.nix`) live in `hosts/<hostname>/`,
  outside `modules/`, so import-tree doesn't load them.

## Checking a change

- `nix eval --raw .#nixosConfigurations.<host>.config.system.build.toplevel.drvPath`
  evaluates a host. For refactors, compare the result to the previous one with
  `nix run --inputs-from . nixpkgs#nix-diff -- <old.drv> <new.drv>`: a pure refactor
  shows no difference.
- `nixos-rebuild build --flake .#<host>`, then `nix store diff-closures /run/current-system ./result`.
- A change to a shared aspect (base, fleet, home, network, dev) affects every host:
  evaluate them all.
- Deploying to another machine over the tailnet: `nixos-rebuild switch --flake .#<host> --target-host <host> --sudo`.
  This builds locally and copies the closure over, so do fleet work on **laptop**, the
  cockpit: it is much the stronger machine, and balaur is also the household screen, where a
  long build competes with the people using it. balaur is a deploy target, not a workstation.
  After pushing, fast-forward balaur's own clone so the next session there is not stale.

## Adding a machine (run on the new machine, in a clone of this repo)

1. The machine runs NixOS (graphical installer is fine) and is on the tailnet
   (`sudo tailscale up` if not; `tailscale ip -4` prints its address).
2. Read its `/etc/nixos/configuration.nix` and `hardware-configuration.nix`. Note:
   - `system.stateVersion`. Keep that exact value. Never "upgrade" it.
   - The bootloader. `base` sets systemd-boot with EFI. If the install uses GRUB or a
     different EFI mount point, carry that over in the host file.
   - The username. It becomes `balaur.user`. A different name makes NixOS drop the
     existing account.
   - Anything else the user set up there (locale, keyboard, extra packages) that is worth keeping.
3. `mkdir hosts/<hostname> && cp /etc/nixos/hardware-configuration.nix hosts/<hostname>/ && git add hosts/<hostname>`.
4. Write `modules/hosts/<hostname>.nix`, modelled on `modules/hosts/balaur.nix`:
   - `fleet.<hostname>`: `description`, `tailnetIp`, `lanIp` (if reserved in the router),
     `sshHostKey` (`cat /etc/ssh/ssh_host_ed25519_key.pub`, without the trailing comment),
     `userKeys` (the user's `~/.ssh/id_ed25519.pub`; offer `ssh-keygen -t ed25519` if there is none).
   - `flake.nixosConfigurations.<hostname> = inputs.nixpkgs.lib.nixosSystem { modules = [ aspects.<hostname> ]; };`
   - `flake.modules.nixos.<hostname>`: its aspects, `hardware-configuration.nix`,
     `networking.hostName`, `time.timeZone`, `system.stateVersion`, `balaur.user`.
   - Hardware specifics go in a `modules/hardware/<model>.nix` aspect (see `yoga-duet-7.nix`
     for Intel, `yoga-pro-7.nix` for AMD).
5. Choose aspects with the user. Every machine gets `base fleet home network`, and usually `dev`.
   A machine with a screen gets `gnome` plus exactly one of `tablet` or `desktop`.
   Don't give a normal laptop the Duet-only ones:
   - `always-on`: never sleeps, ignores the lid.
   - `tablet`: the household kiosk account with auto-login and no lock.
   - `camera`: patched modules for the Duet's sensor.

   `media` and `adblock` are services, normally on one machine only.

   `assistant` runs in the session of `balaur.assistant.user`, which defaults to the
   household account where `tablet` is present and the admin account otherwise, so it
   works on a personal desktop too. Set `balaur.assistant.audio.input` only on a machine
   whose default microphone is too quiet for the wake word (the Duet's array); null means
   PipeWire's default source. Retune `wakeThreshold` per machine with `sudo duet-wake-test`.
6. `nixos-rebuild build --flake .#<hostname>`. Then `sudo nixos-rebuild boot --flake .#<hostname>`
   and reboot. The first switch to a new layout is safer at boot, and older generations
   stay in the boot menu.
7. Commit and push. Then rebuild the other machines so they learn the new host
   (SSH known_hosts, authorized keys): `nixos-rebuild switch --flake .#balaur --target-host balaur --sudo`.

## The user

- Prefers European providers and lean CPU use.
- On the Duet, everything on screen is GNOME-native (GJS, libadwaita).
- The repo is **public**: never commit secrets, keys, tokens or personal data beyond
  what is already there (names, the email in `modules/home.nix`, LAN/tailnet IPs).
  Secrets live in `/var/lib/secrets` on each machine.
