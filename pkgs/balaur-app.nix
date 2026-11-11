# Balaur: the household's GJS/libadwaita app (gnome/app/). No build step: the
# ES modules are copied as they are and bin/balaur-app runs them with gjs;
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
  pname = "balaur-app";
  version = "0.1.0";

  src = lib.fileset.toSource {
    root = ../gnome/app;
    fileset = lib.fileset.unions [
      ../gnome/app/src
      ../gnome/app/data
      ../gnome/app/tests
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

  # The helpers without GTK (gnome/app/src/format.js) and the daemon client's pure parts.
  doCheck = true;
  nativeCheckInputs = [ gjs ];
  checkPhase = ''
    runHook preCheck
    HOME=$TMPDIR LC_ALL=C gjs -m tests/test-app.js
    runHook postCheck
  '';

  installPhase = ''
    runHook preInstall

    mkdir -p $out/share/balaur-app $out/bin
    cp -r src/. $out/share/balaur-app/

    cat > $out/bin/balaur-app <<EOF
    #!${runtimeShell}
    exec ${lib.getExe' gjs "gjs"} -m $out/share/balaur-app/main.js "\$@"
    EOF
    chmod +x $out/bin/balaur-app

    install -Dm644 data/org.balaur.Balaur.desktop -t $out/share/applications
    substituteInPlace $out/share/applications/org.balaur.Balaur.desktop \
      --replace-fail "Exec=balaur-app" "Exec=$out/bin/balaur-app"
    desktop-file-validate $out/share/applications/org.balaur.Balaur.desktop
    install -Dm644 data/org.balaur.Balaur.svg -t $out/share/icons/hicolor/scalable/apps

    runHook postInstall
  '';

  meta = {
    description = "The Balaur home server's household app: assistant, lists, timers, memory, services";
    mainProgram = "balaur-app";
    platforms = lib.platforms.linux;
  };
}
