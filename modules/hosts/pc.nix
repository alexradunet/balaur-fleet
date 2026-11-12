# pc: the GMKtec NucBox EVO-X1 mini-PC, the fleet's most powerful machine. A
# personal GNOME desktop for gaming (an RTX 5060 Ti on OCuLink), the host that
# streams games to the rest of the tailnet, and the fleet's first-choice builder.
# Machine-generated files (hardware-configuration.nix) live in hosts/pc/.
{ inputs, config, ... }:
let
  aspects = config.flake.modules.nixos;
in
{
  fleet.pc = {
    description = "GMKtec NucBox EVO-X1: gaming desktop, game streaming host, fleet builder";
    tailnetIp = "100.118.216.118";
    sshHostKey = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAILAacHQ+NIgv8wtFGuzdu3jF52vZJtv9H9p8fqK6F6sb";
    lanIp = null; # DHCP, was 192.168.50.215 on Wi-Fi; not reserved in the router
    userKeys = [ "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAICC9pHQla6NLPAlOhbVp204calGMamI9kDCoTLWyUhaH" ];
    syncthingId = "PT5TONV-F2LVWWX-UDUINFG-GRL5DS5-QXBARW3-7LCUJDQ-PCDWATW-IG5PTQJ";
    # 12 cores / 24 threads against the laptop's 8 / 16, so the others send it their
    # builds first. 12 jobs leaves half the threads; the daemon also runs at idle
    # priority here (below), so a game always comes first.
    builder = {
      maxJobs = 12;
      speedFactor = 4;
    };
  };

  flake.nixosConfigurations.pc = inputs.nixpkgs.lib.nixosSystem {
    modules = [ aspects.host-pc ];
  };

  flake.modules.nixos.host-pc =
    { config, ... }:
    {
      imports =
        (with aspects; [
          gmktec-evo-x1
          nvidia-egpu
          # What every machine has, in the same order on every host.
          base
          fleet
          home
          # Decrypts with its SSH host key, a recipient in .sops.yaml.
          secrets
          network
          gnome
          desktop
          dev
          files
          torrents-client
          # Runs as alex (no `tablet` here), on PipeWire's default microphone.
          # Retune wakeThreshold for that microphone with `sudo balaur-wake-test`.
          assistant
          auto-deploy
          # The fleet's AI entryway (on the tablet), as a client.
          ai
          # pi, the OS agent: knows the fleet, asks the other machines' agents (balaur-ask).
          agent
          # This machine's own.
          # A mini-PC on mains power, and a builder: never suspend, or Moonlight and
          # the other machines' builds would find it asleep.
          never-sleep
          # aminte runs on the tablet; this is the dev side (aminte-prod, the binaries), and
          # what gives pi its aminte role here (pi-aminte, agent.nix).
          aminte-dev
          gaming
          # What to craft, buy and sell in WoW: Forever, from Auctionator's scans.
          wow-market
          steam
          game-streaming
          # The fleet's local LLM on the 5060 Ti (stopped while a game runs).
          strata
          # A folder of the old disk, for the players on the home network (below).
          dlna
        ])
        # Its own disk/boot layout, copied from /etc/nixos (the `add-machine` skill,
        # .agents/skills). It must be `git add`ed or flakes cannot see it.
        ++ [ ../../hosts/pc/hardware-configuration.nix ];

      networking.hostName = "pc";

      # The value this machine's first install wrote. Never "upgrade" it by hand.
      system.stateVersion = "26.05";
      # The EFI partition is at /boot and the install uses systemd-boot, which is
      # what `base` sets: no boot.loader override needed here.

      # ---- always reachable for streaming ----
      # Sunshine runs in the admin's session, so log in at boot instead of waiting
      # at GDM. The screen still locks when idle, and a locked screen can be
      # unlocked over Moonlight.
      services.displayManager.autoLogin = {
        enable = true;
        user = config.balaur.user;
      };
      # Builds for the fleet wait for idle CPU and disk, so they never take
      # frames from a game.
      nix.daemonCPUSchedPolicy = "idle";
      nix.daemonIOSchedClass = "idle";

      # The living-room TV runs Moonlight but is not on the tailnet (game-streaming).
      balaur.gameStreaming.lanClients = [ "192.168.50.106" ];

      # The second NVMe: the old Windows disk, kept for the personal media on it.
      # Read-only until its future is decided; nofail, so the machine boots without it.
      fileSystems."/mnt/old-ssd" = {
        device = "/dev/disk/by-uuid/1C6CA5E96CA5BE40";
        fsType = "ntfs3";
        options = [
          "ro"
          "nofail"
          "uid=1000"
          "gid=100"
          "x-gvfs-show"
        ];
      };

      balaur = {
        # The existing login on this machine; its password is kept as is.
        user = "alex";
        # A folder of the old disk, served to the home network (no login: dlna.nix).
        dlna.dirs = [ "/mnt/old-ssd/True Strength" ];
        # It stays at home, wired or on the home Wi-Fi: SSH and the Syncthing UI on
        # the LAN as well, like the tablet.
      };
    };
}
