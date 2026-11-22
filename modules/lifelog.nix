# lifelog (lifelog/): the life log as markdown pages and CSV readings in one
# folder, with a checked history in git that also carries the folder between
# the owner's machines (plan 005). Two aspects, like `torrents` and `torrents-client`:
#
#   lifelog          the always-on machine (the server): the folder, its history
#                    (life.git, the hub), and the keeper, which commits each settled
#                    state of the folder to the branch `live`, merges what the other
#                    machines pushed, and moves the refs `checked` and `seen`.
#   lifelog-client   the machines the owner writes on (the laptop): the folder as a
#                    clone of `live`, `lifelog-sync`, the `lifelog` command, Obsidian.
#
# The folder holds health data and private notes, so the group `lifelog` (the owner,
# the keeper, the web app) owns it, mode 2770, and `media` and the household cannot
# read it. Nothing but git over SSH carries it: no Syncthing, no Forgejo.
# The design: lifelog/docs/design.md.
#
#   lifelog check /srv/life            the rules, by hand
#   journalctl -u lifelog-keeper       (server) what the keeper did
#   journalctl -u lifelog-sync         (laptop) what the sync did
#   lifelog restore pages/X.md         (server) a file back from `checked`
{ config, lib, ... }:
let
  hm = config.flake.modules.homeManager;
  gitDir = "/var/lib/lifelog/life.git";

  # What git leaves out of the folder, on the keeper and on a client alike: the
  # marker, the writers' temporary files (Syncthing's name, kept by the Go commands
  # and the web app), Obsidian's settings, and the old versions that Syncthing left
  # on the server (the owner deletes them when they want; git has the history).
  excludes = [
    "/.lifelog/"
    "/.stversions/"
    ".syncthing.*.tmp"
    "/.obsidian/"
  ];

  # Shell lines that end the run while the folder is not settled (design §4):
  # something in the content folders changed in the last $quiet seconds. A deletion
  # changes its folder's time, so folders count too.
  untilSettled = ''
    content=()
    for d in journal pages people places metrics files; do
      if [ -d "$folder/$d" ]; then content+=("$folder/$d"); fi
    done
    since="@$(($(date +%s) - quiet))"
    if [ ''${#content[@]} -gt 0 ] && [ -n "$(find "''${content[@]}" -newermt "$since" -print -quit)" ]; then
      exit 0
    fi
  '';

  # What both aspects need: the group and the folder.
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
    in
    {
      users.groups.lifelog = { };
      users.users.${cfg.user}.extraGroups = [ "lifelog" ];

      # 2770: the group writes, nobody else enters; new files and folders take
      # the group. The marker tells the keeper this is the folder and not an empty
      # directory in its place (it was Syncthing's .stfolder until plan 005).
      systemd.tmpfiles.rules = [
        "d ${folder} 2770 ${cfg.user} lifelog -"
        "d ${folder}/.lifelog 0770 ${cfg.user} lifelog -"
        # A default ACL: what anyone writes in the folder is the group's to write too,
        # whatever the writer's umask (a `mkdir` over SSH makes 0755). The keeper merges
        # other machines' commits into it (plan 005), so it must be able to write there.
        "A+ ${folder} - - - - d:user::rwX,d:group::rwX,d:other::---,group::rwX"
      ];

      environment.systemPackages = [ pkgs.lifelog ];
      environment.variables.LIFELOG_FOLDER = folder;
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
      webSocket = "/run/lifelog-web/http.sock";

      # life.git's `update` hook (plan 005): a push may move a machine's own
      # from/<host> ref only. live, checked and seen are the keeper's, which moves
      # them in place, without a push, so the hook never stands in its way.
      hooks = pkgs.writeShellApplication {
        name = "update";
        text = ''
          case $1 in
            refs/heads/from/*) exit 0 ;;
          esac
          echo "life.git takes a push to refs/heads/from/<host> only; $1 is the keeper's" >&2
          exit 1
        '';
      };

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
          if [ ! -d "$folder/.lifelog" ]; then
            echo "<3>$folder has no .lifelog marker: it is not the life folder; nothing done" >&2
            exit 1
          fi

          # Before GIT_WORK_TREE is set: git init --bare refuses to run with it.
          ${lib.optionalString (cfg.lifelog.importFrom != null) ''
            # A keeper moving in from another machine continues that history: it
            # starts from the copy in the import folder, and does nothing at all
            # until the copy is there (a fresh history would fork the old one).
            if [ ! -f "$gitdir/HEAD" ]; then
              import=${cfg.lifelog.importFrom}
              if [ ! -f "$import/HEAD" ]; then
                echo "<4>no history yet: waiting for a copy of the old keeper's in $import" >&2
                exit 0
              fi
              # The copy belongs to the owner, not to this user: trusted for this clone.
              git -c safe.directory="$import" clone -q --mirror "$import" "$gitdir"
              git --git-dir "$gitdir" config --unset remote.origin.mirror || true
              git --git-dir "$gitdir" remote remove origin
              git --git-dir "$gitdir" symbolic-ref HEAD refs/heads/live
              echo "history imported from $import: live at $(git --git-dir "$gitdir" rev-parse --short refs/heads/live)"
            fi
          ''}
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
          # Plan 005: the other machines push here, as the owner (in the group). What
          # they write must stay writable by this user, and they may move only their own
          # from/<host> ref, never live under this folder (the hook).
          g config core.sharedRepository group
          g config core.hooksPath ${hooks}/bin
          # git makes new folders setgid from now on; the ones this user made before
          # get the bit here, so a push into them takes the group lifelog too.
          find "$gitdir" -type d -user "$(id -un)" ! -perm -2000 -exec chmod g+s {} +
          mkdir -p "$gitdir/info"
          # _check.md is committed (plan 005): it reaches a machine that syncs through
          # git, and its deletion there comes back as the acknowledgement.
          printf '%s\n' ${lib.escapeShellArgs excludes} >"$gitdir/info/exclude"

          ${untilSettled}

          g add -A
          if ! g rev-parse -q --verify refs/heads/live >/dev/null; then
            g commit -q --allow-empty -m "settled (the first state)"
          elif ! g diff --cached --quiet; then
            g commit -q -m "settled"
          fi

          # What the other machines pushed (plan 005), merged into live and the folder.
          # One that cannot be merged now (a write landed a moment ago) is tried again
          # at the next run; the others go on.
          while read -r ref; do
            code=0
            lifelog integrate -folder "$folder" -git-dir "$gitdir" -machine ${config.networking.hostName} "$ref" || code=$?
            case $code in
              0) ;;
              1) echo "<4>$ref: not merged this time (above); tried again at the next run" >&2 ;;
              *) echo "<3>$ref: the merge failed (above)" >&2 ;;
            esac
          done < <(g for-each-ref --format='%(refname)' refs/heads/from/)
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
          # The report, or its removal, as a commit of its own on live. The next run
          # then finds live where this one left it and does not check again.
          commit_report() {
            g add -A -- _check.md 2>/dev/null || true
            if ! g diff --cached --quiet; then g commit -q -m "$1"; fi
          }
          case $code in
            0 | 1)
              if [ "$code" = 0 ]; then g update-ref refs/heads/checked "$live"; fi
              # A report with a section (## Errors, ## Losses, ## Warnings) has something to say.
              if grep -q '^## ' "$report"; then
                publish
                echo "$live" >"$reported"
                commit_report "keeper: the check of $(g rev-parse --short "$live")"
              else
                rm -f "$folder/_check.md" "$reported"
                g update-ref refs/heads/seen "$live"
                commit_report "keeper: nothing to report"
              fi
              g rev-parse refs/heads/live >"$lastrun"
              ;;
            *)
              printf '# The check of the life folder\n\nThe check did not run at %s. On the server: journalctl -u lifelog-keeper\n' \
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
        importFrom = lib.mkOption {
          type = lib.types.nullOr lib.types.str;
          default = null;
          example = "/var/lib/lifelog-import/life.git";
          description = ''
            For a keeper moving in from another machine: a bare copy of the old
            keeper's history (`git clone --mirror`, by the owner, who is in the
            `lifelog` group) that the keeper starts from when it has none. Until the
            copy is there it does nothing, so that it never starts a second history.
            The folder that holds it is made writable by the group.
          '';
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

          # The history exists here only (the folder itself is on every machine with a
          # lifelog aspect). The restored copy belongs to another user than the drill's.
          balaur.state.lifelog = {
            path = gitDir;
            verify = ''
              git -c safe.directory='*' --git-dir "$restored" fsck --full --no-dangling
              echo "life.git: live is at $(git -c safe.directory='*' --git-dir "$restored" log -1 --format='%h, %cr' refs/heads/live)"
            '';
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
              # No RestrictSUIDSGID: life.git is shared with the owner's pushes (plan 005),
              # and its folders must be setgid (group lifelog) for what both write to stay
              # each other's; git sets that bit itself (core.sharedRepository).
              LockPersonality = true;
            };
          };
          # The import folder: the owner (in the group) writes the copy into it.
          systemd.tmpfiles.rules = lib.optional (
            cfg.lifelog.importFrom != null
          ) "d ${dirOf cfg.lifelog.importFrom} 2770 lifelog lifelog -";

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
            {
              name = "Life";
              description = "The life log: the journal, pages and readings";
              icon = "📓";
              socket = webSocket;
              subdomain = "life";
              # Health data and private notes: the owner's devices only. This machine's own
              # screen too, since 2026-11-17: the server is the owner's desktop, its only
              # account is theirs, and it reads /srv/life directly anyway.
              audience = "owner";
              unit = "lifelog-web.service";
              group = "Personal";
            }
          ];

          # The web app (lifelog/web, plan 003): the folder on the phone. It listens on
          # a Unix socket that only Caddy can open, because a loopback port is open to
          # every local account and this machine is shared. systemd makes the socket
          # (group caddy, 0660) and starts the app on the first request, so Caddy needs
          # no new group. The app has no network at all.
          assertions = [
            {
              assertion = cfg ? web;
              message = "the `lifelog` aspect serves its web app through the `web` aspect (Caddy): add `web` to this machine";
            }
          ];
          users.users.lifelog-web = {
            isSystemUser = true;
            group = "lifelog-web";
            extraGroups = [ "lifelog" ];
          };
          users.groups.lifelog-web = { };
          systemd.sockets.lifelog-web = {
            wantedBy = [ "sockets.target" ];
            listenStreams = [ webSocket ];
            socketConfig = {
              SocketGroup = config.services.caddy.group;
              SocketMode = "0660";
            };
          };
          systemd.services.lifelog-web = {
            description = "lifelog web app: the life folder on the phone";
            requires = [ "lifelog-web.socket" ];
            environment = {
              LIFELOG_FOLDER = folder;
              LIFELOG_BIN = lib.getExe pkgs.lifelog;
              NODE_ENV = "production";
            };
            serviceConfig = {
              User = "lifelog-web";
              Group = "lifelog-web";
              ExecStart = lib.getExe pkgs.lifelog-web;
              # The ids of the captures it applied.
              StateDirectory = "lifelog-web";
              StateDirectoryMode = "0700";
              # Files it writes take the group lifelog (the setgid folder) and mode 0660.
              UMask = "0007";
              ReadWritePaths = [ folder ];
              Restart = "on-failure";
              ProtectSystem = "strict";
              ProtectHome = true;
              PrivateTmp = true;
              PrivateDevices = true;
              PrivateNetwork = true;
              RestrictAddressFamilies = [ "AF_UNIX" ];
              NoNewPrivileges = true;
              ProtectKernelTunables = true;
              ProtectKernelModules = true;
              ProtectControlGroups = true;
              RestrictSUIDSGID = true;
              RestrictNamespaces = true;
              LockPersonality = true;
              CapabilityBoundingSet = "";
            };
          };
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
      # The folder synced through git (plan 005): this machine's side. Its history is
      # a clone of the keeper's, with the folder as its work tree and one branch of its
      # own, `work`, which it pushes to the keeper's from/<this host>; the keeper merges
      # that into live. Each run: commit the settled folder, fetch, merge live in
      # (`lifelog integrate`), push. Offline, it commits and stops; the push goes with
      # the next run that reaches the keeper. The clone is also a second copy of the
      # whole history, and the place to read it on this machine.
      #
      #   lifelog-sync init   once: make the clone, into an empty folder
      #   lifelog-sync        one run (the timer's, every minute)
      syncWith = cfg.lifelog-client.syncWith;
      me = config.networking.hostName;
      sync = pkgs.writeShellApplication {
        name = "lifelog-sync";
        runtimeInputs = [
          pkgs.git
          pkgs.openssh
          pkgs.coreutils
          pkgs.findutils
          pkgs.lifelog
        ];
        text = ''
          folder=${cfg.lifelog-folder}
          gitdir=''${LIFELOG_SYNC_GIT_DIR:-$HOME/.local/share/lifelog/sync.git}
          quiet=${toString cfg.lifelog-client.quietSeconds}
          remote=${syncWith}:${gitDir}

          export GIT_CONFIG_NOSYSTEM=1 GIT_CONFIG_GLOBAL=/dev/null LC_ALL=C
          export GIT_SSH_COMMAND="ssh -o BatchMode=yes -o ConnectTimeout=10"
          g() { git --git-dir "$gitdir" --work-tree "$folder" -c gc.autoDetach=false \
                  -c user.name="lifelog ${me}" -c user.email=${me}@lifelog "$@"; }

          if [ "''${1:-}" = init ]; then
            if [ -e "$gitdir" ]; then
              echo "$gitdir is there already: this machine syncs through git" >&2
              exit 1
            fi
            # Into an empty folder only: what is in it now would be overwritten or,
            # worse, committed over the keeper's live at the first run.
            if [ -n "$(find "$folder" -mindepth 1 -maxdepth 1 ! -name .obsidian ! -name .lifelog -print -quit)" ]; then
              echo "$folder is not empty: move it aside first (mv $folder/* somewhere), then run this again" >&2
              exit 1
            fi
            mkdir -p "$(dirname "$gitdir")"
            git init -q --bare "$gitdir"
            g remote add origin "$remote"
            g fetch -q origin
            g update-ref refs/heads/work refs/remotes/origin/live
            g symbolic-ref HEAD refs/heads/work
            printf '%s\n' ${lib.escapeShellArgs excludes} >"$gitdir/info/exclude"
            g read-tree -u --reset refs/heads/work
            echo "$folder is now live at $(g log -1 --format='%h, %cr' refs/heads/work), synced through git with ${syncWith}"
            exit 0
          fi

          # Not set up here (yet): nothing to do.
          if [ ! -f "$gitdir/HEAD" ]; then
            exit 0
          fi
          # Each run, as on the keeper: a change of the list reaches a clone made before it.
          printf '%s\n' ${lib.escapeShellArgs excludes} >"$gitdir/info/exclude"

          ${untilSettled}

          g add -A
          if ! g diff --cached --quiet; then
            g commit -q -m "settled on ${me}"
          fi

          if ! g fetch -q origin; then
            echo "<5>${syncWith} does not answer: this machine's commits wait for the next run"
            exit 0
          fi
          code=0
          lifelog integrate -folder "$folder" -git-dir "$gitdir" -from ${syncWith} -machine ${me} \
            refs/remotes/origin/live || code=$?
          case $code in
            0) ;;
            1) echo "<4>live not merged this time (above); tried again at the next run" >&2 ;;
            *)
              echo "<3>the merge of live failed (above)" >&2
              exit 1
              ;;
          esac
          # What the keeper has not got yet.
          if ! g merge-base --is-ancestor refs/heads/work refs/remotes/origin/from/${me} 2>/dev/null; then
            g push -q origin refs/heads/work:refs/heads/from/${me}
          fi
        '';
      };
    in
    {
      imports = [ folderOption ];

      options.balaur.lifelog-client = {
        syncWith = lib.mkOption {
          type = lib.types.nullOr lib.types.str;
          default = null;
          example = "server";
          description = ''
            The keeper's machine to sync the folder with through git (plan 005), or null
            for none. It starts once `lifelog-sync init` has made the clone; until then
            the folder is not synced.
          '';
        };
        quietSeconds = lib.mkOption {
          type = lib.types.ints.positive;
          default = 60;
          description = "How long nothing in the content folders must change before this machine commits (design §4).";
        };
      };

      config = lib.mkMerge [
        (shared args)
        {
          home-manager.users.${cfg.user}.imports = [ hm.lifelog-client ];

          environment.systemPackages = lib.optional (syncWith != null) sync;
          systemd.services.lifelog-sync = lib.mkIf (syncWith != null) {
            description = "lifelog: sync the folder with ${syncWith} through git";
            serviceConfig = {
              Type = "oneshot";
              User = cfg.user;
              ExecStart = lib.getExe sync;
              # What it writes in the folder is the group's (the folder's ACL makes sure).
              UMask = "0007";
            };
          };
          systemd.timers.lifelog-sync = lib.mkIf (syncWith != null) {
            wantedBy = [ "timers.target" ];
            timerConfig = {
              OnBootSec = "2min";
              OnUnitInactiveSec = "1min";
              AccuracySec = "10s";
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
