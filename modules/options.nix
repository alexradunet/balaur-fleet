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

    dev.enable = mkEnableOption "coding on the box (Claude Code, pi, herdr, gh)" // { default = true; };

    files.enable = mkEnableOption "file sync (Syncthing)";

    media.enable = mkEnableOption "media server: Jellyfin + qBittorrent (search & download), under storage.root/media";

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

    camera = {
      enable = mkEnableOption "front camera (patched kernel modules + webcam relay) with a live preview in the kiosk corner";

      backend = mkOption {
        type = types.enum [ "rgbir" "libcamera" ];
        default = "rgbir";
        description = ''
          How raw sensor frames become a webcam.
          `rgbir`: duet-camera (camera/), which treats the sensor as the RGB-IR
          part it is: rebuilds R/G/B, subtracts infrared, then auto white
          balance, colour matrix, gamma and auto exposure.
          `libcamera`: libcamera's software ISP via GStreamer. It reads the
          sensor as plain Bayer, which gives the yellow-green tint; kept as a
          fallback.
        '';
      };

      screenTimeout = mkOption {
        type = types.ints.unsigned;
        default = 120;
        description = ''
          Seconds without movement in front of the camera (or a touch or key)
          before the built-in screen's backlight goes off; it comes back on at
          the next movement or touch. The tap that wakes the screen is not
          passed on to the dashboard. 0 = screen always on.
          Needs the `rgbir` backend. Sensitivity: `tuning.motionThreshold`
          (luma change per cell, default 12) and `tuning.motionArea` (fraction
          of the picture, default 0.01); the relay logs the peak it saw every 30 s.
        '';
      };

      tuning = mkOption {
        type = types.attrsOf types.anything;
        default = { };
        example = {
          cfa = "GIGI/RGBG/GIGI/BGRG";
          irCoeffs = [ 1.0 0.9 1.1 ];
          flipV = true;
        };
        description = ''
          Overrides for the rgbir pipeline, written to /etc/duet-camera.json.
          Keys: sensor, capture, width, height, outWidth, outHeight, cfa,
          blackLevel, whiteLevel, irCoeffs, ccm, awbGains, saturation, flipH,
          flipV, view (color/raw/noir), aeTarget, maxGain, maxDigitalGain,
          antiFlicker, motionThreshold, motionArea. Defaults are in
          camera/config.go. Try values live first in
          /var/lib/duet-camera/tuning.json + `systemctl reload duet-camera-relay`.
        '';
      };
    };

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
