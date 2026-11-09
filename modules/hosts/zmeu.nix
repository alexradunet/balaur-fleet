# zmeu: the GMKtec NucBox EVO-X1 mini-PC, the fleet's most powerful machine. A
# personal GNOME desktop for gaming (an RTX 5060 Ti on OCuLink), the host that
# streams games to the rest of the tailnet, and the fleet's first-choice builder.
# Machine-generated files (hardware-configuration.nix) live in hosts/zmeu/.
{ inputs, config, ... }:
let
  aspects = config.flake.modules.nixos;
  hm = config.flake.modules.homeManager;
in
{
  fleet.zmeu = {
    description = "GMKtec NucBox EVO-X1: gaming desktop, game streaming host, fleet builder";
    tailnetIp = "100.118.216.118";
    sshHostKey = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAILAacHQ+NIgv8wtFGuzdu3jF52vZJtv9H9p8fqK6F6sb";
    lanIp = null; # DHCP, was 192.168.50.215 on Wi-Fi; not reserved in the router
    # userKeys: none yet; the admin works from laptop, whose key every machine trusts.
    syncthingId = "PT5TONV-F2LVWWX-UDUINFG-GRL5DS5-QXBARW3-7LCUJDQ-PCDWATW-IG5PTQJ";
    # 12 cores / 24 threads against the laptop's 8 / 16, so the others send it their
    # builds first. 12 jobs leaves half the threads; the daemon also runs at idle
    # priority here (below), so a game always comes first.
    builder = { maxJobs = 12; speedFactor = 4; };
  };

  flake.nixosConfigurations.zmeu = inputs.nixpkgs.lib.nixosSystem {
    modules = [ aspects.zmeu ];
  };

  flake.modules.nixos.zmeu =
    { config, ... }:
    {
      imports = (with aspects; [
        gmktec-evo-x1
        nvidia-egpu
        base
        fleet
        home
        network
        gnome
        desktop
        dev
        files
        torrents-client
        gaming
        steam
        game-streaming
        # Follows main on GitHub by itself; the first machine to, before the rest.
        auto-deploy
        # Decrypts with its SSH host key, a recipient in .sops.yaml.
        secrets
        # Runs as alex (no `tablet` here), on PipeWire's default microphone.
        # Retune wakeThreshold for that microphone with `sudo balaur-wake-test`.
        assistant
      ])
      # Its own disk/boot layout, copied from /etc/nixos (see CLAUDE.md, "Adding a
      # machine"). It must be `git add`ed or flakes cannot see it.
      ++ [ ../../hosts/zmeu/hardware-configuration.nix ];

      networking.hostName = "zmeu";
      time.timeZone = "Europe/Bucharest";

      # Carried over from this install's /etc/nixos/configuration.nix.
      i18n.defaultLocale = "en_US.UTF-8";
      i18n.extraLocaleSettings = {
        LC_ADDRESS = "ro_RO.UTF-8";
        LC_IDENTIFICATION = "ro_RO.UTF-8";
        LC_MEASUREMENT = "ro_RO.UTF-8";
        LC_MONETARY = "ro_RO.UTF-8";
        LC_NAME = "ro_RO.UTF-8";
        LC_NUMERIC = "ro_RO.UTF-8";
        LC_PAPER = "ro_RO.UTF-8";
        LC_TELEPHONE = "ro_RO.UTF-8";
        LC_TIME = "ro_RO.UTF-8";
      };
      services.printing.enable = true;
      nixpkgs.config.allowUnfree = true; # the NVIDIA driver, Steam

      # The value this machine's first install wrote. Never "upgrade" it by hand.
      system.stateVersion = "26.05";
      # The EFI partition is at /boot and the install uses systemd-boot, which is
      # what `base` sets: no boot.loader override needed here.

      # ---- always reachable for streaming ----
      # Sunshine runs in the admin's session, so log in at boot instead of waiting
      # at GDM. The screen still locks when idle, and a locked screen can be
      # unlocked over Moonlight.
      services.displayManager.autoLogin = { enable = true; user = config.balaur.user; };
      # A mini-PC on mains power, and a builder: never suspend, or Moonlight and
      # the other machines' builds would find it asleep.
      systemd.targets = {
        sleep.enable = false;
        suspend.enable = false;
        hibernate.enable = false;
        hybrid-sleep.enable = false;
      };
      services.displayManager.gdm.autoSuspend = false;

      # Builds for the fleet wait for idle CPU and disk, so they never take
      # frames from a game.
      nix.daemonCPUSchedPolicy = "idle";
      nix.daemonIOSchedClass = "idle";

      # The second NVMe: the old Windows disk, kept for the personal media on it.
      # Read-only until its future is decided; nofail, so the machine boots without it.
      fileSystems."/mnt/old-ssd" = {
        device = "/dev/disk/by-uuid/1C6CA5E96CA5BE40";
        fsType = "ntfs3";
        options = [ "ro" "nofail" "uid=1000" "gid=100" "x-gvfs-show" ];
      };

      # The admin's own GNOME bits on top of the shared shell/git (modules/home.nix).
      home-manager.users.${config.balaur.user}.imports = [ hm.desktop hm.torrents-client ];

      balaur = {
        # The existing login on this machine; its password is kept as is.
        user = "alex";
        # It stays at home, wired or on the home Wi-Fi: SSH and the Syncthing UI on
        # the LAN as well, like balaur.
      };
    };
}
