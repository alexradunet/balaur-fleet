# GMKtec NucBox EVO-X1 (AMD Ryzen AI 9 HX 370, 12 cores / 24 threads, Radeon
# 890M, Intel AX Wi-Fi (iwlwifi), two Intel 2.5 GbE ports (igc), an OCuLink port).
# A mini-PC on mains power: no battery, no lid, no touchscreen.
# Disks and kernel modules come from hardware-configuration.nix (see the host file).
#
# Run as an always-on server on a smart socket. Its BIOS (AMI Aptio, Del at power-on;
# 1.03 of 2025-02-18 at the time of writing) is set to:
#   Restore on AC power loss / State after G3   Power On  (the socket turns it on)
#   ErP / deep sleep                             Disabled  (keeps the NIC powered: WoL)
#   Wake on LAN / PCIe wake                      Enabled
#   Network stack / PXE boot                     Disabled  (no network boot on ethernet)
#   Boot order                                   the NixOS NVMe only
#   Fast Boot Disabled, Secure Boot off (systemd-boot is unsigned), SVM and IOMMU on,
#   power mode Quiet, fan Auto, UMA frame buffer 8 GB (of 64: the 890M is left room
#   for a small local model; Linux sees 54 GB).
#
# Turning it off: `sudo poweroff` over SSH, then the socket, never the socket alone.
# Turning it on: the socket, or a magic packet to either ethernet port's MAC
# (`wakeonlan c8:ff:bf:05:0a:44` / `…:45`) when it was shut down with power left on.
{
  flake.modules.nixos.gmktec-evo-x1 =
    { ... }:
    {
      nixpkgs.hostPlatform = "x86_64-linux";

      boot.kernelModules = [ "kvm-amd" ];

      hardware.enableRedistributableFirmware = true; # iwlwifi, amdgpu
      hardware.cpu.amd.updateMicrocode = true;

      # Wake-on-LAN on both ethernet ports, armed by udev when the port appears.
      # The first .link file that matches a port is the only one applied, so this
      # one repeats systemd's 99-default.link to keep the names (eno1, enp100s0).
      # (networking.interfaces.<name>.wakeOnLan matches the kernel's first name,
      # eth0, against `eno1`, and so never applies.) NetworkManager leaves WoL alone.
      systemd.network.links."50-igc-wol" = {
        matchConfig.Driver = "igc";
        linkConfig = {
          NamePolicy = "keep kernel database onboard slot path";
          AlternativeNamesPolicy = "database onboard slot path mac";
          MACAddressPolicy = "persistent";
          WakeOnLan = "magic";
        };
      };

      # The chipset's hardware watchdog (sp5100_tco): if the kernel hangs, the board
      # resets itself after 30 s instead of waiting for someone at the socket.
      systemd.settings.Manager = {
        RuntimeWatchdogSec = "30s";
        RebootWatchdogSec = "5min";
      };
    };
}
