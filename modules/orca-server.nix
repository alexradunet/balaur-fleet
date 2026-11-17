# Orca (stablyai/orca, installed by `dev`) as a server: the machine's whole Orca
# runtime (projects, worktrees, terminals, agents) for the other machines' Orca
# apps to pair with, so the work stays on the server while the laptop is only a
# window onto it, and goes on while the laptop sleeps.
#
# `orca serve --supervise` as the admin's user service, started at boot without a
# login (lingering), on :6768. Only the tailnet reaches it: the firewall trusts
# tailscale0, and nothing opens the port on the LAN. Orca's window on the machine
# (a session over RDP) is opened by `balaur-orca-window`, Orca's menu entry here:
# it stops the service, the window serves the same profile on the same port, and
# the service starts again when the window closes.
#
# Pairing is done once, from Orca's window on the server (it has no command): a
# pairing link, pasted on the client into Settings -> Remote Orca Servers -> Add
# Server; then Advanced -> Active Server makes it the default. The grants live in
# the profile (~/.config/orca), which the window and the service share. A phone
# (Orca Mobile) pairs with a one-off `orca serve --mobile-pairing --pairing-address
# <tailnet IP>` while this service is stopped (docs/SETUP.md). The agents'
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

      # Orca's window on this machine (over RDP). The service's Orca holds the
      # profile and has no screen, so a plain launch hands over to it and nothing
      # shows. This stops the service, waits for its Orca to let go, runs the window,
      # and starts the service again once the window closes. The terminals survive
      # both (their daemon runs in its own scopes). A second launch while the window
      # is open (the lock is taken) only hands over to that window.
      orcaWindow = pkgs.writeShellApplication {
        name = "balaur-orca-window";
        runtimeInputs = [
          pkgs.systemd
          pkgs.procps
          pkgs.util-linux
          pkgs.coreutils
          pkgs.zenity
        ];
        text = ''
          lock=''${XDG_RUNTIME_DIR:-/tmp}/balaur-orca-window.lock
          exec 9>"$lock"
          if ! flock -n 9; then
            exec ${lib.getExe' orca "orca-ide"} "$@"
          fi

          systemctl --user stop orca-serve.service || true
          # The service's Orca runs with --serve-port; wait until it has gone.
          for _ in $(seq 60); do
            pgrep -u "$(id -u)" -f -- '--serve-port' >/dev/null || break
            sleep 0.5
          done
          if pgrep -u "$(id -u)" -f -- '--serve-port' >/dev/null; then
            systemctl --user start orca-serve.service || true
            zenity --error --title=Orca \
              --text="The background Orca (orca-serve) did not stop, so its window cannot open." || true
            exit 1
          fi

          status=0
          ${lib.getExe' orca "orca-ide"} "$@" || status=$?
          systemctl --user start orca-serve.service
          exit "$status"
        '';
      };
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

        # Orca's menu entry, over the package's own (hiPrio): the window and the
        # service cannot share the profile at once.
        environment.systemPackages = [
          (lib.hiPrio (
            pkgs.makeDesktopItem {
              name = "orca-ide";
              desktopName = "Orca";
              genericName = "Agentic Development Environment";
              comment = "Orca's window on this machine (stops orca-serve while it is open)";
              exec = "${lib.getExe orcaWindow} %U";
              icon = "orca-ide";
              categories = [ "Development" ];
              mimeTypes = [ "x-scheme-handler/orca" ];
              startupWMClass = "orca";
            }
          ))
          orcaWindow
        ];

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
