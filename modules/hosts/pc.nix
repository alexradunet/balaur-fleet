# pc: the GMKtec NucBox EVO-X1 mini-PC, the fleet's most powerful machine, on its
# way to being the home's always-on server (taking over from the tablet) and the
# fleet's first-choice builder. Wired, on a smart socket: the firmware powers it on
# when power returns (gmktec-evo-x1.nix has the BIOS settings).
# Machine-generated files (hardware-configuration.nix) live in hosts/pc/.
{ inputs, config, ... }:
let
  aspects = config.flake.modules.nixos;
in
{
  fleet.pc = {
    description = "GMKtec NucBox EVO-X1: the home server, fleet builder";
    tailnetIp = "100.118.216.118";
    sshHostKey = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAILAacHQ+NIgv8wtFGuzdu3jF52vZJtv9H9p8fqK6F6sb";
    lanIp = null; # DHCP, was 192.168.50.215 on Wi-Fi; not reserved in the router
    userKeys = [ "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAICC9pHQla6NLPAlOhbVp204calGMamI9kDCoTLWyUhaH" ];
    syncthingId = "PT5TONV-F2LVWWX-UDUINFG-GRL5DS5-QXBARW3-7LCUJDQ-PCDWATW-IG5PTQJ";
    # 12 cores / 24 threads against the laptop's 8 / 16, so the others send it their
    # builds first. 12 jobs leaves half the threads; the daemon also runs at idle
    # priority here (below), so the services always come first.
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
          auto-deploy
          # The fleet's AI entryway (on the tablet), as a client.
          ai
          # pi, the OS agent: knows the fleet, asks the other machines' agents (balaur-ask).
          agent
          # This machine's own.
          # A mini-PC on mains power, a server and a builder: never suspend.
          never-sleep
          # Its GNOME desktop over RDP, on the tailnet, with no monitor attached.
          remote-desktop
          # The fleet's local LLM, on the Radeon 890M (Nemotron 3.5 Lightning).
          local-llm
          # The life log as files: the folder, `lifelog`, Obsidian, and the nightly mirror of
          # the keeper's history (balaur.lifelog-client.mirrorFrom below).
          lifelog-client
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

      # Builds for the fleet wait for idle CPU and disk, so they never slow the
      # services.
      nix.daemonCPUSchedPolicy = "idle";
      nix.daemonIOSchedClass = "idle";

      # The second NVMe: the old Windows disk, kept for the personal media on it.
      # Writable, to tidy it from here; nofail, so the machine boots without it.
      fileSystems."/mnt/old-ssd" = {
        device = "/dev/disk/by-uuid/1C6CA5E96CA5BE40";
        fsType = "ntfs3";
        options = [
          "nofail"
          "uid=1000"
          "gid=100"
          "x-gvfs-show"
        ];
      };

      balaur = {
        # The existing login on this machine; its password is kept as is.
        user = "alex";
        # A second copy of the life log's history, fetched nightly from the keeper.
        lifelog-client.mirrorFrom = "tablet";
        # A folder of the old disk, served to the home network (no login: dlna.nix).
        dlna.dirs = [ "/mnt/old-ssd/True Strength" ];
        # It stays at home, wired or on the home Wi-Fi: SSH and the Syncthing UI on
        # the LAN as well, like the tablet.
      };
    };
}
