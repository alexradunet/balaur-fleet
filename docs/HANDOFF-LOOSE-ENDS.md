# Handoff: loose ends

Written 2026-11-10 on **zmeu** (now `pc`), after the session that reviewed the fleet against
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

`modules/backup.nix` is written and evaluates on the tablet, but no host has it: it needs
an off-site restic repository in Europe. A Hetzner Storage Box (SFTP, Germany or
Finland) fits: put the tablet's SSH host key (`fleet.tablet.sshHostKey`) in its
`.ssh/authorized_keys`. Then:

- `restic-password` (random; also into the password manager: it decrypts the backups)
  in `secrets/hosts/tablet.yaml` (skill `secrets`);
- `backup` in the tablet's aspects, with `balaur.backup.repository` and
  `passwordFile = config.sops.secrets.restic-password.path`;
- after the first night: `sudo restic-balaur snapshots`, and restore one file to
  `/tmp` to prove it.

### 2. Check the laptop when it wakes

It was asleep for the whole session: `balaur-fleet-status` should show it on main,
with no failed units, and `pi` there should list the seven skills. (Strata's sandbox
is proven: it loaded and answered through the entryway on 2026-11-10.) Its assistant
should have house devices: `~/.local/state/balaur-assistant/pi/mcp.json` exists.

Also from the ambient-screen session (item 8): `systemctl show syncthing -p UMask`
says `0002` there, and `ls -ld <synced folder>/photos` is group-writable (`drwxrwsr-x`).
It may sync `photos` in before it deploys `d13280e`, and then the folder arrives
read-only, as it did on the pc: `sudo chmod 2775` it.

And from the session that made the machines alike: `locale` shows `LC_TIME=ro_RO.UTF-8`,
`gsettings get org.gnome.desktop.input-sources sources` lists `us` and `ro+std` (unless
it was set by hand before), `lpstat -r` says the scheduler runs, and
`aminte-prod aminte --help` still reads the token (the secret is now declared by `aminte-dev`).

### 3. Retune the wake word on the laptop and the pc

`wakeThreshold = 0.35` on the laptop was copied from the tablet's microphone array; the pc
uses the default. `sudo balaur-wake-test` on each, with real voices.

### 4. Keep an eye on the tablet's disk

64% used at the last look (275 of 459 GB, 2026-11-10); the Syncthing volume reserves 200 GiB up front and now
also keeps 30 days of replaced and deleted files inside that cap. qBittorrent
downloads into what is left.

### 5. The assistant's state migration

`balaur-assistant-migrate-state` (assistant.nix) carries state over from the old
`duet-assistant` name. Delete it once every machine has started the assistant since
2026-11-08 (the tablet's household account could not be checked without root).

### 6. The development sessions on the tablet (`dev-host`, 2026-11-10)

`dev` from the pc attaches to herdr on the tablet and the panes outlive the client; herdr's
Claude Code and pi integrations are installed there. Left:

- **The phone** (needs the user): a key from its SSH app, as
  `balaur.sshKeys = [ "ssh-ed25519 ..." ];` in `modules/hosts/tablet.nix`; then
  `ssh alex@tablet` and `dev` from mobile data.
- **The laptop**: `dev` there, once it is awake and on main.
- **A reboot of the tablet**: see what herdr restores (the layout, and the agents through
  the integrations). The old workspace `yoga-duet-7-home-server` points at a directory
  that is gone and can be closed.

### 7. The voice assistant on pi, and its house devices (2026-11-10)

House devices are done (`7400f7b`, `5175363`; `gnome/CONTRACT.md`, "The agent"):
on the pc (then zmeu) a typed question listed the devices exposed to Assist and "turn on the
Samsung" reached Home Assistant without error. Left:

- **The Samsung does not wake from off** (needs the user): Home Assistant accepts
  `turn_on` but the TV ignores it. On the TV, Power On with Mobile (Expert
  Settings); in Home Assistant, the Samsung device needs its MAC. Then ask again
  and check the logbook names the assistant's user, not the admin.
- **Android TV Remote** fails to set up (`No module named 'androidtvremote2'`):
  `androidtv_remote` in `extraComponents` if the user wants it.
- **The tablet** has not been asked a real question since it moved to pi (it
  started cleanly).

### 8. The ambient screen: photos and the fleet's status (2026-11-10, on the tablet)

Done and seen working (`6bacc8b`, `d13280e`, `3a84957`; docs/SETUP.md, Stage 12): after a
minute untouched the tablet shows photos from `photos` in the Syncthing folder, with
the machines (Tailscale) and services (systemd, or a probe on other machines) on the
side, next to the clock, date and weather. Syncthing now keeps group write
(`UMask=0002`). `duet-presence` was deaf since 2026-11-08 (a `kill` under `set -e`
ended its reader) and is fixed: a wave at 14:45 took a 15-minute hold. The tablet now
blanks after 15 minutes (`camera.screenTimeout`). Left:

- **The pc and the laptop show it too** (the user asked): its settings moved to the
  `gnome` aspect (`balaur.ambient.*`, was `balaur.tablet.ambient.*`), so every GNOME
  machine writes `/etc/balaur/ambient.json`, with the same photos (its copy of the
  synced folder) and status. Left: see it on the pc's screen after a new login (with
  several monitors it covers the primary one only), and check it stays away during a
  full-screen game and a Sunshine stream. On the laptop, once it is awake.
- **Photo quality** (the user): the 8 photos are resized copies (1720 wide; one is 465×208
  and shows blurry). Full-size originals look better. HEIC is not shown (GdkPixbuf).
- **Not seen yet:** the status panel with a failed unit (red row, "N failed") and a
  rotated tablet on the real screen. Both were checked only in a headless gnome-shell.

### 9. From the review of 2026-11-10 (needs a deploy, and the user)

A review compared the code and the docs with each other, and its fixes are in the
working tree (one commit; `git log` says which). Once they are deployed:

- **Exercise what could not be tried before**, on the tablet unless said:
  - auto-deploy's roll-back never worked before; it now returns to the generation it
    recorded before the switch. Test it once on purpose, with a switch after which the
    machine cannot reach GitHub (`journalctl -u balaur-auto-deploy` should say
    "switching back to ...").
  - A restart of the camera relay no longer deafens `duet-presence`:
    `sudo systemctl restart duet-camera-relay`, wave, and the screen wakes.
  - The ambient screen appears while someone is in the room.
  - House devices right after a reboot of the tablet: "turn on the lamp" as the first
    question.
  - The ambient screen now holds a modal grab, so the key or tap that ends it no longer
    reaches the app underneath. Seen only in a headless gnome-shell: on the real screen,
    check that the tablet still blanks after 15 minutes with the photos up and wakes on
    movement, and that locking the pc with the photos up works. Known cost: an alarm
    that rings while the photos are up needs two taps (one ends the photos, one stops it).
  - While nobody uses the webcam the relay no longer feeds it (it only samples the
    sensor): open Snapshot and see how long the first picture takes (up to about 2 s).
  - `balaur-torrent` with a magnet link and with a `.torrent` file whose name has a comma;
    qBittorrent 5.2 answers `torrents/add` with JSON, which the script reads for failures.
  - On the pc: Strata comes back a minute after the last game or Wine process ends
    (`journalctl -u strata-yield`: "no game for a minute: starting Strata"). WoW Market
    now deletes scans older than 90 days.
  - AdGuard: the Samsung rules are a filter list from a file now, and a custom rule made
    in its UI survives `sudo systemctl restart adguardhome`.
  - The voice assistant: mute, restart it, still muted; a timer survives a restart; a
    search followed by "remind me" in the same conversation is refused, by design.
- **Seen working after the deploy** (2026-11-11, `67fb27d` and `086a1b1`):
  `https://torrents.<domain>` answers; the relay idles at about 2% of a core (3 frames
  a second sampled, 3.6 ms each); on the pc a deploy during a game skipped Strata, and
  WoW Market runs with its home hidden (the game folder read-only, AddOns writable).
  The shell extension's changes load at each machine's next login.
- **`gnome/agent/` in each machine's clone** (tablet, pc, laptop) is the old Node agent's
  orphaned `node_modules` (156 MB, untracked, now git-ignored): delete it by hand.
- **`cups-browsed` runs on every machine** (the NixOS default with avahi).
  `services.printing.browsed.enable = false` would be leaner if no printer is found by
  browsing (needs the user).
- **Long-lived herdr panes on the tablet keep a stale `LOCALE_ARCHIVE`** after a deploy that
  changes the locales (`setlocale: LC_TIME: cannot change locale`). Restarting
  `herdr-server` (`systemctl --user restart herdr-server`) or rebooting fixes it, at the
  cost of the sessions.
- **The Sunshine password is passed on the command line** at each session start (its only
  interface: `sunshine --creds`, in `sunshine.service`'s `ExecStartPre`), so it is briefly
  visible in `/proc` on the pc.

## Backlog from the review (decisions, not fixes)

- **Disk encryption on the laptop** (a reinstall), and whether `~/.ssh/id_ed25519` has
  a passphrase: today a lost laptop gives away the admin key and the shared secrets.
- **Rotate the Gandi token and the FileList passkey** when the laptop gets a new key or
  an encrypted disk. They were always sops-encrypted, but the old ciphertext in git
  history was encrypted to the laptop's keys too; moving them to
  `secrets/hosts/tablet.yaml` keeps only new values away from those keys. (The
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
- **Download directories are per machine**: `/srv/media` on the tablet is not the synced
  volume.
