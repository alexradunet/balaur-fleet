# Network-wide ad and tracker blocking: AdGuard Home as the LAN's DNS server.
#
# Use it per device (TV: Settings → General → Network → Network Status →
# IP Settings → DNS Setting → Enter manually → this machine's LAN IP), or for the
# whole network by setting it as the DNS server in the router's DHCP settings.
# Either way, reserve this machine's IP in the router first.
#
# Settings below are applied on every start and win over the web UI for the keys
# they set (upstreams, filter lists, the `web` rewrites). Lists are replaced whole,
# so the UI's own filter lists do not survive a restart. Everything else, such as
# per-client settings, the query log and the custom rules (`user_rules`, where the UI
# keeps its allow-list and "Unblock" entries), is kept: the Samsung rules are a
# filter list from a file, not custom rules.
{ config, ... }:
let
  fleet = config.fleet;
  nixosConfigs = config.flake.nixosConfigurations;
in
{
  flake.modules.nixos.adblock =
    {
      config,
      lib,
      pkgs,
      ...
    }:
    let
      cfg = config.balaur;
      # The `web` aspect's domains (web.nix), answered here with that machine's
      # tailnet address: at home they resolve even with the internet down, without
      # a router filtering private answers, and without waiting out a cached
      # "no such name". The public A records at the registrar say the same.
      webHosts = lib.filterAttrs (
        host: h: h.tailnetIp != null && nixosConfigs ? ${host} && nixosConfigs.${host}.config.balaur ? web
      ) fleet;
      rewrites = lib.concatLists (
        lib.mapAttrsToList (
          host: h:
          let
            domain = nixosConfigs.${host}.config.balaur.web.domain;
          in
          map
            (d: {
              domain = d;
              answer = h.tailnetIp;
              enabled = true;
            })
            [
              domain
              "*.${domain}"
            ]
        ) webHosts
      );
      webPort = 3000;

      # Samsung TVs: home-screen ads and viewing-data tracking (ACR). Deliberately
      # NOT blocked: samsungcloudsolution.* (blocking it breaks app installs and
      # Smart Hub) and samsungotn.net (firmware updates).
      samsungText = ''
        ||samsungads.com^
        ||ads.samsung.com^
        ||samsungacr.com^
        ||samsungtifa.com^
        ||gpm.samsungqbe.com^
      '';
      samsungRules = pkgs.writeText "samsung-tv-rules.txt" samsungText;
      # AdGuard reads a local list again only when its update interval (24 h) is
      # up, unless it is a list it has not seen: so the id follows the content.
      samsungId =
        100 + lib.fromHexString (builtins.substring 0 6 (builtins.hashString "sha256" samsungText));
    in
    {
      services.adguardhome = {
        enable = true;
        host = "0.0.0.0";
        port = webPort;
        mutableSettings = true;
        settings = {
          dns = {
            bind_hosts = [ "0.0.0.0" ];
            port = 53;
            # Encrypted, European upstreams: Quad9 (Swiss non-profit) and DNS4EU (EU, unfiltered:
            # blocking is done here). The plain IPs only resolve the DoH hostnames.
            upstream_dns = [
              "https://dns.quad9.net/dns-query"
              "https://unfiltered.joindns4.eu/dns-query"
            ];
            bootstrap_dns = [
              "9.9.9.9"
              "86.54.11.100"
            ];
            upstream_mode = "load_balance";
            cache_size = 4194304;
          };
          filtering = {
            protection_enabled = true;
            filtering_enabled = true;
            inherit rewrites;
            # A local list may only be read from a path matching one of these.
            safe_fs_patterns = [ (toString samsungRules) ];
          };
          filters = [
            {
              enabled = true;
              id = 1;
              name = "AdGuard DNS filter";
              url = "https://adguardteam.github.io/HostlistsRegistry/assets/filter_1.txt";
            }
            {
              enabled = true;
              id = 2;
              name = "AdAway default blocklist";
              url = "https://adguardteam.github.io/HostlistsRegistry/assets/filter_2.txt";
            }
            {
              enabled = true;
              id = samsungId;
              name = "Samsung TV ads and tracking";
              url = toString samsungRules;
            }
          ];
        };
      };

      networking.firewall = {
        allowedTCPPorts = [
          53
          webPort
        ];
        allowedUDPPorts = [ 53 ];
      };

      balaur.services = [
        {
          name = "AdGuard Home";
          description = "Blocks ads & trackers for the network";
          icon = "🛡️";
          port = webPort;
          subdomain = "adguard";
          unit = "adguardhome.service";
          appIcon = "${pkgs.adguardhome.src}/client_v2/public/assets/favicon.svg";
          group = "Network";
        }
      ];
    };
}
