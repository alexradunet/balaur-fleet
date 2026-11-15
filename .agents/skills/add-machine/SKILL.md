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
   - Anything else worth keeping: extra packages, a locale or keyboard that differs from
     the fleet's (`base` sets Europe/Bucharest, en_US with ro_RO formats, unfree and
     printing; `gnome` the US + Romanian keyboards). Say a difference in the host file.
   - Whether the disk is encrypted (LUKS). The fleet's are not yet; a new laptop should be.

3. **Its generated file.**
   `mkdir hosts/<hostname> && cp /etc/nixos/hardware-configuration.nix hosts/<hostname>/ && git add hosts/<hostname>`.

4. **Its host file,** `modules/hosts/<hostname>.nix`, modelled on `modules/hosts/server.nix`:
   - `fleet.<hostname>`: `description`, `tailnetIp`, `lanIp` (only if reserved in the
     router), `sshHostKey` (`cat /etc/ssh/ssh_host_ed25519_key.pub`, without the
     trailing comment), `userKeys` (the user's `~/.ssh/id_ed25519.pub`; offer
     `ssh-keygen -t ed25519` if there is none), and `builder` if it should build for
     the others.
   - `flake.nixosConfigurations.<hostname> = inputs.nixpkgs.lib.nixosSystem { modules = [ aspects.host-<hostname> ]; };`
   - `flake.modules.nixos.host-<hostname>` (the `host-` prefix keeps the host's module from
     merging into an aspect of the same name): its aspects, `../../hosts/<hostname>/hardware-configuration.nix`,
     `networking.hostName`, `system.stateVersion`, `balaur.user`. List the aspects in the
     order the other hosts use: hardware, then what every machine has, then its own.
   - Hardware specifics go in a `modules/hardware/<model>.nix` aspect (`yoga-pro-7.nix`
     and `gmktec-evo-x1.nix`, both AMD; `nvidia-egpu.nix`).

5. **Its aspects,** with the user. Every machine: `base fleet home network auto-deploy
   ai agent`, usually `dev files torrents-client`, and `secrets` once step 7
   is done.
   - `never-sleep` on a machine the others depend on (a server, a builder, a streaming
     host).
   - `ai` points everything at the fleet's AI entryway (`ai-gateway`, the server only):
     model `balaur` is the fleet's local model first (`local-llm` on the server), Mistral second.
   - `agent` is pi, the OS agent. A role is pi with other instructions and only the
     tools it is given (`pi-NAME`).
   - A screen: `gnome` and `desktop`. A server stays headless and gets `cockpit` for
     its admin page. Not on a normal laptop: `never-sleep`.
   - Services, normally on one machine only: `media`, `adblock`, `home-assistant`,
     `lifelog` (the keeper), `web`, `torrents`, `backup`.

6. **Switch at boot.** `nixos-rebuild build --flake .#<hostname>`, then
   `sudo nixos-rebuild boot --flake .#<hostname>` and reboot: the first switch to a new
   layout is safer at boot, and the old generation stays in the boot menu.

7. **Secrets,** before it gets the `secrets` aspect (skill `secrets`, "A new machine").

8. **Commit and push** (skill `deploy`). The other machines learn the new one (SSH
   known_hosts, authorized keys, Syncthing, builders) by themselves. `gh auth login`
   on it, so you can push from there too. Add it to README.md's description of the fleet.
