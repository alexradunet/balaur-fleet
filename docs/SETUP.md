# Setup, once per fleet

The pieces that are set up by hand once, after the machines run the flake. Installing a
machine is the `add-machine` skill (`.agents/skills/add-machine/SKILL.md`); this is what
comes after: the agents and Orca's sessions, the Scenes menu, and the ambient screen.

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

## Home Assistant scenes on the screens

Quick Settings on every GNOME machine has a **Scenes** menu: Home Assistant's scenes, then its scripts, fetched
each time it opens; a tap runs one. It talks to the fleet's Home Assistant (the `home-assistant` aspect, on the
server) as a user of its own, not an administrator. In Home Assistant's UI (https://home.<domain>, or
`http://server:8123`):

1. **Onboarding**: the first visit creates the owner, an administrator. Integrations, scenes and automations
   are set in the UI and kept in `/var/lib/hass`.
2. **A user for the screens that is not an administrator** (Settings → People → Users). Log in as it and
   create a long-lived access token (its profile, Security tab).
3. **Put the token into `secrets/balaur.yaml` as `home-assistant-agent-token`** (skill `secrets`) and push. The
   file is the shared one, so every GNOME machine with the `secrets` aspect finds it (`balaur.scenes.tokenFile`,
   readable by the group `balaur-house`, which the session's account is in) and writes
   `/etc/balaur/house.json`, pointing at the machine that runs Home Assistant (`balaur.scenes.host`).
4. **Make the scenes and scripts** in Home Assistant's UI; the menu shows them as they are.

Check: the menu lists them, and Home Assistant's logbook names the screens' user, not the owner, for what it ran.

## The ambient screen

When nobody has touched a GNOME machine for a minute, the Shell extension covers the apps with a view that can
be read across the room. It shows:
- a big clock and the date;
- the weather for `balaur.location` (Open-Meteo);
- on the side, the fleet's machines (from Tailscale: online, or when last seen; this one's failed units) and
  the home's services (green running, grey stopped or not answering, red failed);
- a slow slideshow of the photos in the synced folder.

The `gnome` aspect writes its settings on every GNOME machine; it stays until GNOME blanks and locks the
screen as usual, and `balaur.ambient.idleSeconds = 0` in a host file turns it off there. A touch, click or
key brings back what was there. The tap that does it doesn't reach the app.

- **It stays away** while a window is full screen (a film), or while an app holds an idle inhibitor (a call,
  a player).
- **It is lean**: nothing is asked or decoded while it is hidden; the machines and services every 30 s while
  it is up.

### Photos

Put pictures in `photos` inside the Syncthing folder, on any machine of the fleet (`/srv/files/shared/photos`
on the server, the same folder under the synced one elsewhere), in any subfolders. Syncthing brings them to
every machine; the slideshow lists the folder again every hour, so new ones show within the hour. JPEG, PNG
and WebP (not HEIC: export those as JPEG). Each is decoded at about the screen's size, off the Shell's main
thread.

Without the synced folder (`balaur.ambient.photos.dir = null`), the slideshow uses Jellyfin's photo
libraries instead, on a machine that runs Jellyfin (the `media` aspect): an API key from the Jellyfin web UI
(Dashboard → API Keys → **+**) given to `sudo balaur-photos-login`, which also adds a **Photos** library
for `/srv/media/photos`.

### Tuning

- `balaur.ambient.idleSeconds` (default 60; 0 = off), `balaur.ambient.photos.intervalSeconds`
  (default 30), `balaur.ambient.photos.dir`, `balaur.ambient.status` (default true). The
  extension reads `/etc/balaur/ambient.json` when the session starts, so after a change log
  out and in again (or reboot).
- What it does: `journalctl --user -b | grep "balaur ambient"`, as the session's user (weather, photo,
  status and inhibitor errors).
