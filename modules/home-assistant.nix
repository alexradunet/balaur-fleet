# Home automation: Home Assistant, the NixOS way (no container, no Supervisor).
#
# The web UI is https://home.<domain> (the `web` aspect) and :8123 on the LAN and
# the tailnet, so the companion app works at home and away. Unlike the other
# services it has its own accounts: the first visit runs onboarding and creates
# the owner. Integrations, dashboards, automations, scenes and scripts are set in
# the UI and kept in /var/lib/hass across rebuilds; this file only says which
# integrations are installed (Nix builds their Python dependencies) and the
# settings that must hold for the proxy.
#
# An integration missing from `extraComponents` shows in the UI but fails to set
# up ("No module named ..."): add it here and push.
#
# The fleet in Home Assistant, declared here and not clicked together. Every machine
# of the registry sends how it is every five minutes (`balaur-fleet-report`,
# notify.nix) to a webhook of its own, and that fills its entities:
#
#   sensor.fleet_<host>_state            running, degraded, ... (attribute: the failed units)
#   sensor.fleet_<host>_commit           the deployed commit (attribute: the one it is trying)
#   sensor.fleet_<host>_disk_used        the fullest filesystem, in % (attribute: each one)
#   sensor.fleet_<host>_last_report      when it last said anything
#   sensor.fleet_<host>_last_backup      when its backup last succeeded (a machine with `backup`)
#   binary_sensor.fleet_<host>_reboot_needed   a new kernel waits for a reboot
#
# and three rules tell the owner (`balaur.home-assistant.notify`) about what is not
# a failed unit: a disk over 90 %, no good backup for a day and a half, a reboot
# that has waited a day. A failed unit is told at once by the machine itself
# (notify.nix). More rules, dashboards and the house's own automations are made in
# the UI as before.
#
# The webhooks take no login: whoever is on the home network or the tailnet could
# send a false report (and nothing else). They are not for the internet, like the
# rest of this.
{ config, ... }:
let
  fleet = config.fleet;
  nixosConfigs = config.flake.nixosConfigurations;
in
{
  flake.modules.nixos.home-assistant =
    {
      config,
      lib,
      pkgs,
      ...
    }:
    let
      port = 8123;
      hass = config.services.home-assistant;
      importFrom = config.balaur.home-assistant.importFrom;
      cfg = config.balaur.home-assistant;
      me = config.networking.hostName;
      hostConfig = h: if h == me then config else nixosConfigs.${h}.config;
      hasBackup = h: (h == me || nixosConfigs ? ${h}) && (hostConfig h).balaur ? backup;

      # ---- the fleet's entities: one webhook and one set of sensors per machine ----
      id = h: lib.replaceStrings [ "-" ] [ "_" ] h;
      machine = h: {
        trigger = [
          {
            trigger = "webhook";
            webhook_id = "balaur-fleet-${h}";
            allowed_methods = [ "POST" ];
            # The laptop reports over the tailnet, which Home Assistant does not
            # count as local.
            local_only = false;
          }
        ];
        sensor = [
          {
            name = "Fleet ${h} state";
            unique_id = "balaur_fleet_${id h}_state";
            icon = "mdi:server";
            state = "{{ trigger.json.state }}";
            attributes.failed_units = "{{ trigger.json.failed | default([]) | join(', ') }}";
          }
          {
            name = "Fleet ${h} commit";
            unique_id = "balaur_fleet_${id h}_commit";
            icon = "mdi:source-commit";
            state = "{{ (trigger.json.deployed | default('unknown', true))[:7] }}";
            attributes.trying = "{{ trigger.json.trying | default('') }}";
          }
          {
            name = "Fleet ${h} disk used";
            unique_id = "balaur_fleet_${id h}_disk_used";
            icon = "mdi:harddisk";
            unit_of_measurement = "%";
            state_class = "measurement";
            state = "{{ trigger.json.disks.values() | max }}";
            attributes.filesystems = "{{ trigger.json.disks | tojson }}";
          }
          {
            name = "Fleet ${h} last report";
            unique_id = "balaur_fleet_${id h}_last_report";
            device_class = "timestamp";
            state = "{{ now().isoformat() }}";
          }
        ]
        ++ lib.optional (hasBackup h) {
          name = "Fleet ${h} last backup";
          unique_id = "balaur_fleet_${id h}_last_backup";
          device_class = "timestamp";
          # Kept as it was while the last run is not a good one.
          state = "{{ trigger.json.backup_at | default(this.state if as_datetime(this.state) is not none else none, true) }}";
        };
        binary_sensor = [
          {
            name = "Fleet ${h} reboot needed";
            unique_id = "balaur_fleet_${id h}_reboot_needed";
            icon = "mdi:restart-alert";
            state = "{{ trigger.json.reboot | default(false) }}";
          }
        ];
      };

      # ---- the rules ----
      tell =
        title: message:
        [
          {
            action = "persistent_notification.create";
            data = { inherit title message; };
          }
        ]
        ++ map (service: {
          action = "notify.${service}";
          data = { inherit title message; };
        }) cfg.notify;
      rules =
        h:
        [
          {
            id = "balaur_fleet_${id h}_disk";
            alias = "Fleet: ${h}'s disk is nearly full";
            trigger = [
              {
                trigger = "numeric_state";
                entity_id = "sensor.fleet_${id h}_disk_used";
                above = 90;
              }
            ];
            action = tell "${h}: a disk is nearly full" "{{ state_attr('sensor.fleet_${id h}_disk_used', 'filesystems') }} (% used)";
          }
          {
            id = "balaur_fleet_${id h}_reboot";
            alias = "Fleet: ${h} waits for a reboot";
            trigger = [
              {
                trigger = "state";
                entity_id = "binary_sensor.fleet_${id h}_reboot_needed";
                to = "on";
                "for" = "24:00:00";
              }
            ];
            action = tell "${h}: reboot it" "A new kernel has waited for a reboot since yesterday.";
          }
        ]
        ++ lib.optional (hasBackup h) {
          id = "balaur_fleet_${id h}_backup";
          alias = "Fleet: ${h} has no recent backup";
          trigger = [
            {
              trigger = "template";
              value_template = "{{ as_datetime(states('sensor.fleet_${id h}_last_backup')) is not none and (now() - as_datetime(states('sensor.fleet_${id h}_last_backup'))).total_seconds() > ${
                toString (cfg.backupStaleHours * 3600)
              } }}";
            }
          ];
          action = tell "${h}: no backup since {{ as_datetime(states('sensor.fleet_${id h}_last_backup')) | as_local | as_timestamp | timestamp_custom('%A %H:%M') }}" "The nightly backup has not succeeded for ${toString cfg.backupStaleHours} hours: journalctl -u restic-backups-balaur";
        };

      # A Home Assistant moving in from another machine: started with nothing of
      # its own, it would run onboarding and become a new, empty house. So until
      # its state is there it does not start, and the state comes from the archive.
      hasState = pkgs.writeShellApplication {
        name = "hass-has-state";
        text = ''
          [ -e ${hass.configDir}/.storage ] || [ -f ${toString importFrom} ]
        '';
      };
      unpack = pkgs.writeShellApplication {
        name = "hass-import";
        runtimeInputs = [
          pkgs.gnutar
          pkgs.coreutils
        ];
        text = ''
          if [ ! -e ${hass.configDir}/.storage ]; then
            tar -xf ${toString importFrom} -C ${hass.configDir} --strip-components=1
            echo "state imported from ${toString importFrom}: $(find ${hass.configDir}/.storage -type f | wc -l) files in .storage"
          fi
        '';
      };
    in
    {
      options.balaur.home-assistant.notify = lib.mkOption {
        type = lib.types.listOf lib.types.str;
        default = [ ];
        example = [ "mobile_app_phone" ];
        description = "Home Assistant's notify services the fleet's rules tell (a phone with the companion app is `mobile_app_<its name>`), besides Home Assistant's own notifications.";
      };
      options.balaur.home-assistant.backupStaleHours = lib.mkOption {
        type = lib.types.ints.positive;
        default = 36;
        description = "Hours without a good backup, on a machine with the `backup` aspect, before the owner is told.";
      };
      options.balaur.home-assistant.importFrom = lib.mkOption {
        type = lib.types.nullOr lib.types.str;
        default = null;
        example = "/var/lib/hass-import/hass.tar";
        description = ''
          For a Home Assistant moving in from another machine: a tar of the old
          /var/lib/hass (`tar -C /var/lib -cf - hass`, made with Home Assistant
          stopped there). Until this machine has state of its own, it does not start;
          when the archive appears it starts, unpacked into an empty config dir. The
          owner writes it into the import folder, which only the owner and the
          `hass` group can enter.
        '';
      };

      config = lib.mkMerge [
        (lib.mkIf (importFrom != null) {
          systemd.tmpfiles.rules = [ "d ${dirOf importFrom} 0710 ${config.balaur.user} hass -" ];
          systemd.services.home-assistant.serviceConfig = {
            ExecCondition = lib.getExe hasState;
            ExecStartPre = lib.mkBefore [ (lib.getExe unpack) ];
          };
          # Starts it when the archive arrives.
          systemd.paths.hass-import = {
            wantedBy = [ "paths.target" ];
            pathConfig = {
              PathExists = importFrom;
              Unit = "home-assistant.service";
            };
          };
        })
        {
          services.home-assistant = {
            enable = true;
            extraComponents = [
              # What onboarding sets up by itself; without them it stops with an error.
              "analytics"
              "google_translate"
              "met"
              "radio_browser"
              "shopping_list"
              # Faster compression of the frontend's responses.
              "isal"
              # The house's own devices and services.
              "samsungtv" # the living-room TV
              "cast" # found on the network
              "sonos" # found on the network
              "tuya" # found on the network
              "homekit_controller"
              "dlna_dmr"
              "netatmo" # the thermostat
              "roborock" # the vacuum, set up in the Roborock app
              "xiaomi_miio" # the same vacuum, if it is in Xiaomi's Mi Home app instead
              "qbittorrent"
              "syncthing"
              "upnp" # the router
              "ipp" # printers
              "esphome"
              "mqtt"
              # An MCP server at /api/mcp for agents, set up in the UI ("Model Context
              # Protocol Server"), offering what is exposed to Assist.
              "mcp_server"
            ];
            config = {
              # The usual set: the UI's editors, discovery, the mobile app, history, ...
              default_config = { };
              homeassistant = {
                name = "Balaur";
                time_zone = config.time.timeZone;
                unit_system = "metric";
                temperature_unit = "C";
                currency = "RON";
                country = "RO";
              };
              http = {
                server_port = port;
                # Caddy (the `web` aspect) on the same machine.
                use_x_forwarded_for = true;
                trusted_proxies = [
                  "127.0.0.1"
                  "::1"
                ];
              };
              # The fleet's machines as entities, and the rules about them (above).
              template = map machine (lib.attrNames fleet);
              "automation fleet" = lib.concatMap rules (lib.attrNames fleet);
              # What the UI's editors write; a generated configuration.yaml cannot hold it.
              "automation ui" = "!include automations.yaml";
              "scene ui" = "!include scenes.yaml";
              "script ui" = "!include scripts.yaml";
            };
          };

          # The files the editors above write into; Home Assistant will not start if
          # an included one is missing.
          systemd.tmpfiles.rules = map (f: "f ${hass.configDir}/${f} 0644 hass hass - []") [
            "automations.yaml"
            "scenes.yaml"
            "scripts.yaml"
          ];

          # The LAN too (tailscale0 is trusted already): the phone's companion app at home.
          networking.firewall.allowedTCPPorts = [ port ];

          # What was set up in its UI: integrations, dashboards, automations, accounts.
          balaur.state.home-assistant = {
            path = hass.configDir;
            exclude = [
              # Its history: large, live SQLite, and rebuilt by running.
              "${hass.configDir}/home-assistant_v2.db*"
              "${hass.configDir}/backups"
            ];
            verify = ''test -s "$restored/.storage/core.config_entries"'';
          };

          balaur.services = [
            {
              name = "Home Assistant";
              description = "Lights, devices & automations";
              icon = "🏠";
              inherit port;
              subdomain = "home";
              audience = "household"; # its own accounts: the others are not administrators
              login = true;
              unit = "home-assistant.service";
              appIcon = "${hass.package.frontend}/${hass.package.python3Packages.python.sitePackages}/hass_frontend/static/icons/favicon-192x192.png";
              group = "Home";
            }
          ];
        }
      ];
    };
}
