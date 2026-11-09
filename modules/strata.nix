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
# loads it once, saves the profile `balaur-<model>` and starts strata.service.
# Follow it with `journalctl -fu strata-setup`. To change model, change `model`
# (sizes below) and deploy: the new profile does not exist yet, so the setup runs
# again a minute later, and the router answers from Mistral until it is done.
# Old sizes stay on disk: `sudo strata models list` / `remove` to free them.
# `sudo strata ...` is the upstream CLI, run as the strata user in its state.
#
# Sharing the machine with games (`yieldToGames`): while a Steam game or anything on Wine (Battle.net)
# or Proton runs, Strata is stopped, so the game has the whole card and the RAM back;
# the router meanwhile answers from Mistral. It starts again a minute after the
# game ends, and loading the model again takes a few minutes. A Strata stopped by
# hand (`systemctl stop strata`) stays stopped.
#
# Booted without the eGPU dock, it does not start (ExecCondition), and the router
# simply finds no local tier.
{
  flake.modules.nixos.strata =
    {
      config,
      lib,
      pkgs,
      ...
    }:
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
        STRATA_ALLOWED_HOSTS = lib.concatStringsSep "," [
          config.networking.hostName
          "localhost"
        ];
      };
      # nvidia-smi (in the system profile), for its GPU checks.
      path = "${pkgs.coreutils}/bin:/run/current-system/sw/bin";
      envArgs = lib.concatStringsSep " " (
        lib.mapAttrsToList (k: v: "${k}=${lib.escapeShellArg v}") (env // { PATH = path; })
      );

      # `strata` for the admin: the upstream CLI, as the strata user, in its state.
      cli = pkgs.writeShellApplication {
        name = "strata";
        runtimeInputs = [
          pkgs.coreutils
          pkgs.util-linux
        ];
        text = ''
          cd ${state}
          if [ "$(id -un)" = strata ]; then
            exec env ${envArgs} ${control}/share/strata-control/bin/strata "$@"
          elif [ "$(id -u)" = 0 ]; then
            exec runuser -u strata -- env ${envArgs} ${control}/share/strata-control/bin/strata "$@"
          else
            echo "strata runs as the strata user: use sudo strata $*" >&2
            exit 1
          fi
        '';
      };

      # The card is there only when the OCuLink dock was on at boot.
      gpuPresent = pkgs.writeShellApplication {
        name = "strata-gpu-present";
        text = ''
          for d in /sys/bus/pci/drivers/nvidia/0000:*; do
            if [ -e "$d" ]; then exit 0; fi
          done
          echo "no NVIDIA card bound (dock off at boot?): not starting" >&2
          exit 1
        '';
      };

      # The one-time setup, unattended: download the engine and the model, serve
      # once to prove they work, save the profile strata.service serves, start it.
      setup = pkgs.writeShellApplication {
        name = "strata-setup";
        runtimeInputs = [
          cli
          pkgs.coreutils
          pkgs.curl
          pkgs.findutils
          pkgs.gnugrep
          pkgs.jq
          pkgs.systemd
          pkgs.util-linux
        ];
        text = ''
          # nvidia-smi, for the launcher's GPU checks, is in the system profile.
          export PATH="$PATH:/run/current-system/sw/bin"
          marker=$(mktemp)
          trap 'rm -f "$marker"' EXIT
          echo "downloading the engine and ${cfg.family} ${cfg.model} (tens of GB) and loading it once"
          if ! strata launch --family ${cfg.family} --model ${cfg.model} --access local \
                 --port ${toString cfg.port} --drafting ${cfg.drafting} --no-api-key --yes --no-tui; then
            # Its logs are the strata user's own (0600): put what matters in the journal.
            echo "---- launch failed; the GPU as the strata user sees it:"
            runuser -u strata -- nvidia-smi -L || true
            env | grep -iE '^(CUDA|NVIDIA|NIX_LD|LD_)' || true
            log=$(find ${state}/.local/state/strata/launch -name '*.engine.log' -printf '%T@ %p\n' 2>/dev/null \
                  | sort -rn | head -1 | cut -d' ' -f2- || true)
            if [ -n "$log" ]; then
              echo "---- the end of $log:"
              tail -n 60 "$log"
            fi
            exit 1
          fi
          loaded=0
          for _ in $(seq 360); do
            if curl -fsS -m 5 http://127.0.0.1:${toString cfg.port}/health 2>/dev/null \
                 | jq -e '.loaded != false' >/dev/null; then
              loaded=1
              break
            fi
            sleep 10
          done
          strata launch --stop || true
          if [ "$loaded" != 1 ]; then
            echo "the model did not load within an hour" >&2
            exit 1
          fi
          config=$(find ${state} -name 'strata-*.json' -newer "$marker" -not -path '*/profiles/*' -printf '%T@ %p\n' \
                   | sort -rn | head -1 | cut -d' ' -f2- || true)
          if [ -z "$config" ]; then
            echo "no run config written under ${state}" >&2
            exit 1
          fi
          echo "saving profile ${cfg.profile} from $config"
          strata profile create ${cfg.profile} --from-config "$config"
          systemctl start --no-block strata.service
        '';
      };

      yield = pkgs.writeShellApplication {
        name = "strata-yield";
        runtimeInputs = [
          pkgs.coreutils
          pkgs.procps
          pkgs.systemd
        ];
        text = ''
          flag=/run/strata-yield/yielded
          quiet=0
          while true; do
            # A Steam game (Steam's `reaper` runs beside each one), anything on Wine or
            # Proton (`wineserver`: Battle.net and Proton games) or umu. Process names,
            # not command lines: a shell or editor merely showing these words must not count.
            if pgrep -x 'reaper|wineserver|umu-run' >/dev/null; then
              quiet=0
              state=$(systemctl is-active strata.service || true)
              case "$state" in
                active | activating | reloading)
                  echo "a game started: stopping Strata"
                  touch "$flag"
                  systemctl stop strata.service
                  ;;
              esac
            elif [ -e "$flag" ]; then
              # A minute without a game, so a launcher restarting a game does not
              # reload a 40 GB model in between.
              quiet=$((quiet + 5))
              if [ "$quiet" -ge 60 ]; then
                echo "no game for a minute: starting Strata"
                rm -f "$flag"
                systemctl start --no-block strata.service
              fi
            fi
            sleep 5
          done
        '';
      };
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
        drafting = lib.mkOption {
          type = lib.types.enum [
            "auto"
            "mtp"
            "dflash2"
            "off"
          ];
          # Strata 0.2.13 + q2_0: auto picks DFlash2, which needs a native pack
          # (published for q4_0 only), and with no MTP layer to fall back on the
          # engine stops at start ("--draft-fallback none ... the start ends here").
          default = "off";
          description = "The drafter that guesses words ahead (`strata launch --drafting`); off is slower but starts on every size.";
        };
        model = lib.mkOption {
          type = lib.types.str;
          # Qwen3.8-Flash-Next sizes (RAM + VRAM): q2_0 37.6 GB "good", iq2_xs
          # 39.2 "better", iq3_xxs 47.0 "great", iq3_s 54.8 "best; matches the
          # full model on the published tests" and the slowest. Measured on zmeu
          # (2026-11-09): 50 GB of its 62 GB RAM (+1 GB for pictures), ~5 GB
          # left, 43-50 tokens/s; builds and the desktop lean on swap. Chosen for
          # quality; iq3_xxs is the step down if zmeu ever feels sluggish.
          # Games stop Strata, so they get everything back.
          default = "iq3_s";
          description = "The model size strata-setup downloads (`strata launch --model`).";
        };
        profile = lib.mkOption {
          type = lib.types.str;
          # Named after the size, so a new `model` has no profile yet and
          # strata-setup makes it (strata.service waits for it meanwhile).
          default = "balaur-${lib.toLower cfg.model}";
          defaultText = lib.literalExpression ''"balaur-''${model}"'';
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
          extraGroups = [
            "video"
            "render"
          ];
        };
        users.groups.strata = { };
        systemd.tmpfiles.rules = [ "d ${state} 0750 strata strata -" ];

        # The prebuilt Python and engine need a dynamic loader and a few libraries.
        programs.nix-ld = {
          enable = true;
          libraries = with pkgs; [
            stdenv.cc.cc.lib
            zlib
          ];
        };

        environment.systemPackages = [ cli ];

        # On the home page and in the app. It is an API with no web page of its
        # own: the link opens /health (the model, whether it is loaded). Stopped
        # while a game runs, so "No answer" then is expected.
        balaur.services = [
          {
            name = "Strata";
            description = "Local LLM on the GPU";
            icon = "🧠";
            port = cfg.port;
            path = "/health";
            unit = "strata.service";
            group = "System";
          }
        ];

        systemd.services.strata = {
          description = "Strata: the fleet's local LLM (:${toString cfg.port})";
          wantedBy = [ "multi-user.target" ];
          after = [
            "network-online.target"
            "systemd-modules-load.service"
          ];
          wants = [ "network-online.target" ];
          environment = env;
          path = [
            pkgs.coreutils
            "/run/current-system/sw"
          ];
          unitConfig.ConditionPathExists = "${state}/.config/strata/profiles/${cfg.profile}.json";
          serviceConfig = {
            User = "strata";
            Group = "strata";
            WorkingDirectory = state;
            ExecCondition = lib.getExe gpuPresent;
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
          path = [
            pkgs.systemd
            pkgs.findutils
            pkgs.coreutils
          ];
          serviceConfig = {
            Type = "exec";
            ExecCondition = lib.getExe gpuPresent;
            ExecStart = lib.getExe setup;
            TimeoutStartSec = "infinity";
          };
        };

        # Retries a failed setup an hour later (and first, a minute after a deploy
        # that brings it); once the profile exists the service's condition skips it.
        systemd.timers.strata-setup = {
          wantedBy = [ "timers.target" ];
          timerConfig = {
            OnActiveSec = "1min";
            OnUnitInactiveSec = "1h";
          };
          # A new setup script (other settings) restarts the timer: retried in a minute.
          restartTriggers = [ setup ];
        };

        systemd.services.strata-yield = lib.mkIf cfg.yieldToGames {
          description = "Stop Strata while a game runs";
          wantedBy = [ "multi-user.target" ];
          serviceConfig = {
            ExecStart = lib.getExe yield;
            RuntimeDirectory = "strata-yield";
            RuntimeDirectoryPreserve = true;
            Restart = "always";
            RestartSec = 5;
          };
        };
      };
    };
}
