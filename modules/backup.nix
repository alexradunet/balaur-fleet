# Backups: restic, every night, of the state that exists on one machine only and
# that no rebuild can bring back: what was set up in the services' own web UIs,
# and the life log's history. Everything else is either declared in this repo or
# already on more than one machine (the Syncthing folder, with its versions).
#
# What it backs up is what the machine's aspects declare as their state
# (`balaur.state`, base.nix), so adding a service does not mean editing a list here.
# Today: home-assistant (/var/lib/hass, without the recorder's history database),
# lifelog (the keeper's git history of the life folder, the ledger with it) and
# torrents (qBittorrent's settings and the torrents it is seeding).
#
# A backup nobody restored is a hope. `balaur-restore-drill` restores the newest
# snapshot into a scratch folder on the first of every month, checks that every
# declared state came back, and runs each one's own `verify` lines (the history
# passes `git fsck`, the ledger balances). A drill that fails is a failed unit, which
# `notify` tells the owner.
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
#   sudo systemctl start balaur-restore-drill     the drill now; journalctl -u balaur-restore-drill
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
      state = config.balaur.state;
      paths = lib.unique (lib.mapAttrsToList (_: s: s.path) state ++ cfg.extraPaths);
      # SFTP over the machine's own SSH host key, like everything else here:
      # put its public half (fleet.nix, sshHostKey) on the storage server.
      sftp = lib.optional (lib.hasPrefix "sftp:" cfg.repository) "sftp.args='-i /etc/ssh/ssh_host_ed25519_key -o BatchMode=yes'";

      # A state's name as a shell function's: `home-assistant` is `verify_home_assistant`.
      fn =
        name:
        "verify_" + lib.stringAsChars (c: if builtins.match "[a-zA-Z0-9]" c != null then c else "_") name;

      # The restore drill. Everything it restores stays in its cache folder and is
      # removed when it ends, whatever it ended with.
      drill = pkgs.writeShellApplication {
        name = "balaur-restore-drill";
        # The checks are functions called by name, which shellcheck does not follow.
        excludeShellChecks = [ "SC2329" ];
        runtimeInputs = [
          pkgs.restic
          pkgs.git
          pkgs.gnutar
          pkgs.coreutils
          pkgs.util-linux # setpriv, for a check that must not run as root
        ];
        text = ''
          base=''${CACHE_DIRECTORY:?}
          rm -rf "$base/restored" "$base/scratch"
          trap 'rm -rf "$base/restored" "$base/scratch"' EXIT
          # A check may run as another user in its own scratch folder; what is
          # restored keeps its owners and modes, under a folder only root enters.
          install -d -m 0700 "$base/restored"
          install -d -m 0711 "$base/scratch"

          restic restore latest --target "$base/restored" ${lib.concatMapStringsSep " " (o: "-o ${o}") sftp}

          failed=0
          check() {
            local name=$1 path=$2 verify=$3
            export restored="$base/restored$path" scratch="$base/scratch/$name"
            install -d -m 0755 "$scratch"
            if [ ! -e "$restored" ]; then
              echo "<3>$name: $path did not come back" >&2
              failed=1
              return
            fi
            # A plain command, not a condition: a failing line then ends the
            # subshell (set -e does nothing inside an `if`).
            set +e
            (
              set -euo pipefail
              "$verify"
            )
            local code=$?
            set -e
            if [ "$code" = 0 ]; then
              echo "$name: $path came back whole"
            else
              echo "<3>$name: $path came back, and its check failed" >&2
              failed=1
            fi
          }
          ${lib.concatStrings (
            lib.mapAttrsToList (name: s: ''
              ${fn name}() {
                :
              ${s.verify}
              }
              check ${lib.escapeShellArg name} ${lib.escapeShellArg s.path} ${fn name}
            '') state
          )}
          exit "$failed"
        '';
      };
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
            assertion = paths != [ ];
            message = "the `backup` aspect found nothing to back up on ${config.networking.hostName}: no aspect there declares a `balaur.state`";
          }
        ];

        services.restic.backups.balaur = {
          inherit (cfg) repository passwordFile environmentFile;
          initialize = true;
          inherit paths;
          exclude = lib.concatLists (lib.mapAttrsToList (_: s: s.exclude) state);
          extraOptions = sftp;
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

        systemd.services.balaur-restore-drill = {
          description = "Restore drill: the newest backup comes back, and what it holds is whole";
          unitConfig.RequiresMountsFor = lib.optional local cfg.repository;
          environment = {
            RESTIC_REPOSITORY = cfg.repository;
            RESTIC_PASSWORD_FILE = toString cfg.passwordFile;
            RESTIC_CACHE_DIR = "%C/balaur-restore-drill/restic";
          };
          serviceConfig = {
            Type = "oneshot";
            ExecStart = lib.getExe drill;
            EnvironmentFile = lib.optional (cfg.environmentFile != null) cfg.environmentFile;
            # restic's lock in a folder repository is root's: the owner's again after.
            ExecStopPost = lib.optional (cfg.owner != null) chown;
            CacheDirectory = "balaur-restore-drill";
            CacheDirectoryMode = "0711";
            Nice = 19;
            IOSchedulingClass = "idle";
            # Root, to read the repository and to restore owners and modes, and nothing
            # more than that: it writes only its cache folder and restic's lock, and a
            # folder repository needs no network.
            ProtectSystem = "strict";
            ReadWritePaths = lib.optional local cfg.repository;
            ProtectHome = true;
            PrivateTmp = true;
            PrivateDevices = true;
            PrivateNetwork = local;
            NoNewPrivileges = true;
            ProtectKernelTunables = true;
            ProtectKernelModules = true;
            ProtectControlGroups = true;
            RestrictSUIDSGID = true;
            LockPersonality = true;
          };
        };
        systemd.timers.balaur-restore-drill = {
          wantedBy = [ "timers.target" ];
          timerConfig = {
            # After the night's backup (04:30) has ended.
            OnCalendar = "*-*-01 06:30";
            Persistent = true;
          };
        };
      };
    };
}
