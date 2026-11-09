# Game streaming across the tailnet: Sunshine on the machine with the games,
# Moonlight on the machines that play them remotely.
#
#   game-streaming         Sunshine, the host. It captures the screen (KMS), encodes
#                          it on the GPU (NVENC on NVIDIA, VA-API on AMD) and takes
#                          the client's controller, keyboard and mouse.
#   game-streaming-client  Moonlight, the client.
#
# Sunshine runs in the admin's graphical session, so the host needs that session
# up: auto-login, or someone logged in at the machine.
#
# Its ports (47984-48010) are only open on tailscale0, which `network` trusts: no
# LAN or internet exposure, and the same route at home and away. Tailscale goes
# direct over the LAN when both ends are at home. A phone or tablet just needs the
# Tailscale and Moonlight apps.
#
# Pairing, once per client:
#   1. https://<host>:47990 from any machine on the tailnet (a self-signed
#      certificate). The first visit creates Sunshine's login; it is kept in
#      ~/.config/sunshine on the host, not in this repo.
#   2. In Moonlight, "Add host" with the host's tailnet name (`zmeu`). Discovery
#      only sees the LAN, and the tailnet is not the LAN.
#   3. Moonlight shows a PIN; enter it in Sunshine's PIN tab.
{
  flake.modules.nixos.game-streaming =
    { config, ... }:
    {
      services.sunshine = {
        enable = true;
        # A user service in the graphical session, started with it.
        autoStart = true;
        # KMS capture, the way to grab the screen under GNOME on Wayland.
        capSysAdmin = true;
        # Ports stay closed on the LAN; the tailnet is trusted (see above).
        openFirewall = false;
        settings.sunshine_name = config.networking.hostName;
      };
    };

  flake.modules.nixos.game-streaming-client =
    { pkgs, ... }:
    {
      environment.systemPackages = [ pkgs.moonlight-qt ];
    };
}
