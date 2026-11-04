# Torrents: qBittorrent with FileList search, on any machine that should be able
# to download. Separate from `media` (Jellyfin), because downloading and serving
# are different jobs: the Duet does both, the laptop only the first.
#
#   ${storage.root}/media/downloads   anything without a category
#   ${storage.root}/media/movies      category "movies"  -> Jellyfin "Movies"
#   ${storage.root}/media/shows       category "shows"   -> Jellyfin "Shows"
#
# Search is qBittorrent's own Search tab; the FileList plugin (media-search/) is
# installed on every start and reads its credentials from a JSON file named by
# `balaur.torrents.filelistCredentialsFile`. Point that at a sops secret to have
# it come from the repo (see modules/hosts/*.nix); the default is local state
# written by `sudo duet-filelist-login`.
#
# `balaur-torrent` sends a magnet, URL or .torrent to *any* machine in the fleet
# that runs this aspect, so you can sit at the laptop and choose whether a
# download lands there or on the Duet. The candidates come from the registry's
# `torrentsPort`.
{ config, ... }:
let
  fleet = config.fleet;
in
{
  flake.modules.nixos.torrents =
    { config, lib, pkgs, ... }:
    let
      cfg = config.balaur;
      media = "${toString cfg.storage.root}/media";
      qbProfile = "/var/lib/qBittorrent";
      torrentPort = 51413;
      webuiPort = 8080;
      nova3 = "${qbProfile}/qBittorrent/data/nova3";
      credentials = toString cfg.torrents.filelistCredentialsFile;

      # Every machine that can take a download, this one included.
      me = config.networking.hostName;
      targets = lib.filterAttrs (_: h: h.torrentsPort != null) fleet;
      targetNames = lib.attrNames targets;
      # "name:host:port" — localhost for ourselves, so it works with no network.
      targetSpecs = lib.mapAttrsToList
        (name: h: "${name}:${if name == me then "127.0.0.1" else name}:${toString h.torrentsPort}")
        targets;

      filelistLogin = pkgs.writeShellApplication {
        name = "duet-filelist-login";
        runtimeInputs = [ pkgs.coreutils pkgs.python3 pkgs.util-linux ];
        text = ''
          if [ "$(id -u)" != 0 ]; then echo "run with sudo" >&2; exit 1; fi
          ${
            if cfg.torrents.manageFilelistCredentials then ''
              read -rp "FileList username: " user
              read -rsp "FileList passkey (profile page; hidden): " passkey; echo
              # Create the file private first, then fill it; the passkey goes via stdin,
              # so it never shows up in the process list or in a temporary file.
              install -o ${config.services.qbittorrent.user} -g ${config.services.qbittorrent.group} -m 600 /dev/null ${credentials}
              printf '%s\n%s\n' "$user" "$passkey" | python3 -c '
              import json, sys
              u, p = sys.stdin.read().splitlines()[:2]
              json.dump({"username": u.strip(), "passkey": p.strip()}, sys.stdout)' > ${credentials}
              echo "Saved."
            '' else ''
              # Nothing to type: sops renders the credentials from the repo. Asking
              # for them here would only invite someone to type a passkey that gets
              # thrown away. This is a test of what is actually deployed.
              echo "This machine takes the FileList credentials from sops. To change them:"
              echo "    sops secrets/balaur.yaml      (filelist-username, filelist-passkey)"
              echo "  then rebuild. Testing the search with what is deployed now:"
            ''
          }
          echo "Test search for \"''${1:-ubuntu}\" (as qBittorrent runs it), first 5 results:"
          cd ${nova3}
          # Collect everything first: cutting the pipe short would break the plugin's output.
          results="$(runuser -u ${config.services.qbittorrent.user} -- env FILELIST_CREDENTIALS=${credentials} \
            python3 nova2.py filelist all "''${1:-ubuntu}")"
          printf '%s\n' "$results" | head -n 5 | awk -F'|' '{ printf "  %s  (%s seeders)\n", $2, $4 }'
        '';
      };

      # Send a magnet / URL / .torrent to whichever machine should do the work.
      # The web UI authenticates LAN and tailnet callers by subnet (see qbSeed),
      # so there is no password to carry around; a 403 means that lapsed.
      sendTorrent = pkgs.writeShellApplication {
        name = "balaur-torrent";
        runtimeInputs = [ pkgs.coreutils pkgs.curl pkgs.gnugrep pkgs.zenity ];
        text = ''
          specs=(${lib.escapeShellArgs targetSpecs})
          usage() {
            echo "usage: balaur-torrent [--host ${lib.concatStringsSep "|" targetNames}] [--category NAME] <magnet|url|file>..." >&2
            echo "       balaur-torrent --list" >&2
          }

          host=""; category=""; items=()
          while [ $# -gt 0 ]; do
            case "$1" in
              --host) host="''${2:-}"; shift 2 ;;
              --category) category="''${2:-}"; shift 2 ;;
              --list) printf '%s\n' "''${specs[@]}" | tr ':' ' ' | awk '{printf "%-10s %s:%s\n", $1, $2, $3}'; exit 0 ;;
              -h|--help) usage; exit 0 ;;
              -*) usage; exit 1 ;;
              *) items+=("$1"); shift ;;
            esac
          done
          [ ''${#items[@]} -gt 0 ] || { usage; exit 1; }

          # No target given: ask. Graphical when there is a session to ask in,
          # since this is also the magnet-link handler.
          if [ -z "$host" ]; then
            if [ ''${#specs[@]} -eq 1 ]; then
              host="''${specs[0]%%:*}"
            elif [ -n "''${WAYLAND_DISPLAY:-}''${DISPLAY:-}" ]; then
              names=()
              for s in "''${specs[@]}"; do names+=("''${s%%:*}"); done
              host="$(zenity --list --title="Download on" \
                --text="Which machine should download this?" \
                --column="Machine" "''${names[@]}" 2>/dev/null)" || exit 1
              [ -n "$host" ] || exit 1
            else
              echo "Download on which machine?" >&2
              i=1
              for s in "''${specs[@]}"; do echo "  $i) ''${s%%:*}" >&2; i=$((i+1)); done
              read -rp "> " pick
              host="$(printf '%s\n' "''${specs[@]}" | sed -n "''${pick}p" | cut -d: -f1)"
              [ -n "$host" ] || { echo "no such choice" >&2; exit 1; }
            fi
          fi

          addr=""; port=""
          for s in "''${specs[@]}"; do
            if [ "''${s%%:*}" = "$host" ]; then
              addr="$(printf '%s' "$s" | cut -d: -f2)"; port="$(printf '%s' "$s" | cut -d: -f3)"
            fi
          done
          [ -n "$addr" ] || { echo "unknown machine: $host" >&2; usage; exit 1; }

          api="http://$addr:$port/api/v2/torrents/add"
          for item in "''${items[@]}"; do
            if [ -f "$item" ]; then
              out="$(curl -fsS -X POST "$api" -F "torrents=@$item" \
                ''${category:+-F "category=$category"} 2>&1)" || {
                  echo "$host: refused $item ($out)" >&2; exit 1; }
            else
              out="$(curl -fsS -X POST "$api" --data-urlencode "urls=$item" \
                ''${category:+--data-urlencode "category=$category"} 2>&1)" || {
                  echo "$host: refused $item ($out)" >&2; exit 1; }
            fi
            echo "$host: queued ''${item:0:60}''${category:+ (category $category)}"
          done
        '';
      };

      # Registers balaur-torrent as a handler for magnet: links, without putting
      # another icon in the app grid.
      magnetHandler = pkgs.makeDesktopItem {
        name = "balaur-torrent";
        desktopName = "Download with Balaur";
        comment = "Send this torrent to a machine in the fleet";
        exec = "${lib.getExe sendTorrent} %u";
        icon = "qbittorrent";
        categories = [ "Network" ];
        mimeTypes = [ "x-scheme-handler/magnet" "application/x-bittorrent" ];
        noDisplay = true;
      };

      # Written only on first start, so changes made in the web UI stick.
      # The web UI needs no login from the LAN or the tailnet (convenient on a home LAN; do not port-forward it).
      qbSeed = pkgs.writeText "qBittorrent.conf" ''
        [LegalNotice]
        Accepted=true

        [BitTorrent]
        Session\DefaultSavePath=${media}/downloads
        Session\TempPathEnabled=false
        Session\Port=${toString torrentPort}
        Session\GlobalMaxRatio=2
        Session\QueueingSystemEnabled=true

        [Preferences]
        WebUI\AuthSubnetWhitelistEnabled=true
        WebUI\AuthSubnetWhitelist=127.0.0.0/8, 10.0.0.0/8, 172.16.0.0/12, 192.168.0.0/16, 100.64.0.0/10, fd7a:115c:a1e0::/48
        WebUI\LocalHostAuth=false
        WebUI\HostHeaderValidation=false
        WebUI\CSRFProtection=false
      '';
      qbCategories = pkgs.writeText "categories.json" (builtins.toJSON {
        movies = { save_path = "${media}/movies"; };
        shows = { save_path = "${media}/shows"; };
      });
    in
    {
      options.balaur.torrents = {
        filelistCredentialsFile = lib.mkOption {
          type = lib.types.path;
          default = "${qbProfile}/filelist.json";
          description = ''
            JSON file holding `{"username": ..., "passkey": ...}` for the FileList
            search plugin. By default this machine's own state, written by
            `sudo duet-filelist-login`; point it at a sops template to have it
            rendered from the repo instead.
          '';
        };
        manageFilelistCredentials = lib.mkOption {
          type = lib.types.bool;
          default = true;
          description = ''
            Whether `duet-filelist-login` writes `filelistCredentialsFile`. Set
            false when sops renders it: the command then still runs a test search
            with the deployed credentials, but says where the real ones belong.
          '';
        };
      };

      config = {
        services.qbittorrent = {
          enable = true;
          group = "media";
          profileDir = qbProfile;
          inherit webuiPort;
          torrentingPort = torrentPort;
        };
        systemd.services.qbittorrent = {
          path = [ pkgs.python3 ]; # the Search tab runs Python plugins
          environment.FILELIST_CREDENTIALS = credentials;
          serviceConfig = {
            UMask = "0002"; # files group-writable for `media` (you can tidy them over SSH)
            ExecStartPre = pkgs.writeShellScript "qbittorrent-seed" ''
              conf=${qbProfile}/qBittorrent/config
              [ -e $conf/qBittorrent.conf ] || ${pkgs.coreutils}/bin/install -Dm600 ${qbSeed} $conf/qBittorrent.conf
              [ -e $conf/categories.json ] || ${pkgs.coreutils}/bin/install -Dm644 ${qbCategories} $conf/categories.json
              # Always the current version of our search plugin.
              ${pkgs.coreutils}/bin/install -Dm644 ${./media-search/filelist.py} ${nova3}/engines/filelist.py
            '';
            ReadWritePaths = [ media ];
          };
        };

        environment.systemPackages = [ filelistLogin sendTorrent magnetHandler ];

        systemd.tmpfiles.rules = [
          "d ${media}            2775 qbittorrent media - -"
          "d ${media}/downloads  2775 qbittorrent media - -"
          "d ${media}/movies     2775 qbittorrent media - -"
          "d ${media}/shows      2775 qbittorrent media - -"
        ];

        networking.firewall.allowedTCPPorts = [ webuiPort torrentPort ];
        networking.firewall.allowedUDPPorts = [ torrentPort ];

        balaur.services = [
          {
            name = "qBittorrent";
            description = "Search & download torrents";
            icon = "🧲";
            port = webuiPort;
            unit = "qbittorrent.service";
            appIcon = "${pkgs.qbittorrent-nox.src}/dist/unix/menuicons/scalable/apps/qbittorrent.svg";
            group = "Media & files";
          }
        ];
      };
    };
}
