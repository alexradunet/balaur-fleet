# The built-in screen: GNOME as a household tablet. One account logs in by
# itself and never locks; apps run full screen, the overview (swipe up) is the
# app switcher, the on-screen keyboard pops up on touch (English + Romanian),
# and the screen follows rotation.
#
# What stays ours rather than GNOME's:
#   - Screen off/on: GNOME blanks it after balaur.camera.screenTimeout idle and
#     never locks; movement in front of the camera counts as activity
#     (duet-presence, camera.nix), so it stays on while someone is there.
#   - Sound: the `gnome` aspect's PipeWire, shared by the apps and the voice
#     assistant (a user service of this session, assistant.nix), which also adds
#     the microphone array's 16 kHz device as the default source.
#
# Needs the `gnome` aspect alongside it: that one has GDM, the GNOME session,
# PipeWire and the Firefox policies.
{
  flake.modules.nixos.tablet =
    {
      config,
      lib,
      pkgs,
      ...
    }:
    let
      cfg = config.balaur;
      user = cfg.tablet.user;
      inherit (lib.gvariant) mkTuple mkUint32;
      # Without the camera there's nothing to wake the screen but a touch: keep it on.
      screenTimeout = cfg.camera.screenTimeout or 0;

      # Ours, GNOME-native (gnome/): the Balaur app (assistant, lists, timers, memory,
      # home services) and the Shell extension (assistant orb over every app, mic toggle).
      balaurApp = pkgs.balaur-app;
      balaurExtension = pkgs.balaur-shell-extension;

      # Each service with a web UI (and an appIcon) as an app of its own: GNOME Web
      # (Epiphany) "system web applications". Launched with
      # --application-mode=<this desktop file>, Epiphany makes the app a separate
      # profile and window identity (org.gnome.Epiphany.WebApp_<sha1 of the name>),
      # so it gets its own dock icon and never mixes with browsing.
      # services.json (the `fleet` aspect) points at them through the same s.webAppId.
      webAppId = s: s.webAppId;
      serviceUrl = s: if s.port == null then null else "http://127.0.0.1:${toString s.port}${s.path}";
      hasWebApp = s: s.port != null && s.appIcon != null;
      webApps = map (
        s:
        pkgs.makeDesktopItem {
          name = webAppId s;
          desktopName = s.name;
          comment = s.description;
          icon = s.appIcon;
          exec = "${pkgs.epiphany}/bin/epiphany --application-mode=${webAppId s}.desktop ${serviceUrl s}";
          startupWMClass = "org.gnome.Epiphany.WebApp_${builtins.hashString "sha1" s.name}";
          categories = [ "Network" ];
        }
      ) (lib.filter hasWebApp cfg.services);

      # Working on the box itself (keyboard attached): a terminal logged in as the
      # admin account, where the repo and Claude Code live. Asks that account's
      # password, since the household session is open to anyone at the screen.
      devTerminal = pkgs.makeDesktopItem {
        name = "balaur-dev-terminal";
        desktopName = "Developer terminal";
        comment = "A shell as ${cfg.user}: the repo, Claude Code, nixos-rebuild";
        icon = "com.mitchellh.ghostty";
        exec = "${lib.getExe pkgs.ghostty} -e su - ${cfg.user}";
        categories = [
          "System"
          "TerminalEmulator"
        ];
      };

      # The ambient screen (Shell extension, ambient.js): clock, weather, timers,
      # reminders, and photos from Jellyfin when this machine runs it (media aspect).
      ambient = cfg.tablet.ambient;
      jellyfin = config.services.jellyfin.enable;
      photosKey = "/var/lib/secrets/balaur-photos-key";
      photosDir = "${toString cfg.storage.root}/media/photos";
      ambientJson = builtins.toJSON {
        inherit (ambient) idleSeconds;
        location = { inherit (cfg.location) name latitude longitude; };
        photos =
          if jellyfin then
            {
              server = "http://127.0.0.1:8096";
              keyFile = photosKey;
              inherit (ambient.photos) intervalSeconds;
            }
          else
            null;
      };

      # A Jellyfin API key for the photos, from a terminal (state only, never in the
      # repo or the store; read from stdin). Also adds the Photos library if missing.
      photosLogin = pkgs.writeShellApplication {
        name = "balaur-photos-login";
        runtimeInputs = [
          pkgs.coreutils
          pkgs.curl
          pkgs.jq
        ];
        text = ''
          if [ "$(id -u)" != 0 ]; then echo "run with sudo" >&2; exit 1; fi
          echo "Jellyfin (http://tablet:8096) > Dashboard > API Keys > + (name it Balaur), then paste it here."
          read -rsp "API key (hidden): " key; echo
          api() { # api PATH [curl args]; the key goes through curl's config on stdin, never the process list
            local p=$1; shift
            printf 'header = "Authorization: MediaBrowser Token=\\"%s\\""\n' "$key" \
              | curl -sS -m 20 -f -K - "$@" "http://127.0.0.1:8096$p"
          }
          if ! version="$(api /System/Info | jq -er .Version)"; then echo "Jellyfin did not accept that key." >&2; exit 1; fi
          echo "Jellyfin $version accepted the key."

          install -d -m 0711 ${dirOf photosKey}
          install -o ${user} -m 0600 /dev/null ${photosKey}
          printf '%s\n' "$key" > ${photosKey}

          if api /Library/VirtualFolders | jq -e --arg d ${photosDir} 'any(.[]; .Locations | index($d))' >/dev/null; then
            echo "The Photos library (${photosDir}) is there."
          else
            api "/Library/VirtualFolders?name=Photos&collectionType=homevideos&paths=${lib.escapeURL photosDir}&refreshLibrary=true" -X POST -H 'Content-Type: application/json' -d '{"LibraryOptions":{}}' >/dev/null
            echo "Added the Photos library: ${photosDir}. Put pictures there (any folders); Jellyfin scans it."
          fi
          echo "Photos in Jellyfin now: $(api "/Items?Recursive=true&IncludeItemTypes=Photo&Limit=0" | jq -r .TotalRecordCount)"
        '';
      };

      favorites = [
        "org.balaur.Balaur.desktop"
        "firefox.desktop"
        "org.jellyfin.JellyfinDesktop.desktop"
        "io.m51.Gelly.desktop"
      ];
    in
    {
      options.balaur = {
        tablet = {
          user = lib.mkOption {
            type = lib.types.str;
            default = "home";
            description = "The household account GNOME logs in as (created; it has no password).";
          };

          ambient = {
            idleSeconds = lib.mkOption {
              type = lib.types.ints.unsigned;
              default = 60;
              description = ''
                Seconds without a touch, click or key before the ambient screen (clock,
                weather, timers, reminders, photos) covers the apps; 0 = never. Movement in
                front of the camera keeps it up rather than ending it. It needs a new
                session (log out, or reboot) to pick up changes.
              '';
            };
            photos.intervalSeconds = lib.mkOption {
              type = lib.types.ints.positive;
              default = 30;
              description = "Seconds each photo stays (Jellyfin's photo libraries; key: `sudo balaur-photos-login`).";
            };
          };
        };
      };

      config = {
        # ---- GNOME, trimmed to what a wall tablet needs ----
        # GDM, the GNOME session, PipeWire and the Firefox policies are the shared
        # `gnome` aspect; this one only takes away what a wall screen doesn't need.
        services.displayManager.autoLogin = {
          enable = true;
          inherit user;
        };

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
        environment.gnome.excludePackages = with pkgs; [
          gnome-tour
          gnome-user-docs
          yelp
          orca
        ];

        environment.systemPackages =
          with pkgs;
          [
            balaurApp
            balaurExtension
            devTerminal
            epiphany # GNOME Web: runs the web apps below
          ]
          ++ lib.optional jellyfin photosLogin
          ++ webApps
          ++ [
            ghostty # terminal (as the household account)
            jellyfin-desktop # Jellyfin client (video, and the target for "play on Duet")
            gelly # Jellyfin music, GNOME-native
            nautilus
            loupe
            gnome-calculator
            snapshot # GNOME camera: shows the front camera (the relay's webcam)
          ];

        # Rotation.
        hardware.sensor.iio.enable = true;

        # ---- the household account ----
        users.users.${user} = {
          isNormalUser = true;
          description = "Home";
          extraGroups = [
            "video"
            "audio"
          ];
          hashedPassword = "!"; # never asked: GDM logs it in, and it never locks
        };

        # ---- defaults for the session (locked: the household can't flip them by accident) ----
        programs.dconf.profiles.user.databases = [
          {
            settings = {
              # Blank after balaur.camera.screenTimeout idle (movement in front of the
              # camera counts as activity, camera.nix); never dim, lock or sleep.
              "org/gnome/desktop/session".idle-delay = mkUint32 screenTimeout;
              "org/gnome/desktop/screensaver" = {
                lock-enabled = false;
                idle-activation-enabled = screenTimeout > 0;
              };
              "org/gnome/desktop/lockdown".disable-lock-screen = true;
              "org/gnome/settings-daemon/plugins/power" = {
                sleep-inactive-ac-type = "nothing";
                sleep-inactive-battery-type = "nothing";
                idle-dim = false;
                ambient-enabled = false;
                power-button-action = "nothing"; # a long press still powers off (always-on.nix)
              };
              "org/gnome/desktop/notifications".show-in-lock-screen = false;

              # Touch tablet.
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
                enabled-extensions = [ balaurExtension.passthru.extensionUuid ];
              };
              "org/gnome/mutter".dynamic-workspaces = true;
              # Tools for whoever administers the box, out of the household's way.
              "org/gnome/desktop/app-folders".folder-children = [ "Admin" ];
              "org/gnome/desktop/app-folders/folders/Admin" = {
                name = "Admin";
                apps = [
                  "btop.desktop"
                  "htop.desktop"
                  "gvim.desktop"
                  "vim.desktop"
                  "gtk3-demo.desktop"
                  "gtk3-icon-browser.desktop"
                  "gtk3-widget-factory.desktop"
                  "qv4l2.desktop"
                  "qvidcap.desktop"
                  "org.freedesktop.IBus.Setup.desktop"
                  "org.gnome.Extensions.desktop"
                  "org.gnome.ColorProfileViewer.desktop"
                  "balaur-dev-terminal.desktop"
                  "com.mitchellh.ghostty.desktop"
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
          }
        ];

        environment.etc."balaur/ambient.json".text = ambientJson;
      };
    };
}
