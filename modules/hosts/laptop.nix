# laptop: the Lenovo Yoga Pro 7 14APH8 the fleet is worked on from. A personal
# machine, so it gets the shared base and a normal GNOME desktop, and none of the
# Duet-only aspects: it sleeps when the lid shuts (no `always-on`), it is nobody's
# household screen (no `tablet`), it has no Duet camera and runs no house services.
# Machine-generated files (hardware-configuration.nix) live in hosts/laptop/.
{ inputs, config, ... }:
let
  aspects = config.flake.modules.nixos;
  hm = config.flake.modules.homeManager;
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
    builder = { maxJobs = 8; speedFactor = 2; };
  };

  flake.nixosConfigurations.laptop = inputs.nixpkgs.lib.nixosSystem {
    modules = [ aspects.laptop ];
  };

  flake.modules.nixos.laptop =
    { config, pkgs, ... }:
    {
      imports = (with aspects; [
        yoga-pro-7
        base
        fleet
        home
        secrets
        network
        gnome
        desktop
        dev
        files
        # torrents (the qBittorrent server) stays on balaur; this is just the
        # client, so a magnet clicked here can be sent there.
        torrents-client
        assistant
        gaming
      ])
      # Its own disk/boot layout, copied from /etc/nixos (see CLAUDE.md, "Adding a
      # machine"). It must be `git add`ed or flakes cannot see it.
      ++ [ ../../hosts/laptop/hardware-configuration.nix ];

      networking.hostName = "laptop";
      time.timeZone = "Europe/Bucharest";

      # Carried over from this install's /etc/nixos/configuration.nix.
      i18n.defaultLocale = "en_US.UTF-8";
      i18n.extraLocaleSettings = {
        LC_ADDRESS = "ro_RO.UTF-8";
        LC_IDENTIFICATION = "ro_RO.UTF-8";
        LC_MEASUREMENT = "ro_RO.UTF-8";
        LC_MONETARY = "ro_RO.UTF-8";
        LC_NAME = "ro_RO.UTF-8";
        LC_NUMERIC = "ro_RO.UTF-8";
        LC_PAPER = "ro_RO.UTF-8";
        LC_TELEPHONE = "ro_RO.UTF-8";
        LC_TIME = "ro_RO.UTF-8";
      };
      services.printing.enable = true;
      nixpkgs.config.allowUnfree = true;

      # GNOME defaults this machine does not want. The `desktop` aspect already
      # drops the ones no personal desktop needs; these are this laptop's taste,
      # so they live here. The media apps (Music, Decibels, Showtime, Snapshot)
      # are deliberately kept: a webcam check and a one-off local video file are
      # worth having even with Jellyfin on balaur.
      environment.gnome.excludePackages = with pkgs; [
        # Only useful tied to an online account, and none is set up.
        gnome-calendar
        gnome-contacts
        gnome-clocks
        gnome-weather
        gnome-maps
        # No scanner attached; remote machines are reached over SSH and Tailscale.
        simple-scan
        gnome-connections
        gnome-characters
        gnome-color-manager
      ];
      # Drops the offline manual and its "NixOS Manual" launcher. It duplicates
      # the web one, and building nixos-manual-html is a slice of every rebuild.
      documentation.nixos.enable = false;

      # The value this machine's first install wrote. Never "upgrade" it by hand.
      system.stateVersion = "26.05";
      # The EFI partition is at /boot and the install uses systemd-boot, which is
      # what `base` sets: no boot.loader override needed here.

      # The admin's own GNOME bits on top of the shared shell/git (modules/home.nix).
      home-manager.users.${config.balaur.user}.imports = [ hm.desktop hm.torrents-client ];

      balaur = {
        # The existing login on this machine; its password is kept as is.
        user = "alex";

        # It roams onto networks nobody here owns: SSH and the Syncthing UI only
        # over the tailnet (tailscale0 is trusted), never on whatever Wi-Fi this is.
        ssh.lan = false;
        files.guiOnLan = false;

        assistant = {
          # Mistral, the voices and the sops key are the aspect's defaults, and the
          # default source is this machine's ordinary microphone (audio.input = null).
          # Retune for this machine's microphone with `sudo balaur-wake-test`.
          wakeThreshold = 0.35;
        };
      };

      # No FileList credentials here: searching happens in qBittorrent, which
      # runs on balaur. This machine only hands it magnets.
    };
}
