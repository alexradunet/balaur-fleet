# Our own packages (pkgs/), their checks, and the development shell.
{ self, inputs, ... }:
{
  perSystem =
    { pkgs, ... }:
    let
      duet-camera = pkgs.callPackage ../../pkgs/duet-camera.nix { };
      balaur-agent = pkgs.callPackage ../../pkgs/balaur-agent.nix { };
      balaur-assistant = pkgs.callPackage ../../pkgs/balaur-assistant-gjs.nix { inherit balaur-agent; };
      balaur-app = pkgs.callPackage ../../pkgs/balaur-app.nix { };
      balaur-shell-extension = pkgs.callPackage ../../pkgs/balaur-shell-extension.nix { };
      # aminte (github.com/alexradunet/aminte), served by modules/aminte.nix.
      aminte = pkgs.callPackage ../../pkgs/aminte.nix { src = inputs.aminte; };
    in
    {
      packages = {
        inherit
          duet-camera
          balaur-agent
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
