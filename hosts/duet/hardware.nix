# Lenovo Yoga Duet 7i 13IML05 (Comet Lake i5-10210U / i7-10510U, NVMe, AX201 Wi-Fi).
# Disks and kernel modules come from hardware-configuration.nix (see default.nix).
{ ... }:
{
  nixpkgs.hostPlatform = "x86_64-linux";

  boot.kernelModules = [ "kvm-intel" ];

  hardware.enableRedistributableFirmware = true; # AX201 Wi-Fi/BT, i915 GuC/HuC
  hardware.cpu.intel.updateMicrocode = true;
}
