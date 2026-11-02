# Used only when hosts/duet/hardware-configuration.nix is absent (CI / evaluation).
# Assumes labels `nixos` (ext4 root) and `BOOT` (FAT32 ESP).
{ ... }:
{
  boot.initrd.availableKernelModules = [ "xhci_pci" "thunderbolt" "nvme" "usb_storage" "sd_mod" ];

  fileSystems."/" = {
    device = "/dev/disk/by-label/nixos";
    fsType = "ext4";
  };
  fileSystems."/boot" = {
    device = "/dev/disk/by-label/BOOT";
    fsType = "vfat";
    options = [ "umask=0077" ];
  };
}
