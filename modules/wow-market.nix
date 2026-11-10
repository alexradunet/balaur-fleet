# WoW Market: World of Warcraft: Forever's auction house, read from Auctionator's
# scans, on a machine that plays it (the `gaming` aspect).
#
# Auctionator (installed in the game) keeps the lowest buyout and the number listed
# of every item it saw in its last scan, and the game writes that to Auctionator's
# SavedVariables file on /reload or logout. wow-market/market.py watches the file as
# the player (it is in their home, in Battle.net's Wine prefix), keeps each new scan,
# and serves a page at https://wow.<domain>: which crafts of a profession pay over
# selling their materials, listings below vendor price, enchanting essences, and
# items cheaper or dearer than their median over the past scans. GET /api/report is
# the same as JSON, for the OS agent.
#
# Item names, vendor prices and recipes are the installed build's own game tables,
# fetched from wago.tools once per build (Forever changes vendor prices and recipes
# from Classic Era's), so a patch needs nothing here.
#
# It only reads the game's folder: nothing reaches the game, and buying stays a
# click in it (automating the auction house breaks Blizzard's rules).
#
#   journalctl -u wow-market        scans kept, tables fetched
{
  flake.modules.nixos.wow-market =
    {
      config,
      lib,
      pkgs,
      ...
    }:
    let
      cfg = config.balaur.wow-market;
      user = config.balaur.user;
      home = config.users.users.${user}.home;
      python = pkgs.python3.withPackages (p: [ p.cbor2 ]);
      marketConfig = pkgs.writeText "wow-market.json" (
        builtins.toJSON {
          inherit (cfg)
            port
            gameRoot
            profession
            historyDays
            ;
          flavour = "_forever_";
          product = "wowf"; # Forever in Battle.net's .build.info
          pollSeconds = 30;
          minScansForUsual = 3;
        }
      );
    in
    {
      options.balaur.wow-market = {
        port = lib.mkOption {
          type = lib.types.port;
          default = 8790;
          description = "The page's port on this machine (the tailnet only; Caddy serves it as wow.<domain>).";
        };
        gameRoot = lib.mkOption {
          type = lib.types.str;
          # Where the `gaming` aspect's Battle.net installs it, with XDG_DATA_HOME unset.
          default = "${home}/.local/share/battlenet/prefix/drive_c/Program Files (x86)/World of Warcraft";
          description = "The World of Warcraft folder (the one holding .build.info and _forever_).";
        };
        profession = lib.mkOption {
          type = lib.types.str;
          default = "Leatherworking";
          description = "The profession whose crafts the page shows first.";
        };
        historyDays = lib.mkOption {
          type = lib.types.ints.positive;
          default = 14;
          description = "How many days of scans make an item's usual price.";
        };
      };

      config = {
        systemd.services.wow-market = {
          description = "WoW Market: the auction house from Auctionator's scans (:${toString cfg.port})";
          wantedBy = [ "multi-user.target" ];
          wants = [ "network-online.target" ];
          after = [ "network-online.target" ];
          serviceConfig = {
            ExecStart = "${lib.getExe python} -I ${./wow-market/market.py} ${marketConfig}";
            # The player: the saved file is in their home, readable by them only.
            User = user;
            StateDirectory = "wow-market"; # the scans, and the game tables per build
            Restart = "always";
            RestartSec = 5;
            # A background page: never in a game's way.
            Nice = 10;
            CPUWeight = 20;
            IOSchedulingClass = "idle";
            MemoryMax = "512M";
            CapabilityBoundingSet = "";
            NoNewPrivileges = true;
            PrivateTmp = true;
            PrivateDevices = true;
            ProtectHome = "read-only";
            ProtectSystem = "strict";
            ProtectKernelTunables = true;
            ProtectKernelModules = true;
            ProtectControlGroups = true;
            RestrictAddressFamilies = [
              "AF_INET"
              "AF_INET6"
              "AF_UNIX"
            ];
            RestrictNamespaces = true;
            LockPersonality = true;
            SystemCallArchitectures = "native";
          };
        };

        balaur.services = [
          {
            name = "WoW Market";
            description = "What to craft, buy and sell in WoW: Forever, from Auctionator's scans";
            icon = "💰";
            port = cfg.port;
            subdomain = "wow";
            unit = "wow-market.service";
            group = "Games";
          }
        ];
      };
    };
}
