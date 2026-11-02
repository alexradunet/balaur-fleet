# Touch kiosk on the built-in screen: Cage (single-app Wayland compositor)
# running Chromium full-screen on the local dashboard.
{ config, lib, pkgs, ... }:
let
  cfg = config.duet;
  url = "http://127.0.0.1/?kiosk=1";

  kiosk = pkgs.writeShellScript "duet-kiosk" ''
    # The dashboard may still be starting; wait instead of showing an error page.
    until ${pkgs.curl}/bin/curl -sf -o /dev/null ${url}; do sleep 1; done

    exec ${pkgs.chromium}/bin/chromium \
      --kiosk \
      --ozone-platform=wayland \
      --user-data-dir="$XDG_RUNTIME_DIR/chromium-kiosk" \
      --no-first-run \
      --noerrdialogs \
      --disable-infobars \
      --disable-session-crashed-bubble \
      --disable-translate \
      --disable-pinch \
      --overscroll-history-navigation=0 \
      --touch-events=enabled \
      --password-store=basic \
      --check-for-update-interval=31536000 \
      ${url}
  '';
in
lib.mkIf cfg.kiosk.enable {
  users.users.kiosk = {
    isNormalUser = true;
    description = "Kiosk";
    extraGroups = [ "video" "render" ];
    hashedPassword = "!"; # no password login; Cage logs in via systemd/PAM
  };

  services.cage = {
    enable = true;
    user = "kiosk";
    program = kiosk;
    # Start even though the touchscreen may enumerate late.
    environment.WLR_LIBINPUT_NO_DEVICES = "1";
    # -s: allow Ctrl+Alt+F2..F6 from an attached keyboard to reach a login
    # console on the laptop itself (recovery).
    extraArguments = [ "-s" ];
  };

  # Cage restarts whenever Chromium exits/crashes; bring the dashboard up first.
  systemd.services."cage-tty1" = {
    after = [ "duet-dashboard.service" ];
    wants = [ "duet-dashboard.service" ];
    serviceConfig = {
      Restart = "always";
      RestartSec = 2;
    };
  };

  hardware.graphics.enable = true;
}
