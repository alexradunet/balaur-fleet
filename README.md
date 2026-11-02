# Yoga Duet 7 home server

An opinionated, fully declarative NixOS home server for the **Lenovo Yoga Duet 7i (13IML05)**.
The detachable-tablet laptop becomes an appliance: the built-in touchscreen is a kiosk
dashboard, the same dashboard is a launcher for every device on your LAN, and the battery
is the UPS.

```
flake.nix                 nixos-26.05, one host: nixosConfigurations.duet
hosts/duet/               the only per-install choices (hostname, timezone, SSH keys)
modules/                  the opinions
  power.nix               never sleep, ignore lid, battery = UPS, 80% charge cap
  network.nix             AdGuard Home (DNS), Tailscale, duet.local (mDNS)
  media.nix               Jellyfin (Intel VA-API transcoding); Immich is opt-in
  files.nix               Syncthing (opt-in: duet.files.enable)
  home-automation.nix     Home Assistant, Mosquitto (loopback), optional Zigbee2MQTT
  dashboard.nix           Go service on :80, tiles registered by the modules above
  kiosk.nix               Cage + Chromium on the built-in screen
dashboard/                Go (stdlib only) backend + embedded HTML/CSS/JS frontend
```

## What you get

| Where | What |
|---|---|
| Built-in screen | `http://127.0.0.1/?kiosk=1` full-screen: clock, service health, CPU/RAM/disk/temp, battery, brightness slider. Status only, no navigation. |
| `http://duet.local` (any LAN/tailnet device) | Same dashboard as a launcher: each tile opens the service. |
| Jellyfin `:8096`, AdGuard Home `:3001`, Home Assistant `:8123` | The services. DNS on `:53`. |

Adding a service = add a module that appends to `duet.dashboard.services`; it gets a tile
with live systemd state automatically.

## Install

1. Boot the NixOS minimal ISO on the Duet (disable Secure Boot in firmware; Wi-Fi: `nmtui`, or use a USB-C ethernet dock).
2. Partition and label (**destroys the disk**; check `lsblk` first, NVMe assumed):
   ```bash
   sudo parted /dev/nvme0n1 -- mklabel gpt
   sudo parted /dev/nvme0n1 -- mkpart ESP fat32 1MiB 1GiB
   sudo parted /dev/nvme0n1 -- set 1 esp on
   sudo parted /dev/nvme0n1 -- mkpart root ext4 1GiB 100%
   sudo mkfs.fat -F32 -n BOOT /dev/nvme0n1p1
   sudo mkfs.ext4 -L nixos /dev/nvme0n1p2
   sudo mount /dev/disk/by-label/nixos /mnt
   sudo mkdir -p /mnt/boot && sudo mount /dev/disk/by-label/BOOT /mnt/boot
   ```
3. Get this repo, set your SSH key (and timezone) in `hosts/duet/default.nix`, then install:
   ```bash
   git clone <this repo> && cd yoda-duet-7-home-server
   sudo nixos-install --flake .#duet
   ```
4. Reboot. Console login is `duet` / `duet` (change it with `passwd`); SSH is key-only.
   Later changes: `sudo nixos-rebuild switch --flake .#duet`.

If your hardware differs, replace `hosts/duet/hardware.nix` with `nixos-generate-config` output.

## First-boot checklist

- **AdGuard Home** has *no login* until you set `duet.network.adguard.users` (bcrypt hash; `htpasswd -nbB "" 'pw' | cut -d: -f2`). Then point your router's DHCP DNS at the Duet's IP.
- **Tailscale + SSH**: run `sudo tailscale up` once (or set `duet.network.tailscale.authKeyFile`). Tailscale SSH is always on, so `ssh duet` works from any tailnet device using your tailnet identity (allow it in your tailnet ACL); regular sshd (key-only) is reachable over the tailnet too. SSH is also open on the LAN (key-only); set `duet.ssh.lan = false` to make Tailscale the only way in.
- **Local recovery** (Tailscale or network down): attach a keyboard to the Duet and press Ctrl+Alt+F2 for a login console (`duet` user, `sudo` available), or pick an older generation in the boot menu (last 10 kept). From there you can fix the config and rebuild.
- **Immich** (photos) is **off**. nixpkgs 26.05 marks it insecure (two known CVEs, no more 2.x updates; 3.x arrives in 26.11). Enable with `duet.media.immich.enable = true` only if you accept that, and keep it LAN/tailnet-only.
- **Zigbee**: plug in a coordinator, set `duet.homeAutomation.zigbee = { enable = true; serialPort = "/dev/serial/by-id/..."; };`.
- Service ports are open on the LAN and fully open on `tailscale0`. This is a home-LAN design; do not port-forward it.

## Opinions you may want to change

- **Battery as UPS**: at 7% the machine powers off cleanly; charge is capped at 80% where firmware allows (`duet.power.chargeLimit`, `null` to disable).
- **Never sleeps**; lid ignored; power button needs a long press.
- **Dashboard has no login.** It only exposes status, plus a brightness control (cross-site POSTs are rejected).
- **Quiet boot** with Plymouth; the screen only ever shows the dashboard.

## Developing the dashboard

```bash
nix develop            # Go toolchain
cd dashboard && go run .   # http://127.0.0.1:8088 ; DUET_CONFIG=<json> to load tiles
nix build .#dashboard
```
Backend: Go standard library only. Frontend: plain JS, no build step, embedded into the binary.

## Status

Evaluated and the dashboard built with Nix 2.34 against nixos-26.05; the full system has **not**
been booted on the Duet yet. Things most likely to need a tweak on first boot: touchscreen/pen
behaviour under Cage, whether the firmware exposes a charge-limit control, and the Zigbee serial path.
