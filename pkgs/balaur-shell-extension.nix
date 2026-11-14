{
  lib,
  stdenvNoCC,
  gjs,
  libsoup_3,
  tzdata,
}:

# GNOME Shell extension balaur@balaur.local (gnome/shell-extension/): Home
# Assistant scenes in Quick Settings, and the ambient screen. Plain GJS and
# CSS, no settings schema (they read /etc/balaur/ambient.json and house.json),
# so installing is just copying the files.
let
  dir = ../gnome/shell-extension;
in
stdenvNoCC.mkDerivation (finalAttrs: {
  pname = "gnome-shell-extension-balaur";
  version = "3";

  # What GNOME Shell loads, plus the tests; the README stays in the repo.
  src = lib.fileset.toSource {
    root = dir;
    fileset = lib.fileset.unions [
      (dir + "/metadata.json")
      (dir + "/stylesheet.css")
      (lib.fileset.fileFilter (f: f.hasExt "js") dir)
    ];
  };

  # The Shell-free parts (ambient-data.js, ambient-status.js's helpers, house.js): config, weather, photos, clock, machines, services, scenes.
  doCheck = true;
  nativeCheckInputs = [ gjs ];
  checkPhase = ''
    runHook preCheck
    HOME=$TMPDIR TZDIR=${tzdata}/share/zoneinfo GI_TYPELIB_PATH=${libsoup_3}/lib/girepository-1.0 gjs -m tests/test-ambient.js
    runHook postCheck
  '';

  installPhase = ''
    runHook preInstall
    dest=$out/share/gnome-shell/extensions/${finalAttrs.passthru.extensionUuid}
    mkdir -p "$dest"
    cp metadata.json stylesheet.css *.js "$dest"/
    runHook postInstall
  '';

  passthru = {
    extensionUuid = "balaur@balaur.local";
    extensionPortalSlug = "balaur";
  };

  meta = {
    description = "Balaur household screen in GNOME Shell: Home Assistant scenes, ambient screen";
    platforms = lib.platforms.linux;
  };
})
