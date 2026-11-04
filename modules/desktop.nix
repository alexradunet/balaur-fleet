# A personal GNOME desktop: the other way to use the `gnome` aspect, next to
# `tablet`. Where `tablet` turns the Duet's screen into an open household
# appliance, this leaves GNOME as GNOME — you log in, it locks, it suspends, and
# the settings are yours to change. So the aspect is deliberately small: almost
# everything it wants is already GNOME's default, and what a given machine adds
# (printing, locales, extra apps) belongs in its host file.
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
        (pkgs.callPackage ../pkgs/duet-app.nix { })
        (pkgs.callPackage ../pkgs/duet-shell-extension.nix { })
      ];

      # GNOME ships these; a personal desktop here has no use for any of them.
      # `tablet` drops the same ones for the household screen, for the same
      # reasons — this is not about taste, which belongs in the host file.
      environment.gnome.excludePackages = with pkgs; [
        # The browser is Firefox (the `gnome` aspect sets it up with policies).
        # GNOME Web stays on duet, which needs it to run the service web apps.
        epiphany
        gnome-tour # a first-run walkthrough, on a machine already set up
        yelp # the help browser; the answers are on the web
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
        (pkgs.callPackage ../pkgs/duet-shell-extension.nix { }).passthru.extensionUuid
      ];
    };
}
