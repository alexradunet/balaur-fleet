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
#
# Both get the fleet's own front end from here: the Balaur app (the conversation,
# lists, timers, memory, every service in `balaur.services` with its live state;
# gnome/app) and the Shell extension (the assistant's orb and captions over every
# app, the mic toggle; gnome/shell-extension). The `assistant` aspect has no UI
# without them. So the ambient screen's settings are here too: after a minute
# untouched, a full-screen clock, date, weather, the assistant's timers and
# reminders, the fleet's machines and services, over the photos in the synced
# folder (gnome/shell-extension/ambient.js).
#
# GNOME's own search finds Balaur's things too (the app is a search provider:
# services, list items, memories, timers, reminders, and "Ask" for a question),
# and Quick Settings has a "Scenes" menu with Home Assistant's scenes and scripts
# wherever the assistant has house devices (/etc/balaur/house.json, below).
{ config, ... }:
let
  nixosConfigs = config.flake.nixosConfigurations;
  fleet = config.fleet;
in
{
  flake.modules.nixos.gnome =
    {
      config,
      lib,
      pkgs,
      ...
    }:
    let
      inherit (lib.gvariant) mkTuple;
      cfg = config.balaur;
      ambient = cfg.ambient;
      me = config.networking.hostName;

      # The Scenes menu reaches Home Assistant the way the assistant does: its
      # machine and its non-admin user's token (`assistant` aspect,
      # balaur.assistant.homeAssistant). The token is readable by the group
      # balaur-assistant, which the session's account is in wherever the assistant
      # runs in it (the household account on the tablet, the admin's on a desktop).
      hass = cfg.assistant.homeAssistant or null;
      houseJson =
        if hass != null && hass.host != null && hass.tokenFile != null then
          let
            hassConfig = if hass.host == me then config else nixosConfigs.${hass.host}.config;
            address = if hass.host == me then "127.0.0.1" else fleet.${hass.host}.address;
          in
          builtins.toJSON {
            url = "http://${address}:${toString hassConfig.services.home-assistant.config.http.server_port}";
            tokenFile = toString hass.tokenFile;
          }
        else
          null;
      ambientJson = builtins.toJSON {
        inherit (ambient) idleSeconds;
        location = { inherit (cfg.location) name latitude longitude; };
        photos =
          if ambient.photos.dir != null then
            {
              inherit (ambient.photos) dir intervalSeconds;
            }
          else if config.services.jellyfin.enable then
            {
              server = "http://127.0.0.1:8096";
              keyFile = ambient.photos.jellyfinKeyFile;
              inherit (ambient.photos) intervalSeconds;
            }
          else
            null;
        status =
          if ambient.status then
            {
              # Its socket answers any local user (read-only), so no rights are needed.
              tailscale =
                if config.services.tailscale.enable then lib.getExe config.services.tailscale.package else null;
              servicesFile = "/etc/balaur/services.json";
            }
          else
            null;
      };
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
      options.balaur.ambient = {
        idleSeconds = lib.mkOption {
          type = lib.types.ints.unsigned;
          default = 60;
          description = ''
            Seconds without a touch, click or key before the ambient screen (clock,
            weather, timers, reminders, photos, machines and services) covers the
            apps; 0 = never. Held back while a window is full screen (a film, a game)
            or an app inhibits idle. On the tablet, movement in front of the camera
            keeps it up. It needs a new session (log out, or reboot) to pick up changes.
          '';
        };
        photos = {
          intervalSeconds = lib.mkOption {
            type = lib.types.ints.positive;
            default = 30;
            description = "Seconds each photo stays.";
          };
          dir = lib.mkOption {
            type = lib.types.nullOr lib.types.str;
            # The `files` aspect's synced folder, when this machine has it.
            default =
              if cfg ? files then "${toString cfg.storage.root}/files/${cfg.files.folderName}/photos" else null;
            defaultText = lib.literalExpression ''"''${storage.root}/files/''${files.folderName}/photos" (with the files aspect), else null'';
            description = ''
              The folder the slideshow shows, subfolders included (JPEG, PNG, WebP; not
              HEIC). By default `photos` in the Syncthing folder, so pictures dropped
              there on any machine of the fleet show up on all of them; new ones within
              the hour. It must be readable by the session's account. null = the
              Jellyfin photo libraries, where this machine runs Jellyfin.
            '';
          };
          jellyfinKeyFile = lib.mkOption {
            type = lib.types.str;
            default = "/var/lib/secrets/balaur-photos-key";
            description = "Jellyfin API key for the photos when `dir` is null (the tablet's `sudo balaur-photos-login` writes it).";
          };
        };
        status = lib.mkOption {
          type = lib.types.bool;
          default = true;
          description = ''
            Show the fleet's machines (Tailscale: online, last seen; this one's failed
            units) and the home's services (running or not) on the side.
          '';
        };
      };

      config = {
        environment.etc = {
          "balaur/ambient.json".text = ambientJson;
        }
        // lib.optionalAttrs (houseJson != null) { "balaur/house.json".text = houseJson; };

        services.displayManager.gdm.enable = true;
        services.desktopManager.gnome.enable = true;

        # GNOME's background services that no machine here uses: lean CPU, the same
        # on every GNOME machine. File indexing (localsearch) stays where it is
        # useful, the desktops; `tablet` turns that off as well.
        services.gnome = {
          gnome-initial-setup.enable = false; # every machine is set up by this flake
          gnome-online-accounts.enable = false; # no online account is set up
          gnome-remote-desktop.enable = false; # SSH and Tailscale; Moonlight for the pc
          gnome-user-share.enable = false; # files move through Syncthing (`files`)
          gnome-browser-connector.enable = false; # the extensions come from the flake
          rygel.enable = false; # DLNA sharing to the LAN: nothing asked for it
        };
        services.dleyna.enable = false; # DLNA discovery, likewise

        # The look and the keyboards, the same on every GNOME machine. Defaults, not
        # locks: a personal machine's own settings win (`tablet` locks what it must).
        programs.dconf.profiles.user.databases = [
          {
            settings = {
              "org/gnome/desktop/input-sources".sources = [
                (mkTuple [
                  "xkb"
                  "us"
                ])
                (mkTuple [
                  "xkb"
                  "ro+std"
                ])
              ];
              "org/gnome/desktop/interface" = {
                color-scheme = "prefer-dark";
                clock-show-weekday = true;
                show-battery-percentage = true;
                # The fleet's colour on buttons, switches and selections (GNOME 47+:
                # blue, teal, green, yellow, orange, red, pink, purple, slate).
                accent-color = "green";
              };
            };
          }
        ];

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
        # GNOME Web on the tablet, or anything installed later, does not take over links.
        xdg.mime.defaultApplications = lib.genAttrs [
          "text/html"
          "x-scheme-handler/http"
          "x-scheme-handler/https"
        ] (_: "firefox.desktop");

        # The terminal is Ghostty everywhere (GTK4/libadwaita, GPU-rendered), so
        # Console goes. It is also what "Open in Terminal" and Terminal=true apps
        # launch, through xdg-terminal-exec.
        environment.systemPackages = [
          pkgs.ghostty
          pkgs.balaur-app
          pkgs.balaur-shell-extension
        ];
        environment.gnome.excludePackages = [ pkgs.gnome-console ];
        xdg.terminal-exec = {
          enable = true;
          settings.default = [ "com.mitchellh.ghostty.desktop" ];
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
    };
}
