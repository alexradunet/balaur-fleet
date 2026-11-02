# Front camera (OVTI5678 sensor behind the Intel IPU), shown on the kiosk.
#
# Chromium cannot talk to the raw IPU nodes, so the chain is:
#   patched kernel modules -> libcamera -> GStreamer -> v4l2loopback webcam
#   ("Duet Front Camera", /dev/video64) -> Chromium getUserMedia (kiosk only).
# The kernel changes are kept in pkgs/ so they can be dropped once upstream has them.
{ config, lib, pkgs, ... }:
let
  cfg = config.duet;
  cameraModules = config.boot.kernelPackages.callPackage ../pkgs/camera-modules.nix { };
  v4l2loopback = config.boot.kernelPackages.v4l2loopback;

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
in
lib.mkIf cfg.camera.enable {
  # Compiles three modules, not the kernel.
  boot.extraModulePackages = [ cameraModules v4l2loopback ];
  boot.kernelModules = [ "v4l2loopback" ];
  # No devices at load time: the relay creates its own.
  boot.extraModprobeConfig = "options v4l2loopback devices=0";

  # A direct producer that stays running (v4l2-relayd's on-demand mode stalls
  # after the first black frame with this GStreamer/v4l2loopback combination).
  systemd.services.duet-camera-relay = {
    description = "Front camera: libcamera to V4L2 webcam relay";
    wantedBy = [ "multi-user.target" ];
    after = [ "systemd-modules-load.service" "systemd-logind.service" ];

    environment = {
      GST_PLUGIN_PATH = lib.makeSearchPathOutput "lib" "lib/gstreamer-1.0" gstPlugins;
      V4L2_DEVICE_FILE = "/run/duet-camera-relay/device";
    };

    preStart = ''
      install -d "$(dirname "$V4L2_DEVICE_FILE")"
      ${v4l2loopback.bin}/bin/v4l2loopback-ctl \
        add -x 1 -n "Duet Front Camera" /dev/video64 > "$V4L2_DEVICE_FILE"
    '';

    script = ''
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
    };
  };

  # Your login can use the camera too (the kiosk user already is in `video`).
  users.users.${cfg.user}.extraGroups = [ "video" ];

  environment.systemPackages = [
    pkgs.libcamera-qcam # `qcam`: talks to libcamera directly, for diagnosing
    pkgs.libcamera # `cam -l` lists cameras libcamera can see
    pkgs.v4l-utils
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
