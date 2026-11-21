# Forgejo, the fleet's own git service: repositories, issues and labels at
# https://git.<domain> (with `web`) and over SSH as `forgejo@<host>:<owner>/<repo>`.
# It is the software Codeberg (a German non-profit) runs, a single Go binary on
# SQLite: about 150 MB of memory and no CPU while nobody pushes or browses.
#
# It is here so that the fleet's repository, its issues and the life log's history
# can live in the house instead of on GitHub. Until that move (the plan's phase 3)
# the machines still follow GitHub; this only runs next to it.
#
# Nobody can sign up: the owner's account is made once, by `forgejo-admin`, with a
# random password in /var/lib/forgejo/initial-admin-password that must be changed
# at the first login. Every repository is private unless made public, and nothing
# can be seen without a login. SSH goes through the machine's own sshd (port 22, as
# for every other login), with the keys the owner adds in Forgejo's settings.
#
#   sudo cat /var/lib/forgejo/initial-admin-password   the first login
#   journalctl -u forgejo                               what it did
{ config, ... }:
let
  fleet = config.fleet;
in
{
  flake.modules.nixos.forgejo =
    {
      config,
      lib,
      pkgs,
      ...
    }:
    let
      cfg = config.balaur.forgejo;
      forgejo = config.services.forgejo;
      me = config.networking.hostName;
      domain = config.balaur.web.domain or null;
      state = forgejo.stateDir;
      db = "${state}/data/forgejo.db";
      # A consistent copy of the live database, for the nightly backup (below).
      snapshot = "${state}/backup/forgejo.db";
      address = fleet.${me}.address or me;
      rootUrl =
        if domain != null then "https://git.${domain}/" else "http://${address}:${toString cfg.port}/";

      # The owner's account, made once. A machine whose Forgejo already has an
      # administrator (a restore, a second run) is left as it is.
      admin = pkgs.writeShellApplication {
        name = "balaur-forgejo-admin";
        runtimeInputs = [
          forgejo.package
          pkgs.coreutils
          pkgs.gnugrep
        ];
        text = ''
          if forgejo admin user list --admin | tail -n +2 | grep -q .; then
            exit 0
          fi
          umask 077
          password=$(head -c 18 /dev/urandom | base64)
          forgejo admin user create --admin --username ${lib.escapeShellArg cfg.admin} \
            --email ${lib.escapeShellArg cfg.adminEmail} --password "$password" --must-change-password
          printf '%s\n' "$password" >${state}/initial-admin-password
          echo "made the administrator ${cfg.admin}; the password is in ${state}/initial-admin-password"
        '';
      };

      # SQLite's online backup: a whole database even while Forgejo writes to it,
      # which a plain copy of the live file is not.
      dbSnapshot = pkgs.writeShellApplication {
        name = "balaur-forgejo-db-snapshot";
        runtimeInputs = [
          pkgs.sqlite
          pkgs.coreutils
        ];
        text = ''
          install -d -m 0700 "$(dirname ${snapshot})"
          sqlite3 ${db} ".backup '${snapshot}.tmp'"
          mv ${snapshot}.tmp ${snapshot}
        '';
      };
    in
    {
      options.balaur.forgejo = {
        port = lib.mkOption {
          type = lib.types.port;
          default = 3000;
          description = "Port Forgejo's web UI listens on: 127.0.0.1 behind Caddy with `web`, else the tailnet.";
        };
        admin = lib.mkOption {
          type = lib.types.str;
          default = config.balaur.user;
          defaultText = lib.literalExpression "config.balaur.user";
          description = "The name of the owner's account, the one administrator.";
        };
        adminEmail = lib.mkOption {
          type = lib.types.str;
          default = "radualexandrucosmin@gmail.com";
          description = "The owner's email in Forgejo: its commits are matched to the account by it (the one in home.nix).";
        };
      };

      config = {
        services.forgejo = {
          enable = true;
          database.type = "sqlite3";
          lfs.enable = true;
          settings = {
            DEFAULT.APP_NAME = "Balaur git";
            server = {
              DOMAIN = if domain != null then "git.${domain}" else address;
              ROOT_URL = rootUrl;
              # Behind Caddy only, with `web`. Without it, the tailnet (trusted) reaches
              # it directly; the LAN firewall stays closed either way.
              HTTP_ADDR = if domain != null then "127.0.0.1" else "0.0.0.0";
              HTTP_PORT = cfg.port;
              # Clone addresses name the machine's tailnet name, and the machine's own
              # sshd serves them: no second SSH server.
              SSH_DOMAIN = address;
              SSH_PORT = 22;
              START_SSH_SERVER = false;
              LANDING_PAGE = "explore";
            };
            service = {
              DISABLE_REGISTRATION = true;
              REQUIRE_SIGNIN_VIEW = true;
            };
            repository = {
              DEFAULT_PRIVATE = "private";
              DEFAULT_BRANCH = "main";
              # `git push forgejo@<host>:<owner>/<new>.git` makes the repository (private,
              # as above): a machine's clone can be moved here without the web page.
              ENABLE_PUSH_CREATE_USER = true;
            };
            session.COOKIE_SECURE = domain != null;
            # CI on its own runner comes with the move of the fleet's repository (phase 3).
            actions.ENABLED = false;
            # No mail server: nothing is sent, and nothing waits for a confirmation.
            mailer.ENABLED = false;
            log.LEVEL = "Warn";
          };
        };

        systemd.services.forgejo-admin = {
          description = "Forgejo: the owner's account, once";
          after = [ "forgejo.service" ];
          requires = [ "forgejo.service" ];
          wantedBy = [ "multi-user.target" ];
          # Forgejo's own variables (its work and custom folders, so the CLI finds its
          # config), without its PATH: the script brings its own.
          environment = removeAttrs config.systemd.services.forgejo.environment [ "PATH" ];
          serviceConfig = {
            Type = "oneshot";
            RemainAfterExit = true;
            User = forgejo.user;
            Group = forgejo.group;
            WorkingDirectory = state;
            ExecStart = lib.getExe admin;
          };
        };

        systemd.services.forgejo-db-snapshot = {
          description = "Forgejo: a consistent copy of its database, for the backup";
          after = [ "forgejo.service" ];
          serviceConfig = {
            Type = "oneshot";
            User = forgejo.user;
            Group = forgejo.group;
            ExecStart = lib.getExe dbSnapshot;
          };
        };
        # The snapshot is taken just before each backup run, where the machine has one.
        systemd.services.restic-backups-balaur = lib.mkIf (config.services.restic.backups ? balaur) {
          wants = [ "forgejo-db-snapshot.service" ];
          after = [ "forgejo-db-snapshot.service" ];
        };

        # The repositories and the snapshot of the database; the live database, the
        # logs and what Forgejo rebuilds by itself (search indexes, queues) are left out.
        balaur.state.forgejo = {
          path = state;
          exclude = [
            "${db}*"
            "${state}/log"
            "${state}/data/indexers"
            "${state}/data/queues"
            "${state}/data/tmp"
            "${state}/initial-admin-password"
          ];
          verify = ''
            test -d "$restored/repositories"
            test "$(${lib.getExe pkgs.sqlite} "$restored/backup/forgejo.db" 'pragma integrity_check')" = ok
          '';
        };

        balaur.services = [
          {
            name = "Forgejo";
            description = "The fleet's git repositories and issues";
            icon = "🔀";
            port = cfg.port;
            subdomain = "git";
            unit = "forgejo.service";
            group = "System";
          }
        ];
      };
    };
}
