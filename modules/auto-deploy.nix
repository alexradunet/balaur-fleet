# Auto-deploy: every machine follows `main` on GitHub by itself. Push from any
# machine, and within a few minutes every machine runs it, with no
# `nixos-rebuild --target-host` round.
#
# Every few minutes a timer asks GitHub for main's commit (`git ls-remote`: one
# small HTTPS request, no evaluation, so it costs nothing on the Duet). Only when
# that commit is not the one this machine deployed does it build and switch to
# this machine's configuration at exactly that commit. Heavy builds still go to
# the fleet's builders (fleet.nix), and secrets decrypt with the machine's own
# host key as always.
#
# What it does when something goes wrong:
#   - A commit that fails to build or switch is tried three times: now, 15
#     minutes later and an hour after that (a builder asleep, a network blip),
#     then left alone until the next push. The unit is left failed meanwhile, so
#     `systemctl --failed` and `balaur-fleet-status` show it.
#   - After switching, the machine must still reach GitHub: that is how every
#     later fix arrives, since nobody logs in to repair a machine. If it cannot
#     within two minutes, it switches back to the generation it came from, and
#     that counts as a failed attempt.
#   - A manual `nixos-rebuild switch` from a working tree (testing something
#     before you push) stays until the next push: only a new commit on main
#     makes it act.
#
# It also fast-forwards the admin's clone of the repo, so no machine has a stale
# checkout when you sit down at it. A clone with local commits or a dirty tree is
# left alone (`git pull --ff-only` refuses), never reset.
#
#   balaur-fleet-status                   every machine: deployed commit, state, failed units
#   journalctl -u balaur-auto-deploy      what this machine did
#   sudo systemctl start balaur-auto-deploy   check right away
{ config, ... }:
let
  fleet = config.fleet;
in
{
  flake.modules.nixos.auto-deploy =
    {
      config,
      lib,
      pkgs,
      ...
    }:
    let
      cfg = config.balaur.autoDeploy;
      host = config.networking.hostName;
      user = config.balaur.user;
      stateDir = "/var/lib/balaur-auto-deploy";
      remote = "https://github.com/${cfg.repo}.git";

      # One line about this machine, for balaur-fleet-status (here or over SSH):
      #   <deployed rev> <system state> <trying rev or -> <attempts> <failed units, comma-separated or ->
      deployState = pkgs.writeShellApplication {
        name = "balaur-deploy-state";
        runtimeInputs = [
          pkgs.coreutils
          pkgs.systemd
        ];
        text = ''
          read_state() { cat ${stateDir}/"$1" 2>/dev/null || echo "$2"; }
          deployed=$(read_state deployed -)
          tried=$(read_state tried -)
          attempts=$(read_state attempts 0)
          if [ "$tried" = "$deployed" ]; then tried=-; attempts=0; fi
          state=$(systemctl is-system-running || true)
          failed=$(systemctl --failed --plain --no-legend | cut -d' ' -f1 | paste -sd, -)
          echo "$deployed $state $tried $attempts ''${failed:--}"
        '';
      };

      deploy = pkgs.writeShellApplication {
        name = "balaur-auto-deploy";
        runtimeInputs = [
          pkgs.coreutils
          pkgs.gitMinimal
          pkgs.util-linux # runuser
        ];
        text = ''
          state=${stateDir}
          main() { git ls-remote ${remote} refs/heads/${cfg.branch} | cut -f1; }

          rev=$(main || true)
          if [ -z "$rev" ]; then
            echo "could not read ${cfg.branch} from GitHub; trying again later"
            exit 0
          fi
          if [ "$rev" = "$(cat "$state/deployed" 2>/dev/null || true)" ]; then
            exit 0
          fi

          # A commit that failed before: try again 15 minutes after the first
          # attempt and an hour after the second, then wait for the next push.
          attempts=0
          if [ "$rev" = "$(cat "$state/tried" 2>/dev/null || true)" ]; then
            attempts=$(cat "$state/attempts" 2>/dev/null || echo 1)
            since=$(($(date +%s) - $(cat "$state/last-attempt" 2>/dev/null || echo 0)))
            case $attempts in
              1) wait=900 ;;
              2) wait=3600 ;;
              *) exit 1 ;; # given up: stays failed until the next push
            esac
            if [ "$since" -lt "$wait" ]; then
              # Still failed: keep the unit failed between attempts, so it shows.
              exit 1
            fi
          fi
          attempts=$((attempts + 1))
          # Recorded before building, so a commit that hangs the machine counts.
          echo "$rev" >"$state/tried"
          echo "$attempts" >"$state/attempts"
          date +%s >"$state/last-attempt"
          echo "new commit on ${cfg.branch}: $rev (deployed: $(cat "$state/deployed" 2>/dev/null || echo none)), attempt $attempts of 3"

          ${lib.optionalString (cfg.clone != null) ''
            if [ -d ${lib.escapeShellArg cfg.clone}/.git ]; then
              runuser -u ${user} -- env HOME=${config.users.users.${user}.home} \
                git -C ${lib.escapeShellArg cfg.clone} pull --ff-only --quiet \
                || echo "left ${cfg.clone} alone: it has local changes or commits"
            fi
          ''}

          if ! ${lib.getExe config.system.build.nixos-rebuild} switch --flake "github:${cfg.repo}/$rev#${host}"; then
            echo "attempt $attempts of 3 at $rev failed; see above"
            exit 1
          fi

          # The way every later fix arrives: GitHub must still answer. It did a
          # moment ago, so a couple of minutes of silence means this commit broke it.
          for try in 1 2 3 4 5 6; do
            if [ -n "$(main || true)" ]; then
              echo "$rev" >"$state/deployed"
              echo "deployed $rev"
              exit 0
            fi
            echo "GitHub does not answer after the switch ($try/6)"
            sleep 20
          done
          echo "this machine lost GitHub after switching to $rev: switching back (attempt $attempts of 3)"
          ${lib.getExe config.system.build.nixos-rebuild} switch --rollback
          exit 1
        '';
      };

      # Every machine of the fleet, here or over SSH: what it runs and whether it is well.
      fleetStatus = pkgs.writeShellApplication {
        name = "balaur-fleet-status";
        runtimeInputs = [
          pkgs.coreutils
          pkgs.gitMinimal
          pkgs.openssh
          deployState
        ];
        text = ''
          short() { if [ "$1" = - ]; then echo -; else echo "''${1:0:7}"; fi; }
          main=$(git ls-remote ${remote} refs/heads/${cfg.branch} | cut -f1 || true)
          echo "${cfg.branch} on GitHub: $(short "''${main:--}")"
          printf '%-8s %-9s %-10s %-22s %s\n' MACHINE DEPLOYED STATE TRYING "FAILED UNITS"
          for h in ${lib.escapeShellArgs (lib.attrNames fleet)}; do
            if [ "$h" = ${host} ]; then
              line=$(balaur-deploy-state)
            else
              line=$(ssh -n -o BatchMode=yes -o ConnectTimeout=5 "$h" balaur-deploy-state 2>/dev/null || true)
            fi
            if [ -z "$line" ]; then
              printf '%-8s %s\n' "$h" "no answer (asleep, off the tailnet, or no auto-deploy yet)"
              continue
            fi
            read -r deployed state tried attempts failed <<<"$line"
            mark=""
            if [ -n "$main" ] && [ "$deployed" = "$main" ]; then mark=" ok"; fi
            trying=-
            if [ "$tried" != - ]; then trying="$(short "$tried") (attempt $attempts/3)"; fi
            printf '%-8s %-9s %-10s %-22s %s\n' "$h" "$(short "$deployed")$mark" "$state" "$trying" "$failed"
          done
        '';
      };
    in
    {
      options.balaur.autoDeploy = {
        repo = lib.mkOption {
          type = lib.types.str;
          default = "alexradunet/balaur-fleet";
          description = "The fleet's GitHub repository (owner/name). Public, so no credentials are needed to read it.";
        };
        branch = lib.mkOption {
          type = lib.types.str;
          default = "main";
          description = "The branch every machine follows.";
        };
        interval = lib.mkOption {
          type = lib.types.str;
          default = "5min";
          description = "How often to look for a new commit (a systemd time span).";
        };
        clone = lib.mkOption {
          type = lib.types.nullOr lib.types.str;
          default = "/home/${user}/Projects/balaur-fleet";
          description = "The admin's checkout to fast-forward after each new commit; null to leave clones alone.";
        };
      };

      config = {
        environment.systemPackages = [
          deployState
          fleetStatus
        ];

        systemd.services.balaur-auto-deploy = {
          description = "Deploy the fleet's newest commit to this machine";
          after = [ "network-online.target" ];
          wants = [ "network-online.target" ];

          # It switches the system that defines it: never stop or restart it
          # halfway through its own switch (what system.autoUpgrade does too).
          restartIfChanged = false;
          unitConfig.X-StopOnRemoval = false;

          serviceConfig = {
            Type = "oneshot";
            ExecStart = lib.getExe deploy;
            StateDirectory = "balaur-auto-deploy";
            # A build waits for idle CPU, like the nix daemon on the builders.
            Nice = 19;
            IOSchedulingClass = "idle";
          };

          # The same environment nixpkgs' system.autoUpgrade runs nixos-rebuild in.
          environment =
            config.nix.envVars
            // {
              inherit (config.environment.sessionVariables) NIX_PATH;
              HOME = "/root";
            }
            // config.networking.proxy.envVars;
          # What nixos-rebuild and the flake fetcher call (writeShellApplication
          # prepends its own runtimeInputs to this).
          path = with pkgs; [
            coreutils
            gnutar
            xz.bin
            zstd
            gzip
            gitMinimal
            config.nix.package.out
            config.programs.ssh.package
          ];
        };

        systemd.timers.balaur-auto-deploy = {
          wantedBy = [ "timers.target" ];
          timerConfig = {
            OnBootSec = "2min";
            OnUnitInactiveSec = cfg.interval;
          };
        };
      };
    };
}
