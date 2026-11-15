# A machine the others depend on never sleeps: the server (the fleet's builder and
# home server). Sleep, suspend and hibernate are switched off.
#
# A laptop as a server would also want the lid, the power key and the battery
# handled (the `always-on` aspect did that; it left with the tablet, and git
# history keeps it); a machine on mains power needs only this.
{
  flake.modules.nixos.never-sleep = {
    systemd.targets = {
      sleep.enable = false;
      suspend.enable = false;
      hibernate.enable = false;
      hybrid-sleep.enable = false;
    };
    services.displayManager.gdm.autoSuspend = false;
  };
}
