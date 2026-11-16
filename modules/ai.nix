# AI: one entryway for every model call in the fleet, local first, remote second.
#
#   http://server:4000/v1     OpenAI-compatible, no key needed (tailnet only)
#   https://ai.<domain>       the page: tiers, route, remote model, last requests
#
#   model `balaur`          the page's route; by default the local model when it can
#                           answer now, else the remote API the page chose
#   model `balaur-local`    only the fleet's GPU
#   model `balaur-remote`   only that remote API, even when the GPU is free
#   model `balaur-mistral`, `balaur-claude`
#                           one remote API by name, with the model the page chose for it
#   `claude/<model>`, `mistral/<model>`
#                           one remote API with that model
#   any other name          to Claude when it starts with `claude-`, else straight to
#                           Mistral ("mistral-small-latest", ...)
#
# The remote APIs (`balaur.ai-gateway.remotes`): Mistral (EU, the default) and
# Claude, through the Claude API's OpenAI compatibility layer. Each has its key in
# sops; one without a key is listed on the page and answers nothing.
#
# Two aspects:
#
#   ai-gateway   the entryway itself (ai/router.py, stdlib Python), on one machine:
#                the server, the always-on one. The local tier is every machine with
#                `local-llm` or `strata`, found in the registry, so a second GPU machine
#                joins by itself. Each is probed every few seconds and skipped when
#                it is off, loading, stopped for a game, or busy answering someone
#                else (Strata answers one at a time), so falling back costs nothing.
#                The page's changes live in /var/lib/private/balaur-ai/settings.json,
#                over the defaults below.
#   ai           the clients, on every machine: finds the gateway in the registry
#                (127.0.0.1 on the gateway itself) and points everything at it: pi,
#                the Balaur agent (agent.nix), and OPENAI_BASE_URL/OPENAI_API_KEY for CLI
#                agents and SDKs.
#                ANTHROPIC_BASE_URL is deliberately left alone: Claude Code stays on
#                Anthropic.
#
#   curl -s server:4000/health | jq        which tiers are up, and why not
#   journalctl -u balaur-ai                 (on the server) which tier answered what
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
      options.balaur.ai.remotes = lib.mkOption {
        type = lib.types.listOf (lib.types.attrsOf lib.types.str);
        readOnly = true;
        default = map (r: { inherit (r) name label; }) (hostConfig gw).balaur.ai-gateway.remotes;
        description = "The entryway's remote APIs: each is also the model `balaur-<name>`.";
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
      # Where a remote API's key comes from: its `apiKeyFile`, else its sops secret,
      # else a file put there by hand.
      keyFile =
        r:
        if r.apiKeyFile != null then
          toString r.apiKeyFile
        else if useSops then
          config.sops.secrets.${r.keySecret}.path
        else
          "/var/lib/secrets/balaur-ai-key-${r.name}";
      domain = config.balaur.web.domain or null;

      # The fleet's local models: every machine with `local-llm` (llama.cpp on an
      # iGPU) or `strata` (a discrete card). Reading another host's config is lazy
      # and only touches its `balaur.local-llm`/`balaur.strata`, so hosts reading
      # each other is no loop.
      hostConfig = h: if h == me then config else nixosConfigs.${h}.config;
      localPort =
        h:
        let
          b = (hostConfig h).balaur;
        in
        if b ? local-llm then b.local-llm.port else b.strata.port;
      gpuHosts = lib.filter (
        h:
        (h == me || nixosConfigs ? ${h})
        && ((hostConfig h).balaur ? local-llm || (hostConfig h).balaur ? strata)
      ) (lib.attrNames fleet);
      local = map (h: {
        name = h;
        url = "http://${if h == me then "127.0.0.1" else fleet.${h}.address}:${toString (localPort h)}/v1";
        # Both serve whatever model they loaded under the name asked for.
        model = "local";
      }) gpuHosts;

      routerConfig = pkgs.writeText "balaur-ai.json" (
        builtins.toJSON {
          name = "balaur";
          listen = "0.0.0.0"; # loopback and the tailnet; the firewall keeps it off the LAN
          inherit (cfg) port;
          inherit local;
          remotes = map (r: {
            inherit (r)
              name
              label
              model
              dialect
              prefixes
              ;
            url = r.baseUrl;
            keyCredential = "key-${r.name}";
          }) cfg.remotes;
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
        remotes = lib.mkOption {
          description = ''
            The remote tier: OpenAI-compatible APIs, each with its key. The first is
            the default one: what `balaur` and `balaur-remote` use until the page says
            otherwise, and where a model name no other one claims goes.
          '';
          default = [
            {
              name = "mistral";
              label = "Mistral";
              baseUrl = "https://api.mistral.ai/v1"; # EU (Paris)
              model = "mistral-medium-latest";
              dialect = "mistral";
              # The fleet's Mistral key, in the shared file (named for the voice
              # assistant it was first for).
              keySecret = "assistant-llm-key";
            }
            {
              name = "claude";
              label = "Claude";
              # The Claude API's OpenAI compatibility layer (US).
              baseUrl = "https://api.anthropic.com/v1";
              model = "claude-opus-5-5";
              dialect = "claude";
              prefixes = [ "claude-" ];
              keySecret = "anthropic-api-key";
              keyInHostFile = true;
            }
          ];
          type = lib.types.listOf (
            lib.types.submodule {
              options = {
                name = lib.mkOption {
                  type = lib.types.strMatching "[a-z][a-z0-9]*";
                  description = "Its name: the model `balaur-<name>`, and `<name>/<model>`.";
                };
                label = lib.mkOption {
                  type = lib.types.str;
                  description = "Its name on the page.";
                };
                baseUrl = lib.mkOption {
                  type = lib.types.str;
                  description = "Its OpenAI-compatible base URL.";
                };
                model = lib.mkOption {
                  type = lib.types.str;
                  description = "Its default model (the page can change it). It must support tool calling.";
                };
                dialect = lib.mkOption {
                  type = lib.types.enum [
                    "mistral"
                    "claude"
                    "openai"
                  ];
                  default = "openai";
                  description = "How a request is trimmed on the way there (ai/router.py); `openai` leaves it as it is.";
                };
                prefixes = lib.mkOption {
                  type = lib.types.listOf lib.types.str;
                  default = [ ];
                  description = "Model names that start this way go here, when asked for by their plain name.";
                };
                keySecret = lib.mkOption {
                  type = lib.types.str;
                  description = "The sops secret with its API key, on a machine with the `secrets` aspect.";
                };
                keyInHostFile = lib.mkOption {
                  type = lib.types.bool;
                  default = false;
                  description = "The secret is in this machine's own sops file, not the shared one.";
                };
                apiKeyFile = lib.mkOption {
                  type = lib.types.nullOr lib.types.path;
                  default = null;
                  description = "A file with its API key, in place of the sops secret (without sops: `/var/lib/secrets/balaur-ai-key-<name>`, put there by hand). Read by systemd (LoadCredential), so its owner does not matter.";
                };
              };
            }
          );
        };
      };

      config = lib.mkMerge [
        {
          systemd.services.balaur-ai = {
            description = "Balaur AI entryway: local GPU first, a remote API second (:${toString cfg.port})";
            wantedBy = [ "multi-user.target" ];
            wants = [ "network-online.target" ];
            after = [
              "network-online.target"
              "tailscaled.service"
            ];
            serviceConfig = {
              ExecStart = "${pkgs.python3}/bin/python3 -I ${./ai/router.py} ${routerConfig}";
              LoadCredential = map (r: "key-${r.name}:${keyFile r}") cfg.remotes;
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
              description = "Local GPU first, then Mistral or Claude";
              icon = "✨";
              port = cfg.port;
              subdomain = "ai";
              unit = "balaur-ai.service";
              group = "System";
            }
          ];
        }
        # The keys from the repo; systemd reads them (LoadCredential), so they stay root's.
        (lib.optionalAttrs useSops {
          sops.secrets = lib.listToAttrs (
            map (
              r:
              lib.nameValuePair r.keySecret (
                lib.optionalAttrs r.keyInHostFile { sopsFile = config.balaur.secrets.hostFile; }
              )
            ) (lib.filter (r: r.apiKeyFile == null) cfg.remotes)
          );
          # systemd copies a credential when the unit starts: a changed key reaches the
          # router only through a restart, so the unit follows the files the keys are in.
          systemd.services.balaur-ai.restartTriggers = lib.unique (
            map (r: config.sops.secrets.${r.keySecret}.sopsFile) (
              lib.filter (r: r.apiKeyFile == null) cfg.remotes
            )
          );
        })
      ];
    };
}
