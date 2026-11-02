{ lib, buildGoModule }:

buildGoModule {
  pname = "duet-dashboard";
  version = "0.1.0";

  src = lib.fileset.toSource {
    root = ../dashboard;
    fileset = ../dashboard;
  };

  # Standard library only, so there is nothing to vendor.
  vendorHash = null;
  env.CGO_ENABLED = "0";
  ldflags = [ "-s" "-w" ];

  meta = {
    description = "Status + control dashboard for the Yoga Duet 7 home server";
    mainProgram = "duet-dashboard";
  };
}
