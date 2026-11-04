# The voice assistant. Only the wake word is detected on this machine:
#
#   openWakeWord   127.0.0.1:10400   listens for "Hey Jarvis" (tiny, local, nothing leaves)
#   duet-assistant 127.0.0.1:8770    the pipeline (assistant/), the model's tools,
#                                    and the API behind the dashboard's Assistant tab
#
# After the wake word, everything goes to Mistral (EU) with one key:
#   Voxtral transcription (what you said), the chat model with tools (what to
#   do), Voxtral TTS (the voice), and the web_search tool. Audio is sent only
#   for the sentence after the wake word and is not kept here.
# No port is opened: the dashboard proxies /api/assistant/.
{ config, lib, pkgs, ... }:
let
  cfg = config.duet;
  as = cfg.assistant;
  package = pkgs.callPackage ../pkgs/duet-assistant.nix { };
  amixer = "${pkgs.alsa-utils}/bin/amixer";
  wakewordDir = "/var/lib/duet-wakewords";

  ports = { wake = 10400; api = 8770; };

  configFile = pkgs.writeText "duet-assistant.json" (builtins.toJSON {
    listen = "127.0.0.1:${toString ports.api}";
    inherit (as) name defaultLanguage;
    audio = { inherit (as.audio) input output volume; card = "0"; };
    wake = { uri = "127.0.0.1:${toString ports.wake}"; words = [ as.wakeWord ]; };
    stt.model = as.stt.model;
    tts = {
      inherit (as.tts) model;
      voices = lib.filterAttrs (_: v: v != null) as.tts.voices;
    };
    search.model = lib.optionalString as.webSearch.enable as.webSearch.model;
    llm = { inherit (as.llm) baseUrl model temperature; };
    location = { inherit (as.location) name latitude longitude; };
    newsFeeds = as.newsFeeds;
  });

  # The API key: state only, never in the repo or the store. Read from stdin so it
  # never shows up in the process list; checked against the API, which also
  # lists the voices to choose from (duet.assistant.tts.voices).
  login = pkgs.writeShellApplication {
    name = "duet-assistant-login";
    runtimeInputs = [ pkgs.coreutils pkgs.curl pkgs.jq pkgs.systemd ];
    text = ''
      if [ "$(id -u)" != 0 ]; then echo "run with sudo" >&2; exit 1; fi
      key_file=${lib.escapeShellArg (toString as.llm.apiKeyFile)}
      base=${lib.escapeShellArg as.llm.baseUrl}
      read -rsp "API key for $base (hidden): " key; echo
      [ -n "$key" ] || { echo "empty key, nothing saved" >&2; exit 1; }
      install -d -m 700 "$(dirname "$key_file")"
      install -m 600 /dev/null "$key_file"
      printf '%s' "$key" > "$key_file"
      api() { printf 'header = "Authorization: Bearer %s"\n' "$key" | curl -sS -m 15 -K - "$base$1"; }
      if api /models | jq -e '.data | length > 0' >/dev/null 2>&1; then
        echo "Saved. The API accepted the key."
        echo "Voices (set duet.assistant.tts.voices.ro / .en to an id; empty = the API's default):"
        api '/audio/voices?limit=100' | jq -r '.items[] | "  \(.id)  \(.languages | join(","))  \(.name)"' 2>/dev/null | sort -k2 \
          || echo "  (could not list them)"
      else
        echo "Saved, but $base/models did not accept it: check the key and duet.assistant.llm.baseUrl."
      fi
      systemctl restart duet-assistant.service
      echo "duet-assistant restarted. Try: curl -s localhost/api/assistant/status"
    '';
  };

  # `sudo duet-wake-test`: say the wake word a few times; prints its score each
  # time, to tune duet.assistant.wakeThreshold and audio.micGain with real voices.
  wakeTest = pkgs.writeShellApplication {
    name = "duet-wake-test";
    runtimeInputs = [ pkgs.alsa-utils pkgs.curl pkgs.coreutils ];
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
      unmute() { curl -s -X POST localhost:${toString ports.api}/mute -d '{"muted":false}' >/dev/null || true; }
      trap unmute EXIT
      # The assistant holds the microphone; muting it frees the device.
      curl -s -X POST localhost:${toString ports.api}/mute -d '{"muted":true}' >/dev/null || true
      sleep 0.5
      echo "Recording $secs s: $prompt."
      install -m 600 /dev/null "$rec"
      arecord -q -D ${as.audio.input} -f S16_LE -r 16000 -c 1 -t raw -d "$secs" "$rec"
      "$py" ${./assistant/wake-test.py} "$model" "$rec" ${toString as.wakeThreshold}
    '';
  };
in
lib.mkIf as.enable {
  environment.systemPackages = [ login wakeTest pkgs.alsa-utils ];

  # ---- the wake word: the one local piece (upstream NixOS module), localhost only ----
  services.wyoming.openwakeword = {
    enable = true;
    uri = "tcp://127.0.0.1:${toString ports.wake}";
    threshold = as.wakeThreshold;
    customModelsDirectories = [ wakewordDir ];
  };
  # It must keep up with the microphone even when the box is busy.
  systemd.services.wyoming-openwakeword.serviceConfig.CPUWeight = 1000;

  # Drop custom wake word models (*.tflite) here; readable by the openWakeWord service.
  systemd.tmpfiles.rules = [ "d ${wakewordDir} 0755 root root -" ];

  # ---- the assistant ----
  systemd.services.duet-assistant = {
    description = "Duet voice assistant";
    wantedBy = [ "multi-user.target" ];
    wants = [ "network-online.target" "wyoming-openwakeword.service" ];
    after = [ "network-online.target" "sound.target" "wyoming-openwakeword.service" ];
    path = [ pkgs.alsa-utils ]; # arecord, aplay, amixer
    environment = {
      DUET_ASSISTANT_CONFIG = configFile;
      # Timers, reminders and "what time is it" use local time.
      TZ = config.time.timeZone;
    };
    unitConfig = lib.mkIf (as.llm.apiKeyFile != null) {
      # Waits for `sudo duet-assistant-login`.
      ConditionPathExists = toString as.llm.apiKeyFile;
    };
    serviceConfig = {
      # Nothing else sets the mixer (no sound server): switch the microphone on at
      # a known level and unmute the speakers. Volume itself is set by the service.
      ExecStartPre = [
        "${amixer} -q -c 0 sset Dmic0 cap ${toString as.audio.micGain}"
        "-${amixer} -q -c 0 sset Speaker 100% unmute"
      ];
      ExecStart = lib.getExe package;
      Restart = "always";
      RestartSec = 3;
      CPUWeight = 1000;
      LoadCredential = lib.mkIf (as.llm.apiKeyFile != null) [ "llm-key:${toString as.llm.apiKeyFile}" ];

      DynamicUser = true;
      SupplementaryGroups = [ "audio" ];
      StateDirectory = "duet-assistant";
      DevicePolicy = "closed";
      DeviceAllow = [ "char-alsa rw" ];

      NoNewPrivileges = true;
      ProtectSystem = "strict";
      ProtectHome = true;
      PrivateTmp = true;
      ProtectControlGroups = true;
      ProtectKernelTunables = true;
      ProtectKernelModules = true;
      ProtectKernelLogs = true;
      ProtectHostname = true;
      ProtectClock = true;
      RestrictAddressFamilies = [ "AF_UNIX" "AF_INET" "AF_INET6" ];
      RestrictNamespaces = true;
      RestrictRealtime = true;
      LockPersonality = true;
      MemoryDenyWriteExecute = true;
      SystemCallArchitectures = "native";
      SystemCallFilter = [ "@system-service" "~@privileged" ];
      UMask = "0077";
    };
  };

  duet.dashboard.services = [{
    name = "Assistant";
    description = "Voice assistant · say “${lib.concatMapStringsSep " " (w: lib.toUpper (lib.substring 0 1 w) + lib.substring 1 (-1) w) (lib.splitString "_" as.wakeWord)}”";
    icon = "🎙";
    unit = "duet-assistant.service";
    group = "Home";
  }];
}
