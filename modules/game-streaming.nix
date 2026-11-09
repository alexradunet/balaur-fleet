# Game streaming across the tailnet: Sunshine on the machine with the games,
# Moonlight on the machines that play them remotely.
#
#   game-streaming         Sunshine, the host. It captures the screen (KMS), encodes
#                          it on the GPU (NVENC on NVIDIA, VA-API otherwise) and takes
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
# Declared here: the config, the apps Moonlight offers (the desktop, plus Steam Big
# Picture and Battle.net where the host has them) and, with `secrets`, the web UI's
# login: the admin's username and the `sunshine-password` entry of the sops file,
# set at every start. Not declarable: the paired clients, a certificate exchange
# kept in ~/.config/sunshine/sunshine_state.json (setting the login leaves them be).
#
# Pairing, once per client:
#   1. https://<host>:47990 from any machine on the tailnet (a self-signed
#      certificate), logged in as above.
#   2. In Moonlight, "Add host" with the host's tailnet name (`zmeu`). Discovery
#      only sees the LAN, and the tailnet is not the LAN.
#   3. Moonlight shows a PIN; enter it in Sunshine's PIN tab.
#
# A Samsung TV (Tizen 5.5-6.5) is not on the tailnet: list it in
# `balaur.gameStreaming.lanClients` and install Moonlight from the host:
#   1. TV: Apps, type 12345, Developer mode On, Host PC IP = the host's LAN address,
#      then hold the power button 5 s. The host needs a fixed LAN address.
#   2. nix run nixpkgs#podman -- run --rm --network host \
#        ghcr.io/brightcraft/moonlight-tizen:master bash -c 'sdb connect <tv> &&
#        tizen install -n Moonlight.wgt -t "$(sdb devices | awk "NR>1 && NF {print \$NF}" | head -1)"'
#   3. Pair as above, with the host's LAN address in Moonlight.
{ config, ... }:
let
  fleet = config.fleet;
in
{
  flake.modules.nixos.game-streaming =
    {
      config,
      lib,
      pkgs,
      options,
      ...
    }:
    let
      host = config.networking.hostName;
      ip = fleet.${host}.tailnetIp or null;
      user = config.balaur.user;
      useSops = options ? sops;
      nvidia = lib.elem "nvidia" config.services.xserver.videoDrivers;
      hasBattlenet = lib.any (
        p: (p.pname or p.name or "") == "battlenet"
      ) config.environment.systemPackages;
    in
    {
      options.balaur.gameStreaming.lanClients = lib.mkOption {
        type = lib.types.listOf lib.types.str;
        default = [ ];
        example = [ "192.168.50.106" ];
        description = ''
          LAN addresses of clients that cannot join the tailnet (a TV running
          Moonlight), let through to the streaming ports and nothing else. They
          need a fixed address in the router, and so does this host, which they
          dial on the LAN.
        '';
      };

      config = lib.mkMerge [
        {
          services.sunshine = {
            enable = true;
            # A user service in the graphical session, started with it.
            autoStart = true;
            # KMS capture, the way to grab the screen under GNOME on Wayland.
            capSysAdmin = true;
            # Ports stay closed on the LAN; the tailnet is trusted (see above).
            openFirewall = false;
            # NVENC needs CUDA, and Sunshine runs with a capability, so the loader
            # ignores LD_LIBRARY_PATH: only the CUDA build carries the driver's
            # library path (/run/opengl-driver/lib) in the binary itself.
            package = lib.mkIf nvidia (
              pkgs.sunshine.override {
                cudaSupport = true;
                cudaPackages = pkgs.cudaPackages;
              }
            );
            settings = {
              sunshine_name = host;
              capture = "kms";
              # Named, so a broken driver is an error instead of a quiet fall back
              # to encoding on the CPU or through Vulkan.
              encoder = if nvidia then "nvenc" else "vaapi";
              # The web UI only accepts requests from localhost unless told
              # otherwise; we open it as https://<host>:47990 from the tailnet.
              csrf_allowed_origins = lib.concatMapStringsSep "," (h: "https://${h}:47990") (
                [ host ] ++ lib.optional (ip != null) ip
              );
            };
            applications.apps = [
              {
                name = "Desktop";
                image-path = "desktop.png";
              }
            ]
            ++ lib.optional config.programs.steam.enable {
              name = "Steam Big Picture";
              image-path = "steam.png";
              detached = [ "setsid steam steam://open/bigpicture" ];
              prep-cmd = [
                {
                  do = "";
                  undo = "setsid steam steam://close/bigpicture";
                }
              ];
            }
            ++ lib.optional hasBattlenet {
              name = "Battle.net";
              detached = [ "setsid battlenet" ];
            };
          };

          # Its web UI (pairing, the PIN) on the home page and in the app. It serves
          # only TLS, self-signed: no subdomain behind Caddy, the browser warns once.
          balaur.services = [
            {
              name = "Sunshine";
              description = "Game streaming: pair Moonlight";
              icon = "🎮";
              port = 47990;
              scheme = "https";
              unit = "user:sunshine.service";
              group = "Games";
            }
          ];
        }

        # Streaming ports (not the web UI) for the LAN clients, by source address.
        {
          networking.firewall.extraCommands = lib.concatMapStrings (src: ''
            iptables -A nixos-fw -s ${src} -p tcp -m multiport --dports 47984,47989,48010 -j nixos-fw-accept
            iptables -A nixos-fw -s ${src} -p udp -m multiport --dports 47998:48000,48002,48010 -j nixos-fw-accept
          '') config.balaur.gameStreaming.lanClients;
        }

        # The web UI's login, from the sops file. Sunshine keeps it as a salted hash
        # in its state file; --creds writes it and leaves the paired clients alone.
        (lib.optionalAttrs useSops {
          sops.secrets.sunshine-password.owner = user;
          systemd.user.services.sunshine.serviceConfig.ExecStartPre = lib.getExe (
            pkgs.writeShellApplication {
              name = "sunshine-set-login";
              runtimeInputs = [ pkgs.coreutils ];
              text = ''
                ${lib.getExe config.services.sunshine.package} --creds ${user} \
                  "$(cat ${config.sops.secrets.sunshine-password.path})" >/dev/null
              '';
            }
          );
        })
      ];
    };

  flake.modules.nixos.game-streaming-client =
    { pkgs, ... }:
    {
      environment.systemPackages = [ pkgs.moonlight-qt ];
    };
}
