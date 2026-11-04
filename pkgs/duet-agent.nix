# duet-agent: the voice assistant's brain, a pi SDK session (gnome/agent/),
# spawned by the GJS daemon (pkgs/duet-assistant-gjs.nix) over JSON lines.
# TypeScript run directly by Node 22 (type stripping): no build step.
{ lib, buildNpmPackage, nodejs_22, makeWrapper }:

buildNpmPackage {
  pname = "duet-agent";
  version = "0.1.0";

  src = lib.fileset.toSource {
    root = ../gnome/agent;
    fileset = lib.fileset.unions [
      ../gnome/agent/package.json
      ../gnome/agent/package-lock.json
      ../gnome/agent/src
      ../gnome/agent/test
    ];
  };

  nodejs = nodejs_22;
  npmDepsHash = "sha256-zi1jXSNVw1uNXt+VHXv7le+X5w9mAtd667VxP8AxdaA=";
  # No dependency needs its install script (protobufjs, @google/genai: optional extras).
  npmFlags = [ "--ignore-scripts" ];
  dontNpmBuild = true;

  nativeBuildInputs = [ makeWrapper ];

  # The tests run against pi's faux provider: no network, no key.
  doCheck = true;
  checkPhase = ''
    runHook preCheck
    HOME=$TMPDIR node --test test/*.test.ts
    runHook postCheck
  '';

  # Node refuses to strip types under node_modules, so the program lives in
  # lib/duet-agent (not lib/node_modules) next to its dependencies.
  installPhase = ''
    runHook preInstall
    mkdir -p $out/lib/duet-agent $out/bin
    cp -r package.json src node_modules $out/lib/duet-agent/
    makeWrapper ${nodejs_22}/bin/node $out/bin/duet-agent \
      --add-flags "--disable-warning=ExperimentalWarning $out/lib/duet-agent/src/main.ts" \
      --set-default PI_OFFLINE 1 \
      --set-default PI_SKIP_VERSION_CHECK 1 \
      --set-default PI_TELEMETRY 0
    runHook postInstall
  '';

  meta = {
    description = "The Duet voice assistant's agent: pi SDK, Mistral, the household's tools";
    mainProgram = "duet-agent";
    platforms = lib.platforms.linux;
  };
}
