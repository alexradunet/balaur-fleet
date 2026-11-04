# File sync: one folder, the same on every machine in the fleet, always syncing.
#
# It lives on a filesystem of its own: a preallocated image on the root disk,
# with its own ext4, loop-mounted at ${storage.root}/files. That is the one thing
# a plain directory cannot do — put a hard ceiling on how much the synced set can
# grow. Without it a runaway sync fills the root filesystem, which on the Duet
# would take the household screen, the assistant and the media server with it.
# Both machines' disks are filled by their root partition and ext4 cannot be
# shrunk while mounted, so a real partition would mean booting each machine off
# rescue media; this gets the same ceiling declaratively, and `rm` undoes it.
#
# Devices and the shared folder come from the fleet registry (`syncthingId` on
# each entry), so a new machine pairs by being added there, not by anyone
# clicking through the web UI.
{ config, ... }:
let
  fleet = config.fleet;
in
{
  flake.modules.nixos.files =
    { config, lib, pkgs, ... }:
    let
      cfg = config.balaur;
      root = toString cfg.storage.root;
      mountPoint = "${root}/files";
      # /srv/files -> srv-files.mount
      mountUnit = (lib.replaceStrings [ "/" ] [ "-" ] (lib.removePrefix "/" mountPoint)) + ".mount";

      image = cfg.files.image;
      sizeGiB = cfg.files.sizeGiB;
      folderId = "balaur-files";

      # Everyone but us, and only machines whose ID we actually know.
      me = config.networking.hostName;
      peers = lib.filterAttrs (name: h: name != me && h.syncthingId != null) fleet;

      makeImage = pkgs.writeShellApplication {
        name = "balaur-files-image";
        runtimeInputs = [ pkgs.coreutils pkgs.e2fsprogs pkgs.util-linux ];
        text = ''
          install -d -m 0755 "$(dirname ${image})"

          if [ ! -e ${image} ]; then
            # Enough room for the volume itself plus a little slack.
            avail=$(df --output=avail --block-size=1G "$(dirname ${image})" | tail -1)
            if [ "$avail" -lt ${toString (sizeGiB + 5)} ]; then
              echo "only $avail GiB free; a ${toString sizeGiB} GiB volume needs ${toString (sizeGiB + 5)} GiB" >&2
              exit 1
            fi
            fallocate -l ${toString sizeGiB}G ${image}
            # -m 0: no 5% root reserve, the whole volume is for synced files.
            # -E nodiscard: mkfs otherwise punches holes straight back through the
            # fallocate above and leaves a sparse image. That still caps the synced
            # set, but it stops reserving the space, so other things on the root
            # filesystem (on duet, the media library) could eat it and the volume
            # would then hit ENOSPC on its own backing file.
            mkfs.ext4 -q -m 0 -E nodiscard -L ${folderId} ${image}
          else
            # Top the reservation back up if something punched holes in it, or if
            # sizeGiB grew. Allocating holes does not touch the data, so this is
            # safe on a mounted image; growing the inner filesystem to match a
            # larger size is a separate, manual resize2fs.
            fallocate -l ${toString sizeGiB}G ${image}
          fi
        '';
      };
    in
    {
      options.balaur.files = {
        sizeGiB = lib.mkOption {
          type = lib.types.ints.positive;
          default = 200;
          description = ''
            Size of the synced volume, in GiB. It is preallocated, so this much
            disk is committed on every machine running this aspect. Growing it
            later is `truncate -s` plus `resize2fs` on the unmounted image;
            shrinking it means moving the data out first.
          '';
        };
        image = lib.mkOption {
          type = lib.types.path;
          default = "/var/lib/balaur/files.img";
          description = "Backing file for the synced volume.";
        };
      };

      config = {
        # ---- the volume ----
        # Creates the volume, then on later runs only tops its reservation back
        # up, so it is safe to run before the mount every boot.
        systemd.services.balaur-files-image = {
          description = "Keep the ${toString sizeGiB} GiB Syncthing volume allocated";
          before = [ mountUnit ];
          requiredBy = [ mountUnit ];
          wantedBy = [ "multi-user.target" ];
          serviceConfig = {
            Type = "oneshot";
            RemainAfterExit = true;
            ExecStart = lib.getExe makeImage;
          };
        };

        fileSystems.${mountPoint} = {
          device = image;
          fsType = "ext4";
          # nofail: trouble with the volume must not stop the machine booting.
          # Syncthing requires the mount separately, so it stays off rather than
          # writing into the bare mount point and filling the root disk.
          # (systemd creates the mount point itself, so no x-mount.mkdir.)
          options = [ "loop" "nofail" ];
        };

        # mkfs leaves the volume's root owned by root, and a tmpfiles rule is no
        # use here: on a `switch` it runs before the new mount, so it would set
        # the permissions on the hidden mount point underneath and Syncthing would
        # fail with "folder marker missing". Order it against the mount instead.
        systemd.services.balaur-files-perms = {
          description = "Hand the Syncthing volume to ${config.services.syncthing.user}";
          after = [ mountUnit ];
          requires = [ mountUnit ]; # don't touch the bare mount point if it failed
          before = [ "syncthing.service" ];
          requiredBy = [ "syncthing.service" ];
          # Also on its own: a switch that does not restart syncthing would
          # otherwise never run this.
          wantedBy = [ "multi-user.target" ];
          serviceConfig = {
            Type = "oneshot";
            RemainAfterExit = true;
          };
          path = [ pkgs.coreutils pkgs.util-linux ];
          script = ''
            # Belt and braces: never chown the root filesystem's directory.
            if ! mountpoint -q ${mountPoint}; then
              echo "${mountPoint} is not a mount point; refusing to touch it" >&2
              exit 1
            fi
            chown ${config.services.syncthing.user}:${config.services.syncthing.group} ${mountPoint}
            chmod 2775 ${mountPoint}
          '';
        };

        systemd.tmpfiles.rules = [
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

        # ---- syncthing ----
        services.syncthing = {
          enable = true;
          user = "syncthing";
          group = "media";
          # NOT the volume. The module makes dataDir the syncthing user's home with
          # `createHome`, which resets it to 0700 on every activation — that would
          # fight the 2775 the volume needs and lock the admin out of their own
          # synced folder. dataDir is only the home and the default folder path,
          # and the folder below sets its path explicitly, so point it at the state
          # directory instead and leave the volume to balaur-files-perms.
          dataDir = "/var/lib/syncthing";
          configDir = "/var/lib/syncthing";
          guiAddress = "0.0.0.0:8384";
          openDefaultPorts = true; # 22000 sync + 21027 discovery
          # The registry is the source of truth: a device or folder added by hand
          # in the UI is taken away again on the next rebuild.
          overrideDevices = true;
          overrideFolders = true;
          settings = {
            devices = lib.mapAttrs (_: h: { id = h.syncthingId; }) peers;
            folders.${folderId} = {
              label = "Balaur files";
              path = mountPoint;
              devices = lib.attrNames peers;
              type = "sendreceive";
            };
            # Don't phone home, and don't nag about it in the UI.
            options.urAccepted = -1;
          };
        };

        # Without the volume, stay down rather than sync into the root filesystem.
        systemd.services.syncthing = {
          after = [ mountUnit ];
          requires = [ mountUnit ];
        };

        # Syncthing's GUI is not opened by openDefaultPorts; allow it (LAN/tailnet).
        networking.firewall.allowedTCPPorts = [ 8384 ];

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
    };
}
