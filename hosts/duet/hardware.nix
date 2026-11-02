# Lenovo Yoga Duet 7 13ITL6 (Tiger Lake i5-1135G7 / i7-1165G7, Intel IPU6 cameras, NVMe, AX201 Wi-Fi).
# Disks and kernel modules come from hardware-configuration.nix (see default.nix).
{ ... }:
{
  nixpkgs.hostPlatform = "x86_64-linux";

  boot.kernelModules = [ "kvm-intel" ];

  hardware.enableRedistributableFirmware = true; # AX201 Wi-Fi/BT, i915 GuC/HuC
  hardware.cpu.intel.updateMicrocode = true;
}
