# balaur-home-agent: the voice assistant's brain, the installed pi in its home
# role (gnome/home-agent/). A launcher and one pi extension: TypeScript that pi
# runs as it is, so there is nothing to build and no dependency of our own.
# Started by the GJS daemon (pkgs/balaur-assistant-gjs.nix) in pi's RPC mode.
{
  lib,
  stdenvNoCC,
  bash,
  jq,
  systemd,
  nodejs_22,
  pi, # the fleet's pi (llm-agents), the one `agent.nix` installs
}:

stdenvNoCC.mkDerivation {
  pname = "balaur-home-agent";
  version = "0.1.0";

  src = lib.fileset.toSource {
    root = ../gnome/home-agent;
    fileset = lib.fileset.unions [
      ../gnome/home-agent/bin
      ../gnome/home-agent/index.ts
      ../gnome/home-agent/prompt.ts
      ../gnome/home-agent/web.ts
      ../gnome/home-agent/test
    ];
  };

  dontBuild = true;

  installPhase = ''
    runHook preInstall
    mkdir -p $out/bin $out/share/balaur-home-agent
    cp index.ts prompt.ts web.ts $out/share/balaur-home-agent/
    substitute bin/balaur-home-agent $out/bin/balaur-home-agent \
      --subst-var-by bash ${lib.getExe bash} \
      --subst-var-by jq ${lib.getExe jq} \
      --subst-var-by busctl ${systemd}/bin/busctl \
      --subst-var-by pi ${pi}/bin/pi \
      --subst-var-by share $out/share/balaur-home-agent
    chmod +x $out/bin/balaur-home-agent
    runHook postInstall
  '';

  # The real pi in RPC mode with the installed extension, against a model and a
  # daemon that the test plays itself: no network, no key, no session bus.
  doInstallCheck = true;
  nativeInstallCheckInputs = [ nodejs_22 ];
  installCheckPhase = ''
    runHook preInstallCheck
    export HOME=$TMPDIR
    BALAUR_HOME_AGENT=$out/bin/balaur-home-agent \
      node --disable-warning=ExperimentalWarning --test test/*.test.ts test/*.test.mjs
    runHook postInstallCheck
  '';

  meta = {
    description = "The Balaur voice assistant's agent: pi in its home role, with the household's tools";
    mainProgram = "balaur-home-agent";
    platforms = lib.platforms.linux;
  };
}
