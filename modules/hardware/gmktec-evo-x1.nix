# GMKtec NucBox EVO-X1 (AMD Ryzen AI 9 HX 370, 12 cores / 24 threads, Radeon
# 890M, Intel AX Wi-Fi (iwlwifi), two Intel 2.5 GbE ports (igc), an OCuLink port).
# A mini-PC on mains power: no battery, no lid, no touchscreen.
# A GPU on the OCuLink port is its own aspect (nvidia-egpu.nix).
# Disks and kernel modules come from hardware-configuration.nix (see the host file).
{
  flake.modules.nixos.gmktec-evo-x1 =
    { ... }:
    {
      nixpkgs.hostPlatform = "x86_64-linux";

      boot.kernelModules = [ "kvm-amd" ];

      hardware.enableRedistributableFirmware = true; # iwlwifi, amdgpu
      hardware.cpu.amd.updateMicrocode = true;
    };
}
