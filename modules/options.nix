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
      description = "Authorized SSH public keys for the admin account (optional while password login is on).";
    };

    ssh.passwordAuth = mkOption {
      type = types.bool;
      default = true;
      description = ''
        Allow SSH logins with the account password (LAN and tailnet). Convenient
        to start with; once you have keys in `duet.sshKeys`, set this to false.
      '';
    };

    ssh.lan = mkOption {
      type = types.bool;
      default = true;
      description = ''
        Accept SSH from the local network as well as over Tailscale (subject to `duet.ssh.passwordAuth`).
        Set to false to make Tailscale the only way in; recovery is then a
        keyboard on the laptop (Ctrl+Alt+F2 for a login console).
      '';
    };

    storage.root = mkOption {
      type = types.path;
      default = "/srv";
      description = "Root for bulk data (synced files).";
    };

    dev.enable = mkEnableOption "coding on the box (Claude Code, pi, tmux, gh)" // { default = true; };

    files.enable = mkEnableOption "file sync (Syncthing)";

    network.enable = mkEnableOption "network + privacy (Tailscale, mDNS)" // { default = true; };
    network.tailscale.authKeyFile = mkOption {
      type = types.nullOr types.path;
      default = null;
      description = "File holding a Tailscale auth key. If null, run `sudo tailscale up` once by hand.";
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
