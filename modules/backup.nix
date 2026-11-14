# Backups: restic, every night, of the state that exists on one machine only and
# that no rebuild can bring back: what was set up in the services' own web UIs,
# and aminte's snapshots. Everything else is either declared in this repo or
# already on more than one machine (the Syncthing folder, with its versions).
#
# What it backs up is found from the aspects on the machine, so adding a service
# does not mean editing a list here:
#
#   home-assistant   /var/lib/hass, without the recorder's history database
#   aminte           its nightly snapshots (consistent copies of life.db)
#   adblock          AdGuard Home's settings and statistics
#   media            Jellyfin's users, libraries and watch state (not its caches)
#   torrents         qBittorrent's settings and the torrents it is seeding
#
# Off the machine, and in Europe: the repository is an off-site restic repository
# (an SFTP server such as a Hetzner Storage Box, or an S3 bucket at a European
# provider). Its password and any credentials come from this machine's own sops
# file (modules/secrets.nix); the password also decrypts the backups, so it
# lives in a second place too (the admin's password manager).
#
#   sudo systemctl start restic-backups-balaur    back up now
#   sudo restic-balaur snapshots                  what is there
#   sudo restic-balaur restore latest --target /tmp/r --include /var/lib/hass/configuration.yaml
{
  flake.modules.nixos.backup =
    {
      config,
      lib,
      ...
    }:
    let
      cfg = config.balaur.backup;
      has = name: config.balaur ? ${name};
      found =
        lib.optionals (has "aminte") [ "/var/lib/aminte/snapshots" ]
        ++ lib.optionals config.services.home-assistant.enable [ config.services.home-assistant.configDir ]
        ++ lib.optionals config.services.adguardhome.enable [ "/var/lib/private/AdGuardHome" ]
        ++ lib.optionals config.services.jellyfin.enable [ config.services.jellyfin.dataDir ]
        ++ lib.optionals config.services.qbittorrent.enable [ "/var/lib/qBittorrent/qBittorrent" ];
    in
    {
      options.balaur.backup = {
        repository = lib.mkOption {
          type = lib.types.str;
          example = "sftp:u123456@u123456.your-storagebox.de:/balaur";
          description = "The restic repository, off this machine.";
        };
        passwordFile = lib.mkOption {
          type = lib.types.path;
          description = "File with the repository's password (a sops secret).";
        };
        environmentFile = lib.mkOption {
          type = lib.types.nullOr lib.types.path;
          default = null;
          description = "Environment file with the storage's credentials (an S3 provider's keys), if it needs any.";
        };
        extraPaths = lib.mkOption {
          type = lib.types.listOf lib.types.str;
          default = [ ];
          description = "More paths to back up, beyond what the machine's aspects bring.";
        };
      };

      config = {
        assertions = [
          {
            assertion = found ++ cfg.extraPaths != [ ];
            message = "the `backup` aspect found nothing to back up on ${config.networking.hostName}";
          }
        ];

        services.restic.backups.balaur = {
          inherit (cfg) repository passwordFile environmentFile;
          initialize = true;
          paths = found ++ cfg.extraPaths;
          exclude = [
            # Home Assistant's history: large, live SQLite, and rebuilt by running.
            "/var/lib/hass/home-assistant_v2.db*"
            "/var/lib/hass/backups"
            # Jellyfin's caches, rebuilt from the library.
            "${config.services.jellyfin.dataDir}/metadata"
            "${config.services.jellyfin.dataDir}/transcodes"
            # qBittorrent's logs.
            "/var/lib/qBittorrent/qBittorrent/data/logs"
          ];
          # SFTP over the machine's own SSH host key, like everything else here:
          # put its public half (fleet.nix, sshHostKey) on the storage server.
          extraOptions = lib.optional (lib.hasPrefix "sftp:" cfg.repository) "sftp.args='-i /etc/ssh/ssh_host_ed25519_key -o BatchMode=yes'";
          timerConfig = {
            OnCalendar = "04:30"; # after aminte's 03:17 snapshot
            Persistent = true;
            RandomizedDelaySec = "15min";
          };
          pruneOpts = [
            "--keep-daily 7"
            "--keep-weekly 4"
            "--keep-monthly 6"
          ];
          # A weekly-sized sample of the data is read back and checked, every night.
          checkOpts = [ "--read-data-subset=1/7" ];
        };

        # Low priority: it runs at night, but never in the way of the household.
        systemd.services.restic-backups-balaur.serviceConfig = {
          Nice = 19;
          IOSchedulingClass = "idle";
        };
      };
    };
}
