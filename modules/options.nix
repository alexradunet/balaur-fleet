# Central `duet.*` options. Every feature module reads from here, and
# registers the services it runs in `duet.services` (the Duet app's Home page).
{ lib, ... }:
let
  inherit (lib) mkOption mkEnableOption types;
in
{
  options.duet = {
    user = mkOption {
      type = types.str;
      default = "duet";
      description = "Admin account (SSH + sudo).";
    };

    sshKeys = mkOption {
      type = types.listOf types.str;
      default = [ ];
      description = "Authorized SSH public keys for the admin account (optional while password login is on).";
    };

    ssh.passwordAuth = mkOption {
      type = types.bool;
      default = true;
      description = ''
        Allow SSH logins with the account password (LAN and tailnet). Convenient
        to start with; once you have keys in `duet.sshKeys`, set this to false.
      '';
    };

    ssh.lan = mkOption {
      type = types.bool;
      default = true;
      description = ''
        Accept SSH from the local network as well as over Tailscale (subject to `duet.ssh.passwordAuth`).
        Set to false to make Tailscale the only way in; recovery is then a
        keyboard on the laptop (Ctrl+Alt+F3 for a login console).
      '';
    };

    storage.root = mkOption {
      type = types.path;
      default = "/srv";
      description = "Root for bulk data (synced files).";
    };

    dev.enable = mkEnableOption "coding on the box (Claude Code, pi, herdr, gh)" // { default = true; };

    files.enable = mkEnableOption "file sync (Syncthing)";

    media.enable = mkEnableOption "media server: Jellyfin + qBittorrent (search & download), under storage.root/media";

    adblock.enable = mkEnableOption ''
      network-wide ad and tracker blocking (AdGuard Home on :53, web UI on :3000),
      including Samsung smart-TV ads and viewing-data tracking. Point a device's
      (or the router's) DNS at this machine to use it'';

    assistant = {
      enable = mkEnableOption ''
        the voice assistant ("Hey Jarvis", Romanian and English): a local wake word,
        Mistral's Voxtral for speech-to-text and the voice, and a pi SDK agent with
        tools for the thinking. Runs in the desktop session (needs duet.desktop).
        Set the API key in the Duet app (Assistant settings) or with
        `sudo duet-assistant-login`'';

      name = mkOption {
        type = types.str;
        default = "Jarvis";
        description = "What the assistant calls itself.";
      };

      defaultLanguage = mkOption {
        type = types.enum [ "ro" "en" ];
        default = "ro";
        description = "Language used when it cannot tell which one was spoken.";
      };

      wakeWord = mkOption {
        type = types.str;
        default = "hey_jarvis";
        description = ''
          openWakeWord model to listen for. Built in: hey_jarvis, alexa, hey_mycroft,
          hey_rhasspy, okay_nabu. A custom one: put `<name>.tflite` in
          /var/lib/duet-wakewords and set its name here (docs/SETUP.md, "Custom wake word").
        '';
      };

      wakeThreshold = mkOption {
        type = types.numbers.between 0.0 1.0;
        default = 0.5;
        description = "Wake word sensitivity: higher means fewer false wakes, but it may miss you.";
      };

      llm = {
        baseUrl = mkOption {
          type = types.str;
          example = "https://api.mistral.ai/v1";
          description = "Mistral API base for speech (Voxtral) and the default for the model. Changeable in the Duet app.";
        };
        model = mkOption {
          type = types.str;
          example = "mistral-small-latest";
          description = "Default model (Mistral, through pi; it must support tool calling). Changeable in the Duet app, with any provider pi supports.";
        };
        apiKeyFile = mkOption {
          type = types.path;
          default = "/var/lib/secrets/duet-assistant-llm-key";
          description = ''
            File with the Mistral API key, written by `sudo duet-assistant-login`: the
            fallback when the GNOME Keyring has none (keys saved in the Duet app go there).
          '';
        };
      };

      # Speech, voices and web search use the same Mistral endpoint and key as `llm`.
      stt.model = mkOption {
        type = types.str;
        default = "voxtral-mini-transcribe-3-0";
        description = "Mistral transcription model (Voxtral). voxtral-small-transcribe-3-0 is more accurate and a bit dearer.";
      };

      tts = {
        model = mkOption {
          type = types.str;
          default = "voxtral-mini-tts-3-0";
          description = "Mistral text-to-speech model (Voxtral TTS).";
        };
        voices = {
          ro = mkOption {
            type = types.nullOr types.str;
            default = null;
            description = "Voice id for Romanian replies (`sudo duet-assistant-login` lists them); null = the API's default voice.";
          };
          en = mkOption {
            type = types.nullOr types.str;
            default = null;
            description = "Voice id for English replies; null = the API's default voice.";
          };
        };
      };

      audio = {
        input = mkOption {
          type = types.str;
          default = "plughw:0,7";
          description = "ALSA device of the Duet's microphone array at 16 kHz (`arecord -l`: DMIC16kHz). It becomes the PipeWire source `duet-mic`, the default microphone, which the assistant records from.";
        };
        micGain = mkOption {
          type = types.ints.between 0 70;
          default = 65;
          description = "Microphone level (ALSA 'Dmic0', 50 = 0 dB, 70 = +20 dB). The built-in array is quiet: 65 hears a normal voice across the room; lower it if it wakes on noise.";
        };
      };

      location = {
        name = mkOption { type = types.str; default = "Bucharest"; description = "Home location, for weather and context."; };
        latitude = mkOption { type = types.float; default = 44.4268; };
        longitude = mkOption { type = types.float; default = 26.1025; };
      };

      webSearch = {
        enable = mkEnableOption "web search for the assistant, through Mistral's web_search tool" // { default = true; };
        model = mkOption {
          type = types.str;
          default = "mistral-medium-latest";
          description = "Mistral model that runs the web searches (Conversations API).";
        };
      };

      newsFeeds = mkOption {
        description = "RSS/Atom feeds for the news tool.";
        default = [
          { name = "Digi24"; url = "https://www.digi24.ro/rss"; lang = "ro"; }
          { name = "HotNews"; url = "https://hotnews.ro/feed"; lang = "ro"; }
          { name = "G4Media"; url = "https://www.g4media.ro/feed"; lang = "ro"; }
          { name = "BBC World"; url = "https://feeds.bbci.co.uk/news/world/rss.xml"; lang = "en"; }
          { name = "The Guardian"; url = "https://www.theguardian.com/world/rss"; lang = "en"; }
        ];
        type = types.listOf (types.submodule {
          options = {
            name = mkOption { type = types.str; };
            url = mkOption { type = types.str; };
            lang = mkOption { type = types.enum [ "ro" "en" ]; };
          };
        });
      };
    };

    network.enable = mkEnableOption "network + privacy (Tailscale, mDNS)" // { default = true; };
    network.tailscale.authKeyFile = mkOption {
      type = types.nullOr types.path;
      default = null;
      description = "File holding a Tailscale auth key. If null, run `sudo tailscale up` once by hand.";
    };

    power.chargeLimit = mkOption {
      type = types.nullOr (types.ints.between 50 100);
      default = 80;
      description = ''
        Battery charge ceiling in percent. The laptop battery acts as a small
        UPS; holding it at 80% keeps it healthy for years of 24/7 mains use.
        Best effort: applied only if the firmware exposes a control for it.
      '';
    };

    desktop = {
      enable = mkEnableOption ''
        GNOME on the built-in screen as a household tablet: auto-login, no lock,
        on-screen keyboard, rotation, Firefox, Jellyfin, and the Duet app'' // { default = true; };

      user = mkOption {
        type = types.str;
        default = "home";
        description = "The household account GNOME logs in as (created; it has no password).";
      };
    };

    camera = {
      enable = mkEnableOption "front camera (patched kernel modules + webcam relay): a webcam for GNOME Snapshot and calls, and movement that wakes the screen";

      backend = mkOption {
        type = types.enum [ "rgbir" "libcamera" ];
        default = "rgbir";
        description = ''
          How raw sensor frames become a webcam.
          `rgbir`: duet-camera (camera/), which treats the sensor as the RGB-IR
          part it is: rebuilds R/G/B, subtracts infrared, then auto white
          balance, colour matrix, gamma and auto exposure.
          `libcamera`: libcamera's software ISP via GStreamer. It reads the
          sensor as plain Bayer, which gives the yellow-green tint; kept as a
          fallback.
        '';
      };

      screenTimeout = mkOption {
        type = types.ints.unsigned;
        default = 120;
        description = ''
          Seconds of no activity before GNOME blanks the built-in screen (it never
          locks). Touch, keys and movement in front of the camera all count as
          activity: movement keeps the screen on and wakes it. 0 = always on.
          Needs the `rgbir` backend. Sensitivity: `tuning.motionThreshold`
          (luma change per cell, default 12) and `tuning.motionArea` (fraction
          of the picture, default 0.01); the relay logs the peak it saw every 30 s.
        '';
      };

      tuning = mkOption {
        type = types.attrsOf types.anything;
        default = { };
        example = {
          cfa = "GIGI/RGBG/GIGI/BGRG";
          irCoeffs = [ 1.0 0.9 1.1 ];
          flipV = true;
        };
        description = ''
          Overrides for the rgbir pipeline, written to /etc/duet-camera.json.
          Keys: sensor, capture, width, height, outWidth, outHeight, cfa,
          blackLevel, whiteLevel, irCoeffs, ccm, awbGains, saturation, flipH,
          flipV, view (color/raw/noir), aeTarget, maxGain, maxDigitalGain,
          antiFlicker, motionThreshold, motionArea. Defaults are in
          camera/config.go. Try values live first in
          /var/lib/duet-camera/tuning.json + `systemctl reload duet-camera-relay`.
        '';
      };
    };

    services = mkOption {
      default = [ ];
      description = ''
        The home's services, as listed on the Duet app's Home page (written to
        /etc/duet/services.json). Feature modules append to this.
      '';
      type = types.listOf (types.submodule {
        options = {
          name = mkOption { type = types.str; };
          description = mkOption { type = types.str; default = ""; };
          icon = mkOption { type = types.str; default = "•"; description = "An icon name, a file, or an emoji."; };
          port = mkOption { type = types.nullOr types.port; default = null; description = "Its web UI on this machine, if any."; };
          path = mkOption { type = types.str; default = ""; };
          unit = mkOption {
            type = types.str;
            default = "";
            description = "systemd unit whose state the app shows; `user:<unit>` for a unit of the household session (the voice assistant).";
          };
          group = mkOption { type = types.str; default = "Other"; };
          appIcon = mkOption {
            type = types.nullOr types.str;
            default = null;
            description = "Icon (name or file) for installing the service's web UI as a GNOME web app (GNOME Web's application mode); null = no app.";
          };
          desktopId = mkOption {
            type = types.nullOr types.str;
            default = null;
            description = "The GNOME app that opens this service (a desktop file id); a web app from appIcon fills it in.";
          };
        };
      });
    };
  };
}
