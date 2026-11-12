---
name: add-aspect
description: Add a feature or service to the Balaur fleet as a new aspect (a file under modules/) - its balaur.* options, its entry on the home page, its web UI behind the domain, its firewall, and how it reads other aspects. Use when adding or restructuring a feature, service, program or hardware support in this flake.
---

# Add an aspect

An aspect is one file, `modules/<name>.nix`, named after the feature, not a machine.
import-tree loads it; a host turns it on by listing it. Read two existing aspects of
the same kind first: a service (`media.nix`, `home-assistant.nix`), a program
(`gaming.nix`), a client/server pair (`torrents.nix`, `game-streaming.nix`), hardware
(`modules/hardware/*.nix`).

## The file

```nix
# <What it is, in a sentence or two: what it runs, where, and why this way.>
{
  flake.modules.nixos.<name> =
    { config, lib, pkgs, ... }:
    let
      cfg = config.balaur.<name>;
    in
    {
      options.balaur.<name> = {
        port = lib.mkOption {
          type = lib.types.port;
          default = 1234;
          description = "...";
        };
      };

      config = {
        # ...
      };
    };
}
```

- **No `enable` option.** Being listed by a host is what turns it on.
- **Options under `balaur.<name>`**, typed, each with a description. Defaults that
  suit every machine; a host overrides in its file.
- **Fleet-level data** (the registry, other hosts' configs) comes from the outer
  function: `{ config, ... }: let fleet = config.fleet; nixosConfigs =
  config.flake.nixosConfigurations; in { ... }` — see `ai.nix`, `adblock.nix`.
- **Another aspect's options are optional.** `cfg.web.domain or null`, `config.balaur ?
  tablet`, `options ? sops`. Never import another aspect; never assume it is there.
- **Two sides of a feature** (a server on one machine, a client on others) are two
  aspects in one file: `torrents` and `torrents-client`.
- **Packages of our own** go in `pkgs/<name>.nix` and the overlay in
  `modules/flake/packages.nix`; the aspect uses `pkgs.<name>`.
- **Scripts:** `pkgs.writeShellApplication { name; runtimeInputs; text; }`, run by units
  with `lib.getExe`. Not `writeShellScript`, not `"${pkgs.x}/bin/x"` paths in text.
- **Services:** prefer the NixOS module. For our own units, `DynamicUser` or a system
  user, `StateDirectory`, `LoadCredential` for secrets, and the hardening the service
  tolerates (`ai.nix` and `strata.nix` are examples); check with
  `systemd-analyze security <unit>` on the machine.
- **Secrets** come from sops (skill `secrets`), never from the store.
- **Comments** explain why, in full sentences, like the rest of the repository.

## A service with a web UI

```nix
balaur.services = [{
  name = "Thing";
  description = "What it is for";
  icon = "🧩";              # an emoji, an icon name or a file
  port = cfg.port;          # on this machine
  subdomain = "thing";      # https://thing.<domain> through Caddy, where `web` is
  audience = "owner";       # the default; "household" also serves the people the machine is shared with
  unit = "thing.service";   # `user:<unit>` for a unit of the desktop session
  group = "Home";           # the Home page's section
  appIcon = null;           # an icon here installs it as a GNOME web app on the tablet
}];
```

That puts it on the Balaur app's Home page, the web home page, the OS agents'
instructions, and, with `subdomain`, behind `https://<subdomain>.balaur.space`.

**Firewall:** the tailnet (`tailscale0`) is trusted already. Open a port on the LAN
(`networking.firewall.allowedTCPPorts`) only if a device outside the tailnet needs it,
and say why in a comment. The services here have no logins: nothing is ever exposed
to the internet.

## Turn it on

Add the name to the host's list in `modules/hosts/<host>.nix`, with a comment when the
reason is not obvious. Add a line to README.md's layout. Then skills `check-change`
and `deploy`.
