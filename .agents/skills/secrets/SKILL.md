---
name: secrets
description: Add, change, rotate or move a secret of the Balaur fleet with sops-nix, choose the shared or the per-machine file, give a new machine its recipients, and push in the right order. Use for anything involving a password, token, API key or credential in this repository.
---

# Secrets

`modules/secrets.nix` explains the arrangement. The repository is public: only sops
ciphertext is committed, never a plain value, not in a commit message, a comment, a
log line or a test. Never print a secret's value in your output either; show its key
and length instead.

## Which file

| File | Who can decrypt | For |
|---|---|---|
| `secrets/balaur.yaml` | every machine, every admin key | only what more than one machine needs |
| `secrets/hosts/<host>.yaml` | that machine, the admin keys of zmeu and balaur | everything one machine needs |

The laptop's admin key is deliberately not a recipient of the host files (it travels,
unencrypted), so edit those from zmeu or balaur. Recipients are in `.sops.yaml`;
machine recipients are their SSH host keys through `ssh-to-age`.

## Use a secret

```nix
sops.secrets."<name>" = {
  sopsFile = config.balaur.secrets.hostFile;   # omit for the shared file
  owner = "<user that reads it>";              # default root
};
# a path for the service: config.sops.secrets."<name>".path   (/run/secrets/<name>)
# several values as one file: sops.templates (see modules/hosts/balaur.nix)
```

Prefer `LoadCredential` in our own units, so the file's owner does not matter. An
aspect that works without sops checks `options ? sops` (`assistant.nix`).

## Add or change a value

```sh
# one value, through stdin so it never shows in the process list:
printf '%s' "$value" | jq -Rs . | sops set --value-stdin secrets/hosts/<host>.yaml '["<name>"]'
sops unset secrets/hosts/<host>.yaml '["<name>"]'     # remove one
sops secrets/hosts/<host>.yaml                        # or edit in $EDITOR
# what is in a file, without the values:
sops decrypt --output-type json <file> | jq -r 'to_entries[] | "\(.key): \(.value|length) chars"'
```

Ask the user for a value rather than inventing one, except a random password nobody
types (`head -c 24 /dev/urandom | base64`), and tell them where it is.

## Order of pushing

A secret and the configuration that reads it go in the same push, or the secret
first: a machine that switches to a config naming a secret its file does not have
fails its activation. Check with `nix flake check --no-build` and a build of the hosts
that read it (sops-nix validates the file at build time).

## Rotate

The old ciphertext stays in public git history, so a value that was ever encrypted to
a key that leaked, or that moved to a file with fewer recipients, is only protected
once it is rotated at its source (the provider's site) and the new value stored.

## A new machine

1. `ssh-to-age <<< "$(cat /etc/ssh/ssh_host_ed25519_key.pub)"` on it; add the result to
   `.sops.yaml` under `keys`, and to the rules of the files it needs (the shared one,
   and its own `secrets/hosts/<host>.yaml` with a rule like the others').
2. `sops updatekeys -y secrets/balaur.yaml` (and each other file whose rule changed) on
   a machine with an admin key in `~/.config/sops/age/keys.txt`.
3. An admin key for the user on that machine: `ssh-to-age -private-key -i
   ~/.ssh/id_ed25519 -o ~/.config/sops/age/keys.txt`, its public half
   (`ssh-to-age < ~/.ssh/id_ed25519.pub`) in `.sops.yaml` as `admin_<host>`, then
   `updatekeys` again.
4. Push, then give the host the `secrets` aspect.
