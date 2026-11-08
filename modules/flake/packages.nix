# Our own packages (pkgs/), their checks, and the development shell.
{ self, ... }:
{
  perSystem =
    { pkgs, ... }:
    let
      duet-camera = pkgs.callPackage ../../pkgs/duet-camera.nix { };
      duet-agent = pkgs.callPackage ../../pkgs/duet-agent.nix { };
      duet-assistant = pkgs.callPackage ../../pkgs/duet-assistant-gjs.nix { inherit duet-agent; };
      duet-app = pkgs.callPackage ../../pkgs/duet-app.nix { };
      duet-shell-extension = pkgs.callPackage ../../pkgs/duet-shell-extension.nix { };
    in
    {
      packages = {
        inherit duet-camera duet-agent duet-assistant duet-app duet-shell-extension;
        # The patched camera modules for the kernel the Duet actually boots (`nix build .#camera-modules` checks the patch still applies).
        camera-modules = self.nixosConfigurations.balaur.config.boot.kernelPackages.callPackage ../../pkgs/camera-modules.nix { };
        default = duet-app;
      };

      # duet-agent and duet-camera run their tests while building; the assistant's
      # are `./result/libexec/duet-assistant-tests` (they need a session bus).
      checks = { inherit duet-camera duet-agent duet-assistant duet-app duet-shell-extension; };

      devShells.default = pkgs.mkShell {
        packages = [ pkgs.go pkgs.gopls pkgs.gjs pkgs.nodejs_22 pkgs.libadwaita pkgs.gtk4 ];
        shellHook = ''
          echo "dev: camera/          go test ./..."
          echo "     gnome/agent/     npm test"
          echo "     gnome/assistant/ nix build .#duet-assistant && ./result/libexec/duet-assistant-tests"
          echo "     gnome/app/       nix build .#duet-app && ./result/bin/duet-app"
        '';
      };
    };
}
