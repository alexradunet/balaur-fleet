# Network-wide ad and tracker blocking: AdGuard Home as the LAN's DNS server.
#
# Use it per device (TV: Settings → General → Network → Network Status →
# IP Settings → DNS Setting → Enter manually → this machine's LAN IP), or for the
# whole network by setting it as the DNS server in the router's DHCP settings.
# Either way, reserve this machine's IP in the router first.
#
# Settings below are applied on every start and win over the web UI for the keys
# they set (upstreams, filter lists, the Samsung rules). Everything else, such as
# per-client settings, the query log and allow-listing in the UI, is kept.
{
  flake.modules.nixos.adblock =
    { config, lib, pkgs, ... }:
    let
      cfg = config.balaur;
      webPort = 3000;
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
            upstream_dns = [ "https://dns.quad9.net/dns-query" "https://unfiltered.joindns4.eu/dns-query" ];
            bootstrap_dns = [ "9.9.9.9" "86.54.11.100" ];
            upstream_mode = "load_balance";
            cache_size = 4194304;
          };
          filtering = {
            protection_enabled = true;
            filtering_enabled = true;
          };
          filters = [
            { enabled = true; id = 1; name = "AdGuard DNS filter"; url = "https://adguardteam.github.io/HostlistsRegistry/assets/filter_1.txt"; }
            { enabled = true; id = 2; name = "AdAway default blocklist"; url = "https://adguardteam.github.io/HostlistsRegistry/assets/filter_2.txt"; }
          ];
          # Samsung TVs: home-screen ads and viewing-data tracking (ACR). Deliberately
          # NOT blocked: samsungcloudsolution.* (blocking it breaks app installs and
          # Smart Hub) and samsungotn.net (firmware updates).
          user_rules = [
            "||samsungads.com^"
            "||ads.samsung.com^"
            "||samsungacr.com^"
            "||samsungtifa.com^"
            "||gpm.samsungqbe.com^"
          ];
        };
      };

      networking.firewall = {
        allowedTCPPorts = [ 53 webPort ];
        allowedUDPPorts = [ 53 ];
      };

      balaur.services = [{
        name = "AdGuard Home";
        description = "Blocks ads & trackers for the network";
        icon = "🛡️";
        port = webPort;
        subdomain = "adguard";
        unit = "adguardhome.service";
        appIcon = "${pkgs.adguardhome.src}/client_v2/public/assets/favicon.svg";
        group = "Network";
      }];
    };
}
