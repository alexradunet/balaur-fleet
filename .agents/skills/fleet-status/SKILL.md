---
name: fleet-status
description: Find out what state the Balaur fleet's machines are in and diagnose one that misbehaves - a machine behind main, a failed unit or deploy, a service that does not answer, the AI entryway or Strata down. Use for any question about how a machine or service of the fleet is doing.
---

# Fleet status and diagnosis

Look before changing anything, and change things through the repository (skill
`deploy`), never by hand on a machine.

## Overview

```sh
balaur-fleet-status            # every machine: deployed commit, state, retrying, failed units
cat /etc/balaur/services.json  # every service this machine can reach, with its URL
```

The machines and their services are also in the agent's own instructions (pi:
`~/.pi/agent/AGENTS.md`, made from the registry in `modules/fleet.nix`).

## One machine

Run there over SSH (`ssh <host> '<command>'`), or ask its agent with `balaur-ask
<host> "<question>"` when it needs looking around (one hop: an asked agent cannot ask
a third).

```sh
systemctl --failed
systemctl status <unit>; journalctl -u <unit> -b -n 100
journalctl -u balaur-auto-deploy -n 50        # what the last deploys did
systemctl --user status <unit>                # units written user:<unit> (the session's)
df -h / /srv/files; free -h; uptime
```

Most of `/var/lib/<service>` and `/run/secrets` need root; the admin has sudo with a
password, an agent has none. Say what you could not read rather than guessing.

## Known shapes

- **Behind main.** `trying <rev> (attempt n/3)`: read the auto-deploy journal on that
  machine; the build error is in it. Push a fix. `no answer`: asleep or off the tailnet.
- **AI.** `curl -s balaur:4000/health | jq` shows each tier and why it is down. Strata
  on zmeu is stopped on purpose while a game runs (`strata-yield`: it looks for
  `reaper`, `wineserver`, `umu-run`), and starts a minute after; loading takes minutes.
- **A web UI.** On the machine: `curl -sI http://127.0.0.1:<port>`. Through the domain:
  `curl -sI https://<subdomain>.balaur.space` (Caddy and the wildcard certificate on
  balaur: `systemctl status caddy acme-balaur.space`).
- **Syncthing.** `systemctl status syncthing balaur-files-volume srv-files.mount`; the
  volume must be mounted before Syncthing starts. Replaced or deleted files are kept in
  `/srv/files/shared/.stversions` for 30 days.
- **The voice assistant** is a user unit of the household session on balaur
  (`systemctl --user -M home@ status balaur-assistant` as root).

## Report

What you ran, what it showed, what you conclude, and what you could not see.
