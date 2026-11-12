# DLNA: MiniDLNA serves folders of video, music and pictures to the players on the
# home network (a TV, a headset, VLC on a phone), which find it by themselves.
#
# It serves the files as they are, with no transcoding and no library to curate:
# next to nothing on the CPU, and the player must know the format. Jellyfin
# (`media`) is the server for what should be transcoded or kept as a library.
#
# DLNA has no login: whoever is on the home network can browse and play what is
# listed in `balaur.dlna.dirs`. The machine with this aspect stays at home.
#
# http://<host>:8200 is its status page (how many files, which players).
{
  flake.modules.nixos.dlna =
    { config, lib, ... }:
    let
      cfg = config.balaur.dlna;
    in
    {
      options.balaur.dlna = {
        dirs = lib.mkOption {
          type = lib.types.listOf lib.types.str;
          default = [ ];
          example = [
            "/srv/media/movies"
            "V,/mnt/disk/Home videos"
          ];
          description = ''
            The folders to serve, with everything under them. They must be readable
            by anyone on this machine (the `minidlna` user). An `A,`, `V,` or `P,`
            in front keeps a folder to its audio, video or pictures.
          '';
        };
        port = lib.mkOption {
          type = lib.types.port;
          default = 8200;
          description = "The port the players fetch from, and the status page.";
        };
      };

      config = {
        services.minidlna = {
          enable = true;
          # The players are devices of the home network, outside the tailnet: the
          # port above, and 1900/udp for the SSDP search they find the server with.
          openFirewall = true;
          settings = {
            media_dir = cfg.dirs;
            port = cfg.port;
            # A file added to a folder appears without a restart. Watches cost
            # nothing while the folder is still.
            inotify = "yes";
          };
        };

        # A folder on a disk of its own (`nofail`): start once it is mounted, and
        # not at all without it, rather than serve an empty mount point and forget
        # the index. Quoted, because such paths have spaces.
        systemd.services.minidlna.unitConfig.RequiresMountsFor = map (
          dir: ''"${lib.removePrefix "A," (lib.removePrefix "V," (lib.removePrefix "P," dir))}"''
        ) cfg.dirs;

        balaur.services = [
          {
            name = "DLNA";
            description = "Folders for the TV and other players";
            icon = "📺";
            port = cfg.port;
            unit = "minidlna.service";
            group = "Media & files";
          }
        ];
      };
    };
}
