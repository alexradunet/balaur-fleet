# Graph: this machine's configuration as a live diagram, at https://graph.<domain>.
#
# The page draws (with Mermaid) every aspect the host imports (`balaur.aspects`,
# from the host file), and in each one its systemd units and its `balaur.services`,
# with the web front's subdomains as arrows from Caddy. Which aspect a unit belongs
# to is read from the module system: the file and aspect of each definition of
# `systemd.services`, `.timers`, `.sockets` and `balaur.services`. So a new aspect
# or unit is on the page after the next deploy, with nothing to add here.
#
# The live part is a small read-only server (graph/server.py): every 15 seconds the
# page asks it for /state.json, which is one `systemctl show` of those units and
# `balaur-deploy-state` (auto-deploy.nix: the deployed commit, the system state, the
# failed units, a reboot waiting), with load, memory and uptime. It listens on a
# Unix socket only Caddy can open, as Money and Life do, and systemd starts it on the
# first request: no CPU while nobody looks.
#
# With `web` (it is proxied as a `socket` service); without it the page has no
# address.
{ config, ... }:
let
  fleet = config.fleet;
in
{
  flake.modules.nixos.graph =
    {
      config,
      options,
      lib,
      pkgs,
      ...
    }:
    let
      me = config.networking.hostName;
      domain = config.balaur.web.domain or null;
      sock = "/run/balaur-graph.sock";

      # "…/modules/money.nix, via option flake.modules.nixos.money" -> "money"
      aspectOf =
        file:
        let
          m = builtins.match ".*via option flake\\.modules\\.nixos\\.([A-Za-z0-9_-]+).*" file;
        in
        if m == null then null else lib.head m;

      # The units each aspect defines itself, as { aspect, unit }. Only the ones the
      # system has (a definition under a false mkIf still names its unit), and no
      # templates (`notify@`): they are no unit until an instance runs.
      unitsFrom =
        opt: have: suffix:
        lib.concatMap (
          d:
          let
            a = aspectOf d.file;
          in
          lib.optionals (a != null) (
            map (n: {
              aspect = a;
              unit = n + suffix;
            }) (lib.filter (n: have ? ${n} && !lib.hasSuffix "@" n) (lib.attrNames d.value))
          )
        ) opt.definitionsWithLocations;
      ownUnits =
        unitsFrom options.systemd.services config.systemd.services ".service"
        ++ unitsFrom options.systemd.timers config.systemd.timers ".timer"
        ++ unitsFrom options.systemd.sockets config.systemd.sockets ".socket";

      # Each `balaur.services` entry with its aspect, by name.
      serviceAspect = lib.listToAttrs (
        lib.concatMap (
          d:
          let
            a = aspectOf d.file;
          in
          lib.optionals (a != null) (map (s: lib.nameValuePair s.name a) d.value)
        ) options.balaur.services.definitionsWithLocations
      );

      # A timer's or a socket's service: shown in the same node.
      companion =
        u:
        let
          base = lib.removeSuffix ".timer" (lib.removeSuffix ".socket" u);
        in
        lib.optional (base != u && config.systemd.services ? ${base}) "${base}.service";

      # A service started by its socket (Fava, Life): the socket is the same node.
      socketOf =
        u:
        let
          base = lib.removeSuffix ".service" u;
        in
        lib.optional (base != u && config.systemd.sockets ? ${base}) "${base}.socket";

      url =
        s:
        if s.subdomain != null && domain != null then
          "https://${s.subdomain}.${domain}${s.path}"
        else if s.port != null then
          "${s.scheme}://${fleet.${me}.address or me}:${toString s.port}${s.path}"
        else
          null;

      # A `balaur.services` entry is a node in its aspect, with its unit (and the
      # service of its timer or socket).
      serviceNodesOf =
        a:
        map (s: {
          inherit (s)
            name
            icon
            port
            subdomain
            ;
          units = lib.optionals (s.unit != "") ([ s.unit ] ++ companion s.unit ++ socketOf s.unit);
          url = url s;
          front = s.unit == "caddy.service";
        }) (lib.filter (s: serviceAspect.${s.name} or null == a) config.balaur.services);

      # One node per unit, a timer or a socket together with its service.
      unitNodes =
        us:
        let
          triggered = lib.concatMap companion us;
        in
        map (u: {
          units = [ u ] ++ lib.filter (c: lib.elem c us) (companion u);
        }) (lib.filter (u: !lib.elem u triggered) us);

      # The host's own aspects in its order, then any other definer (the host file).
      names = lib.unique (
        config.balaur.aspects
        ++ map (x: x.aspect) ownUnits
        ++ lib.filter (a: a != null) (lib.attrValues serviceAspect)
      );
      allUnits = lib.unique (map (x: x.unit) ownUnits);
      inServices = lib.concatMap (a: lib.concatMap (n: n.units) (serviceNodesOf a)) names;
      definers = u: lib.unique (map (x: x.aspect) (lib.filter (x: x.unit == u) ownUnits));
      # A unit is drawn once: in the aspect of its `balaur.services` entry, or in the
      # one aspect that defines it. Set by more than one and in no entry (an aspect
      # adding to another's unit, as forgejo does to the backup), it stands on its
      # own, and every aspect that sets it points at it.
      soleUnitsOf =
        a:
        lib.filter (u: !lib.elem u inServices && definers u == [ a ]) (
          lib.unique (map (x: x.unit) (lib.filter (x: x.aspect == a) ownUnits))
        );
      sharedUnits = lib.filter (u: !lib.elem u inServices && lib.length (definers u) > 1) allUnits;

      numbered =
        prefix: owner: xs:
        lib.imap0 (
          i: x:
          x
          // {
            id = "${prefix}${toString i}";
            aspect = owner;
          }
        ) xs;
      aspectId = lib.listToAttrs (lib.imap0 (i: a: lib.nameValuePair a "a${toString i}") names);
      aspects = map (a: {
        id = aspectId.${a};
        name = a;
        nodes = numbered "${aspectId.${a}}n" aspectId.${a} (serviceNodesOf a ++ unitNodes (soleUnitsOf a));
      }) names;
      shared = numbered "s" null (unitNodes sharedUnits);

      # An aspect that sets a unit drawn elsewhere: a dashed arrow to it.
      allNodes = lib.concatMap (a: a.nodes) aspects ++ shared;
      nodeOf = u: lib.findFirst (n: lib.elem u n.units) null allNodes;
      links = lib.unique (
        lib.concatMap (
          x:
          let
            n = nodeOf x.unit;
            from = aspectId.${x.aspect};
          in
          lib.optional (n != null && n.aspect != from) {
            inherit from;
            to = n.id;
          }
        ) ownUnits
      );

      graphJson = pkgs.writeText "graph.json" (
        builtins.toJSON {
          host = me;
          description = fleet.${me}.description or "";
          inherit
            domain
            aspects
            shared
            links
            ;
          repo = config.balaur.autoDeploy.repo or null;
        }
      );

      mermaid =
        let
          version = "11.4.1";
          tarball = pkgs.fetchurl {
            url = "https://registry.npmjs.org/mermaid/-/mermaid-${version}.tgz";
            hash = "sha256-7Hths5Gqokv2Zv0g5I0KYm7rSpW5W8azAWoSLX8Lwq8=";
          };
        in
        pkgs.runCommand "mermaid-${version}.min.js" { } ''
          tar -xzf ${tarball} package/dist/mermaid.min.js -O > $out
        '';

      site = pkgs.runCommand "balaur-graph-site" { } ''
        mkdir $out
        cp ${./graph/index.html} $out/index.html
        cp ${graphJson} $out/graph.json
        cp ${mermaid} $out/mermaid.min.js
        cp ${./web/icon.svg} $out/icon.svg
      '';
    in
    {
      config = lib.mkIf (config.balaur ? web) {
        systemd.sockets.balaur-graph = {
          description = "The graph page's socket (Caddy's only)";
          wantedBy = [ "sockets.target" ];
          listenStreams = [ sock ];
          socketConfig = {
            SocketGroup = config.services.caddy.group;
            SocketMode = "0660";
          };
        };
        systemd.services.balaur-graph = {
          description = "The graph page: this machine's aspects and units, live";
          requires = [ "balaur-graph.socket" ];
          serviceConfig = {
            ExecStart = lib.escapeShellArgs [
              "${pkgs.python3}/bin/python3"
              "-I"
              "${./graph/server.py}"
              "--site"
              site
              "--graph"
              "${site}/graph.json"
              "--systemctl"
              "${config.systemd.package}/bin/systemctl"
              "--deploy-state"
              "/run/current-system/sw/bin/balaur-deploy-state"
            ];
            DynamicUser = true;
            Restart = "on-failure";
            ProtectSystem = "strict";
            ProtectHome = true;
            PrivateTmp = true;
            PrivateDevices = true;
            PrivateNetwork = true;
            # systemctl speaks D-Bus, a Unix socket.
            RestrictAddressFamilies = [ "AF_UNIX" ];
            NoNewPrivileges = true;
            ProtectKernelTunables = true;
            ProtectKernelModules = true;
            ProtectControlGroups = true;
            RestrictSUIDSGID = true;
            RestrictNamespaces = true;
            LockPersonality = true;
            CapabilityBoundingSet = "";
          };
        };

        balaur.services = [
          {
            name = "Graph";
            description = "This machine's aspects and units, live";
            icon = "🕸️";
            socket = sock;
            subdomain = "graph";
            unit = "balaur-graph.socket";
            group = "System";
          }
        ];
      };
    };
}
