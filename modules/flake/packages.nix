# Our own packages (pkgs/), their checks, and the development shell.
#
# The packages are one overlay, `flake.overlays.default`. The `base` aspect puts
# it into every machine's nixpkgs, so an aspect says `pkgs.balaur-app` instead of
# calling pkgs/balaur-app.nix itself, and there is one definition of each.
{ ... }:
let
  overlay = final: _prev: {
    # lifelog, the life log as files (lifelog/, modules/lifelog.nix).
    lifelog = final.callPackage ../../pkgs/lifelog.nix { };
    lifelog-web = final.callPackage ../../pkgs/lifelog-web.nix { };
    balaur-app = final.callPackage ../../pkgs/balaur-app.nix { };
    balaur-shell-extension = final.callPackage ../../pkgs/balaur-shell-extension.nix { };
  };
in
{
  flake.overlays.default = overlay;

  perSystem =
    { pkgs, ... }:
    let
      inherit (pkgs.extend overlay)
        lifelog
        lifelog-web
        balaur-app
        balaur-shell-extension
        ;
    in
    {
      packages = {
        inherit
          lifelog
          lifelog-web
          balaur-app
          balaur-shell-extension
          ;
        default = balaur-app;
      };

      # lifelog, lifelog-web, the app and the Shell extension run their tests while building.
      checks = {
        inherit
          lifelog
          lifelog-web
          balaur-app
          balaur-shell-extension
          ;
        # `nix fmt` leaves nothing to change. hosts/ is machine-generated: left as written.
        formatting = pkgs.runCommand "balaur-formatting" { nativeBuildInputs = [ pkgs.nixfmt ]; } ''
          cd ${../..}
          nixfmt --check flake.nix
          find modules pkgs -name '*.nix' -exec nixfmt --check {} +
          touch $out
        '';

        # The Python that ships as it is, from modules/ (no package of its own, so no
        # build that would run a test): each file compiles, and the AI entryway's
        # router passes its tests (ai/test_router.py), against servers on loopback.
        python = pkgs.runCommand "balaur-python" { nativeBuildInputs = [ pkgs.python3 ]; } ''
          export PYTHONPYCACHEPREFIX=$TMPDIR/pyc
          python3 -m py_compile ${../ai/router.py} ${../media-search/filelist.py} ${../gaming/gamepad-awake.py}
          python3 -I ${../ai}/test_router.py
          touch $out
        '';

        # The agents' skills (.agents/skills, AGENTS.md): each a folder with a
        # SKILL.md whose `name` is the folder's and that has a description (the Agent
        # Skills format, which pi and Claude Code both read), and each linked into
        # .claude/skills, where Claude Code looks. pi finds them through its settings
        # (agent.nix).
        skills = pkgs.runCommand "balaur-skills" { } ''
          cd ${../..}
          fail=0
          bad() { echo "skill $1: $2" >&2; fail=1; }
          for dir in .agents/skills/*/; do
            n=$(basename "$dir")
            f=$dir/SKILL.md
            if [ ! -f "$f" ]; then bad "$n" "no SKILL.md"; continue; fi
            [ "$(head -1 "$f")" = --- ] || bad "$n" "SKILL.md does not start with --- (frontmatter)"
            front=$(sed -n '2,/^---$/p' "$f")
            name=$(printf '%s\n' "$front" | sed -n 's/^name: *//p')
            desc=$(printf '%s\n' "$front" | sed -n 's/^description: *//p')
            [ "$name" = "$n" ] || bad "$n" "name is '$name', not the folder's name"
            [[ $n =~ ^[a-z0-9]+(-[a-z0-9]+)*$ ]] && [ ''${#n} -le 64 ] \
              || bad "$n" "a name is lowercase letters, digits and single hyphens, at most 64"
            [ -n "$desc" ] && [ ''${#desc} -le 1024 ] || bad "$n" "needs a description of at most 1024 characters"
            [ "$(readlink ".claude/skills/$n")" = "../../.agents/skills/$n" ] \
              || bad "$n" "missing its link: ln -s ../../.agents/skills/$n .claude/skills/$n"
          done
          for l in .claude/skills/*; do
            [ -e "$l/SKILL.md" ] || bad "$(basename "$l")" "linked from .claude/skills but not in .agents/skills"
          done
          [ "$fail" = 0 ]
          touch $out
        '';
      };

      # `nix fmt`: every .nix file outside hosts/ (see the check above).
      formatter = pkgs.writeShellApplication {
        name = "balaur-fmt";
        runtimeInputs = [
          pkgs.nixfmt
          pkgs.findutils
        ];
        text = ''
          if [ $# -gt 0 ]; then exec nixfmt "$@"; fi
          nixfmt flake.nix
          find modules pkgs -name '*.nix' -exec nixfmt {} +
        '';
      };

      devShells.default = pkgs.mkShell {
        packages = [
          pkgs.go
          pkgs.gopls
          pkgs.gjs
          pkgs.nodejs_22
          pkgs.libadwaita
          pkgs.gtk4
        ];
        shellHook = ''
          echo "dev: lifelog/         go test ./..."
          echo "     gnome/app/       nix build .#balaur-app && ./result/bin/balaur-app"
        '';
      };
    };
}
