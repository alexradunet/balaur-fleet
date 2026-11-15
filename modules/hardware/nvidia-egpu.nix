# An NVIDIA card in an external dock (Thunderbolt/USB4 or OCuLink), next to the
# machine's own AMD/Intel iGPU. Written for an RTX 5060 Ti, now on the laptop's
# USB4 port (it was on the pc's OCuLink port).
#
# Thunderbolt hot-plugs, but the port's security level is `user`: a new dock must
# be approved before its PCIe tunnel opens. bolt does that, and remembers it:
# approve it once with `boltctl enroll --policy auto <uuid>` (`boltctl list`),
# and it connects by itself from then on. Unplug the dock
# only with games closed, and before the lid shuts: the driver does not survive
# its card vanishing under it, nor suspend with the card attached.
#
# Booted without the dock, the driver just finds no card and the iGPU carries on
# alone, so the same system works both ways.
#
# Plug the monitor into the card, not the machine. Hyprland drives both GPUs
# (aquamarine) and renders on the one it starts on, the iGPU, copying frames to a
# monitor on the card; making the card primary when docked is still to check
# (issue 15). Under GNOME a udev tag made mutter prefer it; Hyprland ignores that.
{
  flake.modules.nixos.nvidia-egpu =
    { config, ... }:
    {
      # Loads the NVIDIA kernel modules and userspace. The compositor is Wayland, which
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

      hardware.graphics.enable = true;

      # Approves Thunderbolt/USB4 devices (the dock): `boltctl`.
      services.hardware.bolt.enable = true;
    };
}
