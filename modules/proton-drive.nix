# A copy of a local folder in Proton Drive: every hour, rclone mirrors
# `balaur.protonDrive.dir` (on the server, /srv/proton, its own partition) to
# `balaur.protonDrive.remote`, the whole of Proton Drive's "My files". One way: the
# local folder is the one worked in, Proton is its backup. Proton has no sync client
# for Linux yet, and rclone's two-way `bisync` against Proton Drive is the part with
# the most reported failures. So files are added on the server, not in Proton's own
# apps: what is in Proton and not here is taken out of the way at the next sync.
#
# Nothing is lost in Proton by a mirror: a file deleted or changed here, or one only
# Proton had, is moved, in Proton, to `<deletedFolder>/<date>/` instead of being
# deleted or overwritten (that folder is left out of the sync on both sides). And the
# sync runs only when the folder's partition is mounted, so a missing disk (an empty
# folder) never mirrors as "delete everything".
#
# The login is the admin's own, kept by rclone in ~/.config/rclone/rclone.conf (0600,
# its session tokens are refreshed there), not in sops: Proton's login wants the
# account's password and a 2FA code once, interactively. Until it exists the timer
# skips; moving the file aside is also how to pause it.
#
#   rclone config                              once: new remote "proton", type protondrive
#   rclone lsd proton: --protondrive-2fa=NNNNNN   then log in, with a fresh code
#   sudo systemctl start proton-drive          sync now
#   journalctl -u proton-drive                 what the last runs did
#   rclone ls proton:Balaur-deleted            what was replaced or deleted, by date
{
  flake.modules.nixos.proton-drive =
    {
      config,
      lib,
      pkgs,
      ...
    }:
    let
      cfg = config.balaur.protonDrive;
      user = config.balaur.user;
      home = config.users.users.${user}.home;
      rcloneConfig = "${home}/.config/rclone/rclone.conf";
      # proton:  +  Balaur-deleted  ->  proton:Balaur-deleted;  proton:Files  ->  proton:Files/Balaur-deleted
      deleted =
        if lib.hasSuffix ":" cfg.remote || lib.hasSuffix "/" cfg.remote then
          cfg.remote + cfg.deletedFolder
        else
          "${cfg.remote}/${cfg.deletedFolder}";

      sync = pkgs.writeShellApplication {
        name = "balaur-proton-drive-sync";
        runtimeInputs = [
          pkgs.rclone
          pkgs.util-linux
          pkgs.coreutils
        ];
        text = ''
          # The folder must be its own mounted partition, never the empty directory
          # under it (RequiresMountsFor= already waits for the mount; this is the check).
          if ${lib.boolToString cfg.requireMount} && ! mountpoint -q ${lib.escapeShellArg cfg.dir}; then
            echo "${cfg.dir} is not mounted: not syncing" >&2
            exit 1
          fi
          exec rclone sync ${lib.escapeShellArg cfg.dir} ${lib.escapeShellArg cfg.remote} \
            --config ${lib.escapeShellArg rcloneConfig} \
            --backup-dir ${lib.escapeShellArg deleted}/"$(date +%F_%H%M)" \
            --exclude ${lib.escapeShellArg "/${cfg.deletedFolder}/**"} \
            --exclude '/lost+found/**' \
            --cache-dir "$CACHE_DIRECTORY" \
            --tpslimit 4 \
            --protondrive-replace-existing-draft=true \
            --stats-one-line --stats 0 -v
        '';
      };
    in
    {
      options.balaur.protonDrive = {
        dir = lib.mkOption {
          type = lib.types.str;
          default = "/srv/proton";
          description = "The local folder Proton Drive keeps a copy of.";
        };
        remote = lib.mkOption {
          type = lib.types.str;
          default = "proton:";
          description = "Where in Proton Drive, as an rclone path (the remote `proton`, from `rclone config`); `proton:` is the whole of \"My files\".";
        };
        deletedFolder = lib.mkOption {
          type = lib.types.str;
          default = "Balaur-deleted";
          description = "The folder, inside `remote`, where a sync moves what it would delete or overwrite in Proton. Left out of the sync on both sides.";
        };
        requireMount = lib.mkOption {
          type = lib.types.bool;
          default = true;
          description = "Sync only when `dir` is a mount point (its own partition), so a missing disk is never mirrored as an empty folder.";
        };
      };

      config = {
        # For the login (`rclone config`), and to look in Proton by hand.
        environment.systemPackages = [ pkgs.rclone ];

        systemd.services.proton-drive = {
          description = "Copy ${cfg.dir} to Proton Drive";
          after = [ "network-online.target" ];
          wants = [ "network-online.target" ];
          unitConfig = {
            RequiresMountsFor = lib.optional cfg.requireMount cfg.dir;
            # Not logged in yet: skip, rather than fail every hour.
            ConditionPathExists = rcloneConfig;
          };
          serviceConfig = {
            Type = "oneshot";
            User = user;
            Group = "users";
            ExecStart = lib.getExe sync;
            Nice = 19;
            IOSchedulingClass = "idle";
            # It reads the folder and writes only rclone's config (refreshed tokens).
            ProtectSystem = "strict";
            ReadWritePaths = [ "${home}/.config/rclone" ];
            CacheDirectory = "proton-drive";
            PrivateTmp = true;
            NoNewPrivileges = true;
          };
        };

        systemd.timers.proton-drive = {
          wantedBy = [ "timers.target" ];
          timerConfig = {
            OnCalendar = "hourly";
            Persistent = true;
            RandomizedDelaySec = "5min";
          };
        };
      };
    };
}
