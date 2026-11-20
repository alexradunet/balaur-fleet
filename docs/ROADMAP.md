# Roadmap

Where the fleet is going next. On the desktop the direction of 2026-11-04 holds:
**as GNOME-native as possible**. Use GNOME's own mechanism before writing code; everything
GNOME-facing is GJS (`gnome/`).

## Done

- Stock GNOME as a household tablet on the Duet: auto-login `home`, no lock, on-screen keyboard (en + ro), rotation.
- Voice assistant in the session: GJS daemon (PipeWire, wake word, Voxtral) + the fleet's pi in its home role.
- Balaur app (libadwaita) and Shell extension; the app removed 2026-11-17 for the web home page (https://balaur.space).
- Web UIs as GNOME web apps; Snapshot for the camera; camera movement keeps the screen awake.
- Web dashboard, Samsung TV integration and the Go assistant removed; the GJS voice assistant ("Hey Jarvis") removed 2026-11-14.
- Ambient screen (2026-11-04, Shell extension): after 1 min untouched, a clock, date, weather, the running
  timers and the next reminder (gone with the assistant) over a Jellyfin photo slideshow; a touch ends it, camera movement keeps it up.
  Photos need a Jellyfin API key: `sudo balaur-photos-login` (docs/SETUP.md, "The ambient screen").
- Ambient screen, 2026-11-10: the machines (Tailscale) and services (systemd, or a probe on other machines)
  on the side; photos from `photos` in the Syncthing folder, so any machine can add them.
- The tablet retired, 2026-11-15: the server took its services over and runs headless (Cockpit), the
  laptop is the only GNOME machine. The household screen, the Duet camera and the always-on laptop settings
  went with it; git history keeps them, and the Duet waits for a new purpose.

## Next

Agreed on 2026-11-20: Balaur holds the owner's personal life and the house, declared here,
with the data and its processing on the server (a remote model is allowed for now). The
owner works mostly through the Balaur agent, and a partner joins later as a full second
person: their own life log, ledger and agent, and shared spaces.

How a domain is built, the pattern of the life log and of money:

1. The data is plain files in a space: a folder with a group. `/srv/life` is the owner's;
   later `/srv/life-<name>` (the partner's) and `/srv/house` (ours).
2. A space has a checker and a git history (the keeper, `bean-check`).
3. A view is a thin page over the files, on a Unix socket behind Caddy.
4. The agent is the main way in: a skill and a block of instructions per domain.
5. An app with a store of its own enters only for a phone's own protocol (CalDAV: Radicale).

The stages, each one shipped alone, in this order:

| Stage | What | Issue |
|---|---|---|
| S1 Foundation | Aspects declare their state (`balaur.state`); a restore test and a monthly restore drill | #26 |
| S2 People | A registry of persons (the owner only), `balaur-notify -to`, the rules for new aspects | #27 |
| S3 Chat | The agent on the phone: a page around `pi --mode rpc`, sandboxed (the life log, the ledger, the house; no keys, no deploys) | #28 |
| S4 Routines | `balaur.agent.routines`: scheduled runs of the agent, a morning brief on the phone | #29 |
| S5 Calendar | Radicale (calendar, contacts, tasks) at `dav.<domain>`; the agent through CalDAV | #30 |
| S6 Documents | A scan or PDF in, its text in the life log's `files/`, the original in `/srv/proton/documents` | #31 |
| S7 Partner | Per-space instances of lifelog, money, agent and chat; `/srv/house` | #32 |

The life log stays the journal: no app replaces it; S3 and S6 close its gaps (the phone, uploads).

Never to migrate: `/srv/life`, the group `lifelog`, the folder id `balaur-life`, `life.git`,
the address `life.balaur.space`. The second person gets names with a suffix.

## Not building

- WhatsApp for the agent: its conversations hold the life log and the ledger, and would pass
  through Meta. The chat page and Home Assistant's notifications cover the phone.
- Nextcloud, Paperless-ngx, Memos, Trilium: a database in place of files the agent reads.
- Single sign-on: the tailnet address is who you are.
- Photos (Immich), a password manager, recipes, an inventory: not asked for now.
- A vision model as the record of a document (it can invent text), vector search (`rg` is
  enough), Syncthing on Android.


## Parked

- Video calls (Jitsi link, Meet or Signal), not decided.

## Watch

- **qBittorrent** quit right after every start from the 2026-11-04 15:10 boot until a manual run
  rewrote its state. It has run normally since, reboot included; the cause was not found (a stale
  lockfile was ruled out). If it happens again, look at it before restarting anything: its log
  (`/var/lib/qBittorrent/qBittorrent/data/logs/qbittorrent.log`) and config files as they are then.
