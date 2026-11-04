# The fleet registry: every machine Balaur configures, and what the others need
# to know about it. Each host file adds its own entry (`fleet.<hostname> = { ... }`);
# the `fleet` aspect turns the whole list into config on every machine:
#
#   - SSH: each machine's host key is known everywhere (no "authenticity of host"
#     prompt, and a changed key is refused), under its name, <name>.local and its IPs.
#   - The admin's SSH keys from every machine are authorized on every machine,
#     so `ssh <host>` and `nixos-rebuild --target-host <host>` work from any of them.
#   - Remote builds: a machine with a `builder` entry offers itself to the others,
#     which get it in `nix.buildMachines`.
#
# Names resolve over the tailnet (MagicDNS: `duet`) and on the LAN (mDNS: `duet.local`).
{ lib, config, ... }:
let
  inherit (lib) mkOption types;
  fleet = config.fleet;
  # The account the other machines' root logs in as to build here. It needs no key
  # of its own: each machine's root authenticates with that machine's SSH *host*
  # key, which the registry already carries, so nothing secret is added anywhere.
  builderUser = "nixremote";
in
{
  options.fleet = mkOption {
    description = "Every machine in the fleet, by hostname.";
    default = { };
    type = types.attrsOf (types.submodule {
      options = {
        description = mkOption { type = types.str; default = ""; description = "What this machine is for."; };
        tailnetIp = mkOption {
          type = types.nullOr types.str;
          default = null;
          description = "Its Tailscale address (`tailscale ip -4` on it).";
        };
        lanIp = mkOption {
          type = types.nullOr types.str;
          default = null;
          description = "Its LAN address, if reserved in the router.";
        };
        sshHostKey = mkOption {
          type = types.nullOr types.str;
          default = null;
          description = "Its SSH host key: `cat /etc/ssh/ssh_host_ed25519_key.pub` on it.";
        };
        userKeys = mkOption {
          type = types.listOf types.str;
          default = [ ];
          description = "The admin's SSH public keys on this machine (~/.ssh/id_ed25519.pub), trusted by every machine.";
        };
        syncthingId = mkOption {
          type = types.nullOr types.str;
          default = null;
          description = ''
            Its Syncthing device ID, so the `files` aspect can pair the machines
            without anyone clicking through the UI. Read it off the machine with
            `journalctl -u syncthing -b | grep "device ID"`, or
            `sudo syncthing --home=/var/lib/syncthing cli show system`.

            It is a hash of the device's public certificate, so it is safe here
            next to the SSH host keys: knowing it lets nobody impersonate the
            device.
          '';
        };
        builder = mkOption {
          default = null;
          description = ''
            Set this to offer the machine to the rest of the fleet as a Nix remote
            builder. The others then get it in `nix.buildMachines`, and it grows a
            `${builderUser}` account that their root logs into with its own host key.
            It needs `sshHostKey` set here, and every client needs one too.

            Leave it null on a machine that should only ever build for itself.
          '';
          type = types.nullOr (types.submodule {
            options = {
              systems = mkOption {
                type = types.listOf types.str;
                default = [ "x86_64-linux" ];
                description = "Platforms it can build for.";
              };
              maxJobs = mkOption {
                type = types.ints.positive;
                default = 4;
                description = "Derivations it will build at once. Leave headroom: it is somebody's desktop.";
              };
              speedFactor = mkOption {
                type = types.ints.positive;
                default = 1;
                description = "Relative speed, compared with the other builders. Higher wins work.";
              };
            };
          });
        };
      };
    });
  };

  config.flake.modules.nixos.fleet =
    { config, lib, pkgs, ... }:
    let
      me = config.networking.hostName;
      others = lib.filterAttrs (name: _: name != me) fleet;
      # Who this machine can farm work out to, and whether it takes work itself.
      builders = lib.filterAttrs (_: h: h.builder != null && h.sshHostKey != null) others;
      myEntry = fleet.${me} or null;
      iAmABuilder = myEntry != null && myEntry.builder != null;
      # Their root authenticates as their host key, which is what we authorize.
      clientHostKeys = lib.filter (k: k != null) (lib.mapAttrsToList (_: h: h.sshHostKey) others);
      haveBuilders = builders != { };
    in
    {
      programs.ssh.knownHosts = lib.mapAttrs (name: h: {
        hostNames = [ name "${name}.local" ] ++ lib.filter (ip: ip != null) [ h.tailnetIp h.lanIp ];
        publicKey = h.sshHostKey;
      }) (lib.filterAttrs (_: h: h.sshHostKey != null) fleet);

      balaur.sshKeys = lib.concatMap (h: h.userKeys) (lib.attrValues fleet);

      # ---- using the others as builders ----
      nix.distributedBuilds = haveBuilders;
      nix.buildMachines = lib.mapAttrsToList (name: h: {
        hostName = name;
        sshUser = builderUser;
        # Root's own identity, readable only by root, already trusted over there.
        sshKey = "/etc/ssh/ssh_host_ed25519_key";
        protocol = "ssh-ng";
        inherit (h.builder) systems maxJobs speedFactor;
      }) builders;
      # Let the builder fetch from the caches itself instead of us shipping every
      # dependency to it and the results back.
      nix.settings.builders-use-substitutes = lib.mkIf haveBuilders true;
      # A builder that is somebody's laptop is not always awake. Give up on the
      # connection quickly; Nix then just builds locally instead of hanging.
      programs.ssh.extraConfig = lib.mkIf haveBuilders (lib.concatMapStrings (name: ''
        Host ${name}
          ConnectTimeout 5
      '') (lib.attrNames builders));

      # ---- being a builder for the others ----
      users.groups.${builderUser} = lib.mkIf iAmABuilder { };
      users.users.${builderUser} = lib.mkIf iAmABuilder {
        isSystemUser = true;
        group = builderUser;
        description = "Nix remote builds for the rest of the fleet";
        # `nix daemon --stdio` is run through a login shell.
        shell = pkgs.bashInteractive;
        openssh.authorizedKeys.keys = clientHostKeys;
      };
      # It has to be trusted to be handed derivations and give their outputs back.
      nix.settings.trusted-users = lib.mkIf iAmABuilder [ builderUser ];
    };
}
