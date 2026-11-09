# An NVIDIA card in an external dock (OCuLink or Thunderbolt), next to the
# machine's own AMD/Intel iGPU. Written for an RTX 5060 Ti on zmeu's OCuLink port.
#
# OCuLink is plain PCIe on a cable, with no hot-plug: power the dock on *before*
# the machine, and don't pull it while running. Booted without the dock, the
# driver just finds no card and the iGPU carries on alone, so the same system
# works both ways.
#
# Plug the monitor into the card, not the mini-PC. GNOME (mutter) then composites
# on the NVIDIA card, games render where they are displayed, and Sunshine's
# capture and NVENC encode happen on the same GPU.
{
  flake.modules.nixos.nvidia-egpu =
    { config, ... }:
    {
      # Loads the NVIDIA kernel modules and userspace. GNOME runs on Wayland, which
      # talks to every GPU through KMS, so the iGPU keeps working as well.
      services.xserver.videoDrivers = [
        "modesetting"
        "nvidia"
      ];

      hardware.nvidia = {
        # Blackwell (RTX 50xx) only runs on the open kernel modules.
        open = true;
        # DRM KMS for Wayland (and its framebuffer console).
        modesetting.enable = true;
        package = config.boot.kernelPackages.nvidiaPackages.stable;
        # A desktop card on mains power: no runtime suspend to fine-tune. The
        # suspend/resume hooks stay off with it; this machine never sleeps (host).
        powerManagement.enable = false;
        nvidiaSettings = true;
      };

      # Ask mutter to make the NVIDIA card its primary GPU when present. By default
      # it picks the GPU the firmware booted on (the iGPU), and would then render
      # everything there and copy it across to a monitor on the card.
      services.udev.extraRules = ''
        SUBSYSTEM=="drm", KERNEL=="card[0-9]*", ATTRS{vendor}=="0x10de", TAG+="mutter-device-preferred-primary"
      '';

      hardware.graphics.enable = true;
    };
}
