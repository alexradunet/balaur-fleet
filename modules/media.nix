# Media server: qBittorrent (search + download, web UI) feeding Jellyfin (watch).
#
#   ${storage.root}/media/downloads   anything without a category
#   ${storage.root}/media/movies      qBittorrent category "movies"  -> Jellyfin "Movies" library
#   ${storage.root}/media/shows       qBittorrent category "shows"   -> Jellyfin "Shows" library
#
# Search: qBittorrent's own Search tab (Python is provided). The FileList
# plugin (media-search/) is installed on every start; log in once with
# `sudo duet-filelist-login`. More plugins can be added from the UI (Search ->
# Search plugins). Everything else (libraries, users, plugins) is set in the two
# web UIs and kept across rebuilds.
{
  flake.modules.nixos.media =
    { config, lib, pkgs, ... }:
    let
      cfg = config.balaur;
      media = "${toString cfg.storage.root}/media";
      qbProfile = "/var/lib/qBittorrent";
      torrentPort = 51413;
      nova3 = "${qbProfile}/qBittorrent/data/nova3";
      # FileList username + passkey: state only, never in the repo or the store.
      filelistCredentials = "${qbProfile}/filelist.json";

      filelistLogin = pkgs.writeShellApplication {
        name = "duet-filelist-login";
        runtimeInputs = [ pkgs.coreutils pkgs.python3 pkgs.util-linux ];
        text = ''
          if [ "$(id -u)" != 0 ]; then echo "run with sudo" >&2; exit 1; fi
          read -rp "FileList username: " user
          read -rsp "FileList passkey (profile page; hidden): " passkey; echo
          # Create the file private first, then fill it; the passkey goes via stdin,
          # so it never shows up in the process list or in a temporary file.
          install -o ${config.services.qbittorrent.user} -g ${config.services.qbittorrent.group} -m 600 /dev/null ${filelistCredentials}
          printf '%s\n%s\n' "$user" "$passkey" | python3 -c '
          import json, sys
          u, p = sys.stdin.read().splitlines()[:2]
          json.dump({"username": u.strip(), "passkey": p.strip()}, sys.stdout)' > ${filelistCredentials}
          echo "Saved. Test search for \"''${1:-ubuntu}\" (as qBittorrent runs it), first 5 results:"
          cd ${nova3}
          # Collect everything first: cutting the pipe short would break the plugin's output.
          results="$(runuser -u ${config.services.qbittorrent.user} -- env FILELIST_CREDENTIALS=${filelistCredentials} \
            python3 nova2.py filelist all "''${1:-ubuntu}")"
          printf '%s\n' "$results" | head -n 5 | awk -F'|' '{ printf "  %s  (%s seeders)\n", $2, $4 }'
        '';
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
      # --- qBittorrent ---------------------------------------------------------
      services.qbittorrent = {
        enable = true;
        group = "media";
        profileDir = qbProfile;
        webuiPort = 8080;
        torrentingPort = torrentPort;
      };
      systemd.services.qbittorrent = {
        path = [ pkgs.python3 ]; # the Search tab runs Python plugins
        environment.FILELIST_CREDENTIALS = filelistCredentials;
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

      # --- Jellyfin ------------------------------------------------------------
      services.jellyfin = {
        enable = true;
        openFirewall = true; # 8096 + LAN discovery
        # Tiger Lake iGPU via Quick Sync; only seeds encoding.xml, the UI can change it later.
        hardwareAcceleration = {
          enable = true;
          type = "qsv";
          device = "/dev/dri/renderD128";
        };
      };
      users.users.jellyfin.extraGroups = [ "media" "render" "video" ];

      environment.systemPackages = [ filelistLogin ];

      hardware.graphics = {
        enable = true;
        extraPackages = [ pkgs.intel-media-driver pkgs.vpl-gpu-rt ];
      };

      # --- Shared ----------------------------------------------------------------
      systemd.tmpfiles.rules = [
        "d ${media}            2775 qbittorrent media - -"
        "d ${media}/downloads  2775 qbittorrent media - -"
        "d ${media}/movies     2775 qbittorrent media - -"
        "d ${media}/shows      2775 qbittorrent media - -"
      ];

      networking.firewall.allowedTCPPorts = [ 8080 torrentPort ];
      networking.firewall.allowedUDPPorts = [ torrentPort ];

      balaur.services = [
        {
          name = "Jellyfin";
          description = "Movies & shows";
          icon = "🎬";
          port = 8096;
          unit = "jellyfin.service";
          desktopId = "org.jellyfin.JellyfinDesktop.desktop";
          group = "Media & files";
        }
        {
          name = "qBittorrent";
          description = "Search & download torrents";
          icon = "🧲";
          port = 8080;
          unit = "qbittorrent.service";
          appIcon = "${pkgs.qbittorrent-nox.src}/dist/unix/menuicons/scalable/apps/qbittorrent.svg";
          group = "Media & files";
        }
      ];
    };
}
