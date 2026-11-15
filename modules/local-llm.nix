# A local LLM that never sleeps: llama.cpp's llama-server on the machine's AMD iGPU
# (Vulkan), serving NVIDIA Nemotron 3.5 Lightning 30B-A3B, a mixture-of-experts
# model that reads ~3B of its 30B parameters per token, so the shared LPDDR5X's
# bandwidth is enough for it. OpenAI-compatible /v1 and a chat page on :8090,
# tailnet only: the port is not opened on the LAN, the tailnet is trusted.
#
# It is the fleet's local inference tier: the `ai-gateway` aspect (on the tablet)
# finds it in the registry and sends model `balaur` here first, Mistral second (ai.nix).
#
# The GPU has no memory of its own. It gets the BIOS's UMA carve-out (small: 2 GB)
# plus, through amdgpu's GTT, up to half of the RAM, which the model takes when it
# loads: ~19 GB of weights and a small cache (most of Nemotron-H's layers are Mamba
# layers, which keep no per-token cache).
#
# The model is not in the Nix store (19 GB, and every builder would fetch it): on
# the first boot or deploy, local-llm-fetch downloads it into /var/lib/local-llm,
# checks its hash and starts the server. To change model, change `model` and deploy;
# old files stay until removed by hand.
#
#   journalctl -fu local-llm-fetch      the download
#   journalctl -u local-llm             the model loading, each request's speed
#   curl -s pc:8090/health              {"status":"ok"} once loaded
{
  flake.modules.nixos.local-llm =
    {
      config,
      lib,
      pkgs,
      ...
    }:
    let
      cfg = config.balaur.local-llm;
      state = "/var/lib/local-llm";
      modelPath = "${state}/${cfg.model.file}";

      fetch = pkgs.writeShellApplication {
        name = "local-llm-fetch";
        runtimeInputs = [
          pkgs.curl
          pkgs.coreutils
        ];
        text = ''
          part=${lib.escapeShellArg modelPath}.part
          echo "downloading ${cfg.model.url}"
          # -C -: a download cut off resumes where it stopped on the next try.
          curl --fail --location --silent --show-error --retry 5 -C - \
            -o "$part" ${lib.escapeShellArg cfg.model.url}
          echo "${cfg.model.sha256}  $part" | sha256sum --check --status || {
            echo "hash mismatch: removing the download" >&2
            rm -f "$part"
            exit 1
          }
          mv "$part" ${lib.escapeShellArg modelPath}
          echo "downloaded and checked ${cfg.model.file}"
        '';
      };

      # Both units run as the same dynamic user, so the server reads what the
      # download wrote, and neither can write anything else.
      sandbox = {
        User = "local-llm";
        DynamicUser = true;
        StateDirectory = "local-llm";
        WorkingDirectory = state;
        ProtectSystem = "strict";
        ProtectHome = true;
        PrivateTmp = true;
        NoNewPrivileges = true;
        CapabilityBoundingSet = "";
        RestrictSUIDSGID = true;
        ProtectKernelTunables = true;
        ProtectKernelModules = true;
        ProtectKernelLogs = true;
        ProtectControlGroups = true;
        ProtectClock = true;
        ProtectHostname = true;
        RestrictRealtime = true;
        LockPersonality = true;
        SystemCallArchitectures = "native";
        RestrictNamespaces = true;
        RestrictAddressFamilies = [
          "AF_UNIX"
          "AF_INET"
          "AF_INET6"
        ];
      };
    in
    {
      options.balaur.local-llm = {
        port = lib.mkOption {
          type = lib.types.port;
          default = 8090;
          description = "llama-server's port (OpenAI-compatible /v1, /health, the chat page), on the tailnet.";
        };
        contextSize = lib.mkOption {
          type = lib.types.ints.positive;
          default = 131072;
          description = "Context window in tokens. The OS agents assume 128k (agent.nix).";
        };
        model = {
          url = lib.mkOption {
            type = lib.types.str;
            default = "https://huggingface.co/ggml-org/NVIDIA-Nemotron-3.5-Lightning-30B-A3B-GGUF/resolve/ba87e1d2152af029eb0e392b155c72c0dd92aa5b/NVIDIA-Nemotron-3.5-Lightning-30B-A3B-Q4_0.gguf";
            description = "Where to download the GGUF file from (pinned to a revision).";
          };
          sha256 = lib.mkOption {
            type = lib.types.str;
            default = "61f87e75974e4b535dcdf9aad056541a9514f1dfa4538b463b081d19b7a00e3c";
            description = "The file's SHA-256 (Hugging Face shows it as the LFS oid).";
          };
          file = lib.mkOption {
            type = lib.types.str;
            default = "NVIDIA-Nemotron-3.5-Lightning-30B-A3B-Q4_0.gguf";
            description = "Its file name in ${state}.";
          };
        };
      };

      config = {
        # Mesa's Vulkan driver (RADV), also on a machine without a desktop.
        hardware.graphics.enable = true;

        # On the home page and in the app: llama-server's own chat page.
        balaur.services = [
          {
            name = "Local LLM";
            description = "Nemotron 3.5 Lightning on the iGPU: chat";
            icon = "🧠";
            port = cfg.port;
            unit = "local-llm.service";
            group = "System";
          }
        ];

        systemd.services.local-llm = {
          description = "Local LLM on the iGPU (:${toString cfg.port})";
          wantedBy = [ "multi-user.target" ];
          after = [ "network-online.target" ];
          wants = [ "network-online.target" ];
          unitConfig.ConditionPathExists = modelPath;
          serviceConfig = sandbox // {
            ExecStart = lib.escapeShellArgs [
              (lib.getExe' pkgs.llama-cpp-vulkan "llama-server")
              "--model"
              modelPath
              "--alias"
              "local"
              "--host"
              "0.0.0.0"
              "--port"
              (toString cfg.port)
              "--ctx-size"
              (toString cfg.contextSize)
              # One conversation at a time with the whole window; the entryway sends
              # the next one to Mistral meanwhile.
              "--parallel"
              "1"
              # Every layer on the GPU.
              "--n-gpu-layers"
              "999"
            ];
            Restart = "on-failure";
            RestartSec = 30;
            # The GPU (/dev/dri), and nothing else of /dev.
            PrivateDevices = false;
            DevicePolicy = "closed";
            DeviceAllow = [ "char-drm rw" ];
            SupplementaryGroups = [
              "render"
              "video"
            ];
            # Mesa keeps its compiled shaders here, so later starts skip compiling them.
            CacheDirectory = "local-llm";
            Environment = [ "XDG_CACHE_HOME=/var/cache/local-llm" ];
            # Loading 19 GB from disk takes a while the first time.
            TimeoutStartSec = "5min";
            # Below the other services when it computes.
            Nice = 5;
          };
        };

        # Runs until the model is on disk, then never again. Type=exec, so a deploy
        # does not wait for 19 GB; when it succeeds it starts the server.
        systemd.services.local-llm-fetch = {
          description = "Local LLM: download the model";
          wantedBy = [ "multi-user.target" ];
          after = [ "network-online.target" ];
          wants = [ "network-online.target" ];
          unitConfig = {
            ConditionPathExists = "!${modelPath}";
            OnSuccess = [ "local-llm.service" ];
          };
          serviceConfig = sandbox // {
            Type = "exec";
            ExecStart = lib.getExe fetch;
            TimeoutStartSec = "infinity";
          };
        };

        # Retries a failed download an hour later; once the file exists, the
        # condition skips it.
        systemd.timers.local-llm-fetch = {
          wantedBy = [ "timers.target" ];
          timerConfig.OnUnitInactiveSec = "1h";
          restartTriggers = [ fetch ];
        };
      };
    };
}
