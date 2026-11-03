# Front camera (OVTI5678 sensor behind the Intel IPU6), shown on the kiosk.
#
# The sensor is RGB-IR (Lenovo: "IR + RGB hybrid"): a 4x4 colour filter with
# infrared pixels where an ordinary Bayer sensor has blue. Read as Bayer it
# comes out yellow-green, so the default chain does what the Windows driver's
# ISP does, in our own Go program (camera/):
#   patched kernel modules -> raw frames from the IPU6 capture node ->
#   duet-camera (RGB-IR rebuild, IR subtraction, AWB, CCM, gamma, AE) ->
#   v4l2loopback webcam "Duet Front Camera" (/dev/video64) -> Chromium (kiosk only).
# duet.camera.backend = "libcamera" swaps duet-camera for libcamera + GStreamer.
# The kernel changes are kept in pkgs/ so they can be dropped once upstream has them.
{ config, lib, pkgs, ... }:
let
  cfg = config.duet;
  cameraModules = config.boot.kernelPackages.callPackage ../pkgs/camera-modules.nix { };
  duetCamera = pkgs.callPackage ../pkgs/duet-camera.nix { };
  v4l2loopback = config.boot.kernelPackages.v4l2loopback;
  rgbir = cfg.camera.backend == "rgbir";

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
    runtimeInputs = [ pkgs.coreutils pkgs.nodejs pkgs.v4l-utils ];
    text = builtins.readFile ./camera-check.sh;
  };

  # Raw + processed snapshot from the running relay, for tuning (`duet-camera analyze`).
  cameraSnapshot = pkgs.writeShellApplication {
    name = "duet-camera-snapshot";
    runtimeInputs = [ pkgs.coreutils pkgs.findutils pkgs.systemd ];
    text = ''
      systemctl kill -s USR1 duet-camera-relay.service
      sleep 2
      # newest two files (the .raw16 and the .png just written)
      find /var/lib/duet-camera/snapshots -maxdepth 1 -type f -printf '%T@ %p\n' \
        | sort -rn | head -n 2 | cut -d' ' -f2-
    '';
  };
in
lib.mkIf cfg.camera.enable {
  # Compiles three modules, not the kernel.
  boot.extraModulePackages = [ cameraModules v4l2loopback ];
  boot.kernelModules = [ "v4l2loopback" ];
  # No devices at load time: the relay creates its own.
  boot.extraModprobeConfig = "options v4l2loopback devices=0";

  environment.etc."duet-camera.json".text = builtins.toJSON cfg.camera.tuning;

  # A producer that stays running (v4l2-relayd's on-demand mode stalls after
  # the first black frame with v4l2loopback).
  systemd.services.duet-camera-relay = {
    description = "Front camera: raw sensor to V4L2 webcam relay (${cfg.camera.backend})";
    wantedBy = [ "multi-user.target" ];
    after = [ "systemd-modules-load.service" "systemd-logind.service" ];
    restartTriggers = [ config.environment.etc."duet-camera.json".source ];

    environment = {
      V4L2_DEVICE_FILE = "/run/duet-camera-relay/device";
    } // lib.optionalAttrs (!rgbir) {
      GST_PLUGIN_PATH = lib.makeSearchPathOutput "lib" "lib/gstreamer-1.0" gstPlugins;
    };

    preStart = ''
      install -d "$(dirname "$V4L2_DEVICE_FILE")"
      # A viewer (the kiosk) that kept the device open across a restart stops
      # postStop from deleting it; reuse it then instead of failing on "File exists".
      if test -e /dev/video64 && ! ${v4l2loopback.bin}/bin/v4l2loopback-ctl delete /dev/video64; then
        echo /dev/video64 > "$V4L2_DEVICE_FILE"
      else
        ${v4l2loopback.bin}/bin/v4l2loopback-ctl \
          add -x 1 -n "Duet Front Camera" /dev/video64 > "$V4L2_DEVICE_FILE"
      fi
    '';

    script =
      if rgbir then ''
        exec ${lib.getExe duetCamera} run -output "$(cat "$V4L2_DEVICE_FILE")"
      '' else ''
        device="$(cat "$V4L2_DEVICE_FILE")"
        exec ${lib.getBin pkgs.gst_all_1.gstreamer}/bin/gst-launch-1.0 -q \
          libcamerasrc ! \
          videoconvert ! \
          'video/x-raw,format=YUY2,width=1280,height=720,framerate=30/1' ! \
          v4l2sink device="$device" sync=false
      '';

    postStop = ''
      if test -s "$V4L2_DEVICE_FILE"; then
        ${v4l2loopback.bin}/bin/v4l2loopback-ctl \
          delete "$(cat "$V4L2_DEVICE_FILE")" || true
      fi
      rm -rf "$(dirname "$V4L2_DEVICE_FILE")"
    '';

    serviceConfig = {
      Type = "simple";
      Restart = "always";
      RestartSec = "2s";
      PrivateNetwork = true;
      PrivateTmp = true;
      # Snapshots and the live-tuning overlay (tuning.json) live here.
      StateDirectory = "duet-camera";
      StateDirectoryMode = "0755";
    } // lib.optionalAttrs rgbir {
      # Re-reads /etc/duet-camera.json + /var/lib/duet-camera/tuning.json without a restart.
      ExecReload = "${pkgs.coreutils}/bin/kill -HUP $MAINPID";
    };
  };

  # Your login can use the camera too (the kiosk user already is in `video`).
  users.users.${cfg.user}.extraGroups = [ "video" ];

  environment.systemPackages = [
    duetCamera # `duet-camera probe` / `duet-camera analyze <raw>`
    cameraSnapshot
    pkgs.libcamera-qcam # `qcam`: talks to libcamera directly, for diagnosing
    pkgs.libcamera # `cam -l`, and raw dumps for `duet-camera analyze`
    pkgs.v4l-utils # v4l2-ctl, media-ctl
    cameraCheck
  ];

  duet.dashboard.services = [{
    name = "Camera";
    description = "Front camera relay";
    icon = "📷";
    unit = "duet-camera-relay.service";
    group = "Home";
  }];
}
