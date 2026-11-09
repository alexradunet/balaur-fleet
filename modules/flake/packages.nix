# Our own packages (pkgs/), their checks, and the development shell.
#
# The packages are one overlay, `flake.overlays.default`. The `base` aspect puts
# it into every machine's nixpkgs, so an aspect says `pkgs.balaur-app` instead of
# calling pkgs/balaur-app.nix itself, and there is one definition of each.
{ self, inputs, ... }:
let
  overlay = final: _prev: {
    duet-camera = final.callPackage ../../pkgs/duet-camera.nix { };
    balaur-agent = final.callPackage ../../pkgs/balaur-agent.nix { };
    # The same pi `agent.nix` installs, in its home role (the assistant on pi).
    balaur-home-agent = final.callPackage ../../pkgs/balaur-home-agent.nix {
      pi = inputs.llm-agents.packages.${final.stdenv.hostPlatform.system}.pi;
    };
    balaur-assistant = final.callPackage ../../pkgs/balaur-assistant-gjs.nix { };
    balaur-app = final.callPackage ../../pkgs/balaur-app.nix { };
    balaur-shell-extension = final.callPackage ../../pkgs/balaur-shell-extension.nix { };
    # aminte (github.com/alexradunet/aminte), served by modules/aminte.nix.
    aminte = final.callPackage ../../pkgs/aminte.nix { src = inputs.aminte; };
  };
in
{
  flake.overlays.default = overlay;

  perSystem =
    { pkgs, ... }:
    let
      inherit (pkgs.extend overlay)
        duet-camera
        balaur-agent
        balaur-home-agent
        balaur-assistant
        balaur-app
        balaur-shell-extension
        aminte
        ;
    in
    {
      packages = {
        inherit
          duet-camera
          balaur-agent
          balaur-home-agent
          balaur-assistant
          balaur-app
          balaur-shell-extension
          aminte
          ;
        # The patched camera modules for the kernel the Duet actually boots (`nix build .#camera-modules` checks the patch still applies).
        camera-modules =
          self.nixosConfigurations.balaur.config.boot.kernelPackages.callPackage ../../pkgs/camera-modules.nix
            { };
        default = balaur-app;
      };

      # balaur-agent and duet-camera run their tests while building; the assistant's
      # are `./result/libexec/balaur-assistant-tests` (they need a session bus).
      checks = {
        inherit
          duet-camera
          balaur-agent
          balaur-home-agent
          balaur-assistant
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
          echo "dev: camera/          go test ./..."
          echo "     gnome/agent/     npm test"
          echo "     gnome/assistant/ nix build .#balaur-assistant && ./result/libexec/balaur-assistant-tests"
          echo "     gnome/app/       nix build .#balaur-app && ./result/bin/balaur-app"
        '';
      };
    };
}
