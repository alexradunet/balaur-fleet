# Memos: notes, lists and comments for the people of the household, each with an
# account of their own (https://usememos.com, the NixOS module).
#
# The web UI is https://memos.<domain> (the `web` aspect); Memos itself listens on
# loopback only, so without `web` it is reachable from this machine alone. It is a
# household service (`audience`): the people the machine is shared with open it too.
#
# Its accounts are its own, kept in its database and set in its web UI, not here:
#   - The first account to sign up is the administrator: sign up before anyone else
#     can reach the page.
#   - Then Settings > System > "Disallow user registration", and create the other
#     accounts under Settings > Members.
#   - A memo is private unless its author says otherwise; "Workspace" shows it to
#     every account. Root on this machine can read the database all the same.
#
# The whole state is one SQLite file (attachments are kept in it by default, up to
# 30 MB each). A consistent copy is taken every night, which is what `backup` sends
# off the machine; the live file, in WAL mode, must not be copied as it is.
{
  flake.modules.nixos.memos =
    {
      config,
      lib,
      pkgs,
      ...
    }:
    let
      cfg = config.balaur.memos;
      domain = config.balaur.web.domain or null;
      data = "/var/lib/memos";
      # Memos names its database after its mode.
      db = "${data}/memos_prod.db";
      snapshots = "${data}/snapshots";

      # One copy per weekday: a week of nights to go back to, and nothing to prune.
      snapshot = pkgs.writeShellApplication {
        name = "memos-snapshot";
        runtimeInputs = [
          pkgs.coreutils
          pkgs.sqlite
        ];
        text = ''
          install -d -m 0700 ${snapshots}
          out=${snapshots}/memos-$(date +%u).db
          rm -f "$out.tmp"
          # SQLite's own backup: a consistent copy while Memos keeps writing.
          sqlite3 ${db} ".timeout 10000" ".backup '$out.tmp'"
          # A copy that does not check out never replaces a good one.
          [ "$(sqlite3 "$out.tmp" 'PRAGMA integrity_check;')" = ok ]
          mv -f "$out.tmp" "$out"
          echo "snapshot $out"
        '';
      };
    in
    {
      options.balaur.memos = {
        port = lib.mkOption {
          type = lib.types.port;
          default = 5230;
          description = "Memos' web UI, on loopback: the `web` aspect serves it at https://memos.<domain>.";
        };
      };

      config = {
        services.memos = {
          enable = true;
          dataDir = data;
          # All six: the module's defaults are one value, so setting any drops the rest.
          # (Never `openFirewall`: the module reads a `port` option it does not have.)
          settings = {
            MEMOS_MODE = "prod";
            MEMOS_ADDR = "127.0.0.1";
            MEMOS_PORT = toString cfg.port;
            MEMOS_DATA = data;
            MEMOS_DRIVER = "sqlite";
            MEMOS_INSTANCE_URL =
              if domain != null then "https://memos.${domain}" else "http://127.0.0.1:${toString cfg.port}";
          };
        };
        # The module sets a restart delay but no restart.
        systemd.services.memos.serviceConfig.Restart = "on-failure";

        systemd.services.memos-snapshot = {
          description = "Memos nightly snapshot of its database";
          # A machine where nobody has opened Memos yet has nothing to copy.
          unitConfig.ConditionPathExists = db;
          serviceConfig = {
            Type = "oneshot";
            User = config.services.memos.user;
            Group = config.services.memos.group;
            ExecStart = lib.getExe snapshot;
            UMask = "0077";
            ProtectSystem = "strict";
            ProtectHome = true;
            PrivateTmp = true;
            PrivateDevices = true;
            NoNewPrivileges = true;
            ReadWritePaths = [ data ];
          };
        };
        systemd.timers.memos-snapshot = {
          wantedBy = [ "timers.target" ];
          timerConfig = {
            OnCalendar = "*-*-* 03:40:00"; # before the backup's 04:30
            Persistent = true; # a night the machine was off: once at the next start
          };
        };

        balaur.services = [
          {
            name = "Memos";
            description = "Notes & lists, an account each";
            icon = "📝";
            port = cfg.port;
            subdomain = "memos";
            audience = "household";
            unit = "memos.service";
            group = "Home";
          }
        ];
      };
    };
}
