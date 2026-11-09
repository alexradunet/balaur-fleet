# The fleet's one place to develop: herdr's server (herdr.dev) runs here from boot and
# owns every terminal and agent session, so the other machines and the phone are only
# screens. `dev` (dev.nix) attaches from any machine; closing that machine, or losing
# the connection, changes nothing here. The host marks itself `devHost` in the
# registry, which is how `dev` finds it.
#
# It has no port and no page: herdr speaks over a socket in the admin's home, and the
# others reach it through SSH.
{ inputs, ... }: {
  flake.modules.nixos.dev-host =
    {
      config,
      lib,
      pkgs,
      ...
    }:
    let
      cfg = config.balaur;
      herdr = inputs.llm-agents.packages.${pkgs.stdenv.hostPlatform.system}.herdr;
    in
    {
      # The admin may have no session open here at all (on the Duet the screen belongs
      # to the tablet account), and the sessions must outlive every login.
      users.users.${cfg.user}.linger = true;

      systemd.user.services.herdr-server = {
        description = "herdr: the terminals and agent sessions of ${cfg.user}";
        wantedBy = [ "default.target" ];
        unitConfig.ConditionUser = cfg.user;
        # Stopping this unit ends every pane, so a deploy must never do it. A new
        # herdr starts with the next boot, or when you restart the unit yourself.
        restartIfChanged = false;
        # What a login shell has, so that the panes find claude, pi, nix and sudo.
        environment.PATH = lib.mkForce "/run/wrappers/bin:%h/.nix-profile/bin:/etc/profiles/per-user/%u/bin:/nix/var/nix/profiles/default/bin:/run/current-system/sw/bin";
        serviceConfig = {
          ExecStart = "${herdr}/bin/herdr server";
          Restart = "on-failure";
        };
      };
    };
}
