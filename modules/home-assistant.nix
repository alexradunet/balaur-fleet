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
              "jellyfin"
              "qbittorrent"
              "adguard"
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
