# Gaming: Battle.net (World of Warcraft: Forever and the rest of Blizzard's games)
# on Proton, plus a WoW add-on manager, for a personal machine with a screen.
#
# Battle.net runs under umu-launcher with GE-Proton: umu is the launcher Proton
# itself uses outside Steam (the Steam Linux Runtime container, plus Proton's
# DXVK/VKD3D), so this is the same stack Steam would use, without Steam or Lutris.
# The approach follows github.com/jacobjdowning/battlenet-umu, kept to what this
# fleet needs instead of taken as a flake input.
#
# One menu entry, "Battle.net". The first launch downloads the Steam runtime (a few
# hundred MB, into ~/.local/share/umu) and Blizzard's installer, then installs
# Battle.net into its own Wine prefix; every launch after that opens Battle.net,
# where the games are installed and played as on Windows.
#
# Add-ons: `wow-addons` is instawow with a profile for Forever's AddOns folder in
# that prefix, so `wow-addons search`, `install`, `update` and `remove` act on
# Forever without any setup. Plain `instawow` is there too for other WoW versions.
# Add-ons are kept by instawow, not declared here: picking one should not need a
# rebuild.
#
# Nothing runs in the background: no daemon, no service.
{
  flake.modules.nixos.gaming =
    { pkgs, ... }:
    let
      # The Wine prefix Battle.net and its games live in, as a shell expression.
      prefix = ''"''${XDG_DATA_HOME:-$HOME/.local/share}/battlenet/prefix"'';

      battlenet = pkgs.writeShellApplication {
        name = "battlenet";
        runtimeInputs = with pkgs; [ umu-launcher curl coreutils libnotify ];
        runtimeEnv = {
          GAMEID = "umu-default";
          PROTONPATH = "${pkgs.proton-ge-bin.steamcompattool}";
        };
        text = ''
          WINEPREFIX=${prefix}
          export WINEPREFIX
          launcher="$WINEPREFIX/drive_c/Program Files (x86)/Battle.net/Battle.net Launcher.exe"

          if [ ! -f "$launcher" ]; then
            notify-send -a Battle.net -i applications-games "Installing Battle.net" \
              "The first start downloads the Proton runtime and the installer. This takes a few minutes."
            # Check for a runtime update only while setting up; later starts go straight in.
            export UMU_RUNTIME_UPDATE=1
            mkdir -p "$WINEPREFIX/drive_c"
            installer=$(mktemp --suffix=.exe -p "$WINEPREFIX/drive_c")
            trap 'rm -f "$installer"' EXIT
            if ! curl -fL -o "$installer" \
                "https://downloader.battle.net/download/getInstaller?os=win&installer=Battle.net-Setup.exe"; then
              notify-send -a Battle.net -u critical "Battle.net" "Downloading the installer failed."
              exit 1
            fi
            # Leave the install location at its default: this script looks for it there.
            umu-run "$installer"
            # The installer usually starts Battle.net itself when it finishes.
            exit 0
          fi

          export UMU_RUNTIME_UPDATE="''${UMU_RUNTIME_UPDATE:-0}"
          exec umu-run "$launcher"
        '';
      };

      # instawow learned WoW: Forever (flavour `forever_classic`, folder `_forever_`)
      # in 7.3.0; nixpkgs has 7.0. 7.3 needs click >= 8.4 (it subscripts click's
      # now-generic types), so it gets a Python of its own with a newer click,
      # which rebuilds a handful of Python packages locally but leaves the rest of
      # the system's Python alone. The other version floors are only floors:
      # relaxed, and checked by running it. Drop all this once nixpkgs has >= 7.3.
      instawowPython = pkgs.python3.override {
        self = instawowPython;
        packageOverrides = _: super: {
          click = super.click.overridePythonAttrs (_: rec {
            version = "8.4.1";
            src = pkgs.fetchPypi {
              pname = "click";
              inherit version;
              hash = "sha256-kYtWM+3fa0HDLU9FS/DegQBlx04/fb+O5UUvi+iNPpY=";
            };
            doCheck = false;
          });
        };
      };
      instawow = (pkgs.instawow.override { python3 = instawowPython; }).overridePythonAttrs (old: rec {
        version = "7.3.0";
        src = pkgs.fetchPypi {
          pname = "instawow";
          inherit version;
          hash = "sha256-ZB+FuMf5oJVRAtsinhFa6NQH5FvInpfnTlchsrVbgA8=";
        };
        pythonRelaxDeps = true;
        nativeBuildInputs = old.nativeBuildInputs ++ [ instawowPython.pkgs.versioningit ];
        propagatedBuildInputs = old.propagatedBuildInputs ++ [ instawowPython.pkgs.wcwidth ];
      });

      wowAddons = pkgs.writeShellApplication {
        name = "wow-addons";
        runtimeInputs = [ instawow pkgs.coreutils ];
        text = ''
          prefix=${prefix}
          game="$prefix/drive_c/Program Files (x86)/World of Warcraft/_forever_"
          if [ ! -d "$game" ]; then
            echo "WoW: Forever is not installed at $game." >&2
            echo "Install it from Battle.net first (keep the default location)." >&2
            exit 1
          fi
          # A fresh install has no AddOns folder until the game makes one.
          mkdir -p "$game/Interface/AddOns"

          config="''${XDG_CONFIG_HOME:-$HOME/.config}/instawow"
          # Written once: `instawow configure` and its own edits are kept after that.
          if [ ! -f "$config/profiles/forever/config.json" ]; then
            mkdir -p "$config/profiles/forever"
            printf '{"profile": "forever", "addon_dir": "%s"}\n' "$game/Interface/AddOns" \
              > "$config/profiles/forever/config.json"
          fi
          # Nix updates instawow; its own "a new version is out" check is noise here.
          if [ ! -f "$config/config.json" ]; then
            echo '{"auto_update_check": false}' > "$config/config.json"
          fi

          exec instawow -p forever "$@"
        '';
      };
    in
    {
      # Proton's container imports the host's graphics drivers, and Battle.net still
      # ships 32-bit helpers, which need the 32-bit Mesa/Vulkan NixOS leaves out.
      hardware.graphics.enable32Bit = true;

      environment.systemPackages = [
        battlenet
        (pkgs.makeDesktopItem {
          name = "battlenet";
          desktopName = "Battle.net";
          comment = "Blizzard's launcher, on Proton";
          exec = "battlenet";
          icon = "applications-games";
          categories = [ "Game" ];
        })
        instawow
        wowAddons
      ];
    };
}
