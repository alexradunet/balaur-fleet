{
  description = "Balaur: one repo, many heads. The NixOS fleet at home, starting with the Yoga Duet 7 tablet server";

  inputs = {
    # Stable channel tarball (carries a flake.nix). Pinned by flake.lock.
    nixpkgs.url = "https://channels.nixos.org/nixos-26.05/nixexprs.tar.xz";

    # Every file under modules/ is a flake-parts module (the dendritic pattern):
    # import-tree loads them all, each one defines an aspect, hosts pick aspects.
    flake-parts.url = "github:hercules-ci/flake-parts";
    flake-parts.inputs.nixpkgs-lib.follows = "nixpkgs";
    import-tree.url = "github:vic/import-tree";

    # The admin's user environment, shared by every machine (modules/home.nix).
    home-manager.url = "github:nix-community/home-manager/release-26.05";
    home-manager.inputs.nixpkgs.follows = "nixpkgs";

    # Daily-updated AI coding agents (Claude Code, pi, ...) with a binary cache.
    # Deliberately NOT following our nixpkgs: that keeps their cache hits.
    llm-agents.url = "git+https://github.com/numtide/llm-agents.nix";

    # Secrets: encrypted in the repo, decrypted into /run/secrets at activation
    # with each machine's own SSH host key (modules/secrets.nix).
    sops-nix.url = "github:Mic92/sops-nix";
    sops-nix.inputs.nixpkgs.follows = "nixpkgs";

    # aminte, the life log (modules/aminte.nix). Not a flake: pkgs/aminte.nix
    # builds it. To ship a change: push aminte, `nix flake update aminte`, deploy.
    aminte.url = "github:alexradunet/aminte";
    aminte.flake = false;
  };

  # Binary cache for llm-agents. Also set in modules/dev.nix for after the first
  # rebuild; pass --accept-flake-config on the very first one to use it.
  nixConfig = {
    extra-substituters = [ "https://cache.numtide.com" ];
    extra-trusted-public-keys = [ "niks3.numtide.com-1:DTx8wZduET09hRmMtKdQDxNNthLQETkc/yaX7M4qK0g=" ];
  };

  outputs = inputs: inputs.flake-parts.lib.mkFlake { inherit inputs; } (inputs.import-tree ./modules);
}
