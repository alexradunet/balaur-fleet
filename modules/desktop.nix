# A personal GNOME desktop, the way the fleet uses the `gnome` aspect since the
# Duet's household screen (`tablet`) left the fleet on 2026-11-15. It leaves GNOME
# as GNOME — you log in, it locks, it suspends, and the settings are yours to
# change. It keeps GNOME's own apps where they are the canonical pick (Showtime,
# Decibels, Loupe, Papers...) and drops the rest, the same on every desktop; what
# a given machine adds belongs in its host file.
#
# The fleet's own front end (the Balaur app, the Shell extension) is installed by
# `gnome`, for every GNOME machine. Here the extension is switched on through
# home-manager rather than a locked system dconf profile, so it stays a setting
# the user can turn off.
{ config, ... }:
let
  hm = config.flake.modules.homeManager;
in
{
  flake.modules.nixos.desktop =
    {
      config,
      lib,
      options,
      pkgs,
      ...
    }:
    {
      config = lib.mkMerge [
        {
          # GNOME ships these; the fleet's desktops don't use them. What stays is the
          # canonical set: Chromium (`gnome`), Ghostty (`gnome`), Showtime for video,
          # Decibels for audio, Loupe, Papers, Nautilus, Text Editor, System Monitor,
          # Snapshot, Calculator, Disks.
          environment.gnome.excludePackages = with pkgs; [
            # The browser is Chromium (the `gnome` aspect sets it up with policies).
            # (GNOME Web ran the service web apps on the tablet, which has left the fleet.)
            epiphany
            gnome-tour # a first-run walkthrough, on a machine already set up
            yelp # the help browser; the answers are on the web
            gnome-music # Decibels plays a file; the library was Jellyfin, on the tablet
            # Only useful tied to an online account, and none is set up.
            gnome-calendar
            gnome-contacts
            gnome-clocks
            gnome-weather
            gnome-maps
            # No scanner; remote machines are reached over SSH and Tailscale.
            simple-scan
            gnome-connections
            # Rarely used tools; `journalctl`, `ncdu` and the terminal cover them.
            gnome-characters
            gnome-color-manager
            gnome-logs
            seahorse # the keyring itself stays (gnome-keyring); this is only its viewer
            gnome-font-viewer
            baobab
            tecla
          ];
        }
        # The admin's side, where the host has home-manager (the `home` aspect).
        (lib.optionalAttrs (options ? home-manager) {
          home-manager.users.${config.balaur.user}.imports = [ hm.desktop ];
        })
      ];
    };

  flake.modules.homeManager.desktop =
    { pkgs, ... }:
    {
      dconf.settings."org/gnome/shell".enabled-extensions = [
        pkgs.balaur-shell-extension.passthru.extensionUuid
      ];

      # Ghostty's own default makes Ctrl+Enter full screen; GNOME has F11 for that,
      # and programs need the key (Claude Code: send now). The rest of Ghostty's
      # settings are its defaults, which follow GNOME's look.
      xdg.configFile."ghostty/config".text = ''
        keybind = ctrl+enter=unbind
      '';
    };
}
