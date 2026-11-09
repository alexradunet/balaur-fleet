{ lib, buildGoModule }:

buildGoModule {
  pname = "duet-camera";
  version = "0.1.0";

  src = lib.fileset.toSource {
    root = ../camera;
    fileset = ../camera;
  };

  # Standard library only, so there is nothing to vendor.
  vendorHash = null;
  env.CGO_ENABLED = "0";
  ldflags = [
    "-s"
    "-w"
  ];

  meta = {
    description = "RGB-IR camera pipeline for the Yoga Duet 7 front sensor (raw IPU6 frames to a webcam)";
    mainProgram = "duet-camera";
    platforms = [ "x86_64-linux" ];
  };
}
