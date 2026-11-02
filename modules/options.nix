# Central `duet.*` options. Every feature module reads from here, and
# registers the services it runs on the dashboard via `duet.dashboard.services`.
{ lib, ... }:
let
  inherit (lib) mkOption mkEnableOption types;
in
{
  options.duet = {
    user = mkOption {
      type = types.str;
      default = "duet";
      description = "Admin account (SSH + sudo).";
    };

    sshKeys = mkOption {
      type = types.listOf types.str;
      default = [ ];
      description = "Authorized SSH public keys for the admin account. Password SSH login is disabled.";
    };

    ssh.lan = mkOption {
      type = types.bool;
      default = true;
      description = ''
        Accept SSH from the local network as well as over Tailscale (key-only).
        Set to false to make Tailscale the only way in; recovery is then a
        keyboard on the laptop (Ctrl+Alt+F2 for a login console).
      '';
    };

    storage.root = mkOption {
      type = types.path;
      default = "/srv";
      description = "Root for bulk data: media, photos and synced files.";
    };

    media.enable = mkEnableOption "media + photos (Jellyfin, Immich)" // { default = true; };
    media.immich.enable = mkOption {
      type = types.bool;
      default = false;
      description = ''
        Photos via Immich. OFF by default: nixpkgs 26.05 marks Immich 2.x as
        insecure (known CVEs, no further 2.x updates; 3.x lands in 26.11).
        Enabling this explicitly permits that package. Only expose it to
        the LAN/tailnet, never the open internet.
      '';
    };
    media.immich.machineLearning = mkOption {
      type = types.bool;
      default = true;
      description = "Run Immich's ML (faces/search). Heavy on a U-series CPU during the initial import.";
    };

    files.enable = mkEnableOption "file sync (Syncthing)";

    network.enable = mkEnableOption "network + privacy (Tailscale, mDNS)" // { default = true; };
    network.tailscale.authKeyFile = mkOption {
      type = types.nullOr types.path;
      default = null;
      description = "File holding a Tailscale auth key. If null, run `sudo tailscale up` once by hand.";
    };

    homeAutomation.enable = mkEnableOption "home automation (Home Assistant, MQTT)" // { default = true; };
    homeAutomation.zigbee = {
      enable = mkEnableOption "Zigbee2MQTT (needs a Zigbee USB coordinator)";
      serialPort = mkOption {
        type = types.str;
        default = "/dev/serial/by-id/CHANGE-ME";
        description = "Path to the coordinator, ideally under /dev/serial/by-id.";
      };
    };

    power.chargeLimit = mkOption {
      type = types.nullOr (types.ints.between 50 100);
      default = 80;
      description = ''
        Battery charge ceiling in percent. The laptop battery acts as a small
        UPS; holding it at 80% keeps it healthy for years of 24/7 mains use.
        Best effort: applied only if the firmware exposes a control for it.
      '';
    };

    kiosk.enable = mkEnableOption "touch kiosk on the built-in screen" // { default = true; };

    dashboard = {
      listen = mkOption {
        type = types.str;
        default = "0.0.0.0:80";
        description = "Address the dashboard binds to.";
      };
      services = mkOption {
        default = [ ];
        description = "Tiles shown on the dashboard. Feature modules append to this.";
        type = types.listOf (types.submodule {
          options = {
            name = mkOption { type = types.str; };
            description = mkOption { type = types.str; default = ""; };
            icon = mkOption { type = types.str; default = "•"; };
            port = mkOption { type = types.nullOr types.port; default = null; };
            path = mkOption { type = types.str; default = ""; };
            unit = mkOption {
              type = types.str;
              default = "";
              description = "systemd unit whose state is shown on the tile.";
            };
            group = mkOption { type = types.str; default = "Other"; };
          };
        });
      };
    };
  };
}
