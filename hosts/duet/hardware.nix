# Lenovo Yoga Duet 7i 13IML05 (Comet Lake i5-10210U / i7-10510U, NVMe, AX201 Wi-Fi).
# If your unit differs, replace this file with the output of `nixos-generate-config`.
{ lib, ... }:
{
  nixpkgs.hostPlatform = "x86_64-linux";

  boot.initrd.availableKernelModules = [ "xhci_pci" "thunderbolt" "nvme" "usb_storage" "sd_mod" ];
  boot.kernelModules = [ "kvm-intel" ];

  hardware.enableRedistributableFirmware = true; # AX201 Wi-Fi/BT, i915 GuC/HuC
  hardware.cpu.intel.updateMicrocode = true;

  # Matches the partition labels created in the README install steps.
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
