# The dashboard: one small Go service serving the UI + API on :80.
# Every feature module registers its tiles via `duet.dashboard.services`.
{ config, lib, pkgs, ... }:
let
  cfg = config.duet;
  dashboard = pkgs.callPackage ../pkgs/dashboard.nix { };

  groupOrder = [ "Media & files" "Network" "Home" ];
  groupIndex = g: lib.lists.findFirstIndex (x: x == g) (lib.length groupOrder) groupOrder;
  # Tiles of one group must be adjacent (the UI prints a header per run).
  sorted = lib.sortOn (s: groupIndex s.group) cfg.dashboard.services;

  registry = pkgs.writeText "duet-dashboard.json" (builtins.toJSON {
    hostname = config.networking.hostName;
    listen = cfg.dashboard.listen;
    services = map (s: s // { port = if s.port == null then 0 else s.port; }) sorted;
    # The relay's live view (camera.nix sets it for the rgbir backend) and who may watch it.
    cameraStream = config.systemd.services.duet-camera-relay.environment.DUET_CAMERA_STREAM or "";
    cameraNets = [ "127.0.0.0/8" "::1/128" ]
      ++ lib.optionals cfg.network.enable [ "100.64.0.0/10" "fd7a:115c:a1e0::/48" ] # tailnet
      ++ lib.optionals cfg.camera.lanView [ "10.0.0.0/8" "172.16.0.0/12" "192.168.0.0/16" "fc00::/7" "fe80::/10" ];
  });
in
{
  systemd.services.duet-dashboard = {
    description = "Duet dashboard";
    wantedBy = [ "multi-user.target" ];
    after = [ "network.target" ];
    path = [ config.systemd.package ]; # systemctl, for unit state
    environment.DUET_CONFIG = registry;
    serviceConfig = {
      ExecStart = lib.getExe dashboard;
      Restart = "always";
      RestartSec = 2;

      DynamicUser = true;
      SupplementaryGroups = [ "video" ]; # backlight slider, camera live-view socket
      AmbientCapabilities = [ "CAP_NET_BIND_SERVICE" ];
      CapabilityBoundingSet = [ "CAP_NET_BIND_SERVICE" ];

      NoNewPrivileges = true;
      ProtectSystem = "strict";
      ProtectHome = true;
      PrivateTmp = true;
      ProtectControlGroups = true;
      RestrictAddressFamilies = [ "AF_UNIX" "AF_INET" "AF_INET6" ]; # AF_UNIX: D-Bus
      RestrictNamespaces = true;
      LockPersonality = true;
      MemoryDenyWriteExecute = true;
      SystemCallArchitectures = "native";
    };
  };

  networking.firewall.allowedTCPPorts = [ 80 ];
}
