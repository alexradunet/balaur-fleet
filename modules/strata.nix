# Strata (github.com/Niko1221/Strata): a local LLM server for a big
# mixture-of-experts model on one consumer GPU. The hot experts stay in VRAM,
# the rest in RAM, so Qwen3.8-Flash-Next (125B) runs on zmeu's RTX 5060 Ti
# 16 GB with its 62 GB of RAM. OpenAI-compatible /v1 (and Anthropic /v1/messages)
# on :8090, tailnet only: the port is not opened on the LAN, the tailnet is trusted.
#
# It is the fleet's local inference tier: the `ai` aspect on every machine finds
# this one in the registry and sends model `balaur` here first (ai.nix).
#
# Upstream ships three parts, and only the first is Nix's:
#   - the Terminal (`strata-control`: a Python CLI with its own interpreter),
#     pinned below and run through nix-ld;
#   - the engine (CUDA 13), which the Terminal downloads for this card;
#   - the model (tens of GB), which the Terminal downloads too.
# Both downloads live in /var/lib/strata, owned by the `strata` user, so the
# engine can follow upstream (`sudo strata update`) without a rebuild.
#
# Setup is unattended: on the first boot or deploy with the card present,
# strata-setup downloads the engine and the model (`family`/`model`, tens of GB),
# loads it once, saves the profile `balaur` and starts strata.service. Follow it
# with `journalctl -fu strata-setup`. To change model: read docs/MODELS.md
# upstream, `sudo strata launch --plan --family ... --model ...`, then point the
# profile at the new run config (`sudo strata profile use-config balaur ...`).
# `sudo strata ...` is the upstream CLI, run as the strata user in its state.
#
# Sharing the machine with games (`yieldToGames`): while a Steam game or Battle.net
# (umu) runs, Strata is stopped, so the game has the whole card and the RAM back;
# the router meanwhile answers from Mistral. It starts again a minute after the
# game ends, and loading the model again takes a few minutes. A Strata stopped by
# hand (`systemctl stop strata`) stays stopped.
#
# Booted without the eGPU dock, it does not start (ExecCondition), and the router
# simply finds no local tier.
{
  flake.modules.nixos.strata =
    { config, lib, pkgs, ... }:
    let
      cfg = config.balaur.strata;
      state = "/var/lib/strata";

      version = "0.1.59"; # strata-control, shipped with Strata 0.2.13
      control = pkgs.stdenvNoCC.mkDerivation {
        pname = "strata-control";
        inherit version;
        src = pkgs.fetchurl {
          url = "https://github.com/Niko1221/Strata/releases/download/v0.2.13/strata-control-${version}-linux-x86_64.tar.gz";
          sha256 = "14a9fde3dbde5a16cd1a0d34fe04b3dca38c462114a534f8813a00fcabfc4f5d";
        };
        # Prebuilt CPython and wheels: run as shipped (nix-ld), no patching.
        dontUnpack = true;
        dontFixup = true;
        installPhase = ''
          mkdir -p $out/share/strata-control
          tar xzf $src -C $out/share/strata-control
        '';
      };

      # The environment every Strata process gets: its state, the NVIDIA driver's
      # libraries for the engine, and nix-ld's for the prebuilt Python.
      env = {
        HOME = state;
        XDG_CONFIG_HOME = "${state}/.config";
        XDG_DATA_HOME = "${state}/.local/share";
        XDG_CACHE_HOME = "${state}/.cache";
        NIX_LD = "/run/current-system/sw/share/nix-ld/lib/ld.so";
        NIX_LD_LIBRARY_PATH = "/run/opengl-driver/lib:/run/current-system/sw/share/nix-ld/lib";
        # DNS-rebinding guard: the names the fleet dials it by (an IP always passes).
        STRATA_ALLOWED_HOSTS = lib.concatStringsSep "," [ config.networking.hostName "localhost" ];
      };
      # nvidia-smi (in the system profile), for its GPU checks.
      path = "${pkgs.coreutils}/bin:/run/current-system/sw/bin";
      envArgs = lib.concatStringsSep " " (lib.mapAttrsToList (k: v: "${k}=${lib.escapeShellArg v}") (env // { PATH = path; }));

      # `strata` for the admin: the upstream CLI, as the strata user, in its state.
      cli = pkgs.writeShellScriptBin "strata" ''
        cd ${state}
        if [ "$(id -un)" = strata ]; then
          exec env ${envArgs} ${control}/share/strata-control/bin/strata "$@"
        elif [ "$(id -u)" = 0 ]; then
          exec ${pkgs.util-linux}/bin/runuser -u strata -- env ${envArgs} ${control}/share/strata-control/bin/strata "$@"
        else
          echo "strata runs as the strata user: use sudo strata $*" >&2
          exit 1
        fi
      '';

      # The card is there only when the OCuLink dock was on at boot.
      gpuPresent = pkgs.writeShellScript "strata-gpu-present" ''
        for d in /sys/bus/pci/drivers/nvidia/0000:*; do [ -e "$d" ] && exit 0; done
        echo "no NVIDIA card bound (dock off at boot?): not starting" >&2
        exit 1
      '';

      # The one-time setup, unattended: download the engine and the model, serve
      # once to prove they work, save the profile strata.service serves, start it.
      setup = pkgs.writeShellScript "strata-setup" ''
        set -eu
        export PATH=${path}
        marker=$(mktemp)
        trap 'rm -f "$marker"' EXIT
        echo "downloading the engine and ${cfg.family} ${cfg.model} (tens of GB) and loading it once"
        ${cli}/bin/strata launch --family ${cfg.family} --model ${cfg.model} --access local \
          --port ${toString cfg.port} --no-api-key --yes --no-tui
        for _ in $(seq 360); do
          if ${pkgs.curl}/bin/curl -fsS -m 5 http://127.0.0.1:${toString cfg.port}/health 2>/dev/null \
               | ${pkgs.jq}/bin/jq -e '.loaded != false' >/dev/null; then
            loaded=1; break
          fi
          sleep 10
        done
        ${cli}/bin/strata launch --stop || true
        [ "''${loaded:-}" = 1 ] || { echo "the model did not load within an hour" >&2; exit 1; }
        config=$(find ${state} -name 'strata-*.json' -newer "$marker" -not -path '*/profiles/*' -printf '%T@ %p\n' \
                 | sort -rn | head -1 | cut -d' ' -f2-)
        [ -n "$config" ] || { echo "no run config written under ${state}" >&2; exit 1; }
        echo "saving profile ${cfg.profile} from $config"
        ${cli}/bin/strata profile create ${cfg.profile} --from-config "$config"
        systemctl start --no-block strata.service
      '';

      yield = pkgs.writeShellScript "strata-yield" ''
        flag=/run/strata-yield/yielded
        quiet=0
        while true; do
          # A Steam game (its reaper carries SteamLaunch) or anything under umu (Battle.net).
          if ${pkgs.procps}/bin/pgrep -f -- 'SteamLaunch AppId=|umu-run' >/dev/null; then
            quiet=0
            case "$(${pkgs.systemd}/bin/systemctl is-active strata.service)" in active|activating|reloading)
              echo "a game started: stopping Strata"
              touch "$flag"
              ${pkgs.systemd}/bin/systemctl stop strata.service
              ;;
            esac
          elif [ -e "$flag" ]; then
            # A minute without a game, so a launcher restarting a game does not
            # reload a 40 GB model in between.
            quiet=$((quiet + 5))
            if [ "$quiet" -ge 60 ]; then
              echo "no game for a minute: starting Strata"
              rm -f "$flag"
              ${pkgs.systemd}/bin/systemctl start --no-block strata.service
            fi
          fi
          sleep 5
        done
      '';
    in
    {
      options.balaur.strata = {
        port = lib.mkOption {
          type = lib.types.port;
          default = 8090;
          description = "Strata's port: on loopback and the tailnet (the firewall keeps it off the LAN).";
        };
        family = lib.mkOption {
          type = lib.types.str;
          default = "qwen";
          description = "The model family strata-setup downloads (`strata launch --family`).";
        };
        model = lib.mkOption {
          type = lib.types.str;
          # The size that leaves room for builds and the desktop in 62 GB; with
          # 64 GB "every size fits" upstream, but this machine shares its RAM.
          default = "q2_0";
          description = "The model size strata-setup downloads (`strata launch --model`).";
        };
        profile = lib.mkOption {
          type = lib.types.str;
          default = "balaur";
          description = "The Strata profile to serve (`sudo strata profile list`).";
        };
        yieldToGames = lib.mkOption {
          type = lib.types.bool;
          default = true;
          description = "Stop Strata while a game runs, and start it again after.";
        };
      };

      config = {
        users.users.strata = {
          isSystemUser = true;
          group = "strata";
          home = state;
          extraGroups = [ "video" "render" ];
        };
        users.groups.strata = { };
        systemd.tmpfiles.rules = [ "d ${state} 0750 strata strata -" ];

        # The prebuilt Python and engine need a dynamic loader and a few libraries.
        programs.nix-ld = {
          enable = true;
          libraries = with pkgs; [ stdenv.cc.cc.lib zlib ];
        };

        environment.systemPackages = [ cli ];

        systemd.services.strata = {
          description = "Strata: the fleet's local LLM (:${toString cfg.port})";
          wantedBy = [ "multi-user.target" ];
          after = [ "network-online.target" "systemd-modules-load.service" ];
          wants = [ "network-online.target" ];
          environment = env;
          path = [ pkgs.coreutils "/run/current-system/sw" ];
          unitConfig.ConditionPathExists = "${state}/.config/strata/profiles/${cfg.profile}.json";
          serviceConfig = {
            User = "strata";
            Group = "strata";
            WorkingDirectory = state;
            ExecCondition = gpuPresent;
            ExecStart = "${control}/share/strata-control/bin/strata serve --profile ${cfg.profile} --host 0.0.0.0 --port ${toString cfg.port}";
            Restart = "on-failure";
            RestartSec = 30;
            # It pins the hot experts in RAM.
            LimitMEMLOCK = "infinity";
            # Loading is minutes; stopping drains the answer in progress.
            TimeoutStartSec = "infinity";
            TimeoutStopSec = 60;
            # Below the desktop and games when it runs alongside them.
            Nice = 5;
          };
        };

        # Runs until it has made the profile, then never again (delete the profile
        # to redo it). Type=exec, so a deploy does not wait for the download.
        systemd.services.strata-setup = {
          description = "Strata: one-time download and setup of the engine and model";
          wantedBy = [ "multi-user.target" ];
          after = [ "network-online.target" ];
          wants = [ "network-online.target" ];
          unitConfig.ConditionPathExists = "!${state}/.config/strata/profiles/${cfg.profile}.json";
          path = [ pkgs.systemd pkgs.findutils pkgs.coreutils ];
          serviceConfig = {
            Type = "exec";
            ExecCondition = gpuPresent;
            ExecStart = setup;
            TimeoutStartSec = "infinity";
          };
        };

        systemd.services.strata-yield = lib.mkIf cfg.yieldToGames {
          description = "Stop Strata while a game runs";
          wantedBy = [ "multi-user.target" ];
          serviceConfig = {
            ExecStart = yield;
            RuntimeDirectory = "strata-yield";
            RuntimeDirectoryPreserve = true;
            Restart = "always";
            RestartSec = 5;
          };
        };
      };
    };
}
