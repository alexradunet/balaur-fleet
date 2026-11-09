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

### 2. Rotate the secrets that moved (needs the user)

The Gandi token and the FileList passkey moved from the shared file into
`secrets/hosts/balaur.yaml`, but the old ciphertext, readable with the laptop's keys,
stays in the public history. They are protected only once rotated: a new Gandi
personal access token (balaur.space only), a new FileList passkey; then
`sops secrets/hosts/balaur.yaml` from zmeu or balaur, and push.

The Sunshine password was rotated: `sops decrypt --extract '["sunshine-password"]'
secrets/hosts/zmeu.yaml` on zmeu shows it. Sunshine takes it at its next start.

### 3. Check the laptop and Strata once they are up

- The laptop was asleep for the whole session: when it wakes, `balaur-fleet-status`
  should show it on main, with no failed units.
- Strata's new sandbox (strata.nix) could not be proven: a game was running on zmeu
  (`strata-yield` stopped it as designed). When it is back: `systemctl status strata`,
  `curl -s balaur:4000/health | jq .local` up, and `systemd-analyze security strata`.
  If the sandbox breaks CUDA or the memory lock, drop that one directive.

### 4. A `kiosk` home on balaur

`/home/kiosk` exists on balaur, but no account of that name is declared any more
(`users.mutableUsers = true` keeps old accounts). Probably from before `tablet` used
`home`: look at it, and delete the account and its home if nothing is in it.

### 5. Retune the wake word on the laptop and zmeu

`wakeThreshold = 0.35` on the laptop was copied from balaur's microphone array; zmeu
uses the default. `sudo balaur-wake-test` on each, with real voices.

### 6. Keep an eye on balaur's disk

56% used at the last look; the Syncthing volume reserves 200 GiB up front and now
also keeps 30 days of replaced and deleted files inside that cap. qBittorrent
downloads into what is left.

### 7. The assistant's state migration

`balaur-assistant-migrate-state` (assistant.nix) carries state over from the old
`duet-assistant` name. Delete it once every machine has started the assistant since
2026-11-08 (balaur's household account could not be checked without root).

## Backlog from the review (decisions, not fixes)

- **Disk encryption on the laptop** (a reinstall), and whether `~/.ssh/id_ed25519` has
  a passphrase: today a lost laptop gives away the admin key and the shared secrets.
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
