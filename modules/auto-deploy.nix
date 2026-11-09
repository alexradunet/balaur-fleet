# Auto-deploy: every machine follows `main` on GitHub by itself. Push from any
# machine, and within a few minutes every machine runs it, with no
# `nixos-rebuild --target-host` round.
#
# Every few minutes a timer asks GitHub for main's commit (`git ls-remote`: one
# small HTTPS request, no evaluation, so it costs nothing on the Duet). Only when
# that commit is new does it build and switch to this machine's configuration at
# exactly that commit. Heavy builds still go to the fleet's builders (fleet.nix),
# and secrets decrypt with the machine's own host key as always.
#
# It records the commit it last *tried*, not what is running. So:
#   - a manual `nixos-rebuild switch` from a working tree (testing something
#     before you push) stays until the next push;
#   - a commit that fails to build is tried once, not every few minutes; the next
#     push tries again. `journalctl -u balaur-auto-deploy` says what went wrong.
#
# It also fast-forwards the admin's clone of the repo, so no machine has a stale
# checkout when you sit down at it. A clone with local commits or a dirty tree is
# left alone (`git pull --ff-only` refuses), never reset.
#
# By hand: `sudo systemctl start balaur-auto-deploy` checks right away.
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
      nixos-rebuild = "${config.system.build.nixos-rebuild}/bin/nixos-rebuild";
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
          path = with pkgs; [
            coreutils
            gnutar
            xz.bin
            gzip
            gitMinimal
            util-linux # runuser
            config.nix.package.out
            config.programs.ssh.package
          ];

          script = ''
            rev=$(git ls-remote https://github.com/${cfg.repo}.git refs/heads/${cfg.branch} | cut -f1)
            if [ -z "$rev" ]; then
              echo "could not read ${cfg.branch} from GitHub; trying again later"
              exit 0
            fi
            last=$(cat ${stateDir}/tried 2>/dev/null || true)
            if [ "$rev" = "$last" ]; then
              exit 0
            fi

            echo "new commit on ${cfg.branch}: $rev (was ''${last:-none})"
            # Recorded before building, so a broken commit is tried once.
            echo "$rev" > ${stateDir}/tried

            ${lib.optionalString (cfg.clone != null) ''
              if [ -d ${lib.escapeShellArg cfg.clone}/.git ]; then
                runuser -u ${user} -- env HOME=${
                  config.users.users.${user}.home
                } git -C ${lib.escapeShellArg cfg.clone} pull --ff-only --quiet \
                  || echo "left ${cfg.clone} alone: it has local changes or commits"
              fi
            ''}

            ${nixos-rebuild} switch --flake "github:${cfg.repo}/$rev#${host}"
            echo "$rev" > ${stateDir}/deployed
            echo "deployed $rev"
          '';
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
