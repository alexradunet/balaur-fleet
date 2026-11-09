# Secrets: committed encrypted, decrypted at activation into /run/secrets.
#
# How it fits together:
#
#   secrets/balaur.yaml         the fleet's shared secrets: every machine and every
#                               admin key can read them. The default file.
#   secrets/hosts/<host>.yaml   one machine's own: only that machine and the admin
#                               keys of the machines that stay at home (not the
#                               laptop, which travels) can read them. Declare such a
#                               secret with `sopsFile = config.balaur.secrets.hostFile`.
#   .sops.yaml                  which recipients encrypt which files.
#   this aspect                 hands sops-nix each machine's decryption key and the
#                               files; the host files and aspects declare which
#                               secrets they want and wire them to what reads them.
#
# A secret goes in the shared file only when more than one machine needs it. The
# ciphertext is public (so is the repo), so a leaked key exposes everything ever
# encrypted to it: the fewer machines a secret is encrypted to, the better.
#
# The decryption key is the machine's own SSH host key, converted to an age
# identity. Nothing new is generated or distributed, and the registry's
# `sshHostKey` is already the public half — the same arrangement the remote
# builders use.
#
# Why not just put secrets in the Nix store: /nix/store is world-readable, and
# anything referenced from a module ends up there. sops-nix writes to a tmpfs
# under /run/secrets instead, with the owner and mode each secret asks for, and
# does it before the services that need them start.
#
# Day to day (the `secrets` skill, .agents/skills/secrets, has the whole routine):
#   sops secrets/balaur.yaml              edit (decrypts to $EDITOR, re-encrypts on save)
#   sops secrets/hosts/tablet.yaml        edit the tablet's own (from the pc or the tablet)
#   sops updatekeys secrets/<file>.yaml   after changing recipients in .sops.yaml
{ inputs, ... }:
{
  flake.modules.nixos.secrets =
    {
      config,
      lib,
      pkgs,
      ...
    }:
    {
      imports = [ inputs.sops-nix.nixosModules.sops ];

      options.balaur.secrets.hostFile = lib.mkOption {
        type = lib.types.path;
        readOnly = true;
        default = ../secrets/hosts + "/${config.networking.hostName}.yaml";
        defaultText = lib.literalExpression "secrets/hosts/<hostName>.yaml";
        description = "This machine's own secrets file: only it and the stationary admins can decrypt it (.sops.yaml).";
      };

      config = {
        # The tools from "Day to day" above, on every machine that has secrets, so
        # whichever one you are at can edit them (with the admin key in
        # ~/.config/sops/age/keys.txt) or add a recipient (ssh-to-age).
        environment.systemPackages = with pkgs; [
          sops
          ssh-to-age
          age
        ];

        # This machine decrypts with its own SSH host key. sops-nix converts it to an
        # age identity itself, so there is no separate key file to place or back up.
        sops.age.sshKeyPaths = [ "/etc/ssh/ssh_host_ed25519_key" ];
        # Don't invent a /var/lib/sops-nix/key.txt if the host key is missing: fail
        # loudly instead, so a machine never silently comes up without its secrets.
        sops.age.generateKey = false;

        sops.defaultSopsFile = ../secrets/balaur.yaml;
      };
    };
}
