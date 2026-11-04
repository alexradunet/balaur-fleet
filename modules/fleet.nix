# The fleet registry: every machine Balaur configures, and what the others need
# to know about it. Each host file adds its own entry (`fleet.<hostname> = { ... }`);
# the `fleet` aspect turns the whole list into config on every machine:
#
#   - SSH: each machine's host key is known everywhere (no "authenticity of host"
#     prompt, and a changed key is refused), under its name, <name>.local and its IPs.
#   - The admin's SSH keys from every machine are authorized on every machine,
#     so `ssh <host>` and `nixos-rebuild --target-host <host>` work from any of them.
#
# Names resolve over the tailnet (MagicDNS: `duet`) and on the LAN (mDNS: `duet.local`).
{ lib, config, ... }:
let
  inherit (lib) mkOption types;
  fleet = config.fleet;
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
      };
    });
  };

  config.flake.modules.nixos.fleet =
    { lib, ... }:
    {
      programs.ssh.knownHosts = lib.mapAttrs (name: h: {
        hostNames = [ name "${name}.local" ] ++ lib.filter (ip: ip != null) [ h.tailnetIp h.lanIp ];
        publicKey = h.sshHostKey;
      }) (lib.filterAttrs (_: h: h.sshHostKey != null) fleet);

      balaur.sshKeys = lib.concatMap (h: h.userKeys) (lib.attrValues fleet);
    };
}
