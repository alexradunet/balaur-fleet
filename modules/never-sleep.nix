# A machine the others depend on never sleeps: the tablet (the home's server),
# the server (the fleet's builder and home server). Sleep, suspend and
# hibernate are switched off, and GDM's login screen never suspends either.
#
# A laptop-as-server also wants `always-on` (the lid, the power key, the battery
# as a UPS); a machine on mains power needs only this.
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
