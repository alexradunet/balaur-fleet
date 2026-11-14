# lifelog (lifelog/): the life log as markdown pages and CSV readings in one
# folder, synced by Syncthing between the owner's machines, with a checked
# history in git. Two aspects, like `torrents` and `torrents-client`:
#
#   lifelog          the always-on machine (the tablet): the folder, and the
#                    keeper, which commits each settled state of the folder to
#                    the branch `live` and moves the refs `checked` and `seen`.
#   lifelog-client   the machines the owner writes on (laptop, pc): the folder,
#                    the `lifelog` command, Obsidian, and on one of them a
#                    nightly mirror of the history.
#
# The folder is a Syncthing folder of its own (`balaur-life`), not part of the
# shared `files` folder: it holds health data and private notes, so the group
# `lifelog` (the owner and Syncthing) owns it, mode 2770, and `media` and the
# household cannot read it. It is paired from the fleet registry with every
# machine that has one of the two aspects. The design: lifelog/docs/design.md.
#
#   lifelog check /srv/life            the rules, by hand
#   journalctl -u lifelog-keeper       (tablet) what the keeper did
#   lifelog restore pages/X.md         (tablet) a file back from `checked`
{ config, ... }:
let
  fleet = config.fleet;
  nixosConfigs = config.flake.nixosConfigurations;
  hm = config.flake.modules.homeManager;
  folderId = "balaur-life";
  gitDir = "/var/lib/lifelog/life.git";

  # What both aspects need: the group, the folder, its Syncthing folder.
  shared =
    {
      config,
      lib,
      pkgs,
      ...
    }:
    let
      cfg = config.balaur;
      folder = cfg.lifelog-folder;
      me = config.networking.hostName;
      hostConfig = h: if h == me then config else nixosConfigs.${h}.config;
      # Every other machine with a lifelog aspect whose Syncthing ID we know.
      peers = lib.filterAttrs (
        h: e:
        h != me
        && e.syncthingId != null
        && nixosConfigs ? ${h}
        && ((hostConfig h).balaur ? lifelog || (hostConfig h).balaur ? lifelog-client)
      ) fleet;
      syncthingUser = config.services.syncthing.user;
    in
    {
      users.groups.lifelog = { };
      users.users.${cfg.user}.extraGroups = [ "lifelog" ];
      users.users.${syncthingUser}.extraGroups = [ "lifelog" ];

      # 2770: the group writes, nobody else enters; new files and folders take
      # the group. The marker tells Syncthing this is the synced folder and not
      # an empty directory in its place.
      systemd.tmpfiles.rules = [
        "d ${folder} 2770 ${syncthingUser} lifelog -"
        "d ${folder}/.stfolder 0770 ${syncthingUser} lifelog -"
      ];

      environment.systemPackages = [ pkgs.lifelog ];
      environment.variables.LIFELOG_FOLDER = folder;

      services.syncthing = {
        enable = true;
        settings = {
          devices = lib.mapAttrs (_: h: { id = h.syncthingId; }) peers;
          folders.${folderId} = {
            label = "Life";
            path = folder;
            devices = lib.attrNames peers;
            type = "sendreceive";
            # A machine keeps the old version of a change it receives, so
            # every machine together holds every old version for 30 days
            # (plan 001, S4).
            versioning = {
              type = "trashcan";
              params.cleanoutDays = "30";
            };
            ignorePatterns = [
              "(?d).obsidian/workspace*"
              "(?d).obsidian/cache"
            ];
          };
        };
      };
      # Files Syncthing brings must stay writable by the group (files.nix sets
      # the same; this holds without the `files` aspect too).
      systemd.services.syncthing.serviceConfig.UMask = lib.mkDefault "0002";
    };

  folderOption =
    { lib, ... }:
    {
      options.balaur.lifelog-folder = lib.mkOption {
        type = lib.types.str;
        default = "/srv/life";
        description = "The life folder, synced between the machines with a lifelog aspect.";
      };
    };
in
{
  flake.modules.nixos.lifelog =
    {
      config,
      lib,
      pkgs,
      ...
    }@args:
    let
      cfg = config.balaur;
      folder = cfg.lifelog-folder;

      # One run of the keeper (design §4). The timer starts it every minute.
      keep = pkgs.writeShellApplication {
        name = "lifelog-keep";
        runtimeInputs = [
          pkgs.git
          pkgs.coreutils
          pkgs.findutils
          pkgs.gnugrep
          pkgs.lifelog
        ];
        text = ''
          folder=${folder}
          gitdir=${gitDir}
          state=$(dirname "$gitdir")
          quiet=${toString cfg.lifelog.quietSeconds}

          export GIT_CONFIG_NOSYSTEM=1 GIT_CONFIG_GLOBAL=/dev/null LC_ALL=C

          # An empty directory where the folder should be is not the folder.
          if [ ! -d "$folder/.stfolder" ]; then
            echo "<3>$folder has no .stfolder marker: it is not the synced folder; nothing done" >&2
            exit 1
          fi

          # Before GIT_WORK_TREE is set: git init --bare refuses to run with it.
          if [ ! -f "$gitdir/HEAD" ]; then
            # The owner (in the group) reads the history too: the unit's UMask 0007
            # makes what git writes readable by the group.
            git init -q --bare "$gitdir"
            git --git-dir "$gitdir" symbolic-ref HEAD refs/heads/live
          fi

          export GIT_DIR=$gitdir GIT_WORK_TREE=$folder
          # gc.autoDetach=false: when git tidies itself, it does so inside this run; a
          # detached gc would be killed with the rest of the service when it ends.
          g() { git -c safe.directory="$gitdir" -c gc.autoDetach=false -c user.name="lifelog keeper" -c user.email=keeper@lifelog "$@"; }
          g config diff.renameLimit 0
          mkdir -p "$gitdir/info"
          printf '%s\n' /.stfolder/ /.stversions/ /.stignore '.syncthing.*.tmp' '~syncthing~*.tmp' \
            /.obsidian/ /_check.md >"$gitdir/info/exclude"

          # Settled: nothing in the content folders changed for $quiet seconds.
          # A deletion changes its folder's time, so folders count too.
          content=()
          for d in journal pages people places metrics files; do
            if [ -d "$folder/$d" ]; then content+=("$folder/$d"); fi
          done
          since="@$(($(date +%s) - quiet))"
          if [ ''${#content[@]} -gt 0 ] && [ -n "$(find "''${content[@]}" -newermt "$since" -print -quit)" ]; then
            exit 0
          fi

          g add -A
          if ! g rev-parse -q --verify refs/heads/live >/dev/null; then
            g commit -q --allow-empty -m "settled (the first state)"
          elif ! g diff --cached --quiet; then
            g commit -q -m "settled"
          fi
          live=$(g rev-parse refs/heads/live)

          reported=$state/reported # the commit that _check.md reports on
          lastrun=$state/last-run  # the commit the last check ran on
          if [ -f "$reported" ] && [ ! -e "$folder/_check.md" ]; then
            # The owner deleted _check.md: they acknowledged that report.
            g update-ref refs/heads/seen "$(cat "$reported")"
            rm -f "$reported" "$lastrun"
          fi
          if [ -f "$lastrun" ] && [ "$(cat "$lastrun")" = "$live" ]; then
            exit 0
          fi

          report=$state/report.md
          code=0
          lifelog check -report -git-dir "$gitdir" -seen refs/heads/seen -live refs/heads/live "$folder" >"$report" || code=$?

          publish() {
            tmp=$folder/.syncthing._check.md.tmp
            cp "$report" "$tmp"
            chmod 0660 "$tmp"
            mv -f "$tmp" "$folder/_check.md"
          }
          case $code in
            0 | 1)
              if [ "$code" = 0 ]; then g update-ref refs/heads/checked "$live"; fi
              # A report with a section (## Errors, ## Losses, ## Warnings) has something to say.
              if grep -q '^## ' "$report"; then
                publish
                echo "$live" >"$reported"
              else
                rm -f "$folder/_check.md" "$reported"
                g update-ref refs/heads/seen "$live"
              fi
              echo "$live" >"$lastrun"
              ;;
            *)
              printf '# The check of the life folder\n\nThe check did not run at %s. On the tablet: journalctl -u lifelog-keeper\n' \
                "$(date -Iseconds)" >"$report"
              publish
              exit 1
              ;;
          esac
        '';
      };
    in
    {
      imports = [ folderOption ];

      options.balaur.lifelog = {
        quietSeconds = lib.mkOption {
          type = lib.types.ints.positive;
          default = 60;
          description = "How long nothing in the content folders must change before the keeper commits (design §4).";
        };
      };

      config = lib.mkMerge [
        (shared args)
        {
          users.users.lifelog = {
            isSystemUser = true;
            group = "lifelog";
            home = "/var/lib/lifelog";
          };

          # The owner's `lifelog restore` and `lifelog check -git-dir` read the
          # keeper's git dir, which another user owns.
          environment.variables.LIFELOG_GIT_DIR = gitDir;
          programs.git = {
            enable = true;
            config.safe.directory = [ gitDir ];
          };

          systemd.services.lifelog-keeper = {
            description = "lifelog keeper: commit the settled life folder and check it";
            after = [ "syncthing.service" ];
            serviceConfig = {
              Type = "oneshot";
              User = "lifelog";
              Group = "lifelog";
              ExecStart = lib.getExe keep;
              StateDirectory = "lifelog";
              StateDirectoryMode = "0750";
              UMask = "0007";
              ReadWritePaths = [ folder ];
              ProtectSystem = "strict";
              ProtectHome = true;
              PrivateTmp = true;
              PrivateDevices = true;
              PrivateNetwork = true;
              NoNewPrivileges = true;
              ProtectKernelTunables = true;
              ProtectControlGroups = true;
              RestrictSUIDSGID = true;
              LockPersonality = true;
            };
          };
          systemd.timers.lifelog-keeper = {
            wantedBy = [ "timers.target" ];
            timerConfig = {
              OnBootSec = "2min";
              OnUnitInactiveSec = "1min";
              AccuracySec = "10s";
            };
          };

          balaur.services = [
            {
              name = "Lifelog";
              description = "The life log's keeper: history and checks";
              icon = "🗂️";
              unit = "lifelog-keeper.timer";
              group = "Personal";
            }
          ];
        }
      ];
    };

  flake.modules.nixos.lifelog-client =
    {
      config,
      lib,
      pkgs,
      ...
    }@args:
    let
      cfg = config.balaur;
      mirror = pkgs.writeShellApplication {
        name = "lifelog-mirror";
        runtimeInputs = [
          pkgs.git
          pkgs.openssh
          pkgs.coreutils
        ];
        text = ''
          # A copy of the keeper's history, over SSH: a second place for it, and
          # history to read on this machine.
          dest=$HOME/.local/share/lifelog/life.git
          src=${cfg.lifelog-client.mirrorFrom}:${gitDir}
          if [ ! -d "$dest" ]; then
            mkdir -p "$(dirname "$dest")"
            git clone -q --mirror "$src" "$dest"
          else
            git -C "$dest" remote update --prune
          fi
        '';
      };
    in
    {
      imports = [ folderOption ];

      options.balaur.lifelog-client = {
        mirrorFrom = lib.mkOption {
          type = lib.types.nullOr lib.types.str;
          default = null;
          example = "tablet";
          description = "The keeper's machine to mirror the history from every night, or null for no mirror.";
        };
      };

      config = lib.mkMerge [
        (shared args)
        {
          home-manager.users.${cfg.user}.imports = [ hm.lifelog-client ];

          systemd.services.lifelog-mirror = lib.mkIf (cfg.lifelog-client.mirrorFrom != null) {
            description = "lifelog: mirror the history from ${cfg.lifelog-client.mirrorFrom}";
            after = [ "network-online.target" ];
            wants = [ "network-online.target" ];
            serviceConfig = {
              Type = "oneshot";
              User = cfg.user;
              ExecStart = lib.getExe mirror;
            };
          };
          systemd.timers.lifelog-mirror = lib.mkIf (cfg.lifelog-client.mirrorFrom != null) {
            wantedBy = [ "timers.target" ];
            timerConfig = {
              OnCalendar = "*-*-* 04:07:00";
              Persistent = true;
            };
          };
        }
      ];
    };

  # Obsidian, the editor of the pages; the owner opens /srv/life as a vault once.
  flake.modules.homeManager.lifelog-client =
    { pkgs, ... }:
    {
      home.packages = [ pkgs.obsidian ];
    };
}
