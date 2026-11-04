# Network: NetworkManager, mDNS (duet.local), Tailscale (+ SSH).
{
  flake.modules.nixos.network =
    { config, lib, ... }:
    let
      cfg = config.balaur;
      net = cfg.network;
    in
    {
      options.balaur = {
        network.tailscale.authKeyFile = lib.mkOption {
          type = lib.types.nullOr lib.types.path;
          default = null;
          description = "File holding a Tailscale auth key. If null, run `sudo tailscale up` once by hand.";
        };
      };

      config = {
        networking.networkmanager.enable = true;
        # Wi-Fi works, but a USB-C ethernet dock is strongly preferred for a server.
        networking.firewall.enable = true;

        # Reach the box as <hostname>.local from any device on the LAN.
        services.avahi = {
          enable = true;
          nssmdns4 = true;
          openFirewall = true;
          publish = {
            enable = true;
            addresses = true;
          };
        };

        services.tailscale = {
          enable = true;
          openFirewall = true;
          useRoutingFeatures = "server"; # can be an exit node / subnet router
          authKeyFile = net.tailscale.authKeyFile;
          # Tailscale SSH: login via tailnet identity, no authorized_keys needed, so it
          # still works as a recovery path if the key setup is broken.
          extraSetFlags = [ "--ssh" ];
        };
        # Reach the admin UIs over the tailnet as well as the LAN.
        networking.firewall.trustedInterfaces = [ "tailscale0" ];

        balaur.services =
          [{
            name = "Tailscale";
            description = "Private remote access";
            icon = "🔒";
            unit = "tailscaled.service";
            group = "Network";
          }];
      };
    };
}
