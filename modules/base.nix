# Baseline: boot, users, SSH, Nix, housekeeping.
{
  flake.modules.nixos.base =
    { config, lib, pkgs, ... }:
    let
      cfg = config.balaur;
    in
    {
      options.balaur = {
        user = lib.mkOption {
          type = lib.types.str;
          default = "duet";
          description = "Admin account (SSH + sudo).";
        };

        sshKeys = lib.mkOption {
          type = lib.types.listOf lib.types.str;
          default = [ ];
          description = "Authorized SSH public keys for the admin account (optional while password login is on).";
        };

        ssh.passwordAuth = lib.mkOption {
          type = lib.types.bool;
          default = true;
          description = ''
            Allow SSH logins with the account password (LAN and tailnet). Convenient
            to start with; once you have keys in `balaur.sshKeys`, set this to false.
          '';
        };

        ssh.lan = lib.mkOption {
          type = lib.types.bool;
          default = true;
          description = ''
            Accept SSH from the local network as well as over Tailscale (subject to `balaur.ssh.passwordAuth`).
            Set to false to make Tailscale the only way in; recovery is then a
            keyboard on the laptop (Ctrl+Alt+F3 for a login console).
          '';
        };

        # Where the home is: the weather (the assistant's tool, the ambient screen).
        location = {
          name = lib.mkOption { type = lib.types.str; default = "Bucharest"; description = "Home location, for weather and context."; };
          latitude = lib.mkOption { type = lib.types.float; default = 44.4268; };
          longitude = lib.mkOption { type = lib.types.float; default = 26.1025; };
        };

        storage.root = lib.mkOption {
          type = lib.types.path;
          default = "/srv";
          description = "Root for bulk data (synced files).";
        };

        services = lib.mkOption {
          default = [ ];
          description = ''
            The home's services, as listed on the Balaur app's Home page (written to
            /etc/duet/services.json by the `fleet` aspect, together with the web UIs
            of the other machines). Feature modules append to this.
          '';
          type = lib.types.listOf (lib.types.submodule ({ config, ... }: {
            options = {
              name = lib.mkOption { type = lib.types.str; };
              description = lib.mkOption { type = lib.types.str; default = ""; };
              icon = lib.mkOption { type = lib.types.str; default = "•"; description = "An icon name, a file, or an emoji."; };
              port = lib.mkOption { type = lib.types.nullOr lib.types.port; default = null; description = "Its web UI on this machine, if any."; };
              path = lib.mkOption { type = lib.types.str; default = ""; };
              unit = lib.mkOption {
                type = lib.types.str;
                default = "";
                description = "systemd unit whose state the app shows; `user:<unit>` for a unit of the household session (the voice assistant).";
              };
              group = lib.mkOption { type = lib.types.str; default = "Other"; };
              appIcon = lib.mkOption {
                type = lib.types.nullOr lib.types.str;
                default = null;
                description = "Icon (name or file) for installing the service's web UI as a GNOME web app (GNOME Web's application mode); null = no app.";
              };
              desktopId = lib.mkOption {
                type = lib.types.nullOr lib.types.str;
                default = null;
                description = "The GNOME app that opens this service (a desktop file id); a web app from appIcon fills it in.";
              };
              webAppId = lib.mkOption {
                type = lib.types.str;
                internal = true;
                readOnly = true;
                default = "duet-web-" + lib.toLower (lib.replaceStrings [ " " ] [ "-" ] config.name);
                description = "Desktop file id (without .desktop) of its web app, where `tablet` installs one.";
              };
            };
          }));
        };
      };

      config = {
        boot.loader.systemd-boot = {
          enable = true;
          configurationLimit = 10;
        };
        boot.loader.efi.canTouchEfiVariables = true;

        # Quiet boot: the built-in screen is an appliance display, not a console.
        boot.plymouth.enable = true;
        boot.consoleLogLevel = 0;
        boot.initrd.verbose = false;
        boot.kernelParams = [ "quiet" "loglevel=3" "udev.log_level=3" ];

        zramSwap.enable = true;
        services.fstrim.enable = true;
        services.journald.extraConfig = "SystemMaxUse=500M";

        users.mutableUsers = true;
        users.users.${cfg.user} = {
          isNormalUser = true;
          extraGroups = [ "wheel" "networkmanager" "media" ];
          openssh.authorizedKeys.keys = cfg.sshKeys;
        };
        users.groups.media = { };

        services.openssh = {
          enable = true;
          # Port 22 is open on tailscale0 (trusted interface) always, and on the
          # LAN too while balaur.ssh.lan is true (the default).
          openFirewall = cfg.ssh.lan;
          settings = {
            PasswordAuthentication = cfg.ssh.passwordAuth;
            KbdInteractiveAuthentication = false;
            PermitRootLogin = "no";
          };
        };

        warnings = lib.optional (cfg.sshKeys == [ ] && !cfg.ssh.passwordAuth && !config.services.tailscale.enable)
          "SSH password login is off, no sshKeys are set and Tailscale is disabled: remote login is impossible.";

        nix.settings = {
          experimental-features = [ "nix-command" "flakes" ];
          trusted-users = [ "root" "@wheel" ];
          auto-optimise-store = true;
        };
        nix.gc = {
          automatic = true;
          dates = "weekly";
          options = "--delete-older-than 30d";
        };

        environment.systemPackages = with pkgs; [
          git
          vim
          htop
          btop
          ncdu
          jq
          curl
          smartmontools
          pciutils
          usbutils
        ];

        system.stateVersion = lib.mkDefault "26.05"; # match what your first install used
      };
    };
}
