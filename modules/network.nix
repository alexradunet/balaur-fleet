# Network: NetworkManager, mDNS (duet.local), Tailscale (+ SSH).
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

  duet.dashboard.services =
    lib.optional net.enable {
      name = "Tailscale";
      description = "Private remote access";
      icon = "🔒";
      unit = "tailscaled.service";
      group = "Network";
    };
}
