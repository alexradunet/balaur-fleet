# Duet: the household's GJS/libadwaita app (gnome/app/). No build step: the
# ES modules are copied as they are and bin/duet-app runs them with gjs;
# wrapGAppsHook4 wraps that launcher so the GTK 4 / libadwaita typelibs (and
# their data) resolve regardless of the session's environment.
{
  lib,
  stdenv,
  runtimeShell,
  gjs,
  glib,
  gtk4,
  libadwaita,
  gobject-introspection,
  wrapGAppsHook4,
  desktop-file-utils,
}:

stdenv.mkDerivation {
  pname = "duet-app";
  version = "0.1.0";

  src = lib.fileset.toSource {
    root = ../gnome/app;
    fileset = lib.fileset.unions [
      ../gnome/app/src
      ../gnome/app/data
    ];
  };

  nativeBuildInputs = [
    gobject-introspection # its setup hook collects GI_TYPELIB_PATH for the wrapper
    wrapGAppsHook4
    desktop-file-utils
  ];
  buildInputs = [
    gjs
    glib
    gtk4
    libadwaita
  ];

  dontBuild = true;

  installPhase = ''
    runHook preInstall

    mkdir -p $out/share/duet-app $out/bin
    cp -r src/. $out/share/duet-app/

    cat > $out/bin/duet-app <<EOF
    #!${runtimeShell}
    exec ${lib.getExe' gjs "gjs"} -m $out/share/duet-app/main.js "\$@"
    EOF
    chmod +x $out/bin/duet-app

    install -Dm644 data/org.balaur.Balaur.desktop -t $out/share/applications
    substituteInPlace $out/share/applications/org.balaur.Balaur.desktop \
      --replace-fail "Exec=duet-app" "Exec=$out/bin/duet-app"
    desktop-file-validate $out/share/applications/org.balaur.Balaur.desktop
    install -Dm644 data/org.balaur.Balaur.svg -t $out/share/icons/hicolor/scalable/apps

    runHook postInstall
  '';

  meta = {
    description = "The Duet home server's household app: assistant, lists, timers, memory, services";
    mainProgram = "duet-app";
    platforms = lib.platforms.linux;
  };
}
