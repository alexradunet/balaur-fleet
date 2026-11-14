---
name: check-change
description: Check a change to the Balaur fleet flake before committing it. Which hosts to evaluate or build, how to prove a refactor changes nothing, how to read a closure diff. Use before every commit to this repository.
---

# Check a change

Run from the repository root. Each step is cheaper than the next; stop at the first
that fails and fix it.

1. **Format.** `nix fmt`. The `formatting` check fails on anything it would change.

2. **Which hosts.** A file under `modules/hosts/` or `hosts/` affects that host. An
   aspect affects every host that lists it: `grep -l '<aspect>' modules/hosts/*.nix`.
   The shared aspects (`base fleet home secrets network gnome dev files torrents-client
   auto-deploy ai agent`: every aspect all three hosts list), `flake.nix`, `flake.lock`, `pkgs/` and `modules/flake/` affect every host. When in
   doubt, all of them: `tablet laptop pc` (`ls modules/hosts`).

3. **Evaluate everything.** `nix flake check --no-build` evaluates every host, check
   and package. NixOS warnings print as `evaluation warning:`; treat them as errors.

4. **A refactor changes nothing.** Before editing, record each affected host's
   derivation; after, compare:

   ```sh
   nix eval --raw .#nixosConfigurations.<host>.config.system.build.toplevel.drvPath
   nix run --inputs-from . nixpkgs#nix-diff -- <old.drv> <new.drv>   # when they differ
   ```

   Identical paths are the proof. Do the same for `.#packages.x86_64-linux.<name>.drvPath`
   when `pkgs/` changes.

5. **Build what changes.** Heavy builds go to the fleet's builders by themselves:

   ```sh
   nix build --no-link .#nixosConfigurations.<host>.config.system.build.toplevel
   nixos-rebuild build --flake .#<this host> && nix store diff-closures /run/current-system ./result
   ```

   Read the closure diff: every added, removed or upgraded package should be one you
   expected. A build also runs shellcheck on every `writeShellApplication`.

6. **Cheap checks for real.** `nix build --no-link .#checks.x86_64-linux.formatting
   .#checks.x86_64-linux.skills`; the package checks (`duet-camera`,
   ...) build with their packages.

7. **What evaluation cannot show** — a service that starts, a page that answers, a
   secret that decrypts — is checked after deploying (skill `deploy`). Say which of
   these you could not check, rather than implying it was checked.

`git add` new files first: a flake only sees files git knows about.
