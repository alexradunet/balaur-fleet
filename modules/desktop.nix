# A personal GNOME desktop: the other way to use the `gnome` aspect, next to
# `tablet`. Where `tablet` turns the Duet's screen into an open household
# appliance, this leaves GNOME as GNOME — you log in, it locks, it suspends, and
# the settings are yours to change. It keeps GNOME's own apps where they are the
# canonical pick (Showtime, Decibels, Loupe, Papers...) and drops the rest, the
# same on every desktop; what a given machine adds (printing, locales, extra
# apps) belongs in its host file.
#
# What it does add is the fleet's own front end, which `tablet` installs for the
# household screen and a personal machine needs just as much:
#
#   Balaur app       the conversation, lists, timers, memory, and every service in
#                    `balaur.services` with its live state (gnome/app)
#   Shell extension  the assistant's orb and captions over every app, and the mic
#                    toggle in Quick Settings (gnome/shell-extension)
#
# Both are useful on their own, and the `assistant` aspect has no UI without them.
# The extension is switched on through home-manager rather than a locked system
# dconf profile, so it stays a setting the user can turn off.
{
  flake.modules.nixos.desktop =
    { pkgs, ... }:
    {
      environment.systemPackages = [
        pkgs.balaur-app
        pkgs.balaur-shell-extension
      ];

      # GNOME ships these; the fleet's desktops don't use them. What stays is the
      # canonical set: Firefox (`gnome`), Ptyxis (`gnome`), Showtime for video,
      # Decibels for audio, Loupe, Papers, Nautilus, Text Editor, System Monitor,
      # Snapshot, Calculator, Disks. `tablet` curates its own list instead.
      environment.gnome.excludePackages = with pkgs; [
        # The browser is Firefox (the `gnome` aspect sets it up with policies).
        # GNOME Web stays on the tablet, which needs it to run the service web apps.
        epiphany
        gnome-tour # a first-run walkthrough, on a machine already set up
        yelp # the help browser; the answers are on the web
        gnome-music # Decibels plays a file; the library is Jellyfin on the tablet
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
      # Shares media over DLNA to whatever is on the network. Nothing asked for that.
      services.gnome.rygel.enable = false;
    };

  # Host wiring (modules/home.nix explains the pattern):
  #   home-manager.users.${config.balaur.user}.imports = [ aspects.homeManager.desktop ];
  flake.modules.homeManager.desktop =
    { pkgs, ... }:
    {
      dconf.settings."org/gnome/shell".enabled-extensions = [
        pkgs.balaur-shell-extension.passthru.extensionUuid
      ];
    };
}
