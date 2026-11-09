---
name: deploy
description: Deploy a change to the Balaur fleet by committing and pushing to main, then follow every machine until it runs the commit, and verify the change by exercising it. Use after check-change passes, whenever the user asks to deploy, ship, push or roll out a change.
---

# Deploy

Every machine follows `main` on GitHub (`modules/auto-deploy.nix`): within about five
minutes of a push it builds its own configuration at that commit and switches to it.
Deploying is committing and pushing; the work is in following it through.

1. **Checked first** (skill `check-change`). Commit only what this change is:
   `git status`, then `git add` the files you changed. Leave alone anything in the
   working tree you did not change; another agent or the user may be working there.

2. **Commit message:** the aspect or area, a colon, what changed; the body says why
   and what you verified. End with the attribution line your instructions give.

3. **Push.** `git pull --rebase && git push`. Never force-push. A secret and the
   config that reads it go in the same push (skill `secrets`).

4. **Follow it.** `balaur-fleet-status` lists each machine's deployed commit against
   main (`ok` when it matches), its state and failed units. Machines check every five
   minutes and then build, so allow ten to fifteen. A machine that shows `no answer`
   is asleep or off the tailnet (the laptop usually); it catches up when it wakes.

   On a machine (or `ssh <host>`): `journalctl -u balaur-auto-deploy -n 50` says what
   it did; `sudo systemctl start balaur-auto-deploy` checks at once.

5. **When a machine fails.** The status shows `trying <rev> (attempt n/3)` and the unit
   is failed. Read its journal, fix, and push the fix: a new commit is tried at once.
   A switch after which the machine could not reach GitHub was rolled back by itself.

6. **Verify by exercising the change** on the machines that have it, not by reading
   the config: `systemctl status <unit>`, `curl` the page or `/health`, run the
   command, read the log line that proves it. For another machine's view of itself,
   `ssh <host> <command>`, or `balaur-ask <host> "<question>"` for its agent.

7. **Report** which machines run the commit, what you exercised and what it showed,
   and anything you could not check (an asleep laptop, a service only usable by hand).

## By hand

The admin is not a trusted Nix user, so pushing a closure with `--target-host` does
not work. For a machine that cannot follow GitHub, run on that machine:
`sudo nixos-rebuild switch --flake github:alexradunet/balaur-fleet#<host>`, or from its
clone `sudo nixos-rebuild switch --flake .#<host>` (stays until the next push).
