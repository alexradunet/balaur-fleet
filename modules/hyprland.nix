# Hyprland, the tiling Wayland compositor, set up the way Omarchy does it: the
# keyboard first, Super+Return for a terminal, Super+Space for the launcher
# (Walker), waybar on top, mako for notifications, hyprlock and hypridle, swayosd
# for volume and brightness. Super+K lists every binding.
#
# It is the desktop's only session (GNOME left the fleet on 2026-11-15). greetd
# with tuigreet asks for the password on the console and starts it; `desktop`
# brings the apps and the services around it. libadwaita apps follow the dark
# style through the GTK portal.
#
# Every service of the session (waybar, mako, walker and the rest) is bound to
# hyprland-session.target, so they start with Hyprland and stop with it.
#
# Hyprland changes its config syntax between releases, and home-manager writes the
# file without reading it. `checks.hyprland-<host>` runs `Hyprland --verify-config`
# on each host's generated file, so a release that breaks it fails `nix flake
# check` rather than the login.
{ config, lib, ... }:
let
  hm = config.flake.modules.homeManager;
  nixosConfigs = config.flake.nixosConfigurations;

  # Tokyo Night, Omarchy's default theme.
  c = {
    bg = "1a1b26";
    bgLight = "24283b";
    fg = "c0caf5";
    dim = "565f89";
    blue = "7aa2f7";
    purple = "bb9af7";
    red = "f7768e";
  };

  # The keybindings, once: the Hyprland binds and the Super+K cheat sheet are both
  # made from this list. [ mods key description dispatcher argument ]
  binds = [
    [
      "SUPER SHIFT"
      "Return"
      "Browser"
      "exec"
      "firefox"
    ]
    [
      "SUPER"
      "Return"
      "Terminal"
      "exec"
      "ghostty"
    ]
    [
      "SUPER"
      "Space"
      "Launch an app"
      "exec"
      "walker"
    ]
    [
      "SUPER"
      "B"
      "Browser"
      "exec"
      "firefox"
    ]
    [
      "SUPER"
      "F"
      "Files"
      "exec"
      "nautilus --new-window"
    ]
    [
      "SUPER"
      "T"
      "Activity (btop)"
      "exec"
      "ghostty -e btop"
    ]
    [
      "SUPER"
      "W"
      "Close the window"
      "killactive"
      ""
    ]
    [
      "SUPER"
      "V"
      "Float / tile the window"
      "togglefloating"
      ""
    ]
    [
      "SUPER"
      "J"
      "Split the other way"
      "layoutmsg"
      "togglesplit"
    ]
    [
      "SUPER"
      "P"
      "Pseudo-tile"
      "pseudo"
      ""
    ]
    [
      ""
      "F11"
      "Full screen"
      "fullscreen"
      "0"
    ]
    [
      "SUPER"
      "K"
      "These keybindings"
      "exec"
      "balaur-hypr-keys"
    ]
    [
      "SUPER"
      "Escape"
      "Session: lock / suspend / log out / restart / power off"
      "exec"
      "balaur-hypr-power"
    ]
    [
      "SUPER CTRL"
      "L"
      "Lock the screen"
      "exec"
      "loginctl lock-session"
    ]
    [
      "SUPER CTRL"
      "V"
      "Clipboard history"
      "exec"
      "balaur-hypr-clipboard"
    ]
    [
      "SUPER SHIFT"
      "Space"
      "Show / hide the bar"
      "exec"
      "pkill -SIGUSR1 waybar"
    ]
    [
      ""
      "Print"
      "Screenshot of a region"
      "exec"
      "hyprshot -m region -o ~/Pictures/Screenshots"
    ]
    [
      "SHIFT"
      "Print"
      "Screenshot of a window"
      "exec"
      "hyprshot -m window -o ~/Pictures/Screenshots"
    ]
    [
      "SUPER"
      "Print"
      "Pick a colour"
      "exec"
      "hyprpicker -a"
    ]
    [
      "SUPER"
      "left"
      "Focus left"
      "movefocus"
      "l"
    ]
    [
      "SUPER"
      "right"
      "Focus right"
      "movefocus"
      "r"
    ]
    [
      "SUPER"
      "up"
      "Focus up"
      "movefocus"
      "u"
    ]
    [
      "SUPER"
      "down"
      "Focus down"
      "movefocus"
      "d"
    ]
    [
      "SUPER SHIFT"
      "left"
      "Swap left"
      "swapwindow"
      "l"
    ]
    [
      "SUPER SHIFT"
      "right"
      "Swap right"
      "swapwindow"
      "r"
    ]
    [
      "SUPER SHIFT"
      "up"
      "Swap up"
      "swapwindow"
      "u"
    ]
    [
      "SUPER SHIFT"
      "down"
      "Swap down"
      "swapwindow"
      "d"
    ]
    [
      "SUPER"
      "minus"
      "Narrower"
      "resizeactive"
      "-100 0"
    ]
    [
      "SUPER"
      "equal"
      "Wider"
      "resizeactive"
      "100 0"
    ]
    [
      "SUPER SHIFT"
      "minus"
      "Shorter"
      "resizeactive"
      "0 -100"
    ]
    [
      "SUPER SHIFT"
      "equal"
      "Taller"
      "resizeactive"
      "0 100"
    ]
    [
      "SUPER"
      "Tab"
      "Next workspace"
      "workspace"
      "e+1"
    ]
    [
      "SUPER SHIFT"
      "Tab"
      "Previous workspace"
      "workspace"
      "e-1"
    ]
  ]
  ++ lib.concatMap (
    n:
    let
      key = toString (lib.mod n 10);
    in
    [
      [
        "SUPER"
        key
        "Workspace ${toString n}"
        "workspace"
        (toString n)
      ]
      [
        "SUPER SHIFT"
        key
        "Move the window to workspace ${toString n}"
        "movetoworkspace"
        (toString n)
      ]
    ]
  ) (lib.range 1 10);

  # Hyprland splits a bind on commas, so a description cannot have one.
  bindLine =
    b:
    assert lib.assertMsg (
      !lib.hasInfix "," (lib.elemAt b 2)
    ) "hyprland.nix: no commas in a binding's description: ${lib.elemAt b 2}";
    lib.concatStringsSep ", " b;
  cheatLine =
    b:
    let
      mods = lib.elemAt b 0;
      chord =
        if mods == "" then
          lib.elemAt b 1
        else
          "${lib.replaceStrings [ " " ] [ "+" ] mods}+${lib.elemAt b 1}";
    in
    "${chord}  ${lib.elemAt b 2}";
in
{
  flake.modules.nixos.hyprland =
    {
      config,
      options,
      lib,
      pkgs,
      ...
    }:
    let
      # What greetd runs: Hyprland, then, once it has exited, the session's
      # services stopped. Nothing else stops them (the user manager outlives the
      # login), and waybar and the rest would otherwise restart against a display
      # that is gone until systemd gives up on them.
      session = pkgs.writeShellApplication {
        name = "balaur-hyprland-session";
        runtimeInputs = [
          config.programs.hyprland.package
          pkgs.systemd
        ];
        text = ''
          status=0
          start-hyprland || status=$?
          systemctl --user stop hyprland-session.target graphical-session.target || true
          exit "$status"
        '';
      };
    in
    {
      config = lib.mkMerge [
        {
          # The compositor and its portal. From nixpkgs, not Hyprland's own flake:
          # one version, from the binary cache; we use no plugins that would need theirs.
          programs.hyprland.enable = true;
          # hyprlock's PAM service, so it can unlock with the account's password.
          programs.hyprlock.enable = true;
          # It also turns on NixOS's own hypridle; home-manager's (below) runs
          # instead, with its settings, and one is enough.
          services.hypridle.enable = lib.mkForce false;

          # The login: tuigreet on the console, then straight into Hyprland. It
          # remembers the last user, so only the password is typed. The keyring
          # unlocks with that password.
          services.greetd = {
            enable = true;
            settings.default_session.command = lib.concatStringsSep " " [
              (lib.getExe pkgs.tuigreet)
              "--time"
              "--remember"
              "--asterisks"
              "--cmd ${lib.getExe session}"
            ];
          };
          security.pam.services.greetd.enableGnomeKeyring = true;

          # swayosd's udev rule hands the backlight to the `video` group, so the
          # brightness keys work without root.
          services.udev.packages = [ pkgs.swayosd ];
          users.users.${config.balaur.user}.extraGroups = [ "video" ];

          # The bar's icons.
          fonts.packages = [ pkgs.nerd-fonts.jetbrains-mono ];
        }
        (lib.optionalAttrs (options ? home-manager) {
          home-manager.users.${config.balaur.user}.imports = [ hm.hyprland ];
        })
      ];
    };

  flake.modules.homeManager.hyprland =
    { pkgs, lib, ... }:
    let
      walker = lib.getExe pkgs.walker;
      # Super+K: the bindings above, searchable.
      keys = pkgs.writeShellApplication {
        name = "balaur-hypr-keys";
        text = ''
          ${walker} --dmenu --placeholder "Keybindings" < ${
            pkgs.writeText "hyprland-keys" (lib.concatMapStringsSep "\n" cheatLine binds)
          } >/dev/null
        '';
      };
      # Super+Escape: what to do with the session.
      power = pkgs.writeShellApplication {
        name = "balaur-hypr-power";
        runtimeInputs = [
          pkgs.hyprland
          pkgs.systemd
        ];
        text = ''
          choice=$(printf '%s\n' Lock Suspend "Log out" Restart "Power off" | ${walker} --dmenu --placeholder "Session")
          case "$choice" in
            Lock) loginctl lock-session ;;
            Suspend) systemctl suspend ;;
            "Log out") hyprctl dispatch exit ;;
            Restart) systemctl reboot ;;
            "Power off") systemctl poweroff ;;
          esac
        '';
      };
      # Super+Ctrl+V: pick from what was copied, and copy it again.
      clipboard = pkgs.writeShellApplication {
        name = "balaur-hypr-clipboard";
        runtimeInputs = [
          pkgs.cliphist
          pkgs.wl-clipboard
        ];
        text = ''
          cliphist list | ${walker} --dmenu --placeholder "Clipboard" | cliphist decode | wl-copy
        '';
      };
      target = "hyprland-session.target";
      cursor = {
        name = "Adwaita";
        package = pkgs.adwaita-icon-theme;
        size = 24;
      };
    in
    {
      # The session's own services start with Hyprland and stop with it.
      wayland.systemd.target = target;

      wayland.windowManager.hyprland = {
        enable = true;
        # The NixOS module's Hyprland and portal, so there is one of each.
        package = null;
        portalPackage = null;
        # hyprland.conf, the format the binds and settings here are written in. Since
        # 0.55 Hyprland also reads Lua (home-manager's default from 26.05); the check
        # below says whether this release still reads the old one.
        configType = "hyprlang";
        # hyprland-session.target, and the session's variables for systemd units.
        systemd.enable = true;
        # At every start, after the variables: forget what failed in the last session
        # (a service that hit its restart limit would otherwise stay down), then
        # restart the target as home-manager does by default.
        systemd.extraCommands = [
          "systemctl --user reset-failed"
          "systemctl --user stop hyprland-session.target"
          "systemctl --user start hyprland-session.target"
        ];

        settings = {
          # The laptop's panel at 167% (as it was in GNOME); any other screen at its preferred mode.
          monitor = [
            "eDP-1, preferred, auto, 1.666667"
            ", preferred, auto, auto"
          ];
          # The cursor (home.pointerCursor, below), said to Hyprland itself as well:
          # greetd starts it without a login shell, so home-manager's session
          # variables do not reach it.
          env = [
            "XCURSOR_THEME,${cursor.name}"
            "XCURSOR_SIZE,${toString cursor.size}"
            "HYPRCURSOR_SIZE,${toString cursor.size}"
          ];

          input = {
            # US and Romanian (standard); Alt+Shift switches.
            kb_layout = "us,ro";
            kb_variant = ",std";
            kb_options = "grp:alt_shift_toggle";
            follow_mouse = 1;
            touchpad.natural_scroll = true;
          };
          gesture = [ "3, horizontal, workspace" ];

          general = {
            gaps_in = 5;
            gaps_out = 10;
            border_size = 2;
            "col.active_border" = "rgb(${c.blue}) rgb(${c.purple}) 45deg";
            "col.inactive_border" = "rgb(${c.bgLight})";
            layout = "dwindle";
          };
          decoration = {
            rounding = 0;
            blur = {
              enabled = true;
              size = 3;
              passes = 2;
            };
            shadow.enabled = false;
          };
          animations.enabled = true;
          dwindle = {
            preserve_split = true;
          };
          misc = {
            disable_hyprland_logo = true;
            disable_splash_rendering = true;
            force_default_wallpaper = 0;
            background_color = "rgb(${c.bg})";
          };
          ecosystem = {
            no_update_news = true;
            no_donation_nag = true;
          };

          # With a description each, which `hyprctl binds` shows too.
          bindd = map bindLine binds;
          # Hold the button with Super: move, or resize.
          bindm = [
            "SUPER, mouse:272, movewindow"
            "SUPER, mouse:273, resizewindow"
          ];
          # Repeat while held, and work on the lock screen too.
          bindel = [
            ", XF86AudioRaiseVolume, exec, swayosd-client --output-volume raise"
            ", XF86AudioLowerVolume, exec, swayosd-client --output-volume lower"
            ", XF86MonBrightnessUp, exec, swayosd-client --brightness raise"
            ", XF86MonBrightnessDown, exec, swayosd-client --brightness lower"
          ];
          bindl = [
            ", XF86AudioMute, exec, swayosd-client --output-volume mute-toggle"
            ", XF86AudioMicMute, exec, swayosd-client --input-volume mute-toggle"
            ", XF86AudioPlay, exec, playerctl play-pause"
            ", XF86AudioNext, exec, playerctl next"
            ", XF86AudioPrev, exec, playerctl previous"
          ];
        };
      };

      home.packages = [
        keys
        power
        clipboard
        pkgs.hyprshot
        pkgs.hyprpicker
        pkgs.playerctl
        # What the bar's buttons open: sound, Bluetooth.
        pkgs.wiremix
        pkgs.bluetui
      ];

      # One cursor everywhere: Hyprland, GTK apps and Electron apps (Orca, Obsidian).
      # Without it each falls back to its own, in its own size.
      home.pointerCursor = cursor // {
        gtk.enable = true;
        hyprcursor.enable = true;
      };
      # Writes the GTK settings files the cursor lands in.
      gtk.enable = true;

      # Tokyo Night in the terminal and in btop too, with the bar's font. No title
      # bar: Hyprland places and closes the windows.
      programs.ghostty = {
        enable = true;
        settings = {
          theme = "TokyoNight";
          font-family = "JetBrainsMono Nerd Font";
          font-size = 11;
          window-padding-x = 10;
          window-padding-y = 10;
          window-decoration = false;
        };
      };
      programs.btop = {
        enable = true;
        settings.color_theme = "tokyo-night";
      };

      # The launcher, and the service that feeds it (apps, files, calculator...).
      services.elephant.enable = true;
      services.walker = {
        enable = true;
        systemd.enable = true;
      };
      # Their modules bind to graphical-session.target whatever the setting above.
      systemd.user.services.elephant.Install.WantedBy = lib.mkForce [ target ];
      systemd.user.services.walker.Install.WantedBy = lib.mkForce [ target ];

      programs.waybar = {
        enable = true;
        systemd.enable = true;
        settings.main = {
          layer = "top";
          position = "top";
          height = 28;
          modules-left = [ "hyprland/workspaces" ];
          modules-center = [ "clock" ];
          modules-right = [
            "tray"
            "hyprland/language"
            "bluetooth"
            "network"
            "pulseaudio"
            "cpu"
            "battery"
          ];
          clock = {
            format = "{:%a %d %b  %H:%M}";
            tooltip-format = "<tt>{calendar}</tt>";
          };
          "hyprland/language" = {
            format-en = "EN";
            format-ro = "RO";
          };
          bluetooth = {
            format = "󰂯";
            format-disabled = "󰂲";
            format-connected = "󰂱";
            on-click = "ghostty -e bluetui";
          };
          network = {
            format-wifi = "󰤨";
            format-ethernet = "󰈀";
            format-disconnected = "󰤭";
            tooltip-format-wifi = "{essid} ({signalStrength}%)";
            on-click = "ghostty -e nmtui";
          };
          pulseaudio = {
            format = "{icon}";
            format-muted = "󰝟";
            format-icons.default = [
              "󰕿"
              "󰖀"
              "󰕾"
            ];
            tooltip-format = "{volume}%";
            on-click = "ghostty -e wiremix";
          };
          cpu = {
            format = "󰍛";
            interval = 5;
            on-click = "ghostty -e btop";
          };
          battery = {
            format = "{icon} {capacity}%";
            format-charging = "󰂄 {capacity}%";
            format-icons = [
              "󰁺"
              "󰁼"
              "󰁾"
              "󰂀"
              "󰁹"
            ];
            states.warning = 20;
          };
        };
        style = ''
          * {
            font-family: "JetBrainsMono Nerd Font";
            font-size: 13px;
            min-height: 0;
          }
          window#waybar {
            background: #${c.bg};
            color: #${c.fg};
          }
          #workspaces button {
            color: #${c.dim};
            padding: 0 6px;
            border: none;
            border-radius: 0;
          }
          #workspaces button.active {
            color: #${c.blue};
          }
          #tray, #language, #bluetooth, #network, #pulseaudio, #cpu, #battery {
            padding: 0 8px;
          }
          #battery.warning:not(.charging) {
            color: #${c.red};
          }
        '';
      };

      services.mako = {
        enable = true;
        settings = {
          background-color = "#${c.bg}";
          text-color = "#${c.fg}";
          border-color = "#${c.blue}";
          border-size = 2;
          default-timeout = 5000;
          font = "sans 11";
        };
      };

      services.swayosd.enable = true;
      services.hyprpolkitagent.enable = true;
      services.cliphist.enable = true;

      # Locked after 5 minutes, the screen off 30 seconds later, and locked before
      # every suspend (the lid: logind suspends).
      services.hypridle = {
        enable = true;
        settings = {
          general = {
            lock_cmd = "pidof hyprlock || hyprlock";
            before_sleep_cmd = "loginctl lock-session";
            after_sleep_cmd = "hyprctl dispatch dpms on";
          };
          listener = [
            {
              timeout = 300;
              on-timeout = "loginctl lock-session";
            }
            {
              timeout = 330;
              on-timeout = "hyprctl dispatch dpms off";
              on-resume = "hyprctl dispatch dpms on";
            }
          ];
        };
      };

      programs.hyprlock = {
        enable = true;
        settings = {
          general.hide_cursor = true;
          background = [ { color = "rgb(${c.bg})"; } ];
          label = [
            {
              text = "$TIME";
              font_size = 64;
              color = "rgb(${c.fg})";
              position = "0, 120";
              halign = "center";
              valign = "center";
            }
          ];
          input-field = [
            {
              size = "300, 50";
              outline_thickness = 2;
              outer_color = "rgb(${c.blue})";
              inner_color = "rgb(${c.bgLight})";
              font_color = "rgb(${c.fg})";
              check_color = "rgb(${c.purple})";
              fail_color = "rgb(${c.red})";
              placeholder_text = "Password";
              fade_on_empty = false;
            }
          ];
        };
      };
    };

  # Hyprland's own reading of each host's generated config (see the top).
  perSystem =
    { pkgs, ... }:
    {
      checks = lib.mapAttrs' (
        host: nixos:
        lib.nameValuePair "hyprland-${host}" (
          pkgs.runCommand "hyprland-config-${host}"
            { nativeBuildInputs = [ nixos.config.programs.hyprland.package ]; }
            ''
              export HOME=$TMPDIR XDG_RUNTIME_DIR=$TMPDIR
              Hyprland --verify-config --config ${
                nixos.config.home-manager.users.${nixos.config.balaur.user}.xdg.configFile."hypr/hyprland.conf".source
              } | tee $out
              grep -qx "config ok" $out
            ''
        )
      ) (lib.filterAttrs (_: nixos: nixos.config.programs.hyprland.enable) nixosConfigs);
    };
}
