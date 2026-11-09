# A laptop pretending to be a server: never sleep, ignore lid and power key,
# treat the battery as a UPS (clean shutdown when it runs low), cap its charge.
{
  flake.modules.nixos.always-on =
    {
      config,
      lib,
      pkgs,
      ...
    }:
    let
      cfg = config.balaur.power;

      chargeLimit = pkgs.writeShellScript "duet-charge-limit" ''
        limit=${toString cfg.chargeLimit}
        done=0
        # Generic ACPI battery API (ThinkPad-style and newer ideapad firmware).
        for f in /sys/class/power_supply/BAT*/charge_control_end_threshold; do
          [ -w "$f" ] && echo "$limit" > "$f" && done=1
        done
        # Lenovo IdeaPad/Yoga "conservation mode": a fixed ~60-80% cap.
        if [ "$done" = 0 ]; then
          for f in /sys/bus/platform/drivers/ideapad_acpi/*/conservation_mode; do
            [ -w "$f" ] && echo 1 > "$f" && done=1
          done
        fi
        [ "$done" = 1 ] && echo "charge limit applied" || echo "no charge-limit control found; skipping"
        exit 0
      '';
    in
    {
      options.balaur = {
        power.chargeLimit = lib.mkOption {
          type = lib.types.nullOr (lib.types.ints.between 50 100);
          default = 80;
          description = ''
            Battery charge ceiling in percent. The laptop battery acts as a small
            UPS; holding it at 80% keeps it healthy for years of 24/7 mains use.
            Best effort: applied only if the firmware exposes a control for it.
          '';
        };
      };

      config = {
        services.logind.settings.Login = {
          HandleLidSwitch = "ignore";
          HandleLidSwitchExternalPower = "ignore";
          HandleLidSwitchDocked = "ignore";
          # Tablet: the power button is easy to hit by accident. Hold to shut down.
          HandlePowerKey = "ignore";
          HandlePowerKeyLongPress = "poweroff";
          IdleAction = "ignore";
        };

        systemd.targets = {
          sleep.enable = false;
          suspend.enable = false;
          hibernate.enable = false;
          hybrid-sleep.enable = false;
        };

        # Battery as UPS: shut down cleanly instead of dying mid-write.
        services.upower = {
          enable = true;
          usePercentageForPolicy = true;
          percentageLow = 20;
          percentageCritical = 10;
          percentageAction = 7;
          criticalPowerAction = "PowerOff";
        };

        services.thermald.enable = true;

        systemd.services.duet-charge-limit = lib.mkIf (cfg.chargeLimit != null) {
          description = "Cap battery charge level";
          wantedBy = [ "multi-user.target" ];
          serviceConfig = {
            Type = "oneshot";
            RemainAfterExit = true;
            ExecStart = chargeLimit;
          };
        };
      };
    };
}
