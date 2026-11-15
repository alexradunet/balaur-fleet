{
  lib,
  buildNpmPackage,
  nodejs_22,
  lifelog,
}:

let
  root = ../lifelog/web;
in
buildNpmPackage {
  pname = "lifelog-web";
  version = "0.1.0";

  src = lib.fileset.toSource {
    inherit root;
    fileset = lib.fileset.unions [
      (root + "/package.json")
      (root + "/package-lock.json")
      (root + "/src")
      (root + "/public")
      (root + "/test")
    ];
  };

  nodejs = nodejs_22;
  # markdown-it (and its five small dependencies) and htmx; nothing to build.
  npmDepsHash = "sha256-xwx9j7JXNU9CgMndvCkim/hMRHY1sjq98QkTRbEveM8=";
  dontNpmBuild = true;

  # The tests run the real lifelog: its rules are the ones the app relies on.
  doCheck = true;
  checkPhase = ''
    runHook preCheck
    LIFELOG_BIN=${lib.getExe lifelog} npm test
    runHook postCheck
  '';

  meta = {
    description = "The life folder on the phone: the journal, pages, readings and search, served on the server";
    mainProgram = "lifelog-web";
    platforms = lib.platforms.linux;
  };
}
