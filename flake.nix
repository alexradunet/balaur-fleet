{
  description = "Opinionated home server on a Lenovo Yoga Duet 7 (13IML05), with a touch kiosk + web dashboard";

  inputs = {
    # Stable channel tarball (carries a flake.nix). Pinned by flake.lock.
    nixpkgs.url = "https://channels.nixos.org/nixos-26.05/nixexprs.tar.xz";
  };

  outputs = { self, nixpkgs }:
    let
      system = "x86_64-linux";
      pkgs = nixpkgs.legacyPackages.${system};
      dashboard = pkgs.callPackage ./pkgs/dashboard.nix { };
    in
    {
      nixosConfigurations.duet = nixpkgs.lib.nixosSystem {
        inherit system;
        modules = [ ./hosts/duet ];
      };

      packages.${system} = {
        inherit dashboard;
        default = dashboard;
      };

      checks.${system}.dashboard = dashboard;

      devShells.${system}.default = pkgs.mkShell {
        packages = [ pkgs.go pkgs.gopls ];
        shellHook = ''
          echo "dev: cd dashboard && go run .   (set DUET_CONFIG=<json> to load a service registry)"
        '';
      };
    };
}
