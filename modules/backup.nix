# Backups: restic, every night, of the state that exists on one machine only and
# that no rebuild can bring back: what was set up in the services' own web UIs,
# and the life log's history. Everything else is either declared in this repo or
# already on more than one machine (the Syncthing folder, with its versions).
#
# What it backs up is found from the aspects on the machine, so adding a service
# does not mean editing a list here:
#
#   home-assistant   /var/lib/hass, without the recorder's history database
#   lifelog          the keeper's git history of the life folder (the folder itself
#                    is on every machine that has a lifelog aspect)
#   torrents         qBittorrent's settings and the torrents it is seeding
#
# Off the machine, and in Europe. Either the repository is itself off-site (an
# SFTP server such as a Hetzner Storage Box, or an S3 bucket at a European
# provider), or it is a folder on another disk of this machine that something else
# copies away: on the server, /srv/proton/restic-backup, on the second NVMe, which
# `proton-drive` mirrors to Proton Drive every hour (`balaur.backup.owner` makes it
# readable by that sync). A folder repository is used only when its disk is mounted.
# Its password and any credentials come from this machine's own sops file
# (modules/secrets.nix); the password also decrypts the backups, so it lives in a
# second place too (the admin's password manager):
#   sops -d --extract '["restic-password"]' secrets/hosts/server.yaml
#
#   sudo systemctl start restic-backups-balaur    back up now
#   sudo restic-balaur snapshots                  what is there
#   sudo restic-balaur restore latest --target /tmp/r --include /var/lib/hass/configuration.yaml
{
  flake.modules.nixos.backup =
    {
      config,
      lib,
      pkgs,
      ...
    }:
    let
      cfg = config.balaur.backup;
      # A folder on this machine, not `sftp:`, `s3:` and the like.
      local = lib.hasPrefix "/" cfg.repository;
      chown = "${lib.getExe' pkgs.coreutils "chown"} -R ${cfg.owner}:users ${lib.escapeShellArg cfg.repository}";
      has = name: config.balaur ? ${name};
      found =
        lib.optionals (has "lifelog") [ "/var/lib/lifelog/life.git" ]
        ++ lib.optionals config.services.home-assistant.enable [ config.services.home-assistant.configDir ]
        ++ lib.optionals config.services.qbittorrent.enable [ "/var/lib/qBittorrent/qBittorrent" ];
    in
    {
      options.balaur.backup = {
        repository = lib.mkOption {
          type = lib.types.str;
          example = "sftp:u123456@u123456.your-storagebox.de:/balaur";
          description = "The restic repository: off this machine, or a folder on another disk that is copied away.";
        };
        owner = lib.mkOption {
          type = lib.types.nullOr lib.types.str;
          default = null;
          example = "alex";
          description = "For a folder repository: the account that must be able to read it (the one whose sync copies it away). restic runs as root and would leave it root's alone.";
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
            assertion = cfg.owner == null || local;
            message = "balaur.backup.owner is for a folder repository";
          }
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
            # qBittorrent's logs.
            "/var/lib/qBittorrent/qBittorrent/data/logs"
          ];
          # SFTP over the machine's own SSH host key, like everything else here:
          # put its public half (fleet.nix, sshHostKey) on the storage server.
          extraOptions = lib.optional (lib.hasPrefix "sftp:" cfg.repository) "sftp.args='-i /etc/ssh/ssh_host_ed25519_key -o BatchMode=yes'";
          timerConfig = {
            OnCalendar = "04:30";
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
          # The folder is the owner's before restic first writes into it and after
          # every run, whatever the run ended with.
          backupPrepareCommand = lib.mkIf (cfg.owner != null) ''
            ${lib.getExe' pkgs.coreutils "install"} -d -m 0700 -o ${cfg.owner} -g users ${lib.escapeShellArg cfg.repository}
          '';
          backupCleanupCommand = lib.mkIf (cfg.owner != null) chown;
        };
        # Without the folder's disk (`nofail`), no backup: never a new, empty
        # repository in the mount point, on the disk it is meant to protect.
        systemd.services.restic-backups-balaur.unitConfig.RequiresMountsFor =
          lib.optional local cfg.repository;

        # Low priority: it runs at night, but never in the way of the household.
        systemd.services.restic-backups-balaur.serviceConfig = {
          Nice = 19;
          IOSchedulingClass = "idle";
        };
      };
    };
}
