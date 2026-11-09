# balaur-assistant: the voice assistant daemon for the GNOME session, in GJS
# (gnome/assistant/). Runs as the systemd user service balaur-assistant.service
# (started by systemd, not D-Bus activated: no D-Bus service file). It spawns
# the agent (pkgs/balaur-agent.nix) for the model and its tools.
#
# Outputs: bin/balaur-assistant, libexec/balaur-assistant-tests,
# share/applications/org.balaur.Assistant.desktop (so GNOME accepts its
# notifications), share/glib-2.0/schemas (org.balaur.Assistant + gschemas.compiled).
{
  lib,
  stdenv,
  gjs,
  glib,
  gobject-introspection,
  wrapGAppsNoGuiHook,
  libsoup_3,
  libsecret,
  gst_all_1,
  pipewire,
  wireplumber,
  alsa-utils,
  balaur-agent, # the flake's overlay (modules/flake/packages.nix)
}:

stdenv.mkDerivation {
  pname = "balaur-assistant-gjs";
  version = "0.2.0";

  src = lib.fileset.toSource {
    root = ../gnome/assistant;
    fileset = ../gnome/assistant;
  };

  nativeBuildInputs = [
    wrapGAppsNoGuiHook
    gobject-introspection
    glib
  ];
  buildInputs = [
    gjs
    glib
    libsoup_3
    libsecret
    gst_all_1.gstreamer
    gst_all_1.gst-plugins-base
    gst_all_1.gst-plugins-good
    pipewire # its GStreamer plugin: pipewiresrc, pipewiresink
  ];

  dontBuild = true;

  installPhase = ''
    runHook preInstall
    app=$out/share/balaur-assistant
    mkdir -p $app/tests $out/bin $out/libexec $out/share/applications $out/share/glib-2.0/schemas
    cp *.js $app/
    cp tests/*.js $app/tests/
    install -m644 org.balaur.Assistant.desktop $out/share/applications/
    install -m644 org.balaur.Assistant.gschema.xml $out/share/glib-2.0/schemas/
    glib-compile-schemas --strict $out/share/glib-2.0/schemas

    cat > $out/bin/balaur-assistant <<SH
    #!${stdenv.shell}
    exec ${gjs}/bin/gjs -m $app/main.js "\$@"
    SH
    cat > $out/libexec/balaur-assistant-tests <<SH
    #!${stdenv.shell}
    exec ${gjs}/bin/gjs -m $app/tests/run.js "\$@"
    SH
    chmod +x $out/bin/balaur-assistant $out/libexec/balaur-assistant-tests
    runHook postInstall
  '';

  # wrapGAppsNoGuiHook adds GI_TYPELIB_PATH and GST_PLUGIN_SYSTEM_PATH_1_0
  # for the inputs above; these add the rest.
  preFixup = ''
    gappsWrapperArgs+=(
      --prefix XDG_DATA_DIRS : "$out/share"
      --prefix PATH : "${
        lib.makeBinPath [
          wireplumber
          alsa-utils
        ]
      }"
      --set-default BALAUR_AGENT "${lib.getExe balaur-agent}"
    )
  '';

  passthru = { inherit balaur-agent; };

  meta = {
    description = "Balaur voice assistant daemon for GNOME (GJS, GStreamer, PipeWire)";
    mainProgram = "balaur-assistant";
    platforms = lib.platforms.linux;
  };
}
