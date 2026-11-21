# laptop: the Lenovo Yoga Pro 7 14APH8 the fleet is worked on from. A personal
# machine, so it gets the shared base and a normal GNOME desktop, and none of the
# server's aspects: it sleeps when the lid shuts (no `never-sleep`), and it runs
# no house services.
# Machine-generated files (hardware-configuration.nix) live in hosts/laptop/.
{ inputs, config, ... }:
let
  aspects = config.flake.modules.nixos;
in
{
  fleet.laptop = {
    description = "Yoga Pro 7 14APH8: the personal laptop, and where the fleet is built";
    tailnetIp = "100.69.82.21";
    sshHostKey = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIPuF+Lz5BXcudqKdUv2Fuohry+8hib+ArCKy1Cg8qqZm";
    lanIp = null; # DHCP: it was 192.168.50.43, not reserved in the router
    userKeys = [ "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIBaXwupVG+t3PlhIRwjvcvyWE9NyzesTUU55qaC0buGd" ];
    syncthingId = "OIWJQ4H-XCGNO6G-YC34T53-KYOUVC6-WWYNUXF-U47H6QL-ULMIURW-BLZ7DQY";
    # torrentsPort: unset — this machine sends downloads, it does not take them.
    # It is also one of the fleet's builders, second to the server: 8 cores / 16
    # threads against the server's 12 / 24. 8 jobs leaves half the threads for
    # whoever is actually using this laptop.
    builder = {
      maxJobs = 8;
      speedFactor = 2;
    };
  };

  flake.nixosConfigurations.laptop = inputs.nixpkgs.lib.nixosSystem {
    modules = [ aspects.host-laptop ];
  };

  flake.modules.nixos.host-laptop =
    { ... }:
    {
      imports =
        (with aspects; [
          yoga-pro-7
          # What every machine has, in the same order on every host.
          base
          fleet
          home
          secrets
          network
          gnome
          desktop
          dev
          files
          # torrents (the qBittorrent server) is on the server; this is just the
          # client, so a magnet clicked here can be sent there.
          torrents-client
          auto-deploy
          # The fleet's AI entryway on the server: its local model first, Mistral second.
          ai
          # The Balaur agent (`balaur`): pi with the fleet's instructions and the life log as its memory.
          agent
          # This machine's own.
          # The life log as files: the folder, `lifelog`, Obsidian, and the nightly mirror of
          # the keeper's history from the server (balaur.lifelog-client.mirrorFrom below).
          lifelog-client
          # WoW, on the RTX 5060 Ti in its Thunderbolt/USB4 dock when it is plugged in here
          # (the fleet's only gaming machine again since 2026-11-18). No local model here.
          nvidia-egpu
          gaming
          # The server's /srv/proton (backed up to Proton Drive) as /mnt/proton, over SSHFS.
          proton-drive-client
          # A failed unit or its disk in trouble is told to the owner's phone, through
          # the server's Home Assistant (over the tailnet, so from anywhere).
          notify
        ])
        # Its own disk/boot layout, copied from /etc/nixos (the `add-machine` skill,
        # .agents/skills). It must be `git add`ed or flakes cannot see it.
        ++ [ ../../hosts/laptop/hardware-configuration.nix ];

      networking.hostName = "laptop";

      # The value this machine's first install wrote. Never "upgrade" it by hand.
      system.stateVersion = "26.05";
      # The EFI partition is at /boot and the install uses systemd-boot, which is
      # what `base` sets: no boot.loader override needed here.

      balaur = {
        # The existing login on this machine; its password is kept as is.
        user = "alex";
        # A second copy of the life log's history, fetched nightly from the keeper (it
        # runs when the laptop next wakes if it slept through the night).
        lifelog-client.mirrorFrom = "server";
        # The folder through git with the keeper (plan 005): it starts once
        # `lifelog-sync init` has made the clone here (P5).
        lifelog-client.syncWith = "server";

        # It roams onto networks nobody here owns: SSH and the Syncthing UI only
        # over the tailnet (tailscale0 is trusted), never on whatever Wi-Fi this is.
        ssh.lan = false;
        files.guiOnLan = false;
      };

      # On networks nobody here owns it does not announce its name (mDNS); nothing
      # dials `laptop.local` (the fleet uses the tailnet name).
      services.avahi.publish.enable = false;

      # No FileList credentials here: searching happens in qBittorrent, which
      # runs on the server. This machine only hands it magnets.
    };
}
