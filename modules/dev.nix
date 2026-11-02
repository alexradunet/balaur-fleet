# Code directly on the box: agent harnesses plus the small tools they lean on.
# The agents come from numtide/llm-agents.nix (updated daily, binary-cached),
# not nixpkgs, which lags upstream by months. Bump them with:
#   nix flake update llm-agents && nixos-rebuild switch --flake .#duet --sudo
# Per-project toolchains come from `nix develop` (see each repo's flake).
{ config, lib, pkgs, llm-agents, ... }:
let
  cfg = config.duet;
  agents = llm-agents.packages.${pkgs.stdenv.hostPlatform.system};
in
lib.mkIf cfg.dev.enable {
  environment.systemPackages = [
    agents.claude-code # `claude`
    agents.pi # `pi` (pi.dev)
  ] ++ (with pkgs; [
    gh
    tmux # sessions that survive an SSH disconnect
    ripgrep
    fd
    tree
    nodejs
  ]);

  # Fetch the pre-built agents instead of compiling them on the Duet.
  nix.settings = {
    extra-substituters = [ "https://cache.numtide.com" ];
    extra-trusted-public-keys = [ "niks3.numtide.com-1:DTx8wZduET09hRmMtKdQDxNNthLQETkc/yaX7M4qK0g=" ];
  };

  # Lets prebuilt binaries that tools download at runtime (npm/pip packages,
  # language servers, agent helpers) run on NixOS.
  programs.nix-ld.enable = true;
}
