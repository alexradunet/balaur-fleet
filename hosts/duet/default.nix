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
    # An EXISTING login on the Duet (its password is kept as is). If this differed from `whoami`, NixOS would
    # create a new user and drop yours, so set it before the first rebuild.
    user = "alex";

    # Front camera + live preview in the kiosk corner (patched kernel modules + the RGB-IR pipeline in camera/).
    camera.enable = true;
    # After the one-time calibration in docs/SETUP.md (Stage 10), pin the layout you picked:
    # camera.tuning.cfa = "BGRG/GIGI/RGBG/GIGI";
    # SSH uses your account password for now. Later: add sshKeys, set ssh.passwordAuth = false.
    # sshKeys = [ "ssh-ed25519 AAAA... you@laptop" ];
    # network.tailscale.authKeyFile = "/var/lib/secrets/tailscale-authkey";
    # storage.root = "/srv";
  };
}
