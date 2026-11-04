# The voice assistant, an app of a GNOME session (gnome/):
#
#   openWakeWord    127.0.0.1:10400   listens for "Hey Jarvis" (tiny, local, nothing leaves)
#   duet-assistant  session service   the GJS daemon: microphone and speaker through
#                                     PipeWire, Voxtral speech, timers, lists, memory,
#                                     notifications; D-Bus org.balaur.Assistant
#   duet-agent      its child         the brain, on the pi SDK: the model and its tools
#
# After the wake word, Mistral (EU) does the rest: Voxtral transcription (what
# you said), the model with tools (what to do; any provider pi supports, set in
# the Balaur app), Voxtral TTS (the voice), and the web_search tool. Audio is sent
# only for the sentence after the wake word and is not kept here.
#
# It runs in the session of `balaur.assistant.user`, which defaults to the
# household account on a host with the `tablet` aspect and to the admin account
# otherwise. Give the host a session to run in — `gnome` plus `tablet` or
# `desktop` — since those also install its front end (the Balaur app and the Shell
# extension's orb and mic toggle).
{
  flake.modules.nixos.assistant =
    { config, lib, pkgs, ... }:
    let
      cfg = config.balaur;
      as = cfg.assistant;
      user = as.user;
      package = pkgs.callPackage ../pkgs/duet-assistant-gjs.nix { };
      wakewordDir = "/var/lib/duet-wakewords";
      wakePort = 10400;

      # A dedicated ALSA capture device as its own PipeWire source, for machines
      # whose default microphone is not good enough for the wake word. On the Duet
      # that is the array's 16 kHz device (DMIC16kHz): PipeWire's stock "Digital
      # Microphone" is the 48 kHz DMIC (hw:0,6), whose processing leaves a voice far
      # too quiet. Where `audio.input` is null we just use the server's default
      # source, which is what an ordinary laptop microphone wants.
      customMic = as.audio.input != null;
      micNode = "duet-mic";
      micHw = lib.removePrefix "plug" (toString as.audio.input);
      # What the daemon records from: "pulse" is the sound server's default source.
      inputDevice = if customMic then "pulse:${micNode}" else "pulse";
      # ... and what `parec` needs to read that same source in duet-wake-test.
      parecDevice = lib.optionalString customMic "--device=${micNode} ";

      # Defaults for the daemon; the model, server and voices can be changed in the
      # Balaur app (GSettings org.balaur.Assistant), which then take precedence.
      configFile = pkgs.writeText "duet-assistant.json" (builtins.toJSON {
        inherit (as) name defaultLanguage;
        audio = { input = inputDevice; output = "pulse"; card = "0"; };
        wake = { uri = "127.0.0.1:${toString wakePort}"; words = [ as.wakeWord ]; };
        stt.model = as.stt.model;
        tts = {
          inherit (as.tts) model;
          voices = lib.filterAttrs (_: v: v != null) as.tts.voices;
        };
        search.model = lib.optionalString as.webSearch.enable as.webSearch.model;
        llm = { inherit (as.llm) baseUrl model; };
        location = { inherit (cfg.location) name latitude longitude; };
        newsFeeds = as.newsFeeds;
      });

      inSession = cmd: ''runuser -u ${user} -- env XDG_RUNTIME_DIR="/run/user/$(id -u ${user})" DBUS_SESSION_BUS_ADDRESS="unix:path=/run/user/$(id -u ${user})/bus" ${cmd}'';

      # The API key from a terminal: state only, never in the repo or the store. Read
      # from stdin so it never shows up in the process list; checked against the API,
      # which also lists the voices to choose from. The Balaur app's Assistant settings
      # do the same from the screen (they keep keys in the GNOME Keyring instead).
      login = pkgs.writeShellApplication {
        name = "duet-assistant-login";
        runtimeInputs = [ pkgs.coreutils pkgs.curl pkgs.jq pkgs.systemd pkgs.util-linux ];
        text = ''
          if [ "$(id -u)" != 0 ]; then echo "run with sudo" >&2; exit 1; fi
          key_file=${lib.escapeShellArg (toString as.llm.apiKeyFile)}
          base=${lib.escapeShellArg as.llm.baseUrl}
          read -rsp "API key for $base (hidden): " key; echo
          [ -n "$key" ] || { echo "empty key, nothing saved" >&2; exit 1; }
          install -d -m 711 "$(dirname "$key_file")"
          # Readable by the assistant's group, which the household account is in.
          install -m 640 -g duet-assistant /dev/null "$key_file"
          printf '%s' "$key" > "$key_file"
          api() { printf 'header = "Authorization: Bearer %s"\n' "$key" | curl -sS -m 15 -K - "$base$1"; }
          if api /models | jq -e '.data | length > 0' >/dev/null 2>&1; then
            echo "Saved. The API accepted the key."
            echo "Voices (set balaur.assistant.tts.voices.ro / .en, or in the Balaur app; empty = the API's default):"
            api '/audio/voices?limit=100' | jq -r '.items[] | "  \(.id)  \(.languages | join(","))  \(.name)"' 2>/dev/null | sort -k2 \
              || echo "  (could not list them)"
          else
            echo "Saved, but $base/models did not accept it: check the key and balaur.assistant.llm.baseUrl."
          fi
          ${inSession "systemctl --user restart duet-assistant.service"} \
            && echo "duet-assistant restarted." || echo "Log in to the desktop to start the assistant."
        '';
      };

      # `sudo duet-wake-test`: say the wake word a few times; prints its score each
      # time, to tune balaur.assistant.wakeThreshold and audio.micGain with real voices.
      wakeTest = pkgs.writeShellApplication {
        name = "duet-wake-test";
        runtimeInputs = [ pkgs.coreutils pkgs.util-linux pkgs.glib.bin pkgs.pulseaudio ];
        text = ''
          if [ "$(id -u)" != 0 ]; then echo "run with sudo" >&2; exit 1; fi
          py=${pkgs.python3.withPackages (ps: [ ps.pyopen-wakeword ])}/bin/python3
          # The recording is kept (root only) for a second look:
          #   sudo duet-wake-test [seconds]           say the wake word a few times
          #   sudo duet-wake-test all [seconds]       compare every built-in wake word
          #   sudo duet-wake-test score [gain] [all]  rescore the last recording, optionally amplified
          rec=/var/tmp/duet-wake-test.raw
          if [ "''${1:-}" = score ]; then
            exec "$py" ${./assistant/wake-test.py} "''${3:-${as.wakeWord}}" "$rec" ${toString as.wakeThreshold} "''${2:-1}"
          fi
          model=${as.wakeWord}
          prompt="say \"${lib.replaceStrings [ "_" ] [ " " ] as.wakeWord}\" a few times, as you normally would"
          if [ "''${1:-}" = all ]; then
            model=all; shift
            prompt="say each twice, a few seconds apart: \"Hey Jarvis\", \"Alexa\", \"Hey Mycroft\", \"Okay Nabu\", \"Hey Rhasspy\""
          fi
          secs="''${1:-$( [ $model = all ] && echo 40 || echo 15 )}"
          # Muted, the assistant doesn't answer the wake words said for the test.
          setmute() {
            ${inSession ''gdbus call --session --dest org.balaur.Assistant --object-path /org/balaur/Assistant \
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
            type = lib.types.enum [ "ro" "en" ];
            default = "ro";
            description = "Language used when it cannot tell which one was spoken.";
          };

          wakeWord = lib.mkOption {
            type = lib.types.str;
            default = "hey_jarvis";
            description = ''
              openWakeWord model to listen for. Built in: hey_jarvis, alexa, hey_mycroft,
              hey_rhasspy, okay_nabu. A custom one: put `<name>.tflite` in
              /var/lib/duet-wakewords and set its name here (docs/SETUP.md, "Custom wake word").
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
              example = "https://api.mistral.ai/v1";
              description = "Mistral API base for speech (Voxtral) and the default for the model. Changeable in the Balaur app.";
            };
            model = lib.mkOption {
              type = lib.types.str;
              example = "mistral-small-latest";
              description = "Default model (Mistral, through pi; it must support tool calling). Changeable in the Balaur app, with any provider pi supports.";
            };
            apiKeyFile = lib.mkOption {
              type = lib.types.path;
              default = "/var/lib/secrets/duet-assistant-llm-key";
              description = ''
                File with the Mistral API key, written by `sudo duet-assistant-login`: the
                fallback when the GNOME Keyring has none (keys saved in the Balaur app go there).
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
                default = null;
                description = "Voice id for Romanian replies (`sudo duet-assistant-login` lists them); null = the API's default voice.";
              };
              en = lib.mkOption {
                type = lib.types.nullOr lib.types.str;
                default = null;
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
                `duet-mic`, the default microphone, which the assistant records from.
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
            enable = lib.mkEnableOption "web search for the assistant, through Mistral's web_search tool" // { default = true; };
            model = lib.mkOption {
              type = lib.types.str;
              default = "mistral-medium-latest";
              description = "Mistral model that runs the web searches (Conversations API).";
            };
          };

          newsFeeds = lib.mkOption {
            description = "RSS/Atom feeds for the news tool.";
            default = [
              { name = "Digi24"; url = "https://www.digi24.ro/rss"; lang = "ro"; }
              { name = "HotNews"; url = "https://hotnews.ro/feed"; lang = "ro"; }
              { name = "G4Media"; url = "https://www.g4media.ro/feed"; lang = "ro"; }
              { name = "BBC World"; url = "https://feeds.bbci.co.uk/news/world/rss.xml"; lang = "en"; }
              { name = "The Guardian"; url = "https://www.theguardian.com/world/rss"; lang = "en"; }
            ];
            type = lib.types.listOf (lib.types.submodule {
              options = {
                name = lib.mkOption { type = lib.types.str; };
                url = lib.mkOption { type = lib.types.str; };
                lang = lib.mkOption { type = lib.types.enum [ "ro" "en" ]; };
              };
            });
          };
        };
      };

      config = {
        # The daemon's desktop file (GNOME only shows notifications from known apps)
        # and its GSettings schema (model, server, voices; edited in the Balaur app).
        environment.systemPackages = [ package login wakeTest ];
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
          # The API key file: root's, readable by the assistant's group.
          "d ${dirOf (toString as.llm.apiKeyFile)} 0711 root root -"
          "z ${toString as.llm.apiKeyFile} 0640 root duet-assistant -"
        ];
        users.groups.duet-assistant = { };
        users.users.${user}.extraGroups = [ "duet-assistant" ];

        # ---- the assistant: a service of the household session ----
        systemd.user.services.duet-assistant = {
          description = "Duet voice assistant";
          wantedBy = [ "graphical-session.target" ];
          partOf = [ "graphical-session.target" ];
          after = [ "graphical-session.target" "pipewire-pulse.service" "wireplumber.service" ];
          environment = {
            DUET_ASSISTANT_CONFIG = configFile;
            # The Mistral key when the GNOME Keyring has none (`sudo duet-assistant-login`).
            DUET_ASSISTANT_KEY_FILE = toString as.llm.apiKeyFile;
            # Timers, reminders and "what time is it" use local time.
            TZ = config.time.timeZone;
          };
          unitConfig.ConditionUser = user;
          serviceConfig = {
            ExecStart = lib.getExe package;
            Restart = "always";
            RestartSec = 3;
            CPUWeight = 1000;
            StateDirectory = "duet-assistant";
            NoNewPrivileges = true;
            RestrictAddressFamilies = [ "AF_UNIX" "AF_INET" "AF_INET6" ];
            LockPersonality = true;
            SystemCallArchitectures = "native";
            SystemCallFilter = [ "@system-service" "~@privileged" ];
            UMask = "0077";
            # No MemoryDenyWriteExecute: GJS and Node compile JavaScript to machine code.
          };
        };

        services.pipewire.extraConfig.pipewire = lib.mkIf customMic {
          "60-duet-mic"."context.objects" = [{
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
              "audio.position" = [ "FL" "FR" ];
              # The default microphone for every app, ahead of the 48 kHz DMIC and the headset jack.
              "priority.session" = 2200;
              "priority.driver" = 2200;
            };
          }];
        };

        # The array's gain is the card's Dmic0 control. Our 16 kHz source has no
        # volume of its own, so set audio.micGain on the card at each login, once
        # WirePlumber has set the card up (it restores the mixer as it does). Nothing
        # else opens the 48 kHz "Digital Microphone", whose volume would move it.
        systemd.user.services.duet-mic-gain = lib.mkIf customMic {
          description = "Microphone array gain";
          wantedBy = [ "pipewire-pulse.service" ];
          after = [ "pipewire-pulse.service" "wireplumber.service" ];
          before = [ "duet-assistant.service" ];
          unitConfig.ConditionUser = user;
          serviceConfig.Type = "oneshot";
          path = [ pkgs.pulseaudio pkgs.alsa-utils pkgs.gnugrep pkgs.coreutils ];
          script = ''
            for _ in $(seq 20); do
              pactl list short sources | grep -q HiFi__Mic1__source && break
              sleep 1
            done
            sleep 1
            amixer -q -c 0 sset Dmic0 cap ${toString as.audio.micGain}
          '';
        };

        balaur.services = [{
          name = "Assistant";
          description = "Voice assistant · say “${lib.concatMapStringsSep " " (w: lib.toUpper (lib.substring 0 1 w) + lib.substring 1 (-1) w) (lib.splitString "_" as.wakeWord)}”";
          icon = "🎙";
          unit = "user:duet-assistant.service";
          desktopId = "org.balaur.Balaur.desktop";
          group = "Home";
        }];
      };
    };
}
