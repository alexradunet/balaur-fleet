# A personal desktop machine, whatever draws its windows (Hyprland, hyprland.nix):
# sound, the fleet's canonical apps (Firefox with its policies and add-ons,
# Ghostty, the Balaur app), the GTK apps we keep, and the services a desktop
# leans on (disks, the keyring, Bluetooth, power profiles). GNOME used to bring
# all of this; since 2026-11-15 no machine runs GNOME, so it is said here.
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
    let
      # Firefox add-ons: add-on ID -> its addons.mozilla.org slug. The ID must match
      # the add-on's manifest exactly, or Firefox skips the entry without saying so.
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
      config = lib.mkMerge [
        {
          # Firefox is the browser. No telemetry, no first-run detours, and the add-ons above.
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
          # nothing installed later takes over links.
          xdg.mime.defaultApplications = lib.genAttrs [
            "text/html"
            "x-scheme-handler/http"
            "x-scheme-handler/https"
          ] (_: "firefox.desktop");

          # The terminal is Ghostty (GTK4/libadwaita, GPU-rendered). It is also what
          # "Open in Terminal" and Terminal=true apps launch, through xdg-terminal-exec.
          xdg.terminal-exec = {
            enable = true;
            settings.default = [ "com.mitchellh.ghostty.desktop" ];
          };

          environment.systemPackages = with pkgs; [
            ghostty
            # The fleet's own front end: every service with its live state (gnome/app).
            balaur-app
            # The GNOME apps that were the canonical pick, and still are on their own.
            nautilus
            loupe # images
            papers # PDFs
            showtime # video
            decibels # audio
            gnome-text-editor
            gnome-calculator
            gnome-disk-utility
            # Their icons and font.
            adwaita-icon-theme
          ];
          fonts.packages = [ pkgs.adwaita-fonts ];

          # The file chooser and the dark style for GTK apps (the portal reads the
          # dconf setting below).
          xdg.portal = {
            enable = true;
            extraPortals = [ pkgs.xdg-desktop-portal-gtk ];
          };
          programs.dconf = {
            enable = true;
            profiles.user.databases = [
              {
                settings."org/gnome/desktop/interface" = {
                  color-scheme = "prefer-dark";
                  # The fleet's colour on buttons, switches and selections (libadwaita).
                  accent-color = "green";
                };
              }
            ];
          };

          # Sound.
          services.pulseaudio.enable = false;
          security.rtkit.enable = true;
          services.pipewire = {
            enable = true;
            alsa.enable = true;
            pulse.enable = true;
          };
          hardware.graphics.enable = true;

          # What a desktop leans on: disks and the trash in Nautilus, the battery,
          # power profiles, Bluetooth, firmware updates (`fwupdmgr`).
          services.udisks2.enable = true;
          services.gvfs.enable = true;
          services.upower.enable = true;
          services.power-profiles-daemon.enable = true;
          hardware.bluetooth.enable = true;
          services.fwupd.enable = true;

          # The keyring (gh's token, Wi-Fi passwords, browsers' secrets), unlocked by
          # the login's password wherever the display manager's PAM service asks it to.
          services.gnome.gnome-keyring.enable = true;
        }
        # The admin's side, where the host has home-manager (the `home` aspect).
        (lib.optionalAttrs (options ? home-manager) {
          home-manager.users.${config.balaur.user}.imports = [ hm.desktop ];
        })
      ];
    };

  flake.modules.homeManager.desktop = {
    # Screenshots land here (hyprland.nix's Print).
    home.file."Pictures/Screenshots/.keep".text = "";
  };
}
