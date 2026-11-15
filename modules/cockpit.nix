# Cockpit, the web admin page of a headless machine: its units and their logs, a
# terminal, CPU, memory, disks and network, at https://cockpit.<domain> (with
# `web`) or http://<host>:9090 on the tailnet. You log in with the machine's own
# account and password (PAM), and administrative actions ask for sudo.
#
# It only looks at the machine and drives systemd. The configuration still comes
# from this flake: a unit started or a setting changed in Cockpit lasts until the
# next deploy. Cockpit was picked over CasaOS and Umbrel because those are Docker
# app stores that want to own the machine, and their apps would live outside the
# flake and auto-deploy. It is socket-activated, so it uses no CPU while nobody
# has it open.
{ config, ... }:
let
  fleet = config.fleet;
in
{
  flake.modules.nixos.cockpit =
    {
      config,
      lib,
      pkgs,
      ...
    }:
    let
      cfg = config.balaur.cockpit;
      me = config.networking.hostName;
      domain = config.balaur.web.domain or null;
    in
    {
      options.balaur.cockpit = {
        port = lib.mkOption {
          type = lib.types.port;
          default = 9090;
          description = "Port Cockpit listens on (the tailnet; the LAN firewall stays closed).";
        };
      };

      config = {
        services.cockpit = {
          enable = true;
          inherit (cfg) port;
          # Browse and edit files as well (/srv/proton, /srv/media).
          plugins = [ pkgs.cockpit-files ];
          # The pages it is opened from. Its websocket refuses any other origin.
          allowed-origins = [
            "http://${fleet.${me}.address or me}:${toString cfg.port}"
          ]
          ++ lib.optionals (domain != null) [
            "https://cockpit.${domain}"
            "wss://cockpit.${domain}"
          ];
          settings.WebService = {
            # Plain HTTP: the tailnet is already WireGuard, and Caddy adds HTTPS
            # in front. Without this it redirects every non-local visitor to its
            # own self-signed certificate.
            AllowUnencrypted = true;
            # Caddy says the page was opened over HTTPS, so the cookie is marked secure.
            ProtocolHeader = "X-Forwarded-Proto";
          };
          showBanner = false;
        };

        # The Storage page reads the disks through udisks.
        services.udisks2.enable = true;

        balaur.services = [
          {
            name = "Cockpit";
            description = "This machine's units, logs, terminal, disks and load";
            icon = "🛠️";
            port = cfg.port;
            subdomain = "cockpit";
            unit = "cockpit.socket";
            group = "System";
          }
        ];
      };
    };
}
