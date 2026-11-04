# File sync: Syncthing, storing into ${storage.root}/files.
{ config, lib, pkgs, ... }:
let
  cfg = config.duet;
  root = toString cfg.storage.root;
in
lib.mkIf cfg.files.enable {
  services.syncthing = {
    enable = true;
    user = "syncthing";
    group = "media";
    dataDir = "${root}/files";
    configDir = "/var/lib/syncthing";
    guiAddress = "0.0.0.0:8384";
    openDefaultPorts = true; # 22000 sync + 21027 discovery
    # Devices and folders are managed in the UI, not in Nix.
    overrideDevices = false;
    overrideFolders = false;
  };
  # Syncthing's GUI is not opened by openDefaultPorts; allow it (LAN/tailnet).
  networking.firewall.allowedTCPPorts = [ 8384 ];

  systemd.tmpfiles.rules = [
    "d ${root}/files 2775 syncthing media - -"
  ];

  duet.dashboard.services = [
    {
      name = "Syncthing";
      description = "Continuous file sync";
      icon = "🔄";
      port = 8384;
      unit = "syncthing.service";
      appIcon = "${pkgs.syncthing}/share/icons/hicolor/scalable/apps/syncthing.svg";
      group = "Media & files";
    }
  ];
}
