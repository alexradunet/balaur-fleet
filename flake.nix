{
  description = "Opinionated home server on a Lenovo Yoga Duet 7 (13ITL6), with a GNOME tablet desktop";

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
      duet-camera = pkgs.callPackage ./pkgs/duet-camera.nix { };
      duet-agent = pkgs.callPackage ./pkgs/duet-agent.nix { };
      duet-assistant = pkgs.callPackage ./pkgs/duet-assistant-gjs.nix { inherit duet-agent; };
      duet-app = pkgs.callPackage ./pkgs/duet-app.nix { };
      duet-shell-extension = pkgs.callPackage ./pkgs/duet-shell-extension.nix { };
    in
    {
      nixosConfigurations.duet = nixpkgs.lib.nixosSystem {
        inherit system;
        specialArgs = { inherit llm-agents; };
        modules = [ ./hosts/duet ];
      };

      packages.${system} = {
        inherit duet-camera duet-agent duet-assistant duet-app duet-shell-extension;
        # The patched camera modules for the kernel the system actually boots (`nix build .#camera-modules` checks the patch still applies).
        camera-modules = self.nixosConfigurations.duet.config.boot.kernelPackages.callPackage ./pkgs/camera-modules.nix { };
        default = duet-app;
      };

      # duet-agent and duet-camera run their tests while building; the assistant's
      # are `./result/libexec/duet-assistant-tests` (they need a session bus).
      checks.${system} = { inherit duet-camera duet-agent duet-assistant duet-app duet-shell-extension; };

      devShells.${system}.default = pkgs.mkShell {
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
