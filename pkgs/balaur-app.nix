# Balaur: the household's GJS/libadwaita app (gnome/app/): the home's services
# and its people, and their overview search. No build step: the
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

  # The parts without GTK: format.js, the overview search and who opens what.
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

    # GNOME's overview search: the Shell finds the provider by the .ini and
    # starts the app for it by D-Bus activation (src/search-provider.js).
    install -Dm644 data/org.balaur.Balaur.search-provider.ini -t $out/share/gnome-shell/search-providers
    install -Dm644 data/org.balaur.Balaur.service -t $out/share/dbus-1/services
    substituteInPlace $out/share/dbus-1/services/org.balaur.Balaur.service \
      --replace-fail "Exec=balaur-app" "Exec=$out/bin/balaur-app"

    runHook postInstall
  '';

  meta = {
    description = "The Balaur home server's household app: the home's services and its people, and their overview search";
    mainProgram = "balaur-app";
    platforms = lib.platforms.linux;
  };
}
