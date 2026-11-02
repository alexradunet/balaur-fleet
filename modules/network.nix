# Network + privacy: NetworkManager, mDNS (duet.local), AdGuard Home DNS, Tailscale.
{ config, lib, ... }:
let
  cfg = config.duet;
  net = cfg.network;
in
{
  networking.networkmanager.enable = true;
  # Wi-Fi works, but a USB-C ethernet dock is strongly preferred for a server.
  networking.firewall.enable = true;

  # Reach the box as <hostname>.local from any device on the LAN.
  services.avahi = lib.mkIf net.enable {
    enable = true;
    nssmdns4 = true;
    openFirewall = true;
    publish = {
      enable = true;
      addresses = true;
    };
  };

  services.tailscale = lib.mkIf net.enable {
    enable = true;
    openFirewall = true;
    useRoutingFeatures = "server"; # can be an exit node / subnet router
    authKeyFile = net.tailscale.authKeyFile;
    # Tailscale SSH: login via tailnet identity, no authorized_keys needed, so it
    # still works as a recovery path if the key setup is broken.
    extraSetFlags = [ "--ssh" ];
  };
  # Reach the admin UIs over the tailnet as well as the LAN.
  networking.firewall.trustedInterfaces = lib.mkIf net.enable [ "tailscale0" ];

  # AdGuard Home owns port 53, so systemd-resolved's stub must stay off and
  # NetworkManager must not rewrite resolv.conf.
  services.resolved.enable = lib.mkIf net.enable false;
  networking.networkmanager.dns = lib.mkIf net.enable "none";
  networking.nameservers = lib.mkIf net.enable [ "127.0.0.1" "9.9.9.9" ];

  services.adguardhome = lib.mkIf net.enable {
    enable = true;
    host = "0.0.0.0";
    port = 3001;
    openFirewall = true; # admin UI
    mutableSettings = true; # keep filter lists / clients edited in the UI
    settings = {
      users = net.adguard.users;
      dns = {
        bind_hosts = [ "0.0.0.0" ];
        port = 53;
        upstream_dns = [
          "https://dns.quad9.net/dns-query"
          "https://cloudflare-dns.com/dns-query"
        ];
        bootstrap_dns = [ "9.9.9.9" "1.1.1.1" ];
      };
    };
  };
  networking.firewall.allowedTCPPorts = lib.mkIf net.enable [ 53 ];
  networking.firewall.allowedUDPPorts = lib.mkIf net.enable [ 53 ];

  warnings = lib.optional (net.enable && net.adguard.users == [ ])
    "duet.network.adguard.users is empty: the AdGuard Home admin UI has no authentication.";

  duet.dashboard.services = lib.optionals net.enable [
    {
      name = "AdGuard Home";
      description = "DNS ad & tracker blocking";
      icon = "🛡️";
      port = 3001;
      unit = "adguardhome.service";
      group = "Network";
    }
    {
      name = "Tailscale";
      description = "Private remote access";
      icon = "🔒";
      unit = "tailscaled.service";
      group = "Network";
    }
  ];
}
