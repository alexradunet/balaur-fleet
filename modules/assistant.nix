# The voice assistant, an app of a GNOME session (gnome/):
#
#   openWakeWord    127.0.0.1:10400   listens for "Hey Jarvis" (tiny, local, nothing leaves)
#   balaur-assistant  session service   the GJS daemon: microphone and speaker through
#                                     PipeWire, Voxtral speech, timers, lists, memory,
#                                     notifications; D-Bus org.balaur.Assistant
#   balaur-home-agent its child         the brain: the fleet's pi in its home role
#                                     (gnome/home-agent/), with the household's tools only
#
# After the wake word, Mistral (EU) does the rest: Voxtral transcription (what
# you said), the model with tools (what to do: the fleet's AI entryway with the
# `agent` aspect, else Mistral), Voxtral TTS (the voice), and the web_search tool. Audio is sent
# only for the sentence after the wake word and is not kept here.
#
# It runs in the session of `balaur.assistant.user`, which defaults to the
# household account on a host with the `tablet` aspect and to the admin account
# otherwise. Give the host a session to run in — `gnome` plus `tablet` or
# `desktop` — since those also install its front end (the Balaur app and the Shell
# extension's orb and mic toggle).
#
# House devices: the agent switches lights, the TV, speakers and scenes through
# the fleet's Home Assistant (its MCP server, /api/mcp) as the assistant's own
# non-admin Home Assistant user, whose token is the shared sops secret
# `home-assistant-agent-token`. What it can switch is what is exposed to Assist.
{ config, ... }:
let
  nixosConfigs = config.flake.nixosConfigurations;
  fleet = config.fleet;
in
{
  flake.modules.nixos.assistant =
    {
      config,
      options,
      lib,
      pkgs,
      ...
    }:
    let
      cfg = config.balaur;
      as = cfg.assistant;
      user = as.user;
      package = pkgs.balaur-assistant;
      # With the `secrets` aspect, the key is the fleet's sops secret; without it,
      # this machine's own state, written by `sudo balaur-assistant-login`.
      useSops = options ? sops;
      keySecret = "assistant-llm-key";
      houseToken = "home-assistant-agent-token";
      hass = as.homeAssistant;
      me = config.networking.hostName;
      hostConfig = h: if h == me then config else nixosConfigs.${h}.config;
      # The machines that run Home Assistant (home-assistant.nix).
      hassHosts = lib.filter (
        h: (h == me || nixosConfigs ? ${h}) && (hostConfig h).services.home-assistant.enable
      ) (lib.attrNames fleet);
      houseDevices = hass.host != null && hass.tokenFile != null;
      wakewordDir = "/var/lib/balaur-wakewords";
      wakePort = 10400;

      # A dedicated ALSA capture device as its own PipeWire source, for machines
      # whose default microphone is not good enough for the wake word. On the Duet
      # that is the array's 16 kHz device (DMIC16kHz): PipeWire's stock "Digital
      # Microphone" is the 48 kHz DMIC (hw:0,6), whose processing leaves a voice far
      # too quiet. Where `audio.input` is null we just use the server's default
      # source, which is what an ordinary laptop microphone wants.
      customMic = as.audio.input != null;
      micNode = "balaur-mic";
      micHw = lib.removePrefix "plug" (toString as.audio.input);
      # What the daemon records from: "pulse" is the sound server's default source.
      inputDevice = if customMic then "pulse:${micNode}" else "pulse";
      # ... and what `parec` needs to read that same source in balaur-wake-test.
      parecDevice = lib.optionalString customMic "--device=${micNode} ";

      # Defaults for the daemon; the model and voices can be changed in the
      # Balaur app (GSettings org.balaur.Assistant), which then take precedence.
      configFile = pkgs.writeText "balaur-assistant.json" (
        builtins.toJSON {
          inherit (as) name defaultLanguage;
          audio = {
            input = inputDevice;
            output = "pulse";
            card = "0";
          };
          wake = {
            uri = "127.0.0.1:${toString wakePort}";
            words = [ as.wakeWord ];
          };
          stt.model = as.stt.model;
          tts = {
            inherit (as.tts) model;
            voices = lib.filterAttrs (_: v: v != null) as.tts.voices;
          };
          search.model = lib.optionalString as.webSearch.enable as.webSearch.model;
          llm = {
            inherit (as.llm)
              baseUrl
              model
              ;
          };
          location = { inherit (cfg.location) name latitude longitude; };
          newsFeeds = as.newsFeeds;
        }
      );

      inSession =
        cmd:
        ''runuser -u ${user} -- env XDG_RUNTIME_DIR="/run/user/$(id -u ${user})" DBUS_SESSION_BUS_ADDRESS="unix:path=/run/user/$(id -u ${user})/bus" ${cmd}'';

      # The API key from a terminal: state only, never in the repo or the store. Read
      # from stdin so it never shows up in the process list; checked against the API,
      # which also lists the voices to choose from. The Balaur app's Assistant settings
      # do the same from the screen (they keep keys in the GNOME Keyring instead).
      login = pkgs.writeShellApplication {
        name = "balaur-assistant-login";
        runtimeInputs = [
          pkgs.coreutils
          pkgs.curl
          pkgs.jq
          pkgs.systemd
          pkgs.util-linux
        ];
        text = ''
          if [ "$(id -u)" != 0 ]; then echo "run with sudo" >&2; exit 1; fi
          base=${lib.escapeShellArg as.llm.baseUrl}
          read -rsp "API key for $base (hidden): " key; echo
          [ -n "$key" ] || { echo "empty key, nothing given" >&2; exit 1; }
          ${
            if as.llm.manageApiKeyFile then
              ''
                key_file=${lib.escapeShellArg (toString as.llm.apiKeyFile)}
                install -d -m 711 "$(dirname "$key_file")"
                # Readable by the assistant's group, which the household account is in.
                install -m 640 -g balaur-assistant /dev/null "$key_file"
                printf '%s' "$key" > "$key_file"
                saved="Saved."
              ''
            else
              ''
                            # Something else owns this file — sops-nix, on this host. Still check
                            # the key and list the voices, which is half of what this is for.
                            saved="NOT saved: this machine takes the key from sops. Put it in the repo with
                  sops secrets/balaur.yaml      (the assistant-llm-key entry)
                then rebuild. Checking the key you typed anyway:"
              ''
          }
          api() { printf 'header = "Authorization: Bearer %s"\n' "$key" | curl -sS -m 15 -K - "$base$1"; }
          if api /models | jq -e '.data | length > 0' >/dev/null 2>&1; then
            echo "$saved The API accepted the key."
            echo "Voices (set balaur.assistant.tts.voices.ro / .en, or in the Balaur app; empty = the API's default):"
            api '/audio/voices?limit=100' | jq -r '.items[] | "  \(.id)  \(.languages | join(","))  \(.name)"' 2>/dev/null | sort -k2 \
              || echo "  (could not list them)"
          else
            echo "$saved But $base/models did not accept it: check the key and balaur.assistant.llm.baseUrl."
          fi
          ${lib.optionalString as.llm.manageApiKeyFile ''
            ${inSession "systemctl --user restart balaur-assistant.service"} \
              && echo "balaur-assistant restarted." || echo "Log in to the desktop to start the assistant."
          ''}
        '';
      };

      # `sudo balaur-wake-test`: say the wake word a few times; prints its score each
      # time, to tune balaur.assistant.wakeThreshold and audio.micGain with real voices.
      wakeTest = pkgs.writeShellApplication {
        name = "balaur-wake-test";
        runtimeInputs = [
          pkgs.coreutils
          pkgs.util-linux
          pkgs.glib.bin
          pkgs.pulseaudio
        ];
        text = ''
          if [ "$(id -u)" != 0 ]; then echo "run with sudo" >&2; exit 1; fi
          py=${pkgs.python3.withPackages (ps: [ ps.pyopen-wakeword ])}/bin/python3
          # The recording is kept (root only) for a second look:
          #   sudo balaur-wake-test [seconds]           say the wake word a few times
          #   sudo balaur-wake-test all [seconds]       compare every built-in wake word
          #   sudo balaur-wake-test score [gain] [all]  rescore the last recording, optionally amplified
          rec=/var/tmp/balaur-wake-test.raw
          if [ "''${1:-}" = score ]; then
            exec "$py" ${./assistant/wake-test.py} "''${3:-${as.wakeWord}}" "$rec" ${toString as.wakeThreshold} "''${2:-1}"
          fi
          model=${as.wakeWord}
          prompt="say \"${
            lib.replaceStrings [ "_" ] [ " " ] as.wakeWord
          }\" a few times, as you normally would"
          if [ "''${1:-}" = all ]; then
            model=all; shift
            prompt="say each twice, a few seconds apart: \"Hey Jarvis\", \"Alexa\", \"Hey Mycroft\", \"Okay Nabu\", \"Hey Rhasspy\""
          fi
          secs="''${1:-$( [ $model = all ] && echo 40 || echo 15 )}"
          # Muted, the assistant doesn't answer the wake words said for the test.
          setmute() {
            ${inSession ''
              gdbus call --session --dest org.balaur.Assistant --object-path /org/balaur/Assistant \
                            --method org.freedesktop.DBus.Properties.Set org.balaur.Assistant1 Muted "<$1>"''} >/dev/null || true
          }
          trap 'setmute false' EXIT
          setmute true
          echo "Recording $secs s: $prompt."
          install -m 600 /dev/null "$rec"
          # From the same PipeWire source the assistant uses.
          ${inSession ''timeout "$secs" parec ${parecDevice}--raw --format=s16le --rate=16000 --channels=1''} > "$rec" || true
          "$py" ${./assistant/wake-test.py} "$model" "$rec" ${toString as.wakeThreshold}
        '';
      };
    in
    {
      options.balaur = {
        assistant = {
          user = lib.mkOption {
            type = lib.types.str;
            default = cfg.tablet.user or cfg.user;
            defaultText = lib.literalExpression "the tablet's household account if there is one, else balaur.user";
            description = ''
              The account whose GNOME session runs the assistant. On the Duet that is
              the household account (the `tablet` aspect); on a personal machine it is
              the admin account, so leaving this alone is right in both cases.
            '';
          };

          name = lib.mkOption {
            type = lib.types.str;
            default = "Jarvis";
            description = "What the assistant calls itself.";
          };

          defaultLanguage = lib.mkOption {
            type = lib.types.enum [
              "ro"
              "en"
            ];
            default = "ro";
            description = "Language used when it cannot tell which one was spoken.";
          };

          wakeWord = lib.mkOption {
            type = lib.types.str;
            default = "hey_jarvis";
            description = ''
              openWakeWord model to listen for. Built in: hey_jarvis, alexa, hey_mycroft,
              hey_rhasspy, okay_nabu. A custom one: put `<name>.tflite` in
              /var/lib/balaur-wakewords and set its name here (docs/SETUP.md, "Custom wake word").
            '';
          };

          wakeThreshold = lib.mkOption {
            type = lib.types.numbers.between 0.0 1.0;
            default = 0.5;
            description = "Wake word sensitivity: higher means fewer false wakes, but it may miss you.";
          };

          llm = {
            baseUrl = lib.mkOption {
              type = lib.types.str;
              default = "https://api.mistral.ai/v1"; # Mistral: EU (Paris), OpenAI-compatible, tool calling
              description = "Mistral API base for speech (Voxtral) and web search. Changeable in the Balaur app.";
            };
            model = lib.mkOption {
              type = lib.types.str;
              # mistral: small was faster but answered English in Romanian
              default = if cfg ? agent then cfg.agent.model else "mistral-medium-latest";
              defaultText = lib.literalMD "`balaur.agent.model` with the `agent` aspect, else `mistral-medium-latest`";
              description = "The model it starts with: one of the AI entryway's (agent.nix) with the `agent` aspect, else one of Mistral's. It must support tool calling. Changeable in the Balaur app.";
            };
            apiKeyFile = lib.mkOption {
              type = lib.types.path;
              default =
                if useSops then
                  config.sops.secrets.${keySecret}.path
                else
                  "/var/lib/secrets/balaur-assistant-llm-key";
              defaultText = lib.literalMD "the `assistant-llm-key` sops secret with the `secrets` aspect, else `/var/lib/secrets/balaur-assistant-llm-key`";
              description = ''
                File with the Mistral API key: the fallback when the GNOME Keyring
                has none (keys saved in the Balaur app go there). By default it is
                the fleet's `assistant-llm-key` sops secret where the `secrets` aspect
                is present, else this machine's own state (`sudo balaur-assistant-login`).
              '';
            };
            manageApiKeyFile = lib.mkOption {
              type = lib.types.bool;
              default = !useSops;
              defaultText = lib.literalMD "false with the `secrets` aspect, else true";
              description = ''
                Whether this aspect owns `apiKeyFile`: creates its directory, and
                lets `balaur-assistant-login` write it.

                Set false when something else provides the file — the `secrets`
                aspect does, at a path under /run/secrets, and both would
                otherwise try to own that directory. `balaur-assistant-login` then
                still checks a key and lists the voices, but says where the real
                one belongs instead of writing it.
              '';
            };
          };

          # Speech, voices and web search use the same Mistral endpoint and key as `llm`.
          stt.model = lib.mkOption {
            type = lib.types.str;
            default = "voxtral-mini-transcribe-3-0";
            description = "Mistral transcription model (Voxtral). voxtral-small-transcribe-3-0 is more accurate and a bit dearer.";
          };

          tts = {
            model = lib.mkOption {
              type = lib.types.str;
              default = "voxtral-mini-tts-3-0";
              description = "Mistral text-to-speech model (Voxtral TTS).";
            };
            voices = {
              ro = lib.mkOption {
                type = lib.types.nullOr lib.types.str;
                default = "01a155a0-3dbb-7274-ab31-7fa1ebf35a3e"; # Irina
                description = "Voice id for Romanian replies (`sudo balaur-assistant-login` lists them); null = the API's default voice.";
              };
              en = lib.mkOption {
                type = lib.types.nullOr lib.types.str;
                default = "82c99ee6-f932-423f-a4a3-d403c8914b8d"; # Jane - Neutral (British)
                description = "Voice id for English replies; null = the API's default voice.";
              };
            };
          };

          audio = {
            input = lib.mkOption {
              type = lib.types.nullOr lib.types.str;
              default = null;
              example = "plughw:0,7";
              description = ''
                ALSA device to record from, when the machine's default microphone is
                not good enough for the wake word. It becomes the PipeWire source
                `balaur-mic`, the default microphone, which the assistant records from.
                The Duet sets it to its array's 16 kHz device (`arecord -l`: DMIC16kHz).
                null = record from whatever PipeWire's default source is, which is what
                an ordinary laptop microphone wants.
              '';
            };
            micGain = lib.mkOption {
              type = lib.types.ints.between 0 70;
              default = 65;
              description = ''
                Microphone level (ALSA 'Dmic0', 50 = 0 dB, 70 = +20 dB), applied to the
                card at each login. Only used together with `audio.input`: without it
                the machine's own mixer levels are left alone. The Duet's built-in
                array is quiet: 65 hears a normal voice across the room; lower it if it
                wakes on noise.
              '';
            };
          };

          webSearch = {
            enable = lib.mkEnableOption "web search for the assistant, through Mistral's web_search tool" // {
              default = true;
            };
            model = lib.mkOption {
              type = lib.types.str;
              default = "mistral-medium-latest";
              description = "Mistral model that runs the web searches (Conversations API).";
            };
          };

          newsFeeds = lib.mkOption {
            description = "RSS/Atom feeds for the news tool.";
            default = [
              {
                name = "Digi24";
                url = "https://www.digi24.ro/rss";
                lang = "ro";
              }
              {
                name = "HotNews";
                url = "https://hotnews.ro/feed";
                lang = "ro";
              }
              {
                name = "G4Media";
                url = "https://www.g4media.ro/feed";
                lang = "ro";
              }
              {
                name = "BBC World";
                url = "https://feeds.bbci.co.uk/news/world/rss.xml";
                lang = "en";
              }
              {
                name = "The Guardian";
                url = "https://www.theguardian.com/world/rss";
                lang = "en";
              }
            ];
            type = lib.types.listOf (
              lib.types.submodule {
                options = {
                  name = lib.mkOption { type = lib.types.str; };
                  url = lib.mkOption { type = lib.types.str; };
                  lang = lib.mkOption {
                    type = lib.types.enum [
                      "ro"
                      "en"
                    ];
                  };
                };
              }
            );
          };

          homeAssistant = {
            host = lib.mkOption {
              type = lib.types.nullOr lib.types.str;
              default = lib.findFirst (_: true) null hassHosts;
              defaultText = lib.literalMD "the fleet machine that runs Home Assistant, if any";
              description = ''
                The fleet machine whose Home Assistant the agent switches the house's
                devices through (its MCP server, /api/mcp; the "Model Context Protocol
                Server" integration in its UI). null: no house devices.
              '';
            };
            tokenFile = lib.mkOption {
              type = lib.types.nullOr lib.types.path;
              default = if useSops then config.sops.secrets.${houseToken}.path else null;
              defaultText = lib.literalMD "the shared `home-assistant-agent-token` sops secret with the `secrets` aspect, else null";
              description = ''
                File with a long-lived access token of Home Assistant's user for the
                assistant (not an administrator), readable by the group
                `balaur-assistant`. null: no house devices.
              '';
            };
          };
        };
      };

      config = lib.mkMerge [
        {
          # The daemon's desktop file (GNOME only shows notifications from known apps)
          # and its GSettings schema (model, voices; edited in the Balaur app).
          environment.systemPackages = [
            package
            login
            wakeTest
          ];
          services.desktopManager.gnome.sessionPath = [ package ];

          # ---- the wake word: the one local piece (upstream NixOS module), localhost only ----
          services.wyoming.openwakeword = {
            enable = true;
            uri = "tcp://127.0.0.1:${toString wakePort}";
            threshold = as.wakeThreshold;
            customModelsDirectories = [ wakewordDir ];
          };
          # It must keep up with the microphone even when the box is busy.
          systemd.services.wyoming-openwakeword.serviceConfig.CPUWeight = 1000;

          systemd.tmpfiles.rules = [
            # Drop custom wake word models (*.tflite) here; readable by the openWakeWord service.
            "d ${wakewordDir} 0755 root root -"
          ]
          ++ lib.optionals as.llm.manageApiKeyFile [
            # The API key file: root's, readable by the assistant's group. Skipped
            # when something else provides it — claiming /run/secrets here would
            # fight sops-nix for the directory.
            "d ${dirOf (toString as.llm.apiKeyFile)} 0711 root root -"
            "z ${toString as.llm.apiKeyFile} 0640 root balaur-assistant -"
          ];
          users.groups.balaur-assistant = { };
          users.users.${user}.extraGroups = [ "balaur-assistant" ];

          # ---- the assistant: a service of the household session ----
          systemd.user.services.balaur-assistant = {
            description = "Balaur voice assistant";
            wantedBy = [ "graphical-session.target" ];
            partOf = [ "graphical-session.target" ];
            after = [
              "graphical-session.target"
              "pipewire-pulse.service"
              "wireplumber.service"
            ];
            environment = {
              BALAUR_ASSISTANT_CONFIG = configFile;
              # The Mistral key when the GNOME Keyring has none (`sudo balaur-assistant-login`).
              BALAUR_ASSISTANT_KEY_FILE = toString as.llm.apiKeyFile;
              # Timers, reminders and "what time is it" use local time.
              TZ = config.time.timeZone;
            }
            # The fleet's AI entryway as pi reads it; without the `agent` aspect the
            # agent runs on pi's own Mistral provider, with the Mistral key.
            // lib.optionalAttrs (cfg ? agent) { BALAUR_PI_MODELS = toString cfg.agent.modelsFile; }
            # The house's devices: Home Assistant's MCP server and the assistant's token
            # there (balaur-home-agent reads the file only when it connects).
            // lib.optionalAttrs houseDevices {
              BALAUR_HOME_ASSISTANT_URL = "http://${
                if hass.host == me then "127.0.0.1" else fleet.${hass.host}.address
              }:${toString (hostConfig hass.host).services.home-assistant.config.http.server_port}/api/mcp";
              BALAUR_HOME_ASSISTANT_TOKEN_FILE = toString hass.tokenFile;
            };
            unitConfig.ConditionUser = user;
            serviceConfig = {
              # Lists, reminders and memory lived in duet-assistant before the rename
              # (2026-11-08). Carried over once, while the new directory is still
              # empty; delete this line once every machine has run it.
              ExecStartPre = lib.getExe (
                pkgs.writeShellApplication {
                  name = "balaur-assistant-migrate-state";
                  runtimeInputs = [ pkgs.coreutils ];
                  text = ''
                    old="''${XDG_STATE_HOME:-$HOME/.local/state}/duet-assistant"
                    if [ -d "$old" ] && [ -z "$(ls -A "$STATE_DIRECTORY")" ]; then
                      rmdir "$STATE_DIRECTORY"
                      mv "$old" "$STATE_DIRECTORY"
                    fi
                  '';
                }
              );
              ExecStart = lib.getExe package;
              Restart = "always";
              RestartSec = 3;
              CPUWeight = 1000;
              StateDirectory = "balaur-assistant";
              NoNewPrivileges = true;
              RestrictAddressFamilies = [
                "AF_UNIX"
                "AF_INET"
                "AF_INET6"
              ];
              LockPersonality = true;
              SystemCallArchitectures = "native";
              SystemCallFilter = [
                "@system-service"
                "~@privileged"
              ];
              UMask = "0077";
              # No MemoryDenyWriteExecute: GJS and Node compile JavaScript to machine code.
            };
          };

          services.pipewire.extraConfig.pipewire = lib.mkIf customMic {
            "60-balaur-mic"."context.objects" = [
              {
                factory = "adapter";
                args = {
                  "factory.name" = "api.alsa.pcm.source";
                  "node.name" = micNode;
                  "node.description" = "Microphone array";
                  "media.class" = "Audio/Source";
                  "api.alsa.path" = micHw;
                  "audio.format" = "S16LE";
                  "audio.rate" = 16000;
                  "audio.channels" = 2;
                  "audio.position" = [
                    "FL"
                    "FR"
                  ];
                  # The default microphone for every app, ahead of the 48 kHz DMIC and the headset jack.
                  "priority.session" = 2200;
                  "priority.driver" = 2200;
                };
              }
            ];
          };

          # The array's gain is the card's Dmic0 control. Our 16 kHz source has no
          # volume of its own, so set audio.micGain on the card at each login, once
          # WirePlumber has set the card up (it restores the mixer as it does). Nothing
          # else opens the 48 kHz "Digital Microphone", whose volume would move it.
          systemd.user.services.balaur-mic-gain = lib.mkIf customMic {
            description = "Microphone array gain";
            wantedBy = [ "pipewire-pulse.service" ];
            after = [
              "pipewire-pulse.service"
              "wireplumber.service"
            ];
            before = [ "balaur-assistant.service" ];
            unitConfig.ConditionUser = user;
            serviceConfig.Type = "oneshot";
            path = [
              pkgs.pulseaudio
              pkgs.alsa-utils
              pkgs.gnugrep
              pkgs.coreutils
            ];
            script = ''
              for _ in $(seq 20); do
                pactl list short sources | grep -q HiFi__Mic1__source && break
                sleep 1
              done
              sleep 1
              amixer -q -c 0 sset Dmic0 cap ${toString as.audio.micGain}
            '';
          };

          balaur.services = [
            {
              name = "Assistant";
              description = "Voice assistant · say “${
                lib.concatMapStringsSep " " (w: lib.toUpper (lib.substring 0 1 w) + lib.substring 1 (-1) w) (
                  lib.splitString "_" as.wakeWord
                )
              }”";
              icon = "🎙";
              unit = "user:balaur-assistant.service";
              desktopId = "org.balaur.Balaur.desktop";
              group = "Home";
            }
          ];
        }

        # The key from the repo: root's, readable by the assistant's group, which the
        # assistant's account is in. Declared only when sops-nix is there to read it.
        (lib.optionalAttrs useSops {
          sops.secrets.${keySecret} = {
            owner = "root";
            group = "balaur-assistant";
            mode = "0640";
          };
          # Home Assistant's token for the assistant's user there: the shared file, so
          # the voice on every machine can switch the house's devices.
          sops.secrets.${houseToken} = lib.mkIf (hass.host != null) {
            owner = "root";
            group = "balaur-assistant";
            mode = "0640";
          };
        })
      ];
    };
}
