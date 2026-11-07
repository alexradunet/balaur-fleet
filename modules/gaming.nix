# Gaming: Battle.net (World of Warcraft: Forever and the rest of Blizzard's games)
# on Proton, for a personal machine with a screen.
#
# Battle.net runs under umu-launcher with GE-Proton: umu is the launcher Proton
# itself uses outside Steam (the Steam Linux Runtime container, plus Proton's
# DXVK/VKD3D), so this is the same stack Steam would use, without Steam or Lutris.
# The approach follows github.com/jacobjdowning/battlenet-umu, kept to the one
# launcher this fleet needs instead of taken as a flake input.
#
# One menu entry, "Battle.net". The first launch downloads the Steam runtime (a few
# hundred MB, into ~/.local/share/umu) and Blizzard's installer, then installs
# Battle.net into its own Wine prefix; every launch after that opens Battle.net,
# where the games are installed and played as on Windows. Nothing runs in the
# background: no daemon, no service.
{
  flake.modules.nixos.gaming =
    { pkgs, ... }:
    let
      battlenet = pkgs.writeShellApplication {
        name = "battlenet";
        runtimeInputs = with pkgs; [ umu-launcher curl coreutils libnotify ];
        runtimeEnv = {
          GAMEID = "umu-default";
          PROTONPATH = "${pkgs.proton-ge-bin.steamcompattool}";
        };
        text = ''
          WINEPREFIX="''${XDG_DATA_HOME:-$HOME/.local/share}/battlenet/prefix"
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
      ];
    };
}
