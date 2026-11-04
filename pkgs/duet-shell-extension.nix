{ lib, stdenvNoCC }:

# GNOME Shell extension duet@duet.local (gnome/shell-extension/): the voice
# assistant's orb overlay and Quick Settings microphone toggle. Plain GJS
# and CSS, no settings schema, so installing is just copying the files.
let
  dir = ../gnome/shell-extension;
in
stdenvNoCC.mkDerivation (finalAttrs: {
  pname = "gnome-shell-extension-duet";
  version = "1";

  # Only what GNOME Shell loads; tools/ and the README stay in the repo.
  src = lib.fileset.toSource {
    root = dir;
    fileset = lib.fileset.unions [
      (dir + "/metadata.json")
      (dir + "/stylesheet.css")
      (lib.fileset.difference (lib.fileset.fileFilter (f: f.hasExt "js") dir) (dir + "/tools"))
    ];
  };

  installPhase = ''
    runHook preInstall
    dest=$out/share/gnome-shell/extensions/${finalAttrs.passthru.extensionUuid}
    mkdir -p "$dest"
    cp metadata.json stylesheet.css *.js "$dest"/
    runHook postInstall
  '';

  passthru = {
    extensionUuid = "duet@duet.local";
    extensionPortalSlug = "duet";
  };

  meta = {
    description = "Duet voice assistant in GNOME Shell: orb + captions overlay and a microphone toggle";
    platforms = lib.platforms.linux;
  };
})
