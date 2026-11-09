# AI: one inference endpoint on every machine, local first, remote second.
#
#   http://127.0.0.1:4000/v1    OpenAI-compatible, no key needed (loopback only)
#
#   model `balaur`          the fleet's own GPU when it can answer now, else Mistral
#   model `balaur-local`    only the fleet's GPU
#   model `balaur-remote`   only Mistral, even when the GPU is free
#   any other name          straight to Mistral ("mistral-small-latest", ...)
#
# The local tier is every fleet machine with the `strata` aspect (zmeu, with the
# RTX 5060 Ti), found in the registry the way the web page finds services, so a
# second GPU machine joins by itself. The router (ai/router.py, stdlib Python)
# probes each one every few seconds and skips one that is off, loading, stopped
# for a game, or busy answering someone else (Strata answers one at a time), so
# falling back costs nothing. A machine reaches its own Strata at 127.0.0.1.
#
# Everything on the machine is pointed here: the voice assistant's default model
# (assistant.nix), OPENAI_BASE_URL/OPENAI_API_KEY for CLI agents and SDKs, and
# aminte's agent on balaur (a runtime setting, see aminte.nix). Speech (Voxtral)
# and web search stay on Mistral directly: Strata does neither.
#
#   curl -s 127.0.0.1:4000/health | jq         which tiers are up, and why not
#   journalctl -u balaur-ai                    which tier answered each request
{ config, ... }:
let
  nixosConfigs = config.flake.nixosConfigurations;
  fleet = config.fleet;
in
{
  flake.modules.nixos.ai =
    { config, options, lib, pkgs, ... }:
    let
      cfg = config.balaur.ai;
      me = config.networking.hostName;
      useSops = options ? sops;
      keySecret = "assistant-llm-key"; # the fleet's Mistral key, shared with the assistant

      # The fleet's GPU machines, in name order. Reading another host's config is
      # lazy and only touches its `balaur.strata`, so hosts reading each other is no loop.
      hostConfig = h: if h == me then config else nixosConfigs.${h}.config;
      gpuHosts = lib.filter (h: (h == me || nixosConfigs ? ${h}) && (hostConfig h).balaur ? strata) (lib.attrNames fleet);
      local = map (h: {
        name = h;
        url = "http://${if h == me then "127.0.0.1" else fleet.${h}.address}:${toString (hostConfig h).balaur.strata.port}/v1";
        model = "strata"; # Strata serves whatever model it loaded, under any name
      }) gpuHosts;

      routerConfig = pkgs.writeText "balaur-ai.json" (builtins.toJSON {
        name = "balaur";
        listen = "127.0.0.1";
        inherit (cfg) port;
        inherit local;
        remote = { url = cfg.remote.baseUrl; model = cfg.remote.model; keyCredential = "remote-key"; };
        # Long enough for a big prompt's prefill on a 12-16 GB card, which runs
        # at a couple of hundred tokens a second.
        readTimeout = 600;
      });
    in
    {
      options.balaur.ai = {
        port = lib.mkOption {
          type = lib.types.port;
          default = 4000;
          description = "The router's port on 127.0.0.1.";
        };
        url = lib.mkOption {
          type = lib.types.str;
          readOnly = true;
          default = "http://127.0.0.1:${toString cfg.port}/v1";
          description = "The OpenAI-compatible base URL every program on this machine uses.";
        };
        remote = {
          baseUrl = lib.mkOption {
            type = lib.types.str;
            default = "https://api.mistral.ai/v1"; # EU (Paris)
            description = "The remote tier: an OpenAI-compatible API (the router trims requests to what Mistral accepts).";
          };
          model = lib.mkOption {
            type = lib.types.str;
            default = "mistral-medium-latest";
            description = "The remote model behind `balaur` and `balaur-remote`. It must support tool calling.";
          };
          apiKeyFile = lib.mkOption {
            type = lib.types.path;
            default = if useSops then config.sops.secrets.${keySecret}.path else "/var/lib/secrets/balaur-assistant-llm-key";
            defaultText = lib.literalMD "the `assistant-llm-key` sops secret with the `secrets` aspect, else the assistant's own key file";
            description = "File with the remote API key. Read by systemd (LoadCredential), so its owner does not matter.";
          };
        };
      };

      config = lib.mkMerge [
        {
          systemd.services.balaur-ai = {
            description = "Balaur AI router: local GPU first, Mistral second (127.0.0.1:${toString cfg.port})";
            wantedBy = [ "multi-user.target" ];
            wants = [ "network-online.target" ];
            after = [ "network-online.target" "tailscaled.service" ];
            serviceConfig = {
              ExecStart = "${pkgs.python3}/bin/python3 -I ${./ai/router.py} ${routerConfig}";
              LoadCredential = [ "remote-key:${toString cfg.remote.apiKeyFile}" ];
              Restart = "always";
              RestartSec = 2;
              DynamicUser = true;
              # It sits between the voice assistant and its answer.
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
              RestrictAddressFamilies = [ "AF_INET" "AF_INET6" "AF_UNIX" ];
              RestrictNamespaces = true;
              LockPersonality = true;
              SystemCallArchitectures = "native";
            };
          };

          # For CLI agents and SDKs that read the OpenAI variables. The key is not a
          # secret: the router takes none (it only listens on loopback), but most
          # clients refuse to start without one. ANTHROPIC_BASE_URL is deliberately
          # not set: Claude Code stays on Anthropic.
          environment.sessionVariables = {
            OPENAI_BASE_URL = cfg.url;
            OPENAI_API_KEY = "balaur";
            BALAUR_AI_URL = cfg.url;
            BALAUR_AI_MODEL = "balaur";
          };
        }
        # Declared here too so the router works without the assistant; sops-nix
        # merges this with the assistant's own declaration of the same secret.
        (lib.optionalAttrs useSops { sops.secrets.${keySecret} = { }; })
      ];
    };
}
