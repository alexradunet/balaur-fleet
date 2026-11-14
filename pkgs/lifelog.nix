{
  lib,
  buildGoModule,
  git,
}:

let
  root = ../lifelog;
in
buildGoModule {
  pname = "lifelog";
  version = "0.1.0";

  # The Go files, the module files and the test vectors only: a change to the
  # docs does not rebuild the package.
  src = lib.fileset.toSource {
    inherit root;
    fileset = lib.fileset.unions [
      (root + "/go.mod")
      (root + "/go.sum")
      (lib.fileset.fileFilter (file: file.hasExt "go") root)
      (root + "/check/testdata")
      (root + "/cmd/lifelog-import/testdata")
    ];
  };

  # golang.org/x/text (Unicode NFC and case folding); modernc.org/sqlite, for
  # lifelog-import only (a pure-Go SQLite: no cgo).
  vendorHash = "sha256-R5TjpZRIf0vv5Elgru9YhlV0ri0Hcz51g2zdykVWQBE=";
  env.CGO_ENABLED = "0";
  ldflags = [
    "-s"
    "-w"
  ];

  # The tests build throwaway git repositories (the history rules, restore).
  nativeCheckInputs = [ git ];

  meta = {
    description = "The life log as markdown and CSV files: the checker and the commands that write into the folder";
    mainProgram = "lifelog";
    platforms = lib.platforms.linux;
  };
}
