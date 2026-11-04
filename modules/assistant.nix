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
  # Go (headless, system service) or GJS + the pi SDK agent (desktop session).
  package = if cfg.desktop.enable
    then pkgs.callPackage ../pkgs/duet-assistant-gjs.nix { }
    else pkgs.callPackage ../pkgs/duet-assistant.nix { };
  amixer = "${pkgs.alsa-utils}/bin/amixer";
  wakewordDir = "/var/lib/duet-wakewords";

  ports = { wake = 10400; api = 8770; };

  # With the desktop on, the assistant is an app of the household session: a
  # systemd user service that records and plays through the session's PipeWire
  # like any other (GNOME shows the mic indicator; media and voice share the
  # speakers). Without it, a hardened system service that owns the ALSA devices.
  session = cfg.desktop.enable;
  user = cfg.desktop.user;

  # The array's dedicated 16 kHz device (DMIC16kHz), as its own PipeWire source.
  # PipeWire's stock "Digital Microphone" is the 48 kHz DMIC (hw:0,6), whose
  # processing leaves a voice far too quiet for the wake word.
  micNode = "duet-mic";
  micHw = lib.removePrefix "plug" as.audio.input;

  restart = if session
    then "systemctl --user -M ${user}@ restart duet-assistant.service"
    else "systemctl restart duet-assistant.service";

  configFile = pkgs.writeText "duet-assistant.json" (builtins.toJSON {
    listen = "127.0.0.1:${toString ports.api}";
    inherit (as) name defaultLanguage;
    audio = {
      inherit (as.audio) volume;
      input = if session then "pulse:${micNode}" else as.audio.input;
      output = if session then "pulse" else as.audio.output;
      card = "0";
    };
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
      install -d -m 711 "$(dirname "$key_file")"
      # Readable by the assistant's own group (the household account runs it with the desktop).
      install -m 640 -g duet-assistant /dev/null "$key_file"
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
      ${restart}
      echo "duet-assistant restarted. Try: curl -s localhost/api/assistant/status"
    '';
  };

  # `sudo duet-wake-test`: say the wake word a few times; prints its score each
  # time, to tune duet.assistant.wakeThreshold and audio.micGain with real voices.
  wakeTest = pkgs.writeShellApplication {
    name = "duet-wake-test";
    runtimeInputs = [ pkgs.alsa-utils pkgs.curl pkgs.coreutils pkgs.util-linux ];
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
      ${if session then ''
        # The assistant is a service of the household session: mute it over D-Bus.
        setmute() {
          runuser -u ${user} -- env DBUS_SESSION_BUS_ADDRESS="unix:path=/run/user/$(id -u ${user})/bus" \
            ${pkgs.glib.bin}/bin/gdbus call --session --dest org.duet.Assistant --object-path /org/duet/Assistant \
            --method org.freedesktop.DBus.Properties.Set org.duet.Assistant1 Muted "<$1>" >/dev/null || true
        }
      '' else ''
        setmute() { curl -s -X POST localhost:${toString ports.api}/mute -d "{\"muted\":$1}" >/dev/null || true; }
      ''}
      unmute() { setmute false; }
      trap unmute EXIT
      # Muted, it doesn't answer the wake words said for the test.
      setmute true
      sleep 0.5
      echo "Recording $secs s: $prompt."
      install -m 600 /dev/null "$rec"
      ${if session then ''
        # Through the session's PipeWire, from the same source the assistant uses.
        runuser -u ${user} -- env XDG_RUNTIME_DIR="/run/user/$(id -u ${user})" \
          timeout "$secs" ${pkgs.pulseaudio}/bin/parec --device=${micNode} --raw --format=s16le --rate=16000 --channels=1 > "$rec" || true
      '' else ''
        arecord -q -D ${as.audio.input} -f S16_LE -r 16000 -c 1 -t raw -d "$secs" "$rec"
      ''}
      "$py" ${./assistant/wake-test.py} "$model" "$rec" ${toString as.wakeThreshold}
    '';
  };
  # What the assistant process needs, as a system or a session service.
  unit = {
    description = "Duet voice assistant";
    path = [ pkgs.alsa-utils ] # arecord, aplay, amixer
      ++ lib.optional session pkgs.pulseaudio; # parec, pacat, pactl
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
      ExecStart = lib.getExe package;
      Restart = "always";
      RestartSec = 3;
      CPUWeight = 1000;
      LoadCredential = lib.mkIf (as.llm.apiKeyFile != null) [ "llm-key:${toString as.llm.apiKeyFile}" ];
      StateDirectory = "duet-assistant";
      NoNewPrivileges = true;
      RestrictAddressFamilies = [ "AF_UNIX" "AF_INET" "AF_INET6" ];
      LockPersonality = true;
      # GJS and Node JIT-compile: they need writable+executable memory.
      MemoryDenyWriteExecute = !session;
      SystemCallArchitectures = "native";
      SystemCallFilter = [ "@system-service" "~@privileged" ];
      UMask = "0077";
    };
  };
in
lib.mkIf as.enable (lib.mkMerge [
  {
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

    systemd.tmpfiles.rules = [
      # Drop custom wake word models (*.tflite) here; readable by the openWakeWord service.
      "d ${wakewordDir} 0755 root root -"
      # The API key: root's, readable by the assistant's group.
      "d ${dirOf (toString as.llm.apiKeyFile)} 0711 root root -"
      "z ${toString as.llm.apiKeyFile} 0640 root duet-assistant -"
    ];
    users.groups.duet-assistant = { };

    duet.dashboard.services = [{
      name = "Assistant";
      description = "Voice assistant · say “${lib.concatMapStringsSep " " (w: lib.toUpper (lib.substring 0 1 w) + lib.substring 1 (-1) w) (lib.splitString "_" as.wakeWord)}”";
      icon = "🎙";
      unit = if session then "user:duet-assistant.service" else "duet-assistant.service";
      group = "Home";
    }];
  }

  # ---- with the desktop: an app of the household session ----
  (lib.mkIf session {
    users.users.${user}.extraGroups = [ "duet-assistant" ];

    # Its desktop file (GNOME only shows notifications from known apps) and
    # its GSettings schema (model, server; edited in the Duet app) in the session.
    environment.systemPackages = [ package ];
    services.desktopManager.gnome.sessionPath = [ package ];

    systemd.user.services.duet-assistant = lib.mkMerge [
      unit
      {
        wantedBy = [ "graphical-session.target" ];
        partOf = [ "graphical-session.target" ];
        after = [ "graphical-session.target" "pipewire-pulse.service" "wireplumber.service" ];
        unitConfig.ConditionUser = user;
      }
    ];

    services.pipewire.extraConfig.pipewire."60-duet-mic" = {
      "context.objects" = [{
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
    systemd.user.services.duet-mic-gain = {
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
  })

  # ---- without it: a hardened system service that owns the ALSA devices ----
  (lib.mkIf (!session) {
    systemd.services.duet-assistant = lib.mkMerge [
      unit
      {
        wantedBy = [ "multi-user.target" ];
        wants = [ "network-online.target" "wyoming-openwakeword.service" ];
        after = [ "network-online.target" "sound.target" "wyoming-openwakeword.service" ];
        serviceConfig = {
          # Nothing else sets the mixer: switch the microphone on at a known
          # level and unmute the speakers. Volume itself is set by the service.
          ExecStartPre = [
            "${amixer} -q -c 0 sset Dmic0 cap ${toString as.audio.micGain}"
            "-${amixer} -q -c 0 sset Speaker 100% unmute"
          ];
          DynamicUser = true;
          SupplementaryGroups = [ "audio" "duet-assistant" ];
          DevicePolicy = "closed";
          DeviceAllow = [ "char-alsa rw" ];
          ProtectSystem = "strict";
          ProtectHome = true;
          PrivateTmp = true;
          ProtectControlGroups = true;
          ProtectKernelTunables = true;
          ProtectKernelModules = true;
          ProtectKernelLogs = true;
          ProtectHostname = true;
          ProtectClock = true;
          RestrictNamespaces = true;
          RestrictRealtime = true;
        };
      }
    ];
  })
])
