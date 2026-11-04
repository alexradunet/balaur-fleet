# The built-in screen: GNOME as a household tablet. One account logs in by
# itself and never locks; apps run full screen, the overview (swipe up) is the
# app switcher, the on-screen keyboard pops up on touch (English + Romanian),
# and the screen follows rotation.
#
# What stays ours rather than GNOME's:
#   - Screen off/on: the camera relay (camera.nix) switches the backlight on
#     movement, so GNOME's own blanking, dimming and locking are off.
#   - Sound: the session's PipeWire, shared by the apps and the voice assistant
#     (a user service of this session, assistant.nix), which also adds the
#     microphone array's 16 kHz device as the default source.
{ config, lib, pkgs, ... }:
let
  cfg = config.duet;
  user = cfg.desktop.user;
  inherit (lib.gvariant) mkTuple mkUint32;
  # Without the camera there's nothing to wake the screen but a touch: keep it on.
  screenTimeout = if cfg.camera.enable then cfg.camera.screenTimeout else 0;

  # The dashboard as an app of its own: a Chromium app window (no tabs or
  # address bar) with its own profile, so it never mixes with browsing.
  # ?kiosk=1 is the dashboard's "built-in screen" mode (voice orb, mirrored
  # camera, back to Services after a minute).
  duetLauncher = pkgs.writeShellScript "duet-app" ''
    exec ${pkgs.chromium}/bin/chromium --app='http://127.0.0.1/?kiosk=1' \
      --user-data-dir="$HOME/.local/share/duet-app" --ozone-platform=wayland \
      --no-first-run --password-store=basic --disable-pinch --overscroll-history-navigation=0
  '';
  duetApp = pkgs.makeDesktopItem {
    name = "duet";
    desktopName = "Duet";
    comment = "Home server dashboard: services, TV remote, assistant, camera";
    icon = "${../tv-app/icon.png}"; # the same tile as on the TV
    exec = "${duetLauncher}";
    # Chromium names an --app window after its URL and profile.
    startupWMClass = "chrome-127.0.0.1__-Default";
    categories = [ "Utility" ];
  };

  # Working on the box itself (keyboard attached): a terminal logged in as the
  # admin account, where the repo and Claude Code live. Asks that account's
  # password, since the household session is open to anyone at the screen.
  devTerminal = pkgs.makeDesktopItem {
    name = "duet-dev-terminal";
    desktopName = "Developer terminal";
    comment = "A shell as ${cfg.user}: the repo, Claude Code, nixos-rebuild";
    icon = "org.gnome.Ptyxis";
    exec = "${pkgs.ptyxis}/bin/ptyxis --new-window -x \"su - ${cfg.user}\"";
    categories = [ "System" "TerminalEmulator" ];
  };

  favorites = [
    "duet.desktop"
    "firefox.desktop"
    "org.jellyfin.JellyfinDesktop.desktop"
    "io.m51.Gelly.desktop"
  ];
in
lib.mkIf cfg.desktop.enable {
  # ---- GNOME, trimmed to what a wall tablet needs ----
  services.displayManager.gdm.enable = true;
  services.desktopManager.gnome.enable = true;
  services.displayManager.autoLogin = { enable = true; inherit user; };

  services.gnome = {
    core-apps.enable = false; # the app grid is curated below
    core-developer-tools.enable = false;
    games.enable = false;
    gnome-initial-setup.enable = false;
    # Background indexing and sharing a wall screen doesn't use (CPU, not features).
    localsearch.enable = false;
    tinysparql.enable = false;
    rygel.enable = false;
    gnome-user-share.enable = false;
    gnome-remote-desktop.enable = false;
    gnome-online-accounts.enable = false;
    gnome-browser-connector.enable = false;
  };
  services.dleyna.enable = false;
  environment.gnome.excludePackages = with pkgs; [ gnome-tour gnome-user-docs yelp orca ];

  environment.systemPackages = with pkgs; [
    duetApp
    devTerminal
    ptyxis # terminal (as the household account)
    jellyfin-desktop # Jellyfin client (video, and the target for "play on Duet")
    gelly # Jellyfin music, GNOME-native
    nautilus
    loupe
    gnome-calculator
  ];

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
      # Ads the router-level AdGuard can't see (same-domain ones, e.g. YouTube).
      ExtensionSettings."uBlock0@raymondhill.net" = {
        installation_mode = "force_installed";
        install_url = "https://addons.mozilla.org/firefox/downloads/latest/ublock-origin/latest.xpi";
      };
    };
  };

  # Rotation.
  hardware.sensor.iio.enable = true;

  # ---- the household account ----
  users.users.${user} = {
    isNormalUser = true;
    description = "Home";
    extraGroups = [ "video" "audio" ];
    hashedPassword = "!"; # never asked: GDM logs it in, and it never locks
  };

  # ---- defaults for the session (locked: the household can't flip them by accident) ----
  programs.dconf.profiles.user.databases = [{
    settings = {
      # Blank after duet.camera.screenTimeout idle (movement in front of the
      # camera counts as activity, camera.nix); never dim, lock or sleep.
      "org/gnome/desktop/session".idle-delay = mkUint32 screenTimeout;
      "org/gnome/desktop/screensaver" = { lock-enabled = false; idle-activation-enabled = screenTimeout > 0; };
      "org/gnome/desktop/lockdown".disable-lock-screen = true;
      "org/gnome/settings-daemon/plugins/power" = {
        sleep-inactive-ac-type = "nothing";
        sleep-inactive-battery-type = "nothing";
        idle-dim = false;
        ambient-enabled = false;
        power-button-action = "nothing"; # a long press still powers off (power.nix)
      };
      "org/gnome/desktop/notifications".show-in-lock-screen = false;

      # Touch tablet.
      "org/gnome/desktop/input-sources".sources = [ (mkTuple [ "xkb" "us" ]) (mkTuple [ "xkb" "ro+std" ]) ];
      "org/gnome/desktop/a11y/applications".screen-keyboard-enabled = false; # false = automatic, on touch
      "org/gnome/settings-daemon/peripherals/touchscreen".orientation-lock = false;
      "org/gnome/desktop/interface" = {
        clock-show-weekday = true;
        show-battery-percentage = true;
        color-scheme = "prefer-dark";
      };

      # The home screen.
      "org/gnome/shell" = {
        favorite-apps = favorites;
        welcome-dialog-last-shown-version = "999";
      };
      "org/gnome/mutter".dynamic-workspaces = true;
      # Tools for whoever administers the box, out of the household's way.
      "org/gnome/desktop/app-folders".folder-children = [ "Admin" ];
      "org/gnome/desktop/app-folders/folders/Admin" = {
        name = "Admin";
        apps = [
          "btop.desktop" "htop.desktop" "gvim.desktop" "vim.desktop" "nixos-manual.desktop"
          "gtk3-demo.desktop" "gtk3-icon-browser.desktop" "gtk3-widget-factory.desktop"
          "qv4l2.desktop" "qvidcap.desktop" "org.freedesktop.IBus.Setup.desktop"
          "org.gnome.Extensions.desktop" "org.gnome.ColorProfileViewer.desktop"
          "duet-dev-terminal.desktop" "org.gnome.Ptyxis.desktop"
        ];
      };
    };
    locks = [
      "/org/gnome/desktop/session/idle-delay"
      "/org/gnome/desktop/screensaver/lock-enabled"
      "/org/gnome/desktop/lockdown/disable-lock-screen"
      "/org/gnome/settings-daemon/plugins/power/sleep-inactive-ac-type"
      "/org/gnome/settings-daemon/plugins/power/sleep-inactive-battery-type"
      "/org/gnome/settings-daemon/plugins/power/idle-dim"
      "/org/gnome/settings-daemon/plugins/power/ambient-enabled"
    ];
  }];

  # ---- sound ----
  services.pulseaudio.enable = false;
  security.rtkit.enable = true;
  services.pipewire = {
    enable = true;
    alsa.enable = true;
    pulse.enable = true;
  };

  hardware.graphics.enable = true;
}
