---
name: update-inputs
description: Update the Balaur fleet's flake inputs (nixpkgs, home-manager, sops-nix, llm-agents for Claude Code and pi, aminte) and check what changed before deploying. Use when asked to update, upgrade or bump packages, the agents, aminte, or move to a new NixOS release.
---

# Update inputs

One input per commit, so a regression points at one change.

```sh
nix flake metadata | sed -n '/Inputs/,$p'        # what is locked, and when
nix flake update <input>                         # nixpkgs, home-manager, sops-nix, llm-agents, aminte, ...
git diff flake.lock
```

- **nixpkgs** follows `nixos-26.05` through the channel's `nixexprs.tar.zst` (the
  revision and date come from the channel URL; never lock a release URL by hand, it
  loses them). A stable update is security and bug fixes.
- **home-manager** follows `release-26.05`: keep it on the same release as nixpkgs.
- **llm-agents** (Claude Code, pi, herdr) is deliberately not following our nixpkgs,
  for its binary cache. Updated daily upstream.
- **aminte** is not a flake; a change in its Go modules changes the `vendorHash`es in
  `pkgs/aminte.nix`. Build `.#aminte`; a hash mismatch prints the new value to copy.

Then, for each update:

1. Skill `check-change`, all hosts. Build them and read
   `nix store diff-closures /run/current-system ./result` on this machine: the
   versions that moved, and nothing unexpected removed.
2. For nixpkgs, watch the services that keep state and migrate it on upgrade (Home
   Assistant, Jellyfin, AdGuard, Syncthing, qBittorrent): read their changelogs for a
   major version step, and make sure the `backup` aspect has run first where it is on.
3. Commit as `flake: <input> to <version or rev>` with what moved, then skill `deploy`.

## A new NixOS release (26.11 and later)

Read the release notes (`nixos/doc/manual/release-notes/rl-<YYMM>.section.md` in the
new nixpkgs, or nixos.org/manual/nixos/unstable/release-notes) and grep `modules/`
for every renamed or removed option first. Move nixpkgs and home-manager together
(`nixos-YY.MM`, `release-YY.MM` in `flake.nix`). Fix every `evaluation warning:`.
Never change any host's `system.stateVersion` or `home.stateVersion`. Known to recheck
at 26.11: `networking.firewall.checkReversePath` with Tailscale, Home Assistant's
`config.http`, the Syncthing and AdGuard modules.
