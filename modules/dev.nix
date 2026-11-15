# Code directly on the box: agent harnesses plus the small tools they lean on.
# (pi, the OS agent, is its own aspect: agent.nix.)
# The agents come from numtide/llm-agents.nix (updated daily, binary-cached),
# not nixpkgs, which lags upstream by months. Bump them with:
#   nix flake update llm-agents && nixos-rebuild switch --flake .#$(hostname) --sudo
# Per-project toolchains come from `nix develop` (see each repo's flake).
#
# The development sessions live in Orca on the pc (`orca-server`): the other
# machines' Orca apps pair with it (Settings -> Remote Orca Servers), so the work
# stays there while a laptop sleeps.
{ inputs, ... }:
{
  flake.modules.nixos.dev =
    { pkgs, ... }:
    let
      agents = inputs.llm-agents.packages.${pkgs.stdenv.hostPlatform.system};
    in
    {
      environment.systemPackages = [
        agents.claude-code # `claude`
        agents.orca # desktop app for parallel agents, each in its own worktree (stablyai/orca)
      ]
      ++ (with pkgs; [
        gh
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
    };
}
