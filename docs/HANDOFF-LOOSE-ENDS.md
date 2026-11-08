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

| | laptop (Yoga Pro 7 14APH8) | balaur (Yoga Duet 7) |
|---|---|---|
| Role | cockpit: builds and deploys the fleet; personal GNOME desktop | always-on home server + household tablet |
| Tailnet | `100.69.82.21` | `100.118.102.119` |
| LAN | DHCP, was `192.168.50.43` | `192.168.50.233` (reserved) |
| Nix builds | builder for the fleet (8 jobs, speedFactor 2) | farms its builds out to the laptop |
| Syncthing | 200 GiB volume, `/srv/files/shared` | same, paired declaratively |
| qBittorrent | client only (`balaur-torrent`) | the server, `http://balaur:8080` |
| Assistant | runs as `alex`, default mic | runs as `home`, 16 kHz array |
| Secrets | `assistant-llm-key` | all three |

Services: qBittorrent `:8080`, Jellyfin `:8096`, Syncthing `:8384`, AdGuard `:3000`,
all on balaur. The fleet reaches them at `balaur` (tailnet); `balaur.local` is for devices outside it.
No logins on the LAN/tailnet by design — do not port-forward any of them.

The laptop's GNOME is trimmed: fourteen default apps are excluded, in
`desktop.nix` (the ones no personal desktop here wants) and `laptop.nix` (this
machine's taste). GNOME Web stays on balaur, which needs Epiphany for the service
web apps. `documentation.nixos.enable = false` on the laptop, so the offline
manual is not rebuilt on every rebuild.

## The list

### 1. Retune the wake word on the laptop

`balaur.assistant.wakeThreshold = 0.35` in `modules/hosts/laptop.nix` was copied
from balaur, where it was measured against the Duet's 16 kHz microphone array. The
laptop has an ordinary HD-Audio mic and `audio.input = null` (PipeWire's default
source), so the number is a guess. Measure it:

```
sudo balaur-wake-test          # say "Hey Jarvis" a few times; prints each score
sudo balaur-wake-test score 2  # rescore the last recording, amplified
```

The assistant does authenticate (the sops key works — Mistral returns 200), so
this is about whether it *hears* you, not whether it answers.

### 2. Keep an eye on balaur's disk

balaur is at **56% used, 194 GiB free**, down from 394 GiB, because the Syncthing
volume reserves 200 GiB up front — deliberately, so a runaway sync cannot fill
the root filesystem and take the household screen, the assistant and the media
server with it. But balaur shares what is left with the media library, and
qBittorrent downloads into it.

`balaur.files.sizeGiB` can differ per machine, and raising or lowering it needs
no manual resize: the backing file is extended and the filesystem grown to match
on the next activation. Lowering it does nothing, since ext4 cannot shrink in
place — that means moving the data out, deleting the image and letting it be
remade.

## Settled, recorded so nobody redoes it

- **The admin key is backed up** (Proton, 2026-11-05). `~/.ssh/id_ed25519` is the
  one secret that matters: SSH to balaur, the sops admin age identity, and the user
  key the fleet authorises. Re-derive the age identity with
  `ssh-to-age -private-key -i ~/.ssh/id_ed25519 -o ~/.config/sops/age/keys.txt`;
  there is no second thing to keep.
- **Nothing irreplaceable in `secrets/balaur.yaml`.** The repo is public, so the
  ciphertext is public forever and a leaked host key would expose every secret
  ever encrypted to it, git history included. Today's three are all rotatable.
  Keep it that way, and rotate the *secret* as well as the key if one ever leaks.
- **qBittorrent's own state** (`/var/lib/qBittorrent`) is not in sops; only its
  FileList credentials are. Noted so nobody goes looking.
- **`magnet:` is pinned** to `balaur-torrent` through `gnome-mimeapps.list`, not
  home-manager's `xdg.mimeApps` — that option would take over `mimeapps.list`,
  where Claude Code keeps its own `claude-cli` association.

## Notes worth keeping, not tasks

- **qBittorrent's unexplained quit** (`docs/ROADMAP.md`, "Watch") did not recur:
  it was restarted several times across this session's deploys and reported
  `NRestarts 0` each time, serving the web UI throughout.
- **A sleeping builder costs about five seconds.** With balaur→laptop:22
  blackholed, Nix reported `cannot build on 'ssh-ng://nixremote@laptop'` and
  built locally; 9.4 s total, of which ~5 s is the `ConnectTimeout` set in
  `modules/fleet.nix`. One number to change if that becomes annoying.
- **Download directories are per machine.** `/srv/media/...` on balaur is not the
  synced volume, so this is not a "download once, appears everywhere" setup. If
  you ever want that, downloading into `/srv/files/shared` would do it, bounded
  by the 200 GiB volume and copying everything both ways — a decision, not a fix.

## How the user likes to work

Unchanged from the previous handoff, and all of it held up:

- European providers. The assistant uses Mistral for speech, the model, TTS and
  web search; only the wake word runs locally. Don't propose self-hosted speech
  or LLMs, or non-EU services, unless asked.
- Lean CPU use, especially on balaur — which is now also why the laptop builds for it.
- On the Duet, everything on screen is GNOME-native: GJS, libadwaita, a Shell
  extension. Prefer GNOME's own mechanisms over custom code.
- Build the new piece next to the old one, and switch over only once it works.
- Public repo: no secrets, tokens or new personal data in commits.
- Verify by exercising the thing, not by reading the config. Four real defects in
  this session's Syncthing work were invisible until deployed.
