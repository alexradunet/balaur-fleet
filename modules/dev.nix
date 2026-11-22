# Code directly on the box: agent harnesses plus the small tools they lean on.
# (pi, the engine of the Balaur agent, is its own aspect: agent.nix.)
# The agents come from numtide/llm-agents.nix (updated daily, binary-cached),
# not nixpkgs, which lags upstream by months. Bump them with:
#   nix flake update llm-agents && nixos-rebuild switch --flake .#$(hostname) --sudo
# Per-project toolchains come from `nix develop` (see each repo's flake).
#
# The development sessions live on the server in zellij: `ssh server`, then
# `zellij attach -c dev` (any name). A session outlives the SSH connection, so the
# agents keep working while the laptop sleeps.
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
      ]
      ++ (with pkgs; [
        gh # GitHub, for other projects' repositories
        tea # Forgejo's issues and pull requests (`tea login add` once per machine)
        zellij # terminal multiplexer: sessions that outlive the SSH connection
        ripgrep
        fd
        tree
        nodejs
      ]);

      # Fetch the pre-built agents instead of compiling them on each machine.
      nix.settings = {
        extra-substituters = [ "https://cache.numtide.com" ];
        extra-trusted-public-keys = [ "niks3.numtide.com-1:DTx8wZduET09hRmMtKdQDxNNthLQETkc/yaX7M4qK0g=" ];
      };

      # Lets prebuilt binaries that tools download at runtime (npm/pip packages,
      # language servers, agent helpers) run on NixOS.
      programs.nix-ld.enable = true;
    };
}
