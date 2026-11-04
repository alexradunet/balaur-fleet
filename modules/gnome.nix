# GNOME itself: the display manager, the session, its sound server and the
# browser policies. Nothing here decides *how* the machine is used — that is the
# job of the aspects built on top:
#
#   tablet   the household screen on the Duet: auto-login, never locks, curated apps
#   desktop  a personal machine: a normal login, a lock screen, the usual apps
#
# Give a host `gnome` plus exactly one of those. (Aspects never import each
# other: flake.modules has no dedup key, so the host lists both.)
{
  flake.modules.nixos.gnome =
    { ... }:
    {
      services.displayManager.gdm.enable = true;
      services.desktopManager.gnome.enable = true;

      # Firefox is the browser on every GNOME machine here. The policies are the
      # same everywhere: no telemetry, no first-run detours, and uBlock Origin for
      # the ads a network-level blocker cannot see (same-domain ones, e.g. YouTube).
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
          ExtensionSettings."uBlock0@raymondhill.net" = {
            installation_mode = "force_installed";
            install_url = "https://addons.mozilla.org/firefox/downloads/latest/ublock-origin/latest.xpi";
          };
        };
      };

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
