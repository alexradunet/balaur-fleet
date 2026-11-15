# Setup, once per fleet

The pieces that are set up by hand once, after the machines run the flake. Installing a
machine is the `add-machine` skill (`.agents/skills/add-machine/SKILL.md`); this is what
comes after: the agents and Orca's sessions.

---

## Code: the agents and Orca's sessions

The agent harnesses come from [numtide/llm-agents.nix](https://github.com/numtide/llm-agents.nix)
(updated daily, pre-built in a binary cache), not from nixpkgs, which lags by months:
`claude` (Claude Code) and `pi` ([pi.dev](https://pi.dev)).

**The first rebuild after adding them** should use the numtide cache so nothing compiles
locally. The flake declares the cache, but Nix asks you to accept flake-provided settings
once:

```bash
cd ~/Projects/balaur-fleet && git pull
nixos-rebuild switch --flake .#<host> --sudo --accept-flake-config
```

(After that first switch the cache is part of the system config, so the flag is not needed.)

**The sessions live on the server,** in Orca: its `orca-server` aspect runs `orca serve` from
boot (`systemctl --user status orca-serve`), and that runtime owns every project,
worktree, terminal and agent. The other machines' Orca apps are only windows onto it:
pair one once (a pairing link from the server's Orca runtime, pasted on the client into
**Settings → Remote Orca Servers → Add Server**), then make it the **Active Server**.
Closing the laptop changes nothing on the server; the agents keep working.

**A phone (Orca Mobile)** pairs with the server directly, over the tailnet, so it works
while the laptop sleeps. The service runs with `--no-pairing` and a running Orca cannot
make a pairing code, so pair from an SSH session on the server, with the service stopped
for a minute (the terminals and agents survive it):

```bash
systemctl --user stop orca-serve
ss -ltn | grep 6768            # nothing: the port is free
orca serve --port 6768 --mobile-pairing --pairing-address "$(tailscale ip -4)"
# scan the QR it prints with Orca Mobile (Tailscale on), wait until it connects, Ctrl+C
systemctl --user reset-failed orca-serve; systemctl --user start orca-serve
```

The pairing is kept in `~/.config/orca/orca-devices.json` (scope `mobile`). Pairing the
phone with the laptop's Orca instead would route it through the laptop.

The projects are cloned on the server, and so are the logins (`claude`, `pi`,
`gh auth login`, `orca account add --agent claude`).

**Updating the agents** (they move fast):

```bash
cd ~/Projects/balaur-fleet
nix flake update llm-agents
nixos-rebuild build --flake .#laptop     # check it builds (skill `update-inputs`)
git add flake.lock && git commit -m "flake: llm-agents to <rev>"
git pull --rebase && git push            # every machine follows
```

`gh`, `ripgrep`, `fd`, `tree` and Node are installed system-wide. Per-project compilers and
toolchains should come from each project's own `nix develop` shell instead of system packages.
