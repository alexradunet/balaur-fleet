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
   The shared aspects (`base fleet home secrets network dev files torrents-client
   auto-deploy ai agent`: every aspect both hosts list), `flake.nix`, `flake.lock`, `pkgs/` and `modules/flake/` affect every host. When in
   doubt, all of them: `laptop server` (`ls modules/hosts`).

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

6. **The checks for real.** `nix build --no-link .#checks.x86_64-linux.formatting
   .#checks.x86_64-linux.skills .#checks.x86_64-linux.python
   .#checks.x86_64-linux.signed-commits` cost seconds (`python`: the Python under
   `modules/` compiles, and `modules/ai/test_router.py` passes; `signed-commits`:
   what auto-deploy accepts as a signed commit). The
   package checks (`lifelog`, `lifelog-web`, `balaur-shell-extension`, ...) build with their
   packages. After a change to `web`, `torrents`, `notify`, `base` or the registry,
   also the tests that boot machines: `nix build -L --no-link
   .#checks.x86_64-linux.web-gate` (and `.torrents`, `.notify`; under a minute each
   once built; `modules/flake/tests.nix`). `nix flake check` without `--no-build` builds them
   all, as the Forgejo runner does (`.forgejo/workflows/check.yml`). One test is not a check, because it builds Home
   Assistant: after a change to `home-assistant.nix` or the report in `notify.nix`,
   `nix build -L .#heavy-tests.fleet-in-home-assistant` (two minutes here).

7. **What evaluation cannot show** — a service that starts, a page that answers, a
   secret that decrypts — is checked after deploying (skill `deploy`). Say which of
   these you could not check, rather than implying it was checked.

`git add` new files first: a flake only sees files git knows about.
