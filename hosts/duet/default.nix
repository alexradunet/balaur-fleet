# The Yoga Duet 7 home server. Everything opinionated lives in ../../modules;
# this file holds only the choices that are specific to *your* install.
{ ... }:
{
  imports = [
    ./hardware.nix
    ../../modules
  ];

  networking.hostName = "duet";
  time.timeZone = "Europe/Bucharest"; # change me
  i18n.defaultLocale = "en_US.UTF-8";

  duet = {
    # sshKeys = [ "ssh-ed25519 AAAA... you@laptop" ];   # <- add yours, then rebuild
    # network.tailscale.authKeyFile = "/var/lib/secrets/tailscale-authkey";
    # homeAutomation.zigbee = { enable = true; serialPort = "/dev/serial/by-id/usb-..."; };
    # storage.root = "/srv";
  };
}
