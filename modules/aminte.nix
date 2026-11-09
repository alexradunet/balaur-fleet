# aminte (github.com/alexradunet/aminte): the life log, one SQLite file, life.db.
# Two aspects:
#
#   aminte       runs `aminte serve` with its extensions (web, agent, whatsapp,
#                ticktick), on one machine: the always-on one, balaur. The browser
#                is https://aminte.<balaur.web.domain>, tailnet only.
#   aminte-dev   the binaries and `aminte-prod`, for the machine you develop on.
#
# life.db can never be shared between machines as a file. It runs in WAL mode,
# which needs shared memory between processes, so aminte's contract
# (docs/contract/connections.md) forbids NFS/SMB/sshfs and a Syncthing folder.
# Instead, dev reaches prod in one of two ways:
#
#   - Clients and extensions work on the live data through prod's API:
#       aminte-prod aminte day --human
#       cd extensions/web && AMINTE_WEB_LISTEN=127.0.0.1:7790 aminte-prod go run ./cmd/aminte-web
#     aminte-prod opens `ssh -L 7777:127.0.0.1:7777 balaur` (the core's Host
#     guard wants the same port on both ends) and sets AMINTE_URL/AMINTE_TOKEN;
#     for the aminte CLI itself it adds `--url`, which the CLI needs.
#     Don't run a dev agent or whatsapp against prod while prod runs its own:
#     every message would get two answers.
#   - Core and schema work runs on a copy. The nightly snapshot (it does its own
#     restore check) is copied to <synced folder>/aminte/life-latest.db, which
#     Syncthing brings to the other machines:
#       cp /srv/files/shared/aminte/life-latest.db ~/Projects/aminte/life.db
#     The copy is mode 0640, group media, like everything in the synced folder.
#
# Set up once on the serving machine (as root):
#   - The token: `aminte-token` in secrets/balaur.yaml (64 hex characters).
#   - The agent's model, kept in life.settings.json beside life.db: with the
#     `ai` aspect it is set before every start to the fleet's entryway (ai.nix).
#     Without it, by hand:
#       sudo -u aminte HOME=/var/lib/aminte aminte --db /var/lib/aminte/life.db \
#         do settings model_url=<url> model=<id> model_key=<key>
#   - Moving an existing life.db here: stop aminte.service, install the snapshot as
#     /var/lib/aminte/life.db (owner aminte, 0600), and the old state folders as
#     /var/lib/aminte/.config/aminte-NAME. Then start it again.
{ inputs, ... }:
let
  src = inputs.aminte;
  port = 7777; # the core, loopback only
  webPort = 7780; # aminte-web, behind Caddy
in
{
  flake.modules.nixos.aminte =
    { config, lib, pkgs, ... }:
    let
      cfg = config.balaur;
      aminte = pkgs.callPackage ../pkgs/aminte.nix { inherit src; };
      state = "/var/lib/aminte";
      db = "${state}/life.db";
      snapshots = "${state}/snapshots";
      # The synced folder of the `files` aspect, when this machine has it.
      synced = if cfg ? files then "${toString cfg.storage.root}/files/${cfg.files.folderName}" else null;
      domain = cfg.web.domain or null;

      publishLatest = pkgs.writeShellApplication {
        name = "aminte-publish-latest";
        runtimeInputs = [ pkgs.coreutils pkgs.gnugrep ];
        text = ''
          # The newest good snapshot (the same pattern aminte-snapshot prunes by).
          export LC_ALL=C
          newest=""
          for f in ${snapshots}/life-*.db; do
            n=''${f##*/}
            # Later names sort later in the C locale (for one day, "." before "T").
            if [[ $n =~ ^life-[0-9]{4}-[0-9]{2}-[0-9]{2}(T[0-9]{6})?\.db$ ]] && [[ $n > $newest ]]; then newest=$n; fi
          done
          [ -n "$newest" ] || { echo "no good snapshot in ${snapshots}" >&2; exit 1; }
          install -d -m 2770 -g media ${synced}/aminte
          # Syncthing ignores .syncthing.*.tmp, so it never sends a half-written copy.
          tmp=${synced}/aminte/.syncthing.life-latest.db.tmp
          install -m 0640 -g media ${snapshots}/"$newest" "$tmp"
          mv -f "$tmp" ${synced}/aminte/life-latest.db
          echo "published $newest as ${synced}/aminte/life-latest.db"
        '';
      };
    in
    {
      options.balaur.aminte = {
        extensions = lib.mkOption {
          type = lib.types.listOf (lib.types.enum [ "web" "agent" "whatsapp" "ticktick" ]);
          default = [ "web" "agent" "whatsapp" "ticktick" ];
          description = ''
            The extensions `serve` runs beside the core. One that is not set up yet
            (whatsapp before `aminte whatsapp login`, ticktick before `aminte ticktick login`)
            exits 78 and is not started again; the others are unaffected.
          '';
        };
        tokenFile = lib.mkOption {
          type = lib.types.path;
          description = "The server's bearer token: one line, 32 characters or more. Also the browser's login.";
        };
        ownerNumberFile = lib.mkOption {
          type = lib.types.nullOr lib.types.path;
          default = null;
          description = ''
            A file holding the owner's phone number (digits with the country code):
            the one number aminte-whatsapp listens to. Written into the settings
            (owner_number) before every start, so the Settings page cannot drift
            from it; the other settings are left as they are. null leaves
            owner_number to the Settings page.
          '';
        };
      };

      config = {
        users.users.aminte = {
          isSystemUser = true;
          group = "aminte";
          home = state;
          # To write the latest snapshot into the synced folder.
          extraGroups = lib.optional (synced != null) "media";
        };
        users.groups.aminte = { };

        environment.systemPackages = [ aminte ];

        systemd.services.aminte = {
          description = "aminte server (life.db)";
          wantedBy = [ "multi-user.target" ];
          after = [ "network-online.target" ];
          wants = [ "network-online.target" ];
          environment = {
            HOME = state; # the extensions keep their state in ~/.config/aminte-NAME
            AMINTE_WEB_LISTEN = "127.0.0.1:${toString webPort}";
          } // lib.optionalAttrs (domain != null) {
            AMINTE_WEB_ORIGINS = "https://aminte.${domain}";
          };
          preStart = ''
            install -d -m 0700 ${snapshots}
            [ -e ${db} ] || ${lib.getExe aminte} --db ${db} init
          '' + lib.optionalString (cfg.aminte.ownerNumberFile != null) ''
            # A field left out of `settings` stays as it is, so this sets the number alone.
            # A value that is not digits fails here, and the service stays down.
            ${lib.getExe aminte} --db ${db} do settings \
              owner_number="$(tr -d ' \n' < ${toString cfg.aminte.ownerNumberFile})" > /dev/null
          '' + lib.optionalString (cfg ? ai) ''
            # The agent's model: the fleet's AI entryway (ai.nix), like everything
            # else here. It takes no key; aminte wants one, so it gets a placeholder.
            ${lib.getExe aminte} --db ${db} do settings \
              model_url=${cfg.ai.url} model=balaur model_key=balaur > /dev/null
          '';
          serviceConfig = {
            User = "aminte";
            Group = "aminte";
            ExecStart = lib.escapeShellArgs ([
              (lib.getExe aminte) "--db" db "serve"
              "--token-file" (toString cfg.aminte.tokenFile)
              "--snapshots" snapshots
            ] ++ lib.concatMap (e: [ "--with" e ]) cfg.aminte.extensions);
            StateDirectory = "aminte";
            StateDirectoryMode = "0700";
            UMask = "0077";
            Restart = "on-failure";
            # SIGTERM reaches aminte alone; it stops its --with children, then
            # drains its requests (up to 10 s) and closes life.db.
            KillSignal = "SIGTERM";
            KillMode = "mixed";
            TimeoutStopSec = 30;
            ProtectSystem = "strict";
            ProtectHome = true;
            PrivateTmp = true;
            PrivateDevices = true;
            NoNewPrivileges = true;
            ProtectKernelTunables = true;
            ProtectControlGroups = true;
            RestrictSUIDSGID = true;
            LockPersonality = true;
          };
        };

        # Nightly snapshot, with aminte's own script (it prunes to the newest 14).
        systemd.services.aminte-snapshot = {
          description = "aminte nightly snapshot of life.db";
          onFailure = [ "aminte-snapshot-failed.service" ];
          path = [ pkgs.coreutils pkgs.gnugrep ];
          environment = {
            HOME = state;
            AMINTE_BIN = lib.getExe aminte;
            AMINTE_DB = db;
            AMINTE_SNAPSHOTS = snapshots;
          };
          serviceConfig = {
            Type = "oneshot";
            User = "aminte";
            Group = "aminte";
            ExecStart = "${pkgs.runtimeShell} ${aminte}/share/aminte/aminte-snapshot";
            ExecStartPost = lib.optional (synced != null) (lib.getExe publishLatest);
            TimeoutStartSec = "30min";
            UMask = "0077";
            ProtectSystem = "strict";
            ProtectHome = true;
            PrivateTmp = true;
            NoNewPrivileges = true;
            ReadWritePaths = [ state ] ++ lib.optional (synced != null) "-${synced}";
          };
        };
        systemd.timers.aminte-snapshot = {
          wantedBy = [ "timers.target" ];
          timerConfig = {
            OnCalendar = "*-*-* 03:17:00";
            Persistent = true; # a night the machine was off: once at the next start
          };
        };
        systemd.services.aminte-snapshot-failed = {
          description = "aminte nightly snapshot failed";
          serviceConfig = {
            Type = "oneshot";
            SyslogIdentifier = "aminte-snapshot-failed";
            ExecStart = "${pkgs.coreutils}/bin/echo '<3>the nightly snapshot of life.db failed; read: journalctl -u aminte-snapshot.service'";
          };
        };

        balaur.services = [{
          name = "Aminte";
          description = "The life log";
          icon = "📓";
          port = webPort;
          subdomain = "aminte";
          unit = "aminte.service";
          group = "Personal";
        }];
      };
    };

  flake.modules.nixos.aminte-dev =
    { config, lib, pkgs, ... }:
    let
      cfg = config.balaur.aminte-dev;
      aminte = pkgs.callPackage ../pkgs/aminte.nix { inherit src; };
      prod = pkgs.writeShellApplication {
        name = "aminte-prod";
        runtimeInputs = [ pkgs.openssh pkgs.coreutils ];
        text = ''
          # Run a command against prod's aminte on ${cfg.host}, through an SSH tunnel
          # that stays open in the background (one per login session).
          if [ $# -eq 0 ]; then echo "usage: aminte-prod COMMAND [ARGS...]   (aminte-prod --close ends the tunnel)" >&2; exit 2; fi
          sock="''${XDG_RUNTIME_DIR:-/tmp}/aminte-prod.sock"
          if [ "$1" = --close ]; then exec ssh -S "$sock" -O exit ${cfg.host}; fi
          if ! ssh -S "$sock" -O check ${cfg.host} 2>/dev/null; then
            # Same port on both ends: the core refuses a Host that names another port.
            ssh -f -N -M -S "$sock" -o ExitOnForwardFailure=yes \
              -L 127.0.0.1:${toString port}:127.0.0.1:${toString port} ${cfg.host}
          fi
          AMINTE_URL=http://127.0.0.1:${toString port}
          AMINTE_TOKEN=$(cat ${toString cfg.tokenFile})
          export AMINTE_URL AMINTE_TOKEN
          # The extensions read AMINTE_URL; the aminte CLI only goes remote with --url,
          # and without it would open the life.db beside its own binary.
          if [ "''${1##*/}" = aminte ]; then
            cmd=$1; shift
            exec "$cmd" --url "$AMINTE_URL" "$@"
          fi
          exec "$@"
        '';
      };
    in
    {
      options.balaur.aminte-dev = {
        host = lib.mkOption {
          type = lib.types.str;
          default = "balaur";
          description = "The machine that serves prod.";
        };
        tokenFile = lib.mkOption {
          type = lib.types.path;
          description = "Prod's bearer token, readable by the developer.";
        };
      };

      config.environment.systemPackages = [ aminte prod ];
    };
}
