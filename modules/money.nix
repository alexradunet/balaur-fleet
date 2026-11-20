# money: the owner's finances as a Beancount ledger, plain text in the life folder
# (`money/` in /srv/life), with Fava as its web page at https://money.<domain>.
#
# Text, like the life log, because the owner keeps it mostly through the Balaur
# agent: it appends a transaction, runs `bean-check`, asks `bean-query`, and every
# change is a readable diff in the keeper's history. The folder gives the rest for
# free: private (group `lifelog`, 2770), synced to the owner's machines, committed by
# the keeper (lifelog.nix commits the whole folder; the checker's rules cover only its
# content folders, so `money/` is left alone). It needs the `lifelog` aspect for that
# folder and `web` for the page.
#
#   bean-check /srv/life/money/main.beancount     the ledger's errors, by hand
#   bean-query /srv/life/money/main.beancount     SQL-like questions (BQL)
#   journalctl -u fava -u money-check             the page, the nightly check
#
# The procedures are the skill `money` (.agents/skills).
{
  flake.modules.nixos.money =
    {
      config,
      lib,
      pkgs,
      ...
    }:
    let
      cfg = config.balaur.money;
      dir = dirOf cfg.ledger;
      webSocket = "/run/fava/http.sock";
      # The ledger's path inside the life folder (`money/main.beancount`), or null for
      # a ledger kept somewhere else.
      life = config.balaur.lifelog-folder or "/srv/life";
      inLife =
        if lib.hasPrefix "${life}/" cfg.ledger then lib.removePrefix "${life}/" cfg.ledger else null;

      # Fava and the tools in one Python, so that importers the agent writes
      # (beangulp) find beancount next to them.
      python = pkgs.python3.withPackages (ps: [
        ps.beancount
        ps.beanquery
        ps.beangulp
        ps.fava
        ps.gunicorn
      ]);

      # `money-python`: that Python by a name of its own, so it never shadows another
      # `python3` on the PATH. For import scripts: `money-python import.py extract ...`.
      moneyPython = pkgs.writeShellApplication {
        name = "money-python";
        runtimeInputs = [ python ];
        text = ''exec python3 "$@"'';
      };

      check = pkgs.writeShellApplication {
        name = "money-check";
        runtimeInputs = [ python ];
        text = "exec bean-check ${lib.escapeShellArg cfg.ledger}";
      };
    in
    {
      options.balaur.money = {
        ledger = lib.mkOption {
          type = lib.types.str;
          default = "${config.balaur.lifelog-folder or "/srv/life"}/money/main.beancount";
          defaultText = lib.literalExpression ''"''${config.balaur.lifelog-folder}/money/main.beancount"'';
          description = "The main Beancount file: the one Fava opens and `bean-check` checks. It may `include` others next to it.";
        };
      };

      config = {
        assertions = [
          {
            assertion = config.balaur ? lifelog;
            message = "the `money` aspect keeps its ledger in the life folder, whose history the keeper writes: add `lifelog` to this machine";
          }
          {
            assertion = config.balaur ? web;
            message = "the `money` aspect serves Fava through the `web` aspect (Caddy): add `web` to this machine";
          }
        ];

        environment.systemPackages = [
          pkgs.python3Packages.beancount # bean-check, bean-format, bean-doctor
          pkgs.python3Packages.beanquery # bean-query
          moneyPython
        ];
        environment.variables.BALAUR_LEDGER = cfg.ledger;

        # The folder, before Syncthing or the owner makes it: the group writes,
        # like the rest of the life folder.
        systemd.tmpfiles.rules = [
          "d ${dir} 2770 ${config.services.syncthing.user} lifelog -"
        ];

        # Fava listens on a Unix socket only Caddy can open, as the life log's web
        # app does (lifelog.nix): a loopback port is open to every local account.
        # systemd makes the socket and starts Fava on the first request. Its one
        # worker keeps the ledger in memory and reloads it when the file changes,
        # so an edit from the agent or the laptop shows on the next page.
        users.users.fava = {
          isSystemUser = true;
          group = "fava";
          extraGroups = [ "lifelog" ];
        };
        users.groups.fava = { };
        systemd.sockets.fava = {
          wantedBy = [ "sockets.target" ];
          listenStreams = [ webSocket ];
          socketConfig = {
            SocketGroup = config.services.caddy.group;
            SocketMode = "0660";
          };
        };
        systemd.services.fava = {
          description = "Fava: the Beancount ledger's web page";
          requires = [ "fava.socket" ];
          after = [ "syncthing.service" ];
          unitConfig.ConditionPathExists = cfg.ledger;
          serviceConfig = {
            User = "fava";
            Group = "fava";
            # gunicorn takes the socket from systemd (LISTEN_FDS) and binds nothing itself.
            ExecStart = lib.escapeShellArgs [
              "${python}/bin/gunicorn"
              "--workers=1"
              "--worker-class=gthread"
              "--threads=4"
              # The first request loads the ledger, which takes a few seconds.
              "--timeout=120"
              "fava.application:create_app([${builtins.toJSON cfg.ledger}], load=True)"
            ];
            # Fava's editor and its "add transaction" write the ledger: group lifelog
            # (the setgid folder), mode 0660.
            UMask = "0007";
            ReadWritePaths = [ dir ];
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

        # Every night: a ledger that no longer balances (an edit by hand, a sync
        # conflict) fails this unit, and `notify` tells the owner of a failed unit.
        systemd.services.money-check = {
          description = "bean-check: the ledger balances";
          unitConfig.ConditionPathExists = cfg.ledger;
          serviceConfig = {
            Type = "oneshot";
            User = "fava";
            Group = "fava";
            ExecStart = lib.getExe check;
            ReadOnlyPaths = [ dir ];
            ProtectSystem = "strict";
            ProtectHome = true;
            PrivateTmp = true;
            PrivateDevices = true;
            PrivateNetwork = true;
            NoNewPrivileges = true;
            CapabilityBoundingSet = "";
          };
        };
        systemd.timers.money-check = {
          wantedBy = [ "timers.target" ];
          timerConfig = {
            OnCalendar = "03:30";
            Persistent = true;
          };
        };

        # The ledger's history is the life log's (the keeper commits the whole folder),
        # so its part of the restore drill goes with that state: the newest ledger in
        # the restored history still balances. A ledger can name plugins, which are
        # code, so bean-check does not run as root.
        balaur.state.lifelog.verify = lib.mkIf (inLife != null) ''
          git -c safe.directory='*' --git-dir "$restored" archive refs/heads/live ${lib.escapeShellArg (lib.head (lib.splitString "/" inLife))} | tar -x -C "$scratch"
          chown -R nobody "$scratch"
          setpriv --reuid=nobody --regid=nogroup --clear-groups ${python}/bin/bean-check "$scratch"/${lib.escapeShellArg inLife}
          echo "the ledger in the restored history balances"
        '';

        balaur.services = [
          {
            name = "Money";
            description = "The ledger: accounts, budgets and investments (Fava)";
            icon = "💶";
            socket = webSocket;
            subdomain = "money";
            # The owner's finances: their devices only.
            audience = "owner";
            unit = "fava.service";
            group = "Personal";
          }
        ];
      };
    };
}
