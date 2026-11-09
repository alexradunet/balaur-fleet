# Steam, for a machine that plays games locally. Separate from `gaming` (Battle.net
# on Proton, add-ons) so a machine can have one without the other. Needs
# `nixpkgs.config.allowUnfree` in the host.
#
# Remote Play is not opened: streaming goes through Sunshine and Moonlight
# (`game-streaming`), which also covers non-Steam games and the whole desktop.
{
  flake.modules.nixos.steam =
    { ... }:
    {
      programs.steam.enable = true; # also brings 32-bit graphics and controller udev rules
      # `gamemoderun %command%` in a game's launch options raises its priority and
      # the CPU governor while it runs.
      programs.gamemode.enable = true;
    };
}
