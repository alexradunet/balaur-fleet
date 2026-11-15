# Orca (stablyai/orca, installed by `dev`) as a server: the machine's whole Orca
# runtime (projects, worktrees, terminals, agents) for the other machines' Orca
# apps to pair with, so the work stays on the server while the laptop is only a
# window onto it, and goes on while the laptop sleeps.
#
# `orca serve --supervise` as the admin's user service, started at boot without a
# login (lingering), on :6768. Only the tailnet reaches it: the firewall trusts
# tailscale0, and nothing opens the port on the LAN. While Orca's desktop window
# runs on the machine (a session over RDP), the supervisor waits and the window
# serves the same profile on the same port; when it closes, the service takes over.
#
# Pairing is done once, from Orca's window on the server (it has no command): a
# pairing link, pasted on the client into Settings -> Remote Orca Servers -> Add
# Server; then Advanced -> Active Server makes it the default. The grants live in
# the profile (~/.config/orca), which the window and the service share. The agents'
# logins are the server's (`orca account add --agent claude` there).
#
#   systemctl --user status orca-serve      journalctl --user -u orca-serve
{ inputs, ... }:
{
  flake.modules.nixos.orca-server =
    {
      config,
      lib,
      pkgs,
      ...
    }:
    let
      cfg = config.balaur.orca-server;
      user = config.balaur.user;
      home = config.users.users.${user}.home;
      orca = inputs.llm-agents.packages.${pkgs.stdenv.hostPlatform.system}.orca;
    in
    {
      options.balaur.orca-server.port = lib.mkOption {
        type = lib.types.port;
        default = 6768;
        description = "orca serve's port, on the tailnet (Orca's default).";
      };

      config = {
        # The admin's user manager runs from boot, not only while someone is logged in.
        users.users.${user}.linger = true;

        # What `orca serve service install` would write, declared (and only for the admin).
        systemd.user.services.orca-serve = {
          description = "Orca server (orca serve --supervise, :${toString cfg.port})";
          wantedBy = [ "default.target" ];
          unitConfig = {
            ConditionUser = user;
            StartLimitIntervalSec = 900;
            StartLimitBurst = 5;
          };
          # The agents and tools its terminals run: the system's and the admin's
          # profiles (Orca's wrapper adds its own helpers).
          environment = {
            PATH = lib.mkForce (
              lib.concatStringsSep ":" [
                "/run/wrappers/bin"
                "${home}/.local/bin"
                "/etc/profiles/per-user/${user}/bin"
                "/run/current-system/sw/bin"
              ]
            );
            ORCA_USER_DATA_PATH = "${home}/.config/orca";
          };
          serviceConfig = {
            ExecStart = "${lib.getExe' orca "orca-ide"} serve --supervise --no-pairing --port ${toString cfg.port}";
            Restart = "on-failure";
            RestartSec = 10;
            TimeoutStopSec = 90;
            # Its terminal daemon outlives a restart, so the sessions do too.
            KillMode = "process";
          };
        };
      };
    };
}
