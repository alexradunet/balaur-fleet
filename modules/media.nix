# Media + photos: Jellyfin and Immich, with Intel hardware transcoding.
{ config, lib, pkgs, ... }:
let
  cfg = config.duet;
  root = toString cfg.storage.root;
in
lib.mkIf cfg.media.enable {
  # One shared group owns bulk data so every service (and you) can read it.
  systemd.tmpfiles.rules = [
    "d ${root}         0755 root root  - -"
    "d ${root}/media   2775 root media - -"
    "d ${root}/media/movies 2775 root media - -"
    "d ${root}/media/shows  2775 root media - -"
    "d ${root}/media/music  2775 root media - -"
  ];

  # Comet Lake (Gen 9.5) graphics: the iHD VA-API driver does QSV/VA-API decode+encode.
  hardware.graphics = {
    enable = true;
    extraPackages = [ pkgs.intel-media-driver ];
  };
  environment.sessionVariables.LIBVA_DRIVER_NAME = "iHD";

  services.jellyfin = {
    enable = true;
    openFirewall = true;
    group = "media";
  };
  users.users.jellyfin.extraGroups = [ "video" "render" ];

  nixpkgs.config.permittedInsecurePackages = lib.optional cfg.media.immich.enable pkgs.immich.name;

  services.immich = {
    enable = cfg.media.immich.enable;
    host = "0.0.0.0";
    port = 2283;
    openFirewall = true;
    mediaLocation = "${root}/photos";
    machine-learning.enable = cfg.media.immich.machineLearning;
  };

  duet.dashboard.services = [
    {
      name = "Jellyfin";
      description = "Movies, shows, music";
      icon = "🎬";
      port = 8096;
      unit = "jellyfin.service";
      group = "Media & files";
    }
  ] ++ lib.optional cfg.media.immich.enable {
    name = "Immich";
    description = "Photos & videos";
    icon = "📷";
    port = 2283;
    unit = "immich-server.service";
    group = "Media & files";
  };
}
