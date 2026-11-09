# Network: NetworkManager, mDNS (<hostname>.local), Tailscale.
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
          # No useRoutingFeatures: nothing here is an exit node or subnet router,
          # and "server" turns on IP forwarding on every machine. Set it on the
          # host that becomes one.
          authKeyFile = net.tailscale.authKeyFile;
          # No Tailscale SSH. It takes port 22 on the tailnet address before OpenSSH
          # sees the connection and decides by the admin console's policy instead, so
          # any device on the tailnet (the VPS, the phone) could log in as any user,
          # nixremote included, with neither a key from the registry nor its
          # build-protocol-only restriction. With it off, OpenSSH answers on
          # tailscale0 (trusted below) and the fleet registry decides: `userKeys`
          # for people, host keys for builds (fleet.nix).
          # The way back in if keys ever break is auto-deploy: push a fix and every
          # machine applies it without anyone logging in.
          # `=false`, not just dropping `--ssh`: `tailscale set` keeps what it is not told.
          # The tailnet name is the hostname, said outright: the fleet dials
          # `fleet.<host>.address` (that name), so a renamed machine must not keep
          # an old name in the tailnet.
          extraSetFlags = [
            "--ssh=false"
            "--hostname=${config.networking.hostName}"
          ];
        };
        # Stays active after setting, so a change to the flags re-runs it on a switch
        # instead of only at the next boot.
        systemd.services.tailscaled-set.serviceConfig.RemainAfterExit = true;
        # Reach the admin UIs over the tailnet as well as the LAN.
        networking.firewall.trustedInterfaces = [ "tailscale0" ];

        balaur.services = [
          {
            name = "Tailscale";
            description = "Private remote access";
            icon = "🔒";
            unit = "tailscaled.service";
            group = "Network";
          }
        ];
      };
    };
}
