# Secrets: committed encrypted, decrypted at activation into /run/secrets.
#
# How it fits together:
#
#   secrets/balaur.yaml   the ciphertext, in the repo. YAML with the keys in
#                         plaintext and the values encrypted, so diffs stay
#                         readable and two people can edit different secrets.
#   .sops.yaml            which recipients encrypt which files.
#   this aspect           hands sops-nix each machine's decryption key and the
#                         default file; the host files declare which secrets they
#                         actually want and wire them to the aspect that reads them.
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
# Day to day:
#   sops secrets/balaur.yaml              edit (decrypts to $EDITOR, re-encrypts on save)
#   sops updatekeys secrets/balaur.yaml   after changing recipients in .sops.yaml
{ inputs, ... }:
{
  flake.modules.nixos.secrets = { pkgs, ... }: {
    imports = [ inputs.sops-nix.nixosModules.sops ];

    # The tools from "Day to day" above, on every machine that has secrets, so
    # whichever one you are at can edit them (with the admin key in
    # ~/.config/sops/age/keys.txt) or add a recipient (ssh-to-age).
    environment.systemPackages = with pkgs; [ sops ssh-to-age age ];

    # This machine decrypts with its own SSH host key. sops-nix converts it to an
    # age identity itself, so there is no separate key file to place or back up.
    sops.age.sshKeyPaths = [ "/etc/ssh/ssh_host_ed25519_key" ];
    # Don't invent a /var/lib/sops-nix/key.txt if the host key is missing: fail
    # loudly instead, so a machine never silently comes up without its secrets.
    sops.age.generateKey = false;

    sops.defaultSopsFile = ../secrets/balaur.yaml;
  };
}
