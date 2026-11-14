# AI: one entryway for every model call in the fleet, local first, remote second.
#
#   http://tablet:4000/v1     OpenAI-compatible, no key needed (tailnet only)
#   https://ai.<domain>       the page: tiers, route, remote model, last requests
#
#   model `balaur`          the page's route; by default the pc's GPU when it can
#                           answer now, else Mistral
#   model `balaur-local`    only the fleet's GPU
#   model `balaur-remote`   only Mistral, even when the GPU is free
#   any other name          straight to Mistral ("mistral-small-latest", ...)
#
# Two aspects:
#
#   ai-gateway   the entryway itself (ai/router.py, stdlib Python), on one machine:
#                the tablet, the always-on one. The local tier is every machine with
#                the `strata` aspect, found in the registry, so a second GPU machine
#                joins by itself. Each is probed every few seconds and skipped when
#                it is off, loading, stopped for a game, or busy answering someone
#                else (Strata answers one at a time), so falling back costs nothing.
#                The page's changes live in /var/lib/private/balaur-ai/settings.json,
#                over the defaults below.
#   ai           the clients, on every machine: finds the gateway in the registry
#                (127.0.0.1 on the gateway itself) and points everything at it: pi,
#                the OS agent (agent.nix), and OPENAI_BASE_URL/OPENAI_API_KEY for CLI
#                agents and SDKs.
#                ANTHROPIC_BASE_URL is deliberately left alone: Claude Code stays on
#                Anthropic.
#
#   curl -s tablet:4000/health | jq        which tiers are up, and why not
#   journalctl -u balaur-ai                 (on the tablet) which tier answered what
{ config, ... }:
let
  nixosConfigs = config.flake.nixosConfigurations;
  fleet = config.fleet;
in
{
  flake.modules.nixos.ai =
    { config, lib, ... }:
    let
      me = config.networking.hostName;
      hostConfig = h: if h == me then config else nixosConfigs.${h}.config;
      gateways = lib.filter (h: (h == me || nixosConfigs ? ${h}) && (hostConfig h).balaur ? ai-gateway) (
        lib.attrNames fleet
      );
      gw = lib.head gateways;
    in
    {
      options.balaur.ai.url = lib.mkOption {
        type = lib.types.str;
        readOnly = true;
        default =
          assert lib.assertMsg (
            gateways != [ ]
          ) "the `ai` aspect needs a machine with `ai-gateway` in the fleet";
          "http://${
            if gw == me then "127.0.0.1" else fleet.${gw}.address
          }:${toString (hostConfig gw).balaur.ai-gateway.port}/v1";
        description = "The fleet's AI entryway, as this machine reaches it (OpenAI-compatible base URL).";
      };

      config.environment.sessionVariables = {
        OPENAI_BASE_URL = config.balaur.ai.url;
        # Not a secret: the entryway takes no key (the tailnet is the boundary),
        # but most clients refuse to start without one.
        OPENAI_API_KEY = "balaur";
        BALAUR_AI_URL = config.balaur.ai.url;
        BALAUR_AI_MODEL = "balaur";
      };
    };

  flake.modules.nixos.ai-gateway =
    {
      config,
      options,
      lib,
      pkgs,
      ...
    }:
    let
      cfg = config.balaur.ai-gateway;
      me = config.networking.hostName;
      useSops = options ? sops;
      keySecret = "assistant-llm-key"; # the fleet's Mistral key (named for the voice assistant it was first for)
      domain = config.balaur.web.domain or null;

      # The fleet's GPU machines. Reading another host's config is lazy and only
      # touches its `balaur.strata`, so hosts reading each other is no loop.
      hostConfig = h: if h == me then config else nixosConfigs.${h}.config;
      gpuHosts = lib.filter (h: (h == me || nixosConfigs ? ${h}) && (hostConfig h).balaur ? strata) (
        lib.attrNames fleet
      );
      local = map (h: {
        name = h;
        url = "http://${
          if h == me then "127.0.0.1" else fleet.${h}.address
        }:${toString (hostConfig h).balaur.strata.port}/v1";
        model = "strata"; # Strata serves whatever model it loaded, under any name
      }) gpuHosts;

      routerConfig = pkgs.writeText "balaur-ai.json" (
        builtins.toJSON {
          name = "balaur";
          listen = "0.0.0.0"; # loopback and the tailnet; the firewall keeps it off the LAN
          inherit (cfg) port;
          inherit local;
          remote = {
            url = cfg.remote.baseUrl;
            model = cfg.remote.model;
            keyCredential = "remote-key";
          };
          # The names its page is opened under (a browser's Origin), so another
          # site's page cannot use it through a browser on the tailnet.
          origins = [
            me
            fleet.${me}.address
          ]
          ++ lib.optional (domain != null) "ai.${domain}";
          # Long enough for a big prompt's prefill on a 12-16 GB card, which runs
          # at a couple of hundred tokens a second.
          readTimeout = 600;
        }
      );
    in
    {
      options.balaur.ai-gateway = {
        port = lib.mkOption {
          type = lib.types.port;
          default = 4000;
          description = "The entryway's port, on loopback and the tailnet.";
        };
        remote = {
          baseUrl = lib.mkOption {
            type = lib.types.str;
            default = "https://api.mistral.ai/v1"; # EU (Paris)
            description = "The remote tier: an OpenAI-compatible API (requests are trimmed to what Mistral accepts).";
          };
          model = lib.mkOption {
            type = lib.types.str;
            default = "mistral-medium-latest";
            description = "The default remote model behind `balaur` and `balaur-remote` (the page can change it). It must support tool calling.";
          };
          apiKeyFile = lib.mkOption {
            type = lib.types.path;
            default =
              if useSops then config.sops.secrets.${keySecret}.path else "/var/lib/secrets/balaur-ai-key";
            defaultText = lib.literalMD "the `assistant-llm-key` sops secret with the `secrets` aspect, else `/var/lib/secrets/balaur-ai-key`, put there by hand";
            description = "File with the remote API key. Read by systemd (LoadCredential), so its owner does not matter.";
          };
        };
      };

      config = lib.mkMerge [
        {
          systemd.services.balaur-ai = {
            description = "Balaur AI entryway: local GPU first, Mistral second (:${toString cfg.port})";
            wantedBy = [ "multi-user.target" ];
            wants = [ "network-online.target" ];
            after = [
              "network-online.target"
              "tailscaled.service"
            ];
            serviceConfig = {
              ExecStart = "${pkgs.python3}/bin/python3 -I ${./ai/router.py} ${routerConfig}";
              LoadCredential = [ "remote-key:${toString cfg.remote.apiKeyFile}" ];
              StateDirectory = "balaur-ai"; # the page's settings
              Restart = "always";
              RestartSec = 2;
              DynamicUser = true;
              CPUWeight = 1000;
              MemoryMax = "256M";
              CapabilityBoundingSet = "";
              NoNewPrivileges = true;
              PrivateTmp = true;
              PrivateDevices = true;
              ProtectHome = true;
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
              name = "AI";
              description = "Local GPU first, Mistral second";
              icon = "✨";
              port = cfg.port;
              subdomain = "ai";
              unit = "balaur-ai.service";
              group = "System";
            }
          ];
        }
        # The key from the repo; systemd reads it (LoadCredential), so it stays root's.
        (lib.optionalAttrs useSops { sops.secrets.${keySecret} = { }; })
      ];
    };
}
