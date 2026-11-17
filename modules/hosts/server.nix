# server: the GMKtec NucBox EVO-X1 mini-PC (called `pc` until 2026-11-15), the fleet's most
# powerful machine and the home's always-on server (taking over from the tablet), and the
# fleet's first-choice builder. Wired, on a smart socket: the firmware powers it on
# when power returns (gmktec-evo-x1.nix has the BIOS settings).
# Machine-generated files (hardware-configuration.nix) live in hosts/server/.
{ inputs, config, ... }:
let
  aspects = config.flake.modules.nixos;
in
{
  fleet.server = {
    description = "GMKtec NucBox EVO-X1: the home server, fleet builder";
    tailnetIp = "100.118.216.118";
    sshHostKey = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAILAacHQ+NIgv8wtFGuzdu3jF52vZJtv9H9p8fqK6F6sb";
    lanIp = "192.168.50.12"; # wired (eno1, c8:ff:bf:05:0a:44), reserved in the router
    userKeys = [ "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAICC9pHQla6NLPAlOhbVp204calGMamI9kDCoTLWyUhaH" ];
    syncthingId = "PT5TONV-F2LVWWX-UDUINFG-GRL5DS5-QXBARW3-7LCUJDQ-PCDWATW-IG5PTQJ";
    # qBittorrent's web UI (`torrents`): where `balaur-torrent` can send downloads.
    torrentsPort = 8080;
    # 12 cores / 24 threads against the laptop's 8 / 16, so the others send it their
    # builds first. 12 jobs leaves half the threads; the daemon also runs at idle
    # priority here (below), so the services always come first.
    builder = {
      maxJobs = 12;
      speedFactor = 4;
    };
  };

  flake.nixosConfigurations.server = inputs.nixpkgs.lib.nixosSystem {
    modules = [ aspects.host-server ];
  };

  flake.modules.nixos.host-server =
    { config, ... }:
    {
      imports =
        (with aspects; [
          gmktec-evo-x1
          # What every machine has, in the same order on every host.
          base
          fleet
          home
          # Decrypts with its SSH host key, a recipient in .sops.yaml.
          secrets
          network
          dev
          files
          torrents-client
          auto-deploy
          # The fleet's AI entryway (ai-gateway, below), as a client.
          ai
          # The Balaur agent (`balaur`): pi with the fleet's instructions and the life log as its memory.
          agent
          # This machine's own.
          # A mini-PC on mains power, a server and a builder: never suspend.
          never-sleep
          # Headless (no GNOME, no RDP since 2026-11-15): its admin page is Cockpit,
          # https://cockpit.balaur.space.
          cockpit
          # /srv/proton (the second NVMe) mirrored to the whole of Proton Drive, hourly.
          proton-drive
          # A failed unit or a disk in trouble is told to the owner, through Home Assistant.
          notify
          # The state only this machine has (Home Assistant, AdGuard, qBittorrent, the
          # life log's history), nightly, into /srv/proton: so on the second disk, and
          # in Proton Drive an hour later (balaur.backup below).
          backup
          # Orca's runtime for the laptop's Orca to pair with, from boot (:6768, tailnet).
          orca-server
          # The fleet's local LLM, on the Radeon 890M (Qwen3.6 35B-A3B).
          local-llm
          # The fleet's AI entryway (http://server:4000/v1), moved from the tablet: the
          # clients take the first machine that has it. Its page is https://ai.balaur.space,
          # behind this machine's web front.
          ai-gateway
          # The LAN's DNS server with ad and tracker blocking (AdGuard Home), moved from
          # the tablet: the router hands out 192.168.50.12 as the DNS server.
          adblock
          # https://balaur.space: the home page and this machine's web UIs behind Caddy,
          # moved from the tablet (balaur.web below).
          web
          # The life log's keeper, moved from the tablet (its history imported
          # 2026-11-15): the folder, its checked history and https://life.balaur.space.
          lifelog
          # Home Assistant, moved from the tablet (its state imported 2026-11-15):
          # https://home.balaur.space and :8123.
          home-assistant
          # The humanshorts project is rendered here: its videos ready to post, with cover
          # and caption, at https://shorts.balaur.space for the laptop and the phone.
          shorts
          # qBittorrent with FileList search, moved from the tablet: /srv/media.
          torrents
          # Its movies and shows and a folder of the old disk, for the TV and the other
          # players on the home network (below). In place of Jellyfin: no transcoding,
          # next to nothing on the CPU.
          dlna
        ])
        # Its own disk/boot layout, copied from /etc/nixos (the `add-machine` skill,
        # .agents/skills). It must be `git add`ed or flakes cannot see it.
        ++ [ ../../hosts/server/hardware-configuration.nix ];

      networking.hostName = "server";

      # The value this machine's first install wrote. Never "upgrade" it by hand.
      system.stateVersion = "26.05";
      # The EFI partition is at /boot and the install uses systemd-boot, which is
      # what `base` sets: no boot.loader override needed here.

      # Builds for the fleet wait for idle CPU and disk, so they never slow the
      # services.
      nix.daemonCPUSchedPolicy = "idle";
      nix.daemonIOSchedClass = "idle";

      # FileList's username and passkey are two entries in this machine's own sops
      # file (secrets/hosts/server.yaml); the search plugin wants them as one JSON object.
      sops.secrets."filelist-username".sopsFile = config.balaur.secrets.hostFile;
      sops.secrets."filelist-passkey".sopsFile = config.balaur.secrets.hostFile;
      sops.templates."filelist.json" = {
        owner = config.services.qbittorrent.user;
        mode = "0400";
        content = builtins.toJSON {
          username = config.sops.placeholder."filelist-username";
          passkey = config.sops.placeholder."filelist-passkey";
        };
      };

      # https://balaur.space: its A records at Gandi point at this machine's tailnet
      # address. The certificate's DNS challenge uses a Gandi personal access token
      # (Domain > "Manage domain technical configurations", balaur.space only).
      sops.secrets."gandi-token".sopsFile = config.balaur.secrets.hostFile;
      sops.templates."gandi.env".content = ''
        GANDIV5_PERSONAL_ACCESS_TOKEN=${config.sops.placeholder."gandi-token"}
      '';
      balaur.web = {
        domain = "balaur.space";
        dnsProvider = "gandiv5";
        dnsCredentialsFile = config.sops.templates."gandi.env".path;
        # The phone. With the fleet's machines, the devices that open everything; a
        # device of another Tailscale account the server is shared with gets the
        # household's services only (modules/web.nix).
        ownerAddresses = [ "100.79.180.82" ];
      };

      # The second NVMe (the Crucial P3), two ext4 halves by label: `proton`, the
      # personal files Proton Drive keeps a copy of, and `media`, qBittorrent's
      # downloads that DLNA serves. nofail, so the machine boots without the disk.
      fileSystems."/srv/proton" = {
        device = "/dev/disk/by-label/proton";
        fsType = "ext4";
        options = [ "nofail" ];
      };
      fileSystems."/srv/media" = {
        device = "/dev/disk/by-label/media";
        fsType = "ext4";
        options = [ "nofail" ];
      };
      systemd.tmpfiles.rules = [ "d /srv/proton 0750 alex users - -" ];

      sops.secrets."restic-password".sopsFile = config.balaur.secrets.hostFile;

      balaur = {
        # The existing login on this machine; its password is kept as is.
        user = "alex";
        # The phone the fleet's rules in Home Assistant tell (home-assistant.nix).
        home-assistant.notify = [ "mobile_app_samsung_phone" ];
        backup = {
          repository = "/srv/proton/restic-backup";
          passwordFile = config.sops.secrets."restic-password".path;
          # proton-drive's sync runs as the admin and must read it.
          owner = "alex";
        };
        # Served to the home network (no login: dlna.nix): qBittorrent's movies and
        # shows (the categories).
        dlna.dirs = [
          "V,/srv/media/movies"
          "V,/srv/media/shows"
        ];
        # FileList's login for the search plugin, from this machine's sops file (below).
        torrents = {
          filelistCredentialsFile = config.sops.templates."filelist.json".path;
          manageFilelistCredentials = false;
        };
        # It stays at home, wired or on the home Wi-Fi: SSH and the Syncthing UI on
        # the LAN as well.
        # The work laptop (Windows, outside the tailnet): SSH on the LAN to this
        # machine only. Not in fleet.server.userKeys, so it cannot sign deploys.
        # Read off a photo; one character (0/O) unsure, so both readings until the
        # first login shows which one it is.
        sshKeys = [
          "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIM8ccP+5/xpPg9/0nC/0b0rpG0YEyGroIk/50K7VpEqG cico@balaur"
          "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIM8ccP+5/xpPg9/0nC/0b0rpG0YEyGroIk/5OK7VpEqG cico@balaur"
        ];
      };
    };
}
