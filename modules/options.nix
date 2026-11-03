# Central `duet.*` options. Every feature module reads from here, and
# registers the services it runs on the dashboard via `duet.dashboard.services`.
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
        keyboard on the laptop (Ctrl+Alt+F2 for a login console).
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

    tv = {
      enable = mkEnableOption "Samsung (Tizen) TV remote control on the dashboard's TV tab, plus `duet-tv-sideload` for apps";

      host = mkOption {
        type = types.str;
        example = "192.168.50.106";
        description = "The TV's IP address. Reserve it in the router so it stays put.";
      };

      mac = mkOption {
        type = types.nullOr types.str;
        default = null;
        example = "a0:d7:f3:9f:2d:18";
        description = ''
          The TV's MAC address, for Wake-on-LAN (powering on from fully off). Needs
          "Power On with Mobile" on the TV (Settings → General → Network → Expert Settings).
        '';
      };

      name = mkOption {
        type = types.str;
        default = "TV";
        description = "Label on the TV tab.";
      };

      apps = mkOption {
        description = "App shortcuts on the TV tab. IDs: http://<tv>:8001/api/v2/applications/<id> answers for installed ones.";
        default = [ ];
        type = types.listOf (types.submodule {
          options = {
            name = mkOption { type = types.str; };
            id = mkOption { type = types.str; };
            icon = mkOption { type = types.str; default = "▶"; };
          };
        });
      };

      dashboardUrl = mkOption {
        type = types.str;
        default = "http://duet.local/";
        example = "http://192.168.50.233/";
        description = ''
          Where the "Duet" TV app (tv-app/, installed with `duet-tv-sideload dashboard`)
          finds this dashboard. Use the server's reserved LAN IP: TVs often can't resolve .local names.
        '';
      };
    };

    assistant = {
      enable = mkEnableOption ''
        the voice assistant: a local wake word, then Mistral for speech-to-text,
        the model with tools, the voice (Romanian and English) and web search; an
        Assistant tab on the dashboard. Set the API key with `sudo duet-assistant-login`'';

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
          description = "Mistral API base (OpenAI-compatible: the part before /chat/completions) (the part before /chat/completions). The model must support tool calling.";
        };
        model = mkOption {
          type = types.str;
          example = "mistral-small-latest";
          description = "Model name as the API expects it.";
        };
        apiKeyFile = mkOption {
          type = types.nullOr types.path;
          default = "/var/lib/secrets/duet-assistant-llm-key";
          description = ''
            File with the API key, written by `sudo duet-assistant-login`. The service
            waits until it exists. null for endpoints that need no key (a local server).
          '';
        };
        temperature = mkOption {
          type = types.nullOr types.float;
          default = null;
          description = "Sampling temperature; null leaves the provider's default.";
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
          description = "ALSA capture device. The Duet's microphone array, at 16 kHz (`arecord -l`: DMIC16kHz).";
        };
        output = mkOption {
          type = types.str;
          default = "plughw:0,0";
          description = "ALSA playback device (the built-in speakers).";
        };
        micGain = mkOption {
          type = types.ints.between 0 70;
          default = 65;
          description = "Microphone level (ALSA 'Dmic0', 50 = 0 dB, 70 = +20 dB). The built-in array is quiet: 65 hears a normal voice across the room; lower it if it wakes on noise.";
        };
        volume = mkOption {
          type = types.ints.between 0 100;
          default = 70;
          description = "Speaker volume at start (it can be changed by voice and on the dashboard).";
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

    kiosk.enable = mkEnableOption "touch kiosk on the built-in screen" // { default = true; };

    camera = {
      enable = mkEnableOption "front camera (patched kernel modules + webcam relay) with a live view on the dashboard's Camera tab";

      lanView = mkOption {
        type = types.bool;
        default = false;
        description = ''
          Also let browsers on the local network watch the live view. By
          default only the built-in screen and tailnet devices may (the
          dashboard has no login). Every screen shows a "camera live" badge
          while anyone is watching. Needs the `rgbir` backend.
        '';
      };

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
          Seconds without movement in front of the camera (or a touch or key)
          before the built-in screen's backlight goes off; it comes back on at
          the next movement or touch. The tap that wakes the screen is not
          passed on to the dashboard. 0 = screen always on.
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

    dashboard = {
      listen = mkOption {
        type = types.str;
        default = "0.0.0.0:80";
        description = "Address the dashboard binds to.";
      };
      services = mkOption {
        default = [ ];
        description = "Tiles shown on the dashboard. Feature modules append to this.";
        type = types.listOf (types.submodule {
          options = {
            name = mkOption { type = types.str; };
            description = mkOption { type = types.str; default = ""; };
            icon = mkOption { type = types.str; default = "•"; };
            port = mkOption { type = types.nullOr types.port; default = null; };
            path = mkOption { type = types.str; default = ""; };
            unit = mkOption {
              type = types.str;
              default = "";
              description = "systemd unit whose state is shown on the tile.";
            };
            group = mkOption { type = types.str; default = "Other"; };
          };
        });
      };
    };
  };
}
