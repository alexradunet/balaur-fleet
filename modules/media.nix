# Media server: Jellyfin, watching what the `torrents` aspect downloaded.
#
#   ${storage.root}/media/movies      Jellyfin "Movies" library
#   ${storage.root}/media/shows       Jellyfin "Shows" library
#   ${storage.root}/media/photos      Jellyfin "Photos" (`sudo balaur-photos-login` adds it)
#
# Serving is a separate job from downloading, so it is a separate aspect: the
# Duet does both, a laptop that only fetches things gets `torrents` alone.
# Libraries and users are set in Jellyfin's own web UI and kept across rebuilds.
{
  flake.modules.nixos.media =
    { config, pkgs, ... }:
    let
      cfg = config.balaur;
      media = "${toString cfg.storage.root}/media";
    in
    {
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

      # Quick Sync: this aspect assumes an Intel iGPU, which is what the one
      # machine serving media has. An AMD host would want radeonsi here instead.
      hardware.graphics = {
        enable = true;
        extraPackages = [ pkgs.intel-media-driver pkgs.vpl-gpu-rt ];
      };

      systemd.tmpfiles.rules = [
        # Jellyfin's own. ${media} itself and the download directories belong to
        # `torrents` (declaring it twice makes tmpfiles complain); without it,
        # tmpfiles makes the parent as a plain root directory.
        "d ${media}/photos  2775 jellyfin media - -"
      ];

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
      ];
    };
}
