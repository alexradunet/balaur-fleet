# Front camera (OVTI5678 sensor behind the Intel IPU6), a webcam for GNOME's
# Snapshot and video calls, and a presence sensor for the desktop.
#
# The sensor is RGB-IR (Lenovo: "IR + RGB hybrid"): a 4x4 colour filter with
# infrared pixels where an ordinary Bayer sensor has blue. Read as Bayer it
# comes out yellow-green, so the default chain does what the Windows driver's
# ISP does, in our own Go program (camera/):
#   patched kernel modules -> raw frames from the IPU6 capture node ->
#   duet-camera (RGB-IR rebuild, IR subtraction, AWB, CCM, gamma, AE) ->
#   v4l2loopback webcam "Duet Front Camera" (/dev/video64). The relay runs the
#   full pipeline only while something has the webcam open, and otherwise
#   looks at a few frames a second for movement (duet-presence, below).
# balaur.camera.backend = "libcamera" swaps duet-camera for libcamera + GStreamer
# (webcam only, no motion reporting).
# The kernel changes are kept in pkgs/ so they can be dropped once upstream has them.
{
  flake.modules.nixos.camera =
    {
      config,
      lib,
      pkgs,
      ...
    }:
    let
      cfg = config.balaur;
      cameraModules = config.boot.kernelPackages.callPackage ../pkgs/camera-modules.nix { };
      duetCamera = pkgs.duet-camera;
      v4l2loopback = config.boot.kernelPackages.v4l2loopback;
      rgbir = cfg.camera.backend == "rgbir";

      # Movement in front of the camera keeps the GNOME session active and wakes
      # its screen. The relay rewrites motionFile on movement; duet-presence (a
      # service of the household session) holds an idle inhibitor while there is
      # some and lifts GNOME's blank screen.
      motionWake = rgbir && cfg ? tablet && cfg.camera.screenTimeout > 0;
      # The relay's runtime directory outlives its restarts (RuntimeDirectoryPreserve),
      # so the directory duet-presence watches stays the same inode.
      runDir = "/run/duet-camera-relay";
      deviceFile = "${runDir}/device";
      motionFile = "${runDir}/motion";
      presence = pkgs.writeShellApplication {
        name = "duet-presence";
        runtimeInputs = [
          pkgs.inotify-tools
          pkgs.glib
          pkgs.gnome-session
          pkgs.coreutils
        ];
        text = ''
          timeout=${toString cfg.camera.screenTimeout}
          quiet="$XDG_RUNTIME_DIR/duet-presence-quiet"
          echo 0 > "$quiet"
          # The screen going dark or lighting up changes the light in the room,
          # which the camera sees as movement: ignore it for a few seconds after.
          gdbus monitor --session --dest org.gnome.ScreenSaver --object-path /org/gnome/ScreenSaver \
            | while read -r line; do
                case "$line" in *ActiveChanged*) date +%s > "$quiet" ;; esac
              done &
          holder=""
          # The previous hold has usually run out by the next movement, so its kill
          # fails: that must not count as an error (set -e), or the loop ends.
          release() { if [ -n "$holder" ]; then kill "$holder" 2>/dev/null || true; fi; }
          trap 'release; kill 0' EXIT
          while :; do
            if [ ! -d "${runDir}" ]; then sleep 5; continue; fi
            # Read in this shell, not at the end of a pipe: if anything here fails,
            # the service exits and systemd restarts it. In a pipe, the reader died
            # alone while `inotifywait -m` kept running, so the service looked
            # healthy and ignored every movement after that.
            exec {events}< <(inotifywait -mq -e close_write -e delete_self -e move_self --format '%e %f' "${runDir}")
            watcher=$!
            while read -r event name <&"$events"; do
              # inotifywait -m keeps running on a directory that was deleted or
              # replaced and never reports anything again: watch the new one.
              case "$event" in *DELETE_SELF* | *MOVE_SELF*) break ;; esac
              [ "$name" = "${baseNameOf motionFile}" ] || continue
              [ $(( $(date +%s) - $(cat "$quiet") )) -ge 6 ] || continue
              # Wake the screen if GNOME blanked it (no-op otherwise)...
              gdbus call --session --dest org.gnome.ScreenSaver --object-path /org/gnome/ScreenSaver \
                --method org.gnome.ScreenSaver.SetActive false >/dev/null || true
              # ...and keep it from going idle for another screenTimeout.
              release
              gnome-session-inhibit --inhibit idle --app-id duet-presence \
                --reason "Someone is in front of the screen" sleep "$timeout" &
              holder=$!
            done
            kill "$watcher" 2>/dev/null || true
            exec {events}<&-
            sleep 2
          done
        '';
      };

      # The same movement as a motion sensor in Home Assistant, when this machine runs
      # it (home-assistant.nix): binary_sensor.<host>_motion, on with movement and off
      # after a quiet minute, for automations ("no one in the room: lights off").
      # duet-motion-hass calls a webhook of the local Home Assistant at most every
      # 20 s while there is movement; each call restarts the sensor's minute.
      # The webhook only answers the home network, and its id is no secret (the repo
      # is public): someone on the LAN could fake movement, not read anything.
      hassMotion = rgbir && config.services.home-assistant.enable;
      me = config.networking.hostName;
      webhookId = "balaur-${me}-camera-motion";
      hassPort = config.services.home-assistant.config.http.server_port or 8123;
      motionHass = pkgs.writeShellApplication {
        name = "duet-motion-hass";
        runtimeInputs = [
          pkgs.inotify-tools
          pkgs.curl
          pkgs.coreutils
        ];
        text = ''
          while :; do
            if [ ! -d "${runDir}" ]; then sleep 5; continue; fi
            # One event per inotifywait: a replaced directory is watched anew.
            # Exit 2 is the timeout, so a stale watch never lasts long.
            name="$(inotifywait -q -t 600 -e close_write --format '%f' "${runDir}")" || continue
            [ "$name" = "${baseNameOf motionFile}" ] || continue
            curl -fsS -m 5 -X POST -H 'Content-Type: application/json' -d '{}' \
              "http://127.0.0.1:${toString hassPort}/api/webhook/${webhookId}" \
              || echo "Home Assistant did not take the movement" >&2
            sleep 20
          done
        '';
      };

      gstPlugins =
        (with pkgs.gst_all_1; [
          gst-plugins-bad
          gst-plugins-base
          gst-plugins-good
          gstreamer.out
        ])
        ++ [ pkgs.libcamera ];

      cameraCheck = pkgs.writeShellApplication {
        name = "duet-camera-check";
        runtimeInputs = [
          pkgs.coreutils
          pkgs.nodejs
          pkgs.v4l-utils
        ];
        text = builtins.readFile ./camera-check.sh;
      };

      # Raw + processed snapshot from the running relay, for tuning (`duet-camera analyze`).
      # Only the rgbir relay saves one on SIGUSR1; gst-launch dies of it. The files
      # are readable by root only (the picture is of the room).
      cameraSnapshot = pkgs.writeShellApplication {
        name = "duet-camera-snapshot";
        runtimeInputs = [
          pkgs.coreutils
          pkgs.findutils
          pkgs.systemd
        ];
        text = ''
          systemctl kill --kill-whom=main -s USR1 duet-camera-relay.service
          sleep 2
          # newest two files (the .raw16 and the .png just written)
          find /var/lib/duet-camera/snapshots -maxdepth 1 -type f -printf '%T@ %p\n' \
            | sort -rn | head -n 2 | cut -d' ' -f2-
        '';
      };

      loopbackCtl = "${v4l2loopback.bin}/bin/v4l2loopback-ctl";

      # The relay's three steps. V4L2_DEVICE_FILE (the unit's environment) holds the
      # device the relay writes to.
      relayPrepare = pkgs.writeShellApplication {
        name = "duet-camera-relay-prepare";
        runtimeInputs = [ pkgs.coreutils ];
        text = ''
          # A viewer that kept the device open across a restart stops the stop step
          # from deleting it; reuse it then instead of failing on "File exists".
          if test -e /dev/video64 && ! ${loopbackCtl} delete /dev/video64; then
            echo /dev/video64 > "$V4L2_DEVICE_FILE"
          else
            ${loopbackCtl} add -x 1 -n "Duet Front Camera" /dev/video64 > "$V4L2_DEVICE_FILE"
          fi
        '';
      };

      relayRun = pkgs.writeShellApplication {
        name = "duet-camera-relay";
        runtimeInputs = [ pkgs.coreutils ];
        text =
          if rgbir then
            ''
              device="$(cat "$V4L2_DEVICE_FILE")"
              exec ${lib.getExe duetCamera} run -output "$device"
            ''
          else
            ''
              device="$(cat "$V4L2_DEVICE_FILE")"
              exec ${lib.getBin pkgs.gst_all_1.gstreamer}/bin/gst-launch-1.0 -q \
                libcamerasrc ! \
                videoconvert ! \
                'video/x-raw,format=YUY2,width=1280,height=720,framerate=30/1' ! \
                v4l2sink device="$device" sync=false
            '';
      };

      # Leaves the directory: duet-presence watches it across restarts.
      relayCleanup = pkgs.writeShellApplication {
        name = "duet-camera-relay-cleanup";
        runtimeInputs = [ pkgs.coreutils ];
        text = ''
          if test -s "$V4L2_DEVICE_FILE"; then
            ${loopbackCtl} delete "$(cat "$V4L2_DEVICE_FILE")" || true
          fi
          rm -f "$V4L2_DEVICE_FILE"
        '';
      };

      # /etc/duet-camera.json. The rgbir relay refuses a key it does not know and
      # then restarts every few seconds: let the build find the typo instead.
      tuningFile = pkgs.writeText "duet-camera.json" (builtins.toJSON cfg.camera.tuning);
      tuningChecked = pkgs.runCommand "duet-camera.json" { } ''
        ${lib.getExe duetCamera} check ${tuningFile}
        cp ${tuningFile} $out
      '';
    in
    {
      options.balaur = {
        camera = {
          backend = lib.mkOption {
            type = lib.types.enum [
              "rgbir"
              "libcamera"
            ];
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

          screenTimeout = lib.mkOption {
            type = lib.types.ints.unsigned;
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

          tuning = lib.mkOption {
            type = lib.types.attrsOf lib.types.anything;
            default = { };
            example = {
              cfa = "GIGI/RGBG/GIGI/BGRG";
              irCoeffs = [
                1.0
                0.9
                1.1
              ];
              flipV = true;
            };
            description = ''
              Overrides for the rgbir pipeline, written to /etc/duet-camera.json.
              Keys: sensor, capture, width, height, outWidth, outHeight, cfa,
              blackLevel, whiteLevel, irCoeffs, ccm, awbGains, saturation, flipH,
              flipV, view (color/raw/noir), aeTarget, maxGain, maxDigitalGain,
              antiFlicker, motionThreshold, motionArea, idleFps. Defaults are in
              camera/config.go. With the `rgbir` backend a key the daemon does not
              know, or a value out of range, fails the build (`duet-camera check`).
              Try values live first in
              /var/lib/duet-camera/tuning.json + `systemctl reload duet-camera-relay`.
            '';
          };
        };
      };

      config = {
        # Compiles three modules, not the kernel.
        boot.extraModulePackages = [
          cameraModules
          v4l2loopback
        ];
        boot.kernelModules = [ "v4l2loopback" ];
        # No devices at load time: the relay creates its own.
        boot.extraModprobeConfig = "options v4l2loopback devices=0";

        # The relay never switches the screen itself: GNOME blanks it (tablet.nix),
        # and movement is reported to the session as activity (below).
        environment.etc."duet-camera.json".source = if rgbir then tuningChecked else tuningFile;

        # A producer that stays running (v4l2-relayd's on-demand mode stalls after
        # the first black frame with v4l2loopback).
        systemd.services.duet-camera-relay = {
          description = "Front camera: raw sensor to V4L2 webcam relay (${cfg.camera.backend})";
          wantedBy = [ "multi-user.target" ];
          after = [
            "systemd-modules-load.service"
            "systemd-logind.service"
          ];
          restartTriggers = [ config.environment.etc."duet-camera.json".source ];

          environment = {
            V4L2_DEVICE_FILE = deviceFile;
          }
          // lib.optionalAttrs (motionWake || hassMotion) {
            DUET_MOTION_FILE = motionFile;
          }
          // lib.optionalAttrs (!rgbir) {
            GST_PLUGIN_PATH = lib.makeSearchPathOutput "lib" "lib/gstreamer-1.0" gstPlugins;
          };

          serviceConfig = {
            Type = "simple";
            ExecStartPre = lib.getExe relayPrepare;
            ExecStart = lib.getExe relayRun;
            ExecStopPost = lib.getExe relayCleanup;
            Restart = "always";
            # A start that keeps failing waits longer each time (up to 30 s) instead
            # of creating and deleting the webcam every two seconds.
            RestartSec = "2s";
            RestartSteps = 4;
            RestartMaxDelaySec = "30s";
            PrivateNetwork = true;
            PrivateTmp = true;
            # The device name and the motion file; kept across restarts.
            RuntimeDirectory = "duet-camera-relay";
            RuntimeDirectoryPreserve = "yes";
            # Snapshots and the live-tuning overlay (tuning.json) live here: the
            # pictures are of the room, so root only.
            StateDirectory = "duet-camera";
            StateDirectoryMode = "0750";
          }
          // lib.optionalAttrs rgbir {
            # Re-reads /etc/duet-camera.json + /var/lib/duet-camera/tuning.json without a restart.
            ExecReload = "${pkgs.coreutils}/bin/kill -HUP $MAINPID";
          };
        };

        systemd.user.services.duet-presence = lib.mkIf motionWake {
          description = "Camera movement as activity: keeps the screen awake, wakes it";
          wantedBy = [ "graphical-session.target" ];
          partOf = [ "graphical-session.target" ];
          after = [ "graphical-session.target" ];
          unitConfig.ConditionUser = cfg.tablet.user;
          serviceConfig = {
            ExecStart = lib.getExe presence;
            Restart = "always";
            RestartSec = 3;
          };
        };

        systemd.services.duet-motion-hass = lib.mkIf hassMotion {
          description = "Camera movement as a motion sensor in Home Assistant";
          wantedBy = [ "multi-user.target" ];
          after = [
            "duet-camera-relay.service"
            "home-assistant.service"
          ];
          serviceConfig = {
            ExecStart = lib.getExe motionHass;
            Restart = "always";
            RestartSec = 5;
            DynamicUser = true;
            ProtectSystem = "strict";
            ProtectHome = true;
            PrivateTmp = true;
          };
        };

        services.home-assistant.config.template = lib.mkIf hassMotion [
          {
            triggers = [
              {
                trigger = "webhook";
                webhook_id = webhookId;
                local_only = true;
                allowed_methods = [ "POST" ];
              }
            ];
            binary_sensor = [
              {
                name = "${me} motion";
                unique_id = webhookId;
                device_class = "motion";
                state = "on";
                auto_off = 60;
              }
            ];
          }
        ];

        # Your login can use the camera too (the household account already is in `video`).
        users.users.${cfg.user}.extraGroups = [ "video" ];

        environment.systemPackages = [
          duetCamera # `duet-camera probe` / `duet-camera analyze <raw>`
          pkgs.libcamera-qcam # `qcam`: talks to libcamera directly, for diagnosing
          pkgs.libcamera # `cam -l`, and raw dumps for `duet-camera analyze`
          pkgs.v4l-utils # v4l2-ctl, media-ctl
          cameraCheck
        ]
        ++ lib.optional rgbir cameraSnapshot;

        balaur.services = [
          {
            name = "Camera";
            description = "Front camera relay";
            icon = "📷";
            unit = "duet-camera-relay.service";
            desktopId = "org.gnome.Snapshot.desktop"; # GNOME's camera app shows the webcam
            group = "Home";
          }
        ];
      };
    };
}
