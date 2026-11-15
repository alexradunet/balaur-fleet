# laptop: the Lenovo Yoga Pro 7 14APH8 the fleet is worked on from. A personal
# machine, so it gets the shared base and a normal GNOME desktop, and none of the
# Duet-only aspects: it sleeps when the lid shuts (no `always-on`), it is nobody's
# household screen (no `tablet`), it has no Duet camera and runs no house services.
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
    # The cockpit is also the fleet's builder: 8 cores / 16 threads against the
    # Duet's 4 / 8, and the Duet is busy being the living-room screen. 8 jobs
    # leaves half the threads for whoever is actually using this laptop.
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
          # pi, the OS agent: knows the fleet, asks the other machines' agents (balaur-ask).
          agent
          # This machine's own.
          # The life log as files: the folder, `lifelog`, Obsidian, and the nightly mirror of
          # the keeper's history from the server (balaur.lifelog-client.mirrorFrom below).
          lifelog-client
          # WoW, on the RTX 5060 Ti in its USB4 dock when it is plugged in.
          nvidia-egpu
          gaming
          # What to craft, buy and sell in WoW: Forever, from Auctionator's scans.
          wow-market
          # One click to the server's desktop over RDP (an app per machine with `remote-desktop`).
          remote-desktop-client
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

        # It roams onto networks nobody here owns: SSH and the Syncthing UI only
        # over the tailnet (tailscale0 is trusted), never on whatever Wi-Fi this is.
        ssh.lan = false;
        files.guiOnLan = false;
      };

      # No FileList credentials here: searching happens in qBittorrent, which
      # runs on the tablet. This machine only hands it magnets.
    };
}
