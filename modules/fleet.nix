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
# Machines reach each other at one address, `address`: the tailnet (MagicDNS) name,
# e.g. `balaur`. Every machine runs Tailscale (the `network` aspect), and Tailscale
# connects directly over the LAN when both are at home, so home and away are one
# route, one browser origin, one login. A machine reaches itself at 127.0.0.1.
# LAN addresses (`lanIp`, mDNS `<name>.local`) are for devices outside the tailnet,
# such as the TV using AdGuard: the fleet accepts them, but never dials them.
{ lib, config, ... }:
let
  inherit (lib) mkOption types;
  fleet = config.fleet;
  # Every host's evaluated config, to read the others' `balaur.services`. Lazy, and
  # services never depend on services.json, so hosts reading each other is no loop.
  nixosConfigs = config.flake.nixosConfigurations;
  # The account the other machines' root logs in as to build here. It needs no key
  # of its own: each machine's root authenticates with that machine's SSH *host*
  # key, which the registry already carries, so nothing secret is added anywhere.
  builderUser = "nixremote";
in
{
  options.fleet = mkOption {
    description = "Every machine in the fleet, by hostname.";
    default = { };
    type = types.attrsOf (types.submodule ({ name, ... }: {
      options = {
        description = mkOption { type = types.str; default = ""; description = "What this machine is for."; };
        address = mkOption {
          type = types.str;
          default = name;
          description = "How the other machines reach it: its tailnet (MagicDNS) name. The only address they dial.";
        };
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
        torrentsPort = mkOption {
          type = types.nullOr types.port;
          default = null;
          description = ''
            qBittorrent's web UI port on this machine, if it runs one (the
            `torrents` aspect). It is what the other machines' `balaur-torrent`
            offers as a download target, so a machine missing from the list here
            is a machine you cannot send a torrent to.
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
    }));
  };

  config.flake.modules.nixos.fleet =
    { config, lib, pkgs, ... }:
    let
      me = config.networking.hostName;
      others = lib.filterAttrs (name: _: name != me) fleet;
      # Who this machine can farm work out to, and whether it takes work itself.
      # A builder only hands work to builders faster than itself: Nix tries remote
      # machines before its own cores, so the fastest machine would otherwise ship
      # its builds off to a slower one.
      myEntry = fleet.${me} or null;
      iAmABuilder = myEntry != null && myEntry.builder != null;
      mySpeed = if iAmABuilder then myEntry.builder.speedFactor else 0;
      builders = lib.filterAttrs
        (_: h: h.builder != null && h.sshHostKey != null && h.builder.speedFactor > mySpeed)
        others;
      # Their root authenticates as their host key, which is what we authorize.
      clientHostKeys = lib.filter (k: k != null) (lib.mapAttrsToList (_: h: h.sshHostKey) others);
      haveBuilders = builders != { };

      # ---- the Balaur app's Home page (gnome/CONTRACT.md) ----
      # This machine's services, with their live systemd state, then the web UIs of
      # the other machines, each under "On <host>", reached at its `address` over
      # the tailnet (which `network` trusts). Their units live on another machine,
      # so the app shows whether the address answers instead, and opens the web
      # page: a local GNOME app (or a web app installed for 127.0.0.1) would open
      # the wrong machine's service.
      cfg = config.balaur;
      localUrl = s: if s.port == null then null else "http://127.0.0.1:${toString s.port}${s.path}";
      # `tablet` installs a GNOME web app for each of these (tablet.nix).
      hasWebApp = s: cfg ? tablet && s.port != null && s.appIcon != null;
      localServices = map (s: {
        inherit (s) name description icon unit group;
        url = localUrl s;
        desktopId = if hasWebApp s then "${s.webAppId}.desktop" else s.desktopId;
        host = null;
      }) cfg.services;
      # Where that machine runs the `web` aspect, its subdomain over HTTPS (web.nix).
      remoteUrl = host: s:
        let theirs = nixosConfigs.${host}.config.balaur; in
        if theirs ? web && s.subdomain != null then "https://${s.subdomain}.${theirs.web.domain}${s.path}"
        else "http://${fleet.${host}.address}:${toString s.port}${s.path}";
      remoteServices = lib.concatLists (lib.mapAttrsToList (host: _:
        map (s: {
          inherit (s) name description icon;
          inherit host;
          group = "On ${host}";
          url = remoteUrl host s;
          unit = "";
          desktopId = null;
        }) (lib.filter (s: s.port != null) nixosConfigs.${host}.config.balaur.services))
        (lib.intersectAttrs nixosConfigs others));
    in
    {
      environment.etc."balaur/services.json".text = builtins.toJSON (localServices ++ remoteServices);

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
        # Only ever the build protocol: no shell, no forwarding, no PTY. (It is a
        # trusted user, so this is about not handing out a shell, not about root.)
        openssh.authorizedKeys.keys = map
          (k: ''restrict,command="${config.nix.package}/bin/nix-daemon --stdio" ${k}'')
          clientHostKeys;
      };
      # It has to be trusted to be handed derivations and give their outputs back.
      nix.settings.trusted-users = lib.mkIf iAmABuilder [ builderUser ];
    };
}
