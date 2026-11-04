# Handoff: loose ends

Written 2026-11-05 on **laptop**, after the session that registered it in the
fleet and then added remote builds, Syncthing, sops and the torrent client.
Read `CLAUDE.md` first for the repo's rules. **Delete this file once the list is
empty** (and drop its pointer from CLAUDE.md), as its predecessor was.

Nothing here is broken. Both machines are healthy, on `origin/main`, with zero
failed units, and everything described below was verified by exercising it, not
by reading the config. These are the things a careful person would still want to
do.

## Where things stand

| | laptop (Yoga Pro 7 14APH8) | duet (Yoga Duet 7) |
|---|---|---|
| Role | cockpit: builds and deploys the fleet; personal GNOME desktop | always-on home server + household tablet |
| Tailnet | `100.69.82.21` | `100.118.102.119` |
| LAN | DHCP, was `192.168.50.43` | `192.168.50.233` (reserved) |
| Nix builds | builder for the fleet (8 jobs, speedFactor 2) | farms its builds out to the laptop |
| Syncthing | 200 GiB volume, `/srv/files/shared` | same, paired declaratively |
| qBittorrent | client only (`balaur-torrent`) | the server, `http://duet.local:8080` |
| Assistant | runs as `alex`, default mic | runs as `home`, 16 kHz array |
| Secrets | `assistant-llm-key` | all three |

Services: qBittorrent `:8080`, Jellyfin `:8096`, Syncthing `:8384`, AdGuard `:3000`,
all on duet, reachable as `duet.local` on the LAN and `duet` over the tailnet.
No logins on the LAN/tailnet by design — do not port-forward any of them.

## The list, most worth doing first

### 1. Back up `~/.ssh/id_ed25519` on the laptop

This one key now does three jobs: SSH to duet, the admin age identity for sops
(`~/.config/sops/age/keys.txt` is derived from it), and the user key the fleet
authorises everywhere. Losing it costs you the ability to **edit secrets** —
both machines keep working, since they decrypt with their own host keys — but
you would have to re-derive or rotate. There is no backup of it anywhere today.

### 2. Retune the wake word on the laptop

`balaur.assistant.wakeThreshold = 0.35` in `modules/hosts/laptop.nix` was copied
from duet, where it was measured against the Duet's 16 kHz microphone array. The
laptop has an ordinary HD-Audio mic and `audio.input = null` (PipeWire's default
source), so the number is a guess. Measure it:

```
sudo duet-wake-test          # say "Hey Jarvis" a few times; prints each score
sudo duet-wake-test score 2  # rescore the last recording, amplified
```

The assistant does now authenticate (the sops key works — Mistral returns 200),
so this is about whether it *hears* you, not whether it answers.

### 3. Turn duet's passwordless sudo back off

`security.sudo.wheelNeedsPassword = false` in `modules/hosts/duet.nix`, added in
`38d1a38` and marked TEMPORARY. It is what let this session deploy duet
unattended, and `docs/ROADMAP.md` already lists reverting it under "When
development is done". Deciding that development *is* done is the only step.

### 4. Remove the laptop's qBittorrent leftovers

The laptop briefly ran the server before we settled on duet-only. Nix does not
remove state it did not create:

```
sudo rm -rf /srv/media /var/lib/qBittorrent
```

Checked before writing this: `/srv/media` holds 0 files and nothing downloaded
there. Harmless to leave, untidy to keep.

### 5. Pick `balaur-torrent` as Firefox's magnet handler

It is registered as a handler for `magnet:` and `.torrent`, hidden from the app
grid, but nothing is forced as the system default — that is a preference, so it
was left to you. Click a magnet once in Firefox and choose "Download with
Balaur"; it then sends to duet. Verified end to end from the laptop: a Debian
netinst torrent queued on duet into `/srv/media/downloads`, then removed.

### 6. Watch duet's disk

duet is at **56% used, 194 GiB free**, down from 394 GiB, because the Syncthing
volume reserves 200 GiB up front — deliberately, so a runaway sync cannot fill
the root filesystem and take the household screen, the assistant and the media
server with it. But duet shares what is left with the media library, and
qBittorrent is actively downloading into it.

`balaur.files.sizeGiB` can differ per machine, and raising or lowering it needs
no manual resize: the backing file is extended and the filesystem grown to match
on the next activation. Lowering it does nothing, since ext4 cannot shrink in
place — that means moving the data out, deleting the image and letting it be
remade.

## Agreed earlier, still unstarted

- **qBittorrent's `filelist.json` is in sops now**, but its own state directory
  is not: nothing else in `/var/lib/qBittorrent` is managed. That is fine; noted
  so nobody looks for it.
- **Nothing irreplaceable in `secrets/balaur.yaml`.** The repo is public, so the
  ciphertext is public forever and a leaked host key would expose every secret
  ever encrypted to it, git history included. Today's three are all rotatable.
  Keep it that way, and rotate the *secret* as well as the key if one ever leaks.

## Notes worth keeping, not tasks

- **qBittorrent's unexplained quit** (`docs/ROADMAP.md`, "Watch") did not recur:
  it was restarted several times across this session's deploys and reported
  `NRestarts 0` each time, serving the web UI throughout.
- **A sleeping builder costs about five seconds.** With duet→laptop:22
  blackholed, Nix reported `cannot build on 'ssh-ng://nixremote@laptop'` and
  built locally; 9.4 s total, of which ~5 s is the `ConnectTimeout` set in
  `modules/fleet.nix`. One number to change if that becomes annoying.
- **Download directories are per machine.** `/srv/media/...` on duet is not the
  synced volume, so this is not a "download once, appears everywhere" setup. If
  you ever want that, downloading into `/srv/files/shared` would do it, bounded
  by the 200 GiB volume and copying everything both ways — a decision, not a fix.

## How the user likes to work

Unchanged from the previous handoff, and all of it held up:

- European providers. The assistant uses Mistral for speech, the model, TTS and
  web search; only the wake word runs locally. Don't propose self-hosted speech
  or LLMs, or non-EU services, unless asked.
- Lean CPU use, especially on duet — which is now also why the laptop builds for it.
- On the Duet, everything on screen is GNOME-native: GJS, libadwaita, a Shell
  extension. Prefer GNOME's own mechanisms over custom code.
- Build the new piece next to the old one, and switch over only once it works.
- Public repo: no secrets, tokens or new personal data in commits.
- Verify by exercising the thing, not by reading the config. Four real defects in
  this session's Syncthing work were invisible until deployed.
