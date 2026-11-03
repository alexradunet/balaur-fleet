# Samsung (Tizen) TV: remote control from the dashboard's TV tab, and
# `duet-tv-sideload` to install apps on the TV from this machine.
#
# Sideloading needs Developer Mode on the TV (Apps → 1 2 3 4 5 → On, Host PC IP =
# this machine's IP, restart the TV). It runs the community installer image
# (github.com/georift/install-jellyfin-tizen), which carries Samsung's `tizen` and
# `sdb` tools and a developer signing certificate, with rootless podman:
#
#   duet-tv-sideload dashboard   the "Duet" app (tv-app/): this dashboard on the TV
#   duet-tv-sideload jellyfin    the latest Jellyfin build (jeppevinkel/jellyfin-tizen-builds)
#
# Developer Mode can be switched off afterwards; sideloaded apps keep working.
{ config, lib, pkgs, ... }:
let
  cfg = config.duet;
  tv = cfg.tv;
  installer = "ghcr.io/georift/install-jellyfin-tizen:latest";

  sideload = pkgs.writeShellApplication {
    name = "duet-tv-sideload";
    runtimeInputs = [ pkgs.podman pkgs.coreutils pkgs.curl pkgs.gnused ];
    text = ''
      tv=${lib.escapeShellArg tv.host}
      what="''${1:-}"
      work="$(mktemp -d)"
      trap 'rm -rf "$work"' EXIT

      # Sign with the image's developer profile ("dev") and install; $1 is a
      # widget directory or a .wgt file under /work.
      install_in_image() {
        podman run --rm --network host -v "$work":/work:ro --entrypoint bash ${installer} -c '
          set -euo pipefail
          sdb connect "$0" >/dev/null
          name=$(sdb devices | grep -E "device\s+\w+[-]?\w+" -o | sed "s/device//" | xargs)
          [ -n "$name" ] || { echo "The TV did not accept the connection: is Developer Mode on, with Host PC IP set to this machine?" >&2; exit 1; }
          echo "Connected to $name"
          mkdir -p /tmp/out
          cp -r "/work/$1" /tmp/
          tizen package -t wgt -s dev -o /tmp/out -- "/tmp/$1"
          cd /tmp/out
          tizen install -n "$(ls ./*.wgt | head -n1 | xargs basename)" -t "$name"
        ' "$tv" "$1"
      }

      case "$what" in
        jellyfin)
          exec podman run --rm --network host ${installer} "$tv"
          ;;
        dashboard)
          cp -r ${../tv-app} "$work/app"
          chmod -R u+w "$work/app"
          sed -i "s|__DASHBOARD_URL__|${tv.dashboardUrl}|" "$work/app/main.js"
          install_in_image app
          ;;
        *)
          echo "usage: duet-tv-sideload dashboard|jellyfin" >&2
          exit 2
          ;;
      esac
    '';
  };
in
lib.mkIf tv.enable {
  environment.systemPackages = [ sideload ];

  # Rootless podman for the installer image (policy.json, registries).
  virtualisation.containers.enable = true;

  # The remote-control token the TV hands out after "Allow" (dashboard reads $STATE_DIRECTORY).
  systemd.services.duet-dashboard.serviceConfig.StateDirectory = "duet-dashboard";

  duet.tv.apps = lib.mkBefore (
    lib.optional cfg.media.enable { name = "Jellyfin"; id = "AprZAARz4r.Jellyfin"; icon = "🎬"; }
  );
}
