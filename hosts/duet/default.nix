# The Yoga Duet 7 home server. Everything opinionated lives in ../../modules;
# this file holds only the choices that are specific to *your* install.
{ lib, ... }:
{
  imports = [
    ./hardware.nix
    ../../modules
  ]
  # Your machine's own disk/boot layout, copied from /etc/nixos on the Duet
  # (see docs/SETUP.md). It must be `git add`ed or flakes cannot see it.
  ++ (
    if builtins.pathExists ./hardware-configuration.nix
    then [ ./hardware-configuration.nix ]
    else [ ./fallback-filesystems.nix ]
  );

  networking.hostName = "duet";
  time.timeZone = "Europe/Bucharest"; # change me
  i18n.defaultLocale = "en_US.UTF-8";

  # Keep the same value your first install put in /etc/nixos/configuration.nix.
  # system.stateVersion = "26.05";
  # boot.loader.efi.efiSysMountPoint = "/boot/efi";   # only if your EFI partition is mounted there

  duet = {
    # Your existing login on the Duet (`whoami`). If this differs, NixOS would
    # create a new user and drop yours, so set it before the first rebuild.
    user = "duet";
    # sshKeys = [ "ssh-ed25519 AAAA... you@laptop" ];   # <- add yours, then rebuild
    # network.tailscale.authKeyFile = "/var/lib/secrets/tailscale-authkey";
    # homeAutomation.zigbee = { enable = true; serialPort = "/dev/serial/by-id/usb-..."; };
    # storage.root = "/srv";
  };
}
