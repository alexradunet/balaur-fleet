# Code directly on the box: agent harnesses plus the small tools they lean on.
# (pi, the OS agent, is its own aspect: agent.nix.)
# The agents come from numtide/llm-agents.nix (updated daily, binary-cached),
# not nixpkgs, which lags upstream by months. Bump them with:
#   nix flake update llm-agents && nixos-rebuild switch --flake .#$(hostname) --sudo
# Per-project toolchains come from `nix develop` (see each repo's flake).
#
# `dev` opens the development sessions. They live in herdr on the fleet's dev host
# (dev-host.nix, the machine marked `devHost` in the registry), so `dev` there
# attaches to them, and `dev` anywhere else draws them over SSH. With no dev host in
# the fleet it is plain herdr on this machine.
{
  inputs,
  config,
  lib,
  ...
}:
let
  fleet = config.fleet;
  devHosts = lib.attrNames (lib.filterAttrs (_: h: h.devHost) fleet);
in
{
  flake.modules.nixos.dev =
    { config, pkgs, ... }:
    let
      agents = inputs.llm-agents.packages.${pkgs.stdenv.hostPlatform.system};
      # The sessions are here, or there is nowhere else to look for them.
      local = devHosts == [ ] || lib.elem config.networking.hostName devHosts;
      dev = pkgs.writeShellApplication {
        name = "dev";
        runtimeInputs = [
          agents.herdr
          pkgs.openssh
        ];
        text =
          if local then
            ''
              exec herdr "$@"
            ''
          else
            ''
              exec herdr --remote ${lib.escapeShellArg fleet.${lib.head devHosts}.address} "$@"
            '';
      };
    in
    {
      environment.systemPackages = [
        agents.claude-code # `claude`
        agents.herdr # workspace manager for agent sessions (herdr.dev)
        dev
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
