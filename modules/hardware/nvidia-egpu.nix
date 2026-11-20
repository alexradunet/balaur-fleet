# An NVIDIA card in an external dock (Thunderbolt/USB4 or OCuLink), next to the
# machine's own AMD/Intel iGPU. Written for an RTX 5060 Ti, on the laptop's USB4
# port (on the server's OCuLink port 2026-11-17 to 2026-11-18, which kept the
# server from being always on). On OCuLink it is there from boot, and does not hot-plug.
#
# Thunderbolt hot-plugs, but the port's security level is `user`: a new dock must
# be approved before its PCIe tunnel opens. bolt does that, and remembers it:
# approve it once with `boltctl enroll --policy auto <uuid>` (`boltctl list`), or
# from GNOME's Settings, and it connects by itself from then on. Unplug the dock
# only with games closed, and before the lid shuts: the driver does not survive
# its card vanishing under it, nor suspend with the card attached.
# On the laptop (2026-11-20), a dock plugged in after a wake from sleep was not seen
# at all (no Thunderbolt event): plug it in, then reboot. Use the AG02's USB4 port
# and its USB4 cable, not the OCuLink one.
#
# Booted without the dock, the driver just finds no card and the iGPU carries on
# alone, so the same system works both ways.
#
# Plug the monitor into the card, not the machine. GNOME (mutter) then composites
# on the NVIDIA card and games render where they are displayed.
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
        # suspend/resume hooks stay off with it, so the laptop must not suspend with
        # the dock attached (above): unplug it first.
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

      # Approves Thunderbolt/USB4 devices (the dock), with GNOME's Settings panel.
      services.hardware.bolt.enable = true;
    };
}
