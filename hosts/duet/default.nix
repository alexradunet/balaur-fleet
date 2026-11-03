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

  # TEMPORARY, development only: wheel users (alex) get sudo without a password so
  # Claude Code can rebuild and tune the camera. Delete this line when development is done.
  security.sudo.wheelNeedsPassword = false;

  # Keep the same value your first install put in /etc/nixos/configuration.nix.
  # system.stateVersion = "26.05";
  # boot.loader.efi.efiSysMountPoint = "/boot/efi";   # only if your EFI partition is mounted there

  duet = {
    # An EXISTING login on the Duet (its password is kept as is). If this differed from `whoami`, NixOS would
    # create a new user and drop yours, so set it before the first rebuild.
    user = "alex";

    # Front camera + live preview in the kiosk corner (patched kernel modules + the RGB-IR pipeline in camera/).
    camera.enable = true;

    # Jellyfin (:8096) + qBittorrent with torrent search (:8080), media in /srv/media.
    media.enable = true;

    # AdGuard Home (DNS :53, UI :3000). Point the TV's DNS (or the router's) at this machine.
    adblock.enable = true;

    # The living-room Samsung (UE65AU7172, Tizen 6): TV tab on the dashboard + `duet-tv-sideload`.
    # Reserve both IPs in the router (TV 192.168.50.106, this machine 192.168.50.233).
    tv = {
      enable = true;
      host = "192.168.50.106";
      mac = "a0:d7:f3:9f:2d:18";
      name = "Living room TV";
      dashboardUrl = "http://192.168.50.233/";
      apps = [
        { name = "YouTube"; id = "111299001912"; icon = "▶"; }
        { name = "TizenBrew"; id = "xvvl3S1bvH.TizenBrewStandalone"; icon = "🧪"; }
        { name = "Netflix"; id = "3201907018807"; icon = "🍿"; }
        { name = "Prime Video"; id = "3201910019365"; icon = "📦"; }
        { name = "Disney+"; id = "3201901017640"; icon = "✨"; }
        { name = "Spotify"; id = "3201606009684"; icon = "🎵"; }
      ];
    };
    # The colour-filter layout was measured on this laptop (docs/SETUP.md, Stage 10).
    # camera.tuning.cfa = "GIGI/BGRG/GIGI/RGBG"; # only if red and blue come out swapped (default: GIGI/RGBG/GIGI/BGRG)
    # SSH uses your account password for now. Later: add sshKeys, set ssh.passwordAuth = false.
    # sshKeys = [ "ssh-ed25519 AAAA... you@laptop" ];
    # network.tailscale.authKeyFile = "/var/lib/secrets/tailscale-authkey";
    # storage.root = "/srv";
  };
}
