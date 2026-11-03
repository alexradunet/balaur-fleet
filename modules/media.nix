# Media server: qBittorrent (search + download, web UI) feeding Jellyfin (watch).
#
#   ${storage.root}/media/downloads   anything without a category
#   ${storage.root}/media/movies      qBittorrent category "movies"  -> Jellyfin "Movies" library
#   ${storage.root}/media/shows       qBittorrent category "shows"   -> Jellyfin "Shows" library
#
# Search: qBittorrent's own Search tab (Python is provided); add search plugins
# from the UI (Search -> Search plugins -> Install a new one). Everything else
# (libraries, users, plugins) is set in the two web UIs and kept across rebuilds.
{ config, lib, pkgs, ... }:
let
  cfg = config.duet;
  media = "${toString cfg.storage.root}/media";
  qbProfile = "/var/lib/qBittorrent";
  torrentPort = 51413;

  # Written only on first start, so changes made in the web UI stick.
  # The web UI needs no login from the LAN or the tailnet (like the dashboard).
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
lib.mkIf cfg.media.enable {
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
    serviceConfig = {
      UMask = "0002"; # files group-writable for `media` (you can tidy them over SSH)
      ExecStartPre = pkgs.writeShellScript "qbittorrent-seed" ''
        conf=${qbProfile}/qBittorrent/config
        [ -e $conf/qBittorrent.conf ] || ${pkgs.coreutils}/bin/install -Dm600 ${qbSeed} $conf/qBittorrent.conf
        [ -e $conf/categories.json ] || ${pkgs.coreutils}/bin/install -Dm644 ${qbCategories} $conf/categories.json
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

  duet.dashboard.services = [
    {
      name = "Jellyfin";
      description = "Movies & shows";
      icon = "🎬";
      port = 8096;
      unit = "jellyfin.service";
      group = "Media & files";
    }
    {
      name = "qBittorrent";
      description = "Search & download torrents";
      icon = "🧲";
      port = 8080;
      unit = "qbittorrent.service";
      group = "Media & files";
    }
  ];
}
