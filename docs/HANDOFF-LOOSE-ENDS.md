# Handoff: loose ends

Written 2026-11-10 on **zmeu**, after the session that reviewed the fleet against
current NixOS practice and made the agents' instructions and skills shared
(AGENTS.md, `.agents/skills`). Read `AGENTS.md` first. **Delete this file once the
list is empty** (and drop its pointer from AGENTS.md), as its predecessors were.

## What that session changed

nixfmt and a formatting check; one overlay for `pkgs/`; nixpkgs from the channel's
`.tar.zst`; no channels, no offline manual, no boot-menu editor, fwupd; every script a
`writeShellApplication`; the admin no longer a trusted Nix user; per-machine secret
files; a sandboxed Strata; auto-deploy retries and rolls back, and
`balaur-fleet-status`; Syncthing versioning; a `backup` aspect; CI; AGENTS.md and
seven skills shared by Claude Code and pi.

## The list

### 1. Choose where backups go, then turn `backup` on (needs the user)

`modules/backup.nix` is written and evaluates on balaur, but no host has it: it needs
an off-site restic repository in Europe. A Hetzner Storage Box (SFTP, Germany or
Finland) fits: put balaur's SSH host key (`fleet.balaur.sshHostKey`) in its
`.ssh/authorized_keys`. Then:

- `restic-password` (random; also into the password manager: it decrypts the backups)
  in `secrets/hosts/balaur.yaml` (skill `secrets`);
- `backup` in balaur's aspects, with `balaur.backup.repository` and
  `passwordFile = config.sops.secrets.restic-password.path`;
- after the first night: `sudo restic-balaur snapshots`, and restore one file to
  `/tmp` to prove it.

### 2. Check the laptop when it wakes

It was asleep for the whole session: `balaur-fleet-status` should show it on main,
with no failed units, and `pi` there should list the seven skills. (Strata's sandbox
is proven: it loaded and answered through the entryway on 2026-11-10.)

### 3. Retune the wake word on the laptop and zmeu

`wakeThreshold = 0.35` on the laptop was copied from balaur's microphone array; zmeu
uses the default. `sudo balaur-wake-test` on each, with real voices.

### 4. Keep an eye on balaur's disk

56% used at the last look; the Syncthing volume reserves 200 GiB up front and now
also keeps 30 days of replaced and deleted files inside that cap. qBittorrent
downloads into what is left.

### 5. The assistant's state migration

`balaur-assistant-migrate-state` (assistant.nix) carries state over from the old
`duet-assistant` name. Delete it once every machine has started the assistant since
2026-11-08 (balaur's household account could not be checked without root).

### 6. The development sessions on balaur (`dev-host`, 2026-11-10)

`dev` from zmeu attaches to herdr on balaur and the panes outlive the client; herdr's
Claude Code and pi integrations are installed there. Left:

- **The phone** (needs the user): a key from its SSH app, as
  `balaur.sshKeys = [ "ssh-ed25519 ..." ];` in `modules/hosts/balaur.nix`; then
  `ssh alex@balaur` and `dev` from mobile data.
- **`gh auth login` on balaur** (needs the user): its token is invalid.
- **The laptop**: `dev` there, once it is awake and on main.
- **A deploy leaves the server alone**: `systemctl --user show herdr-server -p MainPID`
  on balaur was 235170 before the first switch after `c7be55a`; it should not change.
- **A reboot of balaur**: see what herdr restores (the layout, and the agents through
  the integrations). The old workspace `yoga-duet-7-home-server` points at a directory
  that is gone and can be closed.

## Backlog from the review (decisions, not fixes)

- **Disk encryption on the laptop** (a reinstall), and whether `~/.ssh/id_ed25519` has
  a passphrase: today a lost laptop gives away the admin key and the shared secrets.
- **Rotate the Gandi token and the FileList passkey** when the laptop gets a new key or
  an encrypted disk. They were always sops-encrypted, but the old ciphertext in git
  history was encrypted to the laptop's keys too; moving them to
  `secrets/hosts/balaur.yaml` keeps only new values away from those keys. (The
  Sunshine password was rotated: Sunshine takes a new one when it restarts.)
- **Signed commits for auto-deploy**: verify main's commit against the registry's
  `userKeys` before switching, so a stolen GitHub login cannot deploy.
- `nixpkgs.config.allowUnfreePredicate` (NVIDIA, Steam) instead of `allowUnfree`.
- nftables instead of iptables (the extra rules in `game-streaming.nix`), sudo-rs,
  Secure Boot (lanzaboote).
- 26.11: recheck `networking.firewall.checkReversePath` with Tailscale, Home
  Assistant's `config.http`, the Syncthing and AdGuard modules (skill `update-inputs`).
- AdGuard (:3000) and qBittorrent (:8080) have no login on the LAN, by design; noted
  only. Nothing is reachable from the internet.

## Settled, recorded so nobody redoes it

- **The admin key is backed up** (Proton, 2026-11-05). Re-derive the age identity with
  `ssh-to-age -private-key -i ~/.ssh/id_ed25519 -o ~/.config/sops/age/keys.txt`.
- **qBittorrent's own state** (`/var/lib/qBittorrent`) is not in sops; only its
  FileList credentials are. The `backup` aspect covers it once on.
- **`magnet:` is pinned** to `balaur-torrent` through `gnome-mimeapps.list`, not
  home-manager's `xdg.mimeApps`, which would take over `mimeapps.list`, where Claude
  Code keeps its own `claude-cli` association.
- **A sleeping builder costs about five seconds** (`ConnectTimeout` in fleet.nix).
- **Download directories are per machine**: `/srv/media` on balaur is not the synced
  volume.

### 7. House devices for the voice assistant: Home Assistant over MCP (handed off 2026-11-10)

Handed off from a session on zmeu, mid-investigation: nothing of this item is built.
The session ran on zmeu; its plan file and memory are there, not on balaur, so
this entry is the whole brief.

**Where things stand.** The assistant's brain is the fleet's pi in its *home role*:
the GJS daemon starts `balaur-home-agent` (`gnome/home-agent/bin/`), which runs
`pi --mode rpc` with one extension (`gnome/home-agent/index.ts`) and no tool of pi's
own. `gnome/CONTRACT.md`, "The agent", is the description to read first. Roles are
in `modules/agent.nix` (`os`: `pi`, `balaur-ask`; `aminte`: `pi-aminte`).

**Decided with the user.**

- The home role gets house devices (lights, TV, speakers, scenes) through Home
  Assistant, with **its own non-admin Home Assistant user**: it can switch things,
  not change the setup.
- After this: media (play from Jellyfin; no downloads by voice), then a read-only
  status question to the OS agent, run as an account with no power.
- On the laptop and zmeu the voice is the home role plus handing a question to the
  OS agent; on the tablet it is the home role only. The home role never gets aminte:
  the tablet is shared, and the household account holds no aminte token.
- Tools arrive as MCP servers and role configuration, not hand-written tools.

**Found so far.**

- Home Assistant is 2026.5.4 on balaur (`modules/home-assistant.nix`), onboarding
  done. `mcp_server` is an available component but not in `extraComponents`:
  `/api/mcp` answers 404 today.
- The MCP Server integration is set up in the UI (a config entry), answers at
  `/api/mcp` (streamable HTTP, which pi speaks; pi rejects SSE), takes a long-lived
  access token, and offers the entities exposed to Assist.
- pi's MCP rules that matter (`docs/mcp.md` beside the pi binary): a server's tools
  are `mcp__<server>__<tool>`; the default exposure is `codemode`, which activates
  pi's `codemode` tool. The home role must not have that: give the server
  `"exposure": "direct"` and set `"autoEnableCodemode": false`. With resources, pi
  adds `list_mcp_resources`, `list_mcp_resource_templates` and `read_mcp_resource`:
  keep them out with `--exclude-tools`. A header may be a command, as the whole
  value: `"Authorization": "!echo Bearer $(cat <file>)"`, so the token is neither
  in the store nor in the environment.

**To build.**

1. `mcp_server` in `extraComponents` (`modules/home-assistant.nix`).
2. Launcher (`gnome/home-agent/bin/balaur-home-agent`): when a Home Assistant URL
   and token file are given (two environment variables from `modules/assistant.nix`,
   set only where the token is), write `mcp.json` into the agent's state directory
   and drop `--no-mcp`; otherwise as today.
3. Extension (`gnome/home-agent/index.ts`): `checkTools` allows `mcp__homeassistant__*`
   beside our own and still exits on anything else active; the `tool_call` handler
   lets those through. Add one rule to `prompt.ts` about house devices, only when
   the server is there. The cap of 6 rounds must still remove every tool.
4. Test (`gnome/home-agent/test/rpc.test.mjs`): a small streamable-HTTP MCP server
   in the test (initialize, tools/list, tools/call). Assert the model is offered
   our tools plus that server's and nothing else (no `codemode`, no `tool_search`,
   no resource tools), a call reaches the server with the bearer header, and with
   the server down the assistant still starts and answers.
5. The secret: the token as `home-assistant-agent-token`, readable by the group
   `balaur-assistant` like `assistant-llm-key` (skill `secrets`). Ask the user
   whether it is balaur's alone (`secrets/hosts/balaur.yaml`: the tablet only) or
   the fleet's (`secrets/balaur.yaml`: also the voice on zmeu and the laptop,
   which travels).

**Needs the user, in Home Assistant's UI** (https://home.balaur.space):

- add the integration "Model Context Protocol Server";
- create a user for the assistant, not an administrator, log in as it, and make a
  long-lived access token (profile, Security);
- choose which entities are exposed to Assist: that list is what a voice in the
  living room can switch;
- put the token into sops themselves (`sops secrets/...`): an agent must not
  decrypt or print secrets into a scratch file.

**Verify by exercising** (skills `check-change`, `deploy`): on balaur,
`curl -H "Authorization: Bearer ..."` is the user's to run; ours are the package's
tests, then a typed question through the daemon
(`busctl --user call org.balaur.Assistant /org/balaur/Assistant org.balaur.Assistant1 Ask sb "..." false`
in a session that runs the assistant: zmeu's or the laptop's admin session; the
tablet's belongs to the household account) and Home Assistant's logbook showing the
assistant's user as the one who acted.

**Left open by the same session, not part of this item.**

- The tablet has not been asked a real question since it moved to pi (it started
  cleanly). `git revert 664e4b4` brings the old engine back if it misbehaves.
- On zmeu the admin's session predates its membership of `balaur-assistant`, so the
  assistant there has no Mistral key (no speech, no web search) until the next login.
