{ lib, buildGoModule }:

buildGoModule {
  pname = "duet-assistant";
  version = "0.1.0";

  src = lib.fileset.toSource {
    root = ../assistant;
    fileset = ../assistant;
  };

  # Standard library only, so there is nothing to vendor.
  vendorHash = null;
  env.CGO_ENABLED = "0";
  ldflags = [ "-s" "-w" ];

  meta = {
    description = "Private voice assistant (wake word, Romanian + English speech, OpenAI-compatible model with tools)";
    mainProgram = "duet-assistant";
    platforms = [ "x86_64-linux" ];
  };
}
