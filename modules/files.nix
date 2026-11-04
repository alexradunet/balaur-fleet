# File sync: Syncthing, storing into ${storage.root}/files.
{
  flake.modules.nixos.files =
    { config, lib, pkgs, ... }:
    let
      cfg = config.balaur;
      root = toString cfg.storage.root;
    in
    {
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
        # Nothing else creates configDir. The upstream module has no StateDirectory
        # and creates it only in an ExecStartPre gated on `cert`/`key` being set; the
        # stock setup gets away with it because the default configDir sits inside
        # dataDir, which `createHome` makes. Ours is deliberately outside it (keys and
        # database out of the synced tree), so Syncthing cannot start without this:
        # it fails with `mkdir /var/lib/syncthing: permission denied`.
        # 0700 because this holds the device's private key, as upstream's own
        # `install -dm700` does.
        "d ${config.services.syncthing.configDir} 0700 syncthing media - -"
      ];

      balaur.services = [
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
    };
}
