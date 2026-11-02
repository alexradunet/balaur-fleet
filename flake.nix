{
  description = "Opinionated home server on a Lenovo Yoga Duet 7 (13ITL6), with a touch kiosk + web dashboard";

  inputs = {
    # Stable channel tarball (carries a flake.nix). Pinned by flake.lock.
    nixpkgs.url = "https://channels.nixos.org/nixos-26.05/nixexprs.tar.xz";

    # Daily-updated AI coding agents (Claude Code, pi, ...) with a binary cache.
    # Deliberately NOT following our nixpkgs: that keeps their cache hits.
    llm-agents.url = "git+https://github.com/numtide/llm-agents.nix";
  };

  # Binary cache for llm-agents. Also set in modules/dev.nix for after the first
  # rebuild; pass --accept-flake-config on the very first one to use it.
  nixConfig = {
    extra-substituters = [ "https://cache.numtide.com" ];
    extra-trusted-public-keys = [ "niks3.numtide.com-1:DTx8wZduET09hRmMtKdQDxNNthLQETkc/yaX7M4qK0g=" ];
  };

  outputs = { self, nixpkgs, llm-agents }:
    let
      system = "x86_64-linux";
      pkgs = nixpkgs.legacyPackages.${system};
      dashboard = pkgs.callPackage ./pkgs/dashboard.nix { };
      duet-camera = pkgs.callPackage ./pkgs/duet-camera.nix { };
    in
    {
      nixosConfigurations.duet = nixpkgs.lib.nixosSystem {
        inherit system;
        specialArgs = { inherit llm-agents; };
        modules = [ ./hosts/duet ];
      };

      packages.${system} = {
        inherit dashboard duet-camera;
        # The patched camera modules for the kernel the system actually boots (`nix build .#camera-modules` checks the patch still applies).
        camera-modules = self.nixosConfigurations.duet.config.boot.kernelPackages.callPackage ./pkgs/camera-modules.nix { };
        default = dashboard;
      };

      checks.${system} = { inherit dashboard duet-camera; };

      devShells.${system}.default = pkgs.mkShell {
        packages = [ pkgs.go pkgs.gopls ];
        shellHook = ''
          echo "dev: cd dashboard && go run .   (set DUET_CONFIG=<json> to load a service registry)"
        '';
      };
    };
}
