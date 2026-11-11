{
  lib,
  stdenvNoCC,
  gjs,
  libsoup_3,
  tzdata,
}:

# GNOME Shell extension balaur@balaur.local (gnome/shell-extension/): the voice
# assistant's orb overlay, the Quick Settings microphone toggle and Home
# Assistant scenes, and the ambient screen. Plain GJS and CSS, no settings schema
# (they read /etc/balaur/ambient.json and house.json), so installing is just
# copying the files.
let
  dir = ../gnome/shell-extension;
in
stdenvNoCC.mkDerivation (finalAttrs: {
  pname = "gnome-shell-extension-balaur";
  version = "2";

  # What GNOME Shell loads, plus the tests; tools/ and the README stay in the repo.
  src = lib.fileset.toSource {
    root = dir;
    fileset = lib.fileset.unions [
      (dir + "/metadata.json")
      (dir + "/stylesheet.css")
      (lib.fileset.difference (lib.fileset.fileFilter (f: f.hasExt "js") dir) (dir + "/tools"))
    ];
  };

  # The Shell-free parts (ambient-data.js, and ambient-status.js's helpers): config, weather, photos, times, machines, services.
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
    description = "Balaur household screen in GNOME Shell: assistant orb overlay, microphone toggle, Home Assistant scenes, ambient screen";
    platforms = lib.platforms.linux;
  };
})
