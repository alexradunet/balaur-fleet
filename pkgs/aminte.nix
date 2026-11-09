# aminte (github.com/alexradunet/aminte): the core and its extensions, in one bin/.
#
# Each extension is a Go module of its own (`replace aminte => ../..`), so each
# gets its own vendorHash. `serve --with NAME` looks for `aminte-NAME` beside
# os.Executable(), which resolves symlinks, so the binaries are copied into one
# folder rather than joined with symlinks.
{ lib, buildGoModule, go_1_27, runCommand, src }:

let
  buildGo = buildGoModule.override { go = go_1_27; };
  version = "0.1.0-${builtins.substring 0 7 (src.rev or "dirty")}";

  part = { name, modRoot ? ".", vendorHash }: buildGo {
    pname = name;
    inherit version src modRoot vendorHash;
    subPackages = [ "cmd/${name}" ];
    env.CGO_ENABLED = "0";
    ldflags = [ "-s" "-w" ];
    # The suites need a writable HOME, a model server stub and more; aminte runs them in its own CI.
    doCheck = false;
  };

  parts = [
    (part { name = "aminte"; vendorHash = "sha256-oMNEBAoHoxa0s/rK0efMUHq5H9QvzygoInSOwrQZ3YM="; })
    (part { name = "aminte-web"; modRoot = "extensions/web"; vendorHash = "sha256-qufZU9Gk0bQpWcP68PlMc9C7pwQkV+OHiofLDdXpbUM="; })
    (part { name = "aminte-ticktick"; modRoot = "extensions/ticktick"; vendorHash = "sha256-Ba77vKH41YndzoWunFj9MzxrZYa9aUXXkp/B+iDKFjk="; })
    (part { name = "aminte-mcp"; modRoot = "extensions/mcp"; vendorHash = "sha256-QPDJQkGLTJWTTVrmGd0wQQEjC7/PiZU1fDIl3WOnPBw="; })
    (part { name = "aminte-agentic-init"; modRoot = "extensions/agentic"; vendorHash = null; }) # standard library only
  ];
in
runCommand "aminte-${version}" {
  meta = {
    description = "aminte: a lifetime-scale, single-user SQLite life log, with its extensions";
    homepage = "https://github.com/alexradunet/aminte";
    mainProgram = "aminte";
  };
} ''
  mkdir -p $out/bin $out/share/aminte
  ${lib.concatMapStrings (p: "cp ${p}/bin/* $out/bin/\n") parts}
  cp ${src}/deploy/aminte-snapshot $out/share/aminte/
''
