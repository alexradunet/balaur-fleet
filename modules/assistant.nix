# The voice assistant, an app of the household's GNOME session (gnome/):
#
#   openWakeWord    127.0.0.1:10400   listens for "Hey Jarvis" (tiny, local, nothing leaves)
#   duet-assistant  session service   the GJS daemon: microphone and speaker through
#                                     PipeWire, Voxtral speech, timers, lists, memory,
#                                     notifications; D-Bus org.duet.Assistant
#   duet-agent      its child         the brain, on the pi SDK: the model and its tools
#
# After the wake word, Mistral (EU) does the rest: Voxtral transcription (what
# you said), the model with tools (what to do; any provider pi supports, set in
# the Duet app), Voxtral TTS (the voice), and the web_search tool. Audio is sent
# only for the sentence after the wake word and is not kept here.
{ config, lib, pkgs, ... }:
let
  cfg = config.duet;
  as = cfg.assistant;
  user = cfg.desktop.user;
  package = pkgs.callPackage ../pkgs/duet-assistant-gjs.nix { };
  wakewordDir = "/var/lib/duet-wakewords";
  wakePort = 10400;

  # The array's dedicated 16 kHz device (DMIC16kHz), as its own PipeWire source.
  # PipeWire's stock "Digital Microphone" is the 48 kHz DMIC (hw:0,6), whose
  # processing leaves a voice far too quiet for the wake word.
  micNode = "duet-mic";
  micHw = lib.removePrefix "plug" as.audio.input;

  # Defaults for the daemon; the model, server and voices can be changed in the
  # Duet app (GSettings org.duet.Assistant), which then take precedence.
  configFile = pkgs.writeText "duet-assistant.json" (builtins.toJSON {
    inherit (as) name defaultLanguage;
    audio = { input = "pulse:${micNode}"; output = "pulse"; card = "0"; };
    wake = { uri = "127.0.0.1:${toString wakePort}"; words = [ as.wakeWord ]; };
    stt.model = as.stt.model;
    tts = {
      inherit (as.tts) model;
      voices = lib.filterAttrs (_: v: v != null) as.tts.voices;
    };
    search.model = lib.optionalString as.webSearch.enable as.webSearch.model;
    llm = { inherit (as.llm) baseUrl model; };
    location = { inherit (as.location) name latitude longitude; };
    newsFeeds = as.newsFeeds;
  });

  inSession = cmd: ''runuser -u ${user} -- env XDG_RUNTIME_DIR="/run/user/$(id -u ${user})" DBUS_SESSION_BUS_ADDRESS="unix:path=/run/user/$(id -u ${user})/bus" ${cmd}'';

  # The API key from a terminal: state only, never in the repo or the store. Read
  # from stdin so it never shows up in the process list; checked against the API,
  # which also lists the voices to choose from. The Duet app's Assistant settings
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
        echo "Voices (set duet.assistant.tts.voices.ro / .en, or in the Duet app; empty = the API's default):"
        api '/audio/voices?limit=100' | jq -r '.items[] | "  \(.id)  \(.languages | join(","))  \(.name)"' 2>/dev/null | sort -k2 \
          || echo "  (could not list them)"
      else
        echo "Saved, but $base/models did not accept it: check the key and duet.assistant.llm.baseUrl."
      fi
      ${inSession "systemctl --user restart duet-assistant.service"} \
        && echo "duet-assistant restarted." || echo "Log in to the desktop to start the assistant."
    '';
  };

  # `sudo duet-wake-test`: say the wake word a few times; prints its score each
  # time, to tune duet.assistant.wakeThreshold and audio.micGain with real voices.
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
        ${inSession ''gdbus call --session --dest org.duet.Assistant --object-path /org/duet/Assistant \
          --method org.freedesktop.DBus.Properties.Set org.duet.Assistant1 Muted "<$1>"''} >/dev/null || true
      }
      trap 'setmute false' EXIT
      setmute true
      echo "Recording $secs s: $prompt."
      install -m 600 /dev/null "$rec"
      # From the same PipeWire source the assistant uses.
      ${inSession ''timeout "$secs" parec --device=${micNode} --raw --format=s16le --rate=16000 --channels=1''} > "$rec" || true
      "$py" ${./assistant/wake-test.py} "$model" "$rec" ${toString as.wakeThreshold}
    '';
  };
in
lib.mkIf as.enable {
  assertions = [{
    assertion = cfg.desktop.enable;
    message = "duet.assistant runs in the desktop session: it needs duet.desktop.enable.";
  }];

  # The daemon's desktop file (GNOME only shows notifications from known apps)
  # and its GSettings schema (model, server, voices; edited in the Duet app).
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

  duet.services = [{
    name = "Assistant";
    description = "Voice assistant · say “${lib.concatMapStringsSep " " (w: lib.toUpper (lib.substring 0 1 w) + lib.substring 1 (-1) w) (lib.splitString "_" as.wakeWord)}”";
    icon = "🎙";
    unit = "user:duet-assistant.service";
    desktopId = "org.duet.Duet.desktop";
    group = "Home";
  }];
}
