# Lenovo Yoga Pro 7 14APH8 / 82Y8 (AMD Ryzen 7 7840HS, Radeon 780M, MediaTek
# MT7921 Wi-Fi/BT, NVMe). No touchscreen and no discrete GPU: one amdgpu card
# driving the internal eDP panel, backlight amdgpu_bl1.
# Disks and kernel modules come from hardware-configuration.nix (see the host file).
{
  flake.modules.nixos.yoga-pro-7 =
    { ... }:
    {
      nixpkgs.hostPlatform = "x86_64-linux";

      boot.kernelModules = [ "kvm-amd" ];

      hardware.enableRedistributableFirmware = true; # MT7921 Wi-Fi/BT, amdgpu
      hardware.cpu.amd.updateMicrocode = true;

      # The battery has no charge_control_end_threshold; what this firmware exposes
      # is ideapad_acpi's conservation_mode at
      # /sys/bus/platform/drivers/ideapad_acpi/VPC2004:00/ (a fixed ~80% cap), which
      # is the fallback the `always-on` aspect already writes to. This laptop does
      # not run `always-on`, so nothing sets it; flip it by hand if you ever want it.
    };
}
