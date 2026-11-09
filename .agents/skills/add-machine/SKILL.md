---
name: add-machine
description: Add a new machine to the Balaur fleet - carry over its install's settings, write its host file and registry entry, choose its aspects, give it secrets, and switch it over safely. Run on the new machine, in a clone of the repository.
---

# Add a machine

Run on the new machine, in a clone of this repository. Ask the user before each
choice that is theirs (name, aspects, account).

1. **Prerequisites.** NixOS is installed (the graphical installer is fine) and the
   machine is on the tailnet (`sudo tailscale up`; `tailscale ip -4` prints its address).

2. **Read its install.** `/etc/nixos/configuration.nix` and `hardware-configuration.nix`:
   - `system.stateVersion`: keep that exact value. Never "upgrade" it.
   - The bootloader. `base` sets systemd-boot with EFI at `/boot`. GRUB or another EFI
     mount point is carried over in the host file.
   - The username. It becomes `balaur.user`; a different name makes NixOS drop the
     existing account.
   - Anything else worth keeping: locale, keyboard, printing, extra packages.
   - Whether the disk is encrypted (LUKS). The fleet's are not yet; a new laptop should be.

3. **Its generated file.**
   `mkdir hosts/<hostname> && cp /etc/nixos/hardware-configuration.nix hosts/<hostname>/ && git add hosts/<hostname>`.

4. **Its host file,** `modules/hosts/<hostname>.nix`, modelled on `modules/hosts/zmeu.nix`:
   - `fleet.<hostname>`: `description`, `tailnetIp`, `lanIp` (only if reserved in the
     router), `sshHostKey` (`cat /etc/ssh/ssh_host_ed25519_key.pub`, without the
     trailing comment), `userKeys` (the user's `~/.ssh/id_ed25519.pub`; offer
     `ssh-keygen -t ed25519` if there is none), and `builder` if it should build for
     the others.
   - `flake.nixosConfigurations.<hostname> = inputs.nixpkgs.lib.nixosSystem { modules = [ aspects.<hostname> ]; };`
   - `flake.modules.nixos.<hostname>`: its aspects, `../../hosts/<hostname>/hardware-configuration.nix`,
     `networking.hostName`, `time.timeZone`, `system.stateVersion`, `balaur.user`.
   - Hardware specifics go in a `modules/hardware/<model>.nix` aspect (`yoga-duet-7.nix`
     for Intel, `yoga-pro-7.nix` and `gmktec-evo-x1.nix` for AMD, `nvidia-egpu.nix`).

5. **Its aspects,** with the user. Every machine: `base fleet home network auto-deploy
   ai agent`, usually `dev`, and `secrets` once step 7 is done.
   - `ai` points everything at the fleet's AI entryway (`ai-gateway`, balaur only):
     model `balaur` is a fleet GPU running `strata` first (zmeu), Mistral second.
   - `agent` is pi, the OS agent. A role is pi with other instructions and only the
     tools it is given (`pi-aminte`, where `aminte-dev` is).
   - A screen: `gnome` plus exactly one of `tablet` or `desktop`. Not on a normal
     laptop: `always-on` (never sleeps), `tablet` (the household account, no lock),
     `camera` (the Duet's sensor).
   - Services, normally on one machine only: `media`, `adblock`, `home-assistant`,
     `aminte` (`aminte-dev` is its other side), `web`, `torrents`, `backup`.
   - `assistant` runs in the session of `balaur.assistant.user` (the household account
     with `tablet`, the admin otherwise). Set `balaur.assistant.audio.input` only where
     the default microphone is too quiet; retune `wakeThreshold` with `sudo balaur-wake-test`.

6. **Switch at boot.** `nixos-rebuild build --flake .#<hostname>`, then
   `sudo nixos-rebuild boot --flake .#<hostname>` and reboot: the first switch to a new
   layout is safer at boot, and the old generation stays in the boot menu.

7. **Secrets,** before it gets the `secrets` aspect (skill `secrets`, "A new machine").

8. **Commit and push** (skill `deploy`). The other machines learn the new one (SSH
   known_hosts, authorized keys, Syncthing, builders) by themselves. `gh auth login`
   on it, so you can push from there too. Add it to README.md's description of the fleet.
