# The flake's own wiring. `flake.modules.<class>.<aspect>` is where every other
# file in modules/ puts its piece: `nixos` for system config (later also
# `homeManager` for the user environment shared by every machine).
{ inputs, ... }:
{
  imports = [ inputs.flake-parts.flakeModules.modules ];

  systems = [ "x86_64-linux" ];
}
