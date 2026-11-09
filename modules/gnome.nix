# GNOME itself: the display manager, the session, its sound server, and the
# fleet's canonical apps that every GNOME machine shares (browser, its add-ons,
# terminal). Nothing here decides *how* the machine is used — that is the job of
# the aspects built on top:
#
#   tablet   the household screen on the Duet: auto-login, never locks, curated apps
#   desktop  a personal machine: a normal login, a lock screen, the GNOME apps we keep
#
# Give a host `gnome` plus exactly one of those. (Aspects never import each
# other: flake.modules has no dedup key, so the host lists both.)
{
  flake.modules.nixos.gnome =
    { lib, pkgs, ... }:
    let
      # Firefox add-ons on every machine: add-on ID -> its addons.mozilla.org slug.
      # The ID must match the add-on's manifest exactly, or Firefox skips the
      # entry without saying so.
      addons = {
        # The ads a network-level blocker cannot see (same-domain ones, e.g. YouTube).
        "uBlock0@raymondhill.net" = "ublock-origin";
        "78272b6fa58f4a1abaac99321d503a20@proton.me" = "proton-pass";
        "vpn@proton.ch" = "proton-vpn-firefox-extension";
        "sponsorBlocker@ajay.app" = "sponsorblock";
        "addon@darkreader.org" = "darkreader";
      };
    in
    {
      services.displayManager.gdm.enable = true;
      services.desktopManager.gnome.enable = true;

      # Firefox is the browser on every GNOME machine here. The policies are the
      # same everywhere: no telemetry, no first-run detours, and the add-ons above.
      programs.firefox = {
        enable = true;
        policies = {
          DisableTelemetry = true;
          DisableFirefoxStudies = true;
          DisablePocket = true;
          DontCheckDefaultBrowser = true;
          OverrideFirstRunPage = "";
          OverridePostUpdatePage = "";
          NoDefaultBookmarks = true;
          ExtensionSettings = lib.mapAttrs (_: slug: {
            installation_mode = "force_installed";
            install_url = "https://addons.mozilla.org/firefox/downloads/latest/${slug}/latest.xpi";
          }) addons;
        };
      };
      # Said outright (in /etc/xdg/mimeapps.list, under the user's own list), so
      # GNOME Web on balaur, or anything installed later, does not take over links.
      xdg.mime.defaultApplications = lib.genAttrs [
        "text/html"
        "x-scheme-handler/http"
        "x-scheme-handler/https"
      ] (_: "firefox.desktop");

      # The terminal is Ptyxis everywhere (GNOME-native, tabs and profiles), so
      # Console goes.
      environment.systemPackages = [ pkgs.ptyxis ];
      environment.gnome.excludePackages = [ pkgs.gnome-console ];

      # Sound for the session, shared by the apps and (on the Duet) the voice
      # assistant, which runs as a service of that same session.
      services.pulseaudio.enable = false;
      security.rtkit.enable = true;
      services.pipewire = {
        enable = true;
        alsa.enable = true;
        pulse.enable = true;
      };

      hardware.graphics.enable = true;
    };
}
