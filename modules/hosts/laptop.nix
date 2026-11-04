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
    { config, ... }:
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
        # torrents (the qBittorrent server) stays on duet; this is just the
        # client, so a magnet clicked here can be sent there.
        torrents-client
        assistant
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

      # The value this machine's first install wrote. Never "upgrade" it by hand.
      system.stateVersion = "26.05";
      # The EFI partition is at /boot and the install uses systemd-boot, which is
      # what `base` sets: no boot.loader override needed here.

      # The admin's own GNOME bits on top of the shared shell/git (modules/home.nix).
      home-manager.users.${config.balaur.user}.imports = [ hm.desktop ];

      balaur = {
        # The existing login on this machine; its password is kept as is.
        user = "alex";

        assistant = {
          # No microphone array here: record from PipeWire's default source.
          audio.input = null;
          # Mistral (EU, Paris), the same as the Duet. The key is the fleet's one
          # sops secret, so this machine has it without anyone typing it in.
          llm = {
            baseUrl = "https://api.mistral.ai/v1";
            model = "mistral-medium-latest";
            apiKeyFile = config.sops.secrets."assistant-llm-key".path;
            manageApiKeyFile = false;
          };
          tts.voices = {
            ro = "01a155a0-3dbb-7274-ab31-7fa1ebf35a3e"; # Irina
            en = "82c99ee6-f932-423f-a4a3-d403c8914b8d"; # Jane - Neutral (British)
          };
          # Retune for this machine's microphone with `sudo duet-wake-test`.
          wakeThreshold = 0.35;
        };
      };

      # Readable by the assistant's group, which the admin account is in.
      sops.secrets."assistant-llm-key" = {
        owner = "root";
        group = "duet-assistant";
        mode = "0640";
      };

      # No FileList credentials here: searching happens in qBittorrent, which
      # runs on duet. This machine only hands it magnets.
    };
}
