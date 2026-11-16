# Notify: when something on a machine breaks, the owner is told, instead of it
# waiting for someone to run `balaur-fleet-status`.
#
#   - A unit that fails: every service gets `OnFailure=balaur-notify-failure@<unit>`,
#     which sends the unit's name and its last log lines. Once per unit in
#     `quietHours`, however often it fails (auto-deploy stays failed between its
#     attempts, on purpose).
#   - A disk that reports trouble: smartd watches the drives (SMART health, error
#     counts, temperature) and sends its message the same way.
#
# Where it goes: Home Assistant, on the fleet machine that runs it. Always into its
# own notifications (the bell in its sidebar), and to every phone that has the
# companion app logged in (`notify.mobile_app_<phone>`, found when sending: a phone
# added later needs nothing here). It is sent with the token of Home Assistant's
# user for the screens, which is not an administrator.
#
# And how the machine is, every five minutes, for Home Assistant's fleet entities
# and the rules made of them (home-assistant.nix): `balaur-fleet-report` sends its
# state, failed units, deployed commit, disks, a waiting reboot and its last good
# backup to the machine's webhook there.
#
# What it cannot say: that this machine is off, or that Home Assistant itself is
# down. A unit that stops with success (status 0) is not a failure either; such a
# service needs `Restart=always` (torrents.nix).
#
#   balaur-notify "title" "message"       send one by hand (as root)
#   journalctl -u 'balaur-notify-failure@*'   what was sent, and what was held back
{ config, ... }:
let
  fleet = config.fleet;
  nixosConfigs = config.flake.nixosConfigurations;
in
{
  flake.modules.nixos.notify =
    {
      config,
      options,
      lib,
      pkgs,
      ...
    }:
    let
      cfg = config.balaur.notify;
      me = config.networking.hostName;
      useSops = options ? sops;
      tokenSecret = "home-assistant-agent-token";
      hostConfig = h: if h == me then config else nixosConfigs.${h}.config;
      hassHosts = lib.filter (
        h: (h == me || nixosConfigs ? ${h}) && (hostConfig h).services.home-assistant.enable
      ) (lib.attrNames fleet);
      hassHost = lib.head hassHosts;
      inherit (cfg) url;

      notify = pkgs.writeShellApplication {
        name = "balaur-notify";
        runtimeInputs = [
          pkgs.curl
          pkgs.jq
          pkgs.coreutils
        ];
        text = ''
          if [ $# -lt 1 ]; then echo "usage: balaur-notify TITLE [MESSAGE]" >&2; exit 2; fi
          title=$1
          message=''${2:-$1}
          # A unit hands the token over as a credential; by hand it is root's to read.
          if [ -n "''${CREDENTIALS_DIRECTORY:-}" ]; then
            token=$(cat "$CREDENTIALS_DIRECTORY/token")
          else
            token=$(cat ${toString cfg.tokenFile})
          fi
          api() {
            curl -fsS --max-time 15 -H "Authorization: Bearer $token" -H "Content-Type: application/json" "$@"
          }
          body=$(jq -n --arg t "$title" --arg m "$message" '{title: $t, message: $m}')
          sent=0
          # Home Assistant's own notifications, always.
          if api -d "$body" ${url}/api/services/persistent_notification/create >/dev/null; then sent=1; fi
          # And every phone with the companion app.
          phones=$(api ${url}/api/services \
            | jq -r '.[] | select(.domain == "notify") | .services | keys[] | select(startswith("mobile_app_"))' || true)
          for phone in $phones; do
            if api -d "$body" "${url}/api/services/notify/$phone" >/dev/null; then sent=1; fi
          done
          if [ "$sent" = 0 ]; then
            echo "balaur-notify: Home Assistant at ${url} took nothing: $title" >&2
            exit 1
          fi
          echo "sent: $title''${phones:+ (also to $(echo "$phones" | tr '\n' ' '))}"
        '';
      };

      failed = pkgs.writeShellApplication {
        name = "balaur-notify-failure";
        runtimeInputs = [
          notify
          pkgs.coreutils
          pkgs.systemd
        ];
        text = ''
          unit=$1
          stamp=$STATE_DIRECTORY/$(printf %s "$unit" | tr -c 'A-Za-z0-9@._-' _)
          now=$(date +%s)
          if [ -f "$stamp" ] && [ $((now - $(cat "$stamp"))) -lt ${toString (cfg.quietHours * 3600)} ]; then
            echo "$unit failed again; already said within ${toString cfg.quietHours} h"
            exit 0
          fi
          log=$(journalctl -u "$unit" -n 6 -o cat --no-pager 2>/dev/null | cut -c1-240 || true)
          if balaur-notify "${me}: $unit failed" "''${log:-No log lines.}"; then
            echo "$now" >"$stamp"
          else
            exit 1
          fi
        '';
      };

      # How this machine is, as JSON, to its webhook in Home Assistant.
      report = pkgs.writeShellApplication {
        name = "balaur-fleet-report";
        runtimeInputs = [
          pkgs.curl
          pkgs.jq
          pkgs.coreutils
          pkgs.systemd
        ];
        text = ''
          state=$(systemctl is-system-running || true)
          failed=$(systemctl --failed --plain --no-legend | cut -d' ' -f1 | jq -R . | jq -cs .)
          # auto-deploy's own record, where the machine has it.
          deploy=/var/lib/balaur-auto-deploy
          deployed=$(cat $deploy/deployed 2>/dev/null || true)
          trying=$(cat $deploy/tried 2>/dev/null || true)
          if [ "$trying" = "$deployed" ]; then trying=; fi
          reboot=false
          for part in kernel kernel-modules initrd; do
            if [ "$(readlink -f /run/booted-system/$part)" != "$(readlink -f /run/current-system/$part)" ]; then
              reboot=true
            fi
          done
          # Real filesystems only: {"/": 61, "/srv/media": 17}
          disks=$(df --output=target,pcent -t ext4 -t btrfs -t xfs -t f2fs | tail -n +2 \
            | jq -R 'split(" ") | map(select(. != "")) | {(.[0]): (.[1] | rtrimstr("%") | tonumber)}' | jq -cs 'add // {}')
          # The last good backup, on a machine that makes one.
          backup_at=
          if [ "$(systemctl show restic-backups-balaur -P Result 2>/dev/null)" = success ]; then
            at=$(systemctl show restic-backups-balaur --timestamp=unix -P InactiveEnterTimestamp 2>/dev/null || true)
            if [ -n "$at" ]; then backup_at=$(date -d "$at" -Iseconds); fi
          fi
          jq -cn --arg state "$state" --argjson failed "$failed" --arg deployed "$deployed" --arg trying "$trying" \
            --argjson reboot "$reboot" --argjson disks "$disks" --arg backup_at "$backup_at" \
            '{state: $state, failed: $failed, deployed: $deployed, trying: $trying, reboot: $reboot, disks: $disks}
             + (if $backup_at == "" then {} else {backup_at: $backup_at} end)' \
            | curl -fsS --max-time 15 -H "Content-Type: application/json" -d @- ${url}/api/webhook/balaur-fleet-${me}
        '';
      };

      # smartd runs it as root, with its message in the environment.
      disk = pkgs.writeShellApplication {
        name = "balaur-notify-disk";
        runtimeInputs = [ notify ];
        text = ''
          balaur-notify "${me}: disk ''${SMARTD_DEVICE:-?} (''${SMARTD_FAILTYPE:-smartd})" "''${SMARTD_MESSAGE:-smartd reports a problem.}"
        '';
      };

      # For every service at once: a drop-in for the unit type. That includes the
      # notifier and the report, and a drop-in cannot take a dependency away again
      # (systemd.unit(5)). So those two never fail instead: their commands' exit
      # status is ignored (`-`), and curl gives up long before systemd would. A
      # notifier that could fail would be told about by a notifier, and so on; and a
      # failed unit during a switch makes auto-deploy count the deploy as failed
      # (2026-11-17: the report ran while Home Assistant restarted in the same switch).
      dropIns = pkgs.runCommand "balaur-notify-drop-ins" { } ''
        mkdir -p $out/lib/systemd/system/service.d
        printf '[Unit]\nOnFailure=balaur-notify-failure@%%n.service\n' \
          > $out/lib/systemd/system/service.d/10-balaur-notify.conf
      '';
    in
    {
      options.balaur.notify = {
        url = lib.mkOption {
          type = lib.types.nullOr lib.types.str;
          default =
            if hassHosts == [ ] then
              null
            else
              "http://${
                if hassHost == me then "127.0.0.1" else fleet.${hassHost}.address
              }:${toString (hostConfig hassHost).services.home-assistant.config.http.server_port}";
          defaultText = lib.literalMD "the fleet machine that runs Home Assistant";
          description = "Home Assistant's address, as this machine reaches it.";
        };
        tokenFile = lib.mkOption {
          type = lib.types.path;
          default =
            if useSops then config.sops.secrets.${tokenSecret}.path else "/var/lib/secrets/balaur-notify-token";
          defaultText = lib.literalMD "the shared `home-assistant-agent-token` sops secret with the `secrets` aspect";
          description = "File with a long-lived access token of a Home Assistant user (not an administrator).";
        };
        quietHours = lib.mkOption {
          type = lib.types.ints.positive;
          default = 6;
          description = "After telling about a unit, hours before the same unit is told about again.";
        };
      };

      config = lib.mkMerge [
        {
          assertions = [
            {
              assertion = cfg.url != null;
              message = "the `notify` aspect sends through Home Assistant: no machine of the fleet runs it";
            }
          ];

          environment.systemPackages = [ notify ];

          systemd.packages = [ dropIns ];
          systemd.services."balaur-notify-failure@" = {
            description = "Tell the owner that %i failed";
            serviceConfig = {
              Type = "oneshot";
              ExecStart = "-${lib.getExe failed} %i"; # `-`: never failed itself (above)
              LoadCredential = "token:${toString cfg.tokenFile}";
              DynamicUser = true;
              StateDirectory = "balaur-notify"; # when each unit was last told about
              SupplementaryGroups = [ "systemd-journal" ]; # the failed unit's last lines
              CapabilityBoundingSet = "";
              NoNewPrivileges = true;
              PrivateTmp = true;
              PrivateDevices = true;
              ProtectHome = true;
              ProtectSystem = "strict";
              ProtectKernelTunables = true;
              ProtectKernelModules = true;
              ProtectControlGroups = true;
              RestrictAddressFamilies = [
                "AF_INET"
                "AF_INET6"
                "AF_UNIX"
              ];
              RestrictNamespaces = true;
              LockPersonality = true;
              SystemCallArchitectures = "native";
            };
          };

          systemd.services.balaur-fleet-report = {
            description = "Tell Home Assistant how this machine is";
            after = [ "network-online.target" ];
            wants = [ "network-online.target" ];
            serviceConfig = {
              Type = "oneshot";
              ExecStart = "-${lib.getExe report}"; # `-`: never failed (above)
              DynamicUser = true;
              CapabilityBoundingSet = "";
              NoNewPrivileges = true;
              PrivateTmp = true;
              PrivateDevices = true;
              ProtectHome = true;
              ProtectSystem = "strict";
              ProtectKernelTunables = true;
              ProtectKernelModules = true;
              ProtectControlGroups = true;
              RestrictNamespaces = true;
              LockPersonality = true;
              SystemCallArchitectures = "native";
            };
            # (A laptop away from the tailnet, Home Assistant restarting: the next
            # report is in five minutes.)
          };
          systemd.timers.balaur-fleet-report = {
            wantedBy = [ "timers.target" ];
            timerConfig = {
              OnBootSec = "1min";
              OnUnitInactiveSec = "5min";
            };
          };

          services.smartd = {
            enable = true;
            # Not a message on every terminal: ours.
            notifications.wall.enable = false;
            defaults.monitored = "-a -o on -s (S/../.././02|L/../../7/04) -m <nomailer> -M exec ${lib.getExe disk}";
          };
        }
        # (On a GNOME machine the `gnome` aspect declares the same secret, with the
        # group its screens read it through; the two merge.)
        (lib.optionalAttrs useSops { sops.secrets.${tokenSecret} = { }; })
      ];
    };
}
