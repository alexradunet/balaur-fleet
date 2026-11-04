# duet: the Lenovo Yoga Duet 7 in the living room. A home server whose built-in
# screen is the household tablet. The aspects it runs are listed below; its own
# choices (account, assistant voices, ...) are the settings after them.
# Machine-generated files (hardware-configuration.nix) live in hosts/duet/.
{ inputs, config, ... }:
let
  aspects = config.flake.modules.nixos;
in
{
  fleet.duet = {
    description = "Yoga Duet 7 in the living room: home server + household tablet";
    tailnetIp = "100.118.102.119";
    lanIp = "192.168.50.233"; # reserved in the router
    sshHostKey = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIKgXcAskVb3sHgL8Z0VlVpSYHB2yDirUQ3GV5xfDvKQo";
    # userKeys: none yet (you reach it with Tailscale SSH)
  };

  flake.nixosConfigurations.duet = inputs.nixpkgs.lib.nixosSystem {
    modules = [ aspects.duet ];
  };

  flake.modules.nixos.duet = {
    imports = with aspects; [
      yoga-duet-7
      base
      fleet
      home
      always-on
      network
      # files (Syncthing): not on this machine yet
      media
      adblock
      assistant
      dev
      camera
      tablet
    ]
    # Your machine's own disk/boot layout, copied from /etc/nixos on the Duet
    # (see docs/SETUP.md). It must be `git add`ed or flakes cannot see it.
    ++ (
      if builtins.pathExists ../../hosts/duet/hardware-configuration.nix
      then [ ../../hosts/duet/hardware-configuration.nix ]
      else [ ../../hosts/duet/fallback-filesystems.nix ]
    );

    networking.hostName = "duet";
    time.timeZone = "Europe/Bucharest";
    i18n.defaultLocale = "en_US.UTF-8";

    # TEMPORARY, development only: wheel users (alex) get sudo without a password so
    # Claude Code can rebuild and tune the camera. Delete this line when development is done.
    security.sudo.wheelNeedsPassword = false;

    # Keep the same value your first install put in /etc/nixos/configuration.nix.
    # system.stateVersion = "26.05";
    # boot.loader.efi.efiSysMountPoint = "/boot/efi";   # only if your EFI partition is mounted there

    balaur = {
      # An EXISTING login on the Duet (its password is kept as is). If this differed from `whoami`, NixOS would
      # create a new user and drop yours, so set it before the first rebuild.
      user = "alex";

      # The living-room Samsung (UE65AU7172, Tizen 6) is at 192.168.50.106, this machine at
      # 192.168.50.233 (both reserved in the router); AdGuard (the adblock aspect) blocks its ads.

      # Voice assistant: "Hey Jarvis", Romanian + English; Mistral for speech, a pi SDK agent for the rest.
      # Key: Balaur app > Assistant settings (GNOME Keyring), or `sudo duet-assistant-login` (/var/lib/secrets).
      assistant = {
        # Mistral (EU, Paris): OpenAI-compatible, tool calling. Key from console.mistral.ai.
        llm = {
          baseUrl = "https://api.mistral.ai/v1";
          model = "mistral-medium-latest"; # small was faster but answered English in Romanian
        };
        # Mistral preset voices (`sudo duet-assistant-login` lists them all).
        tts.voices = {
          ro = "01a155a0-3dbb-7274-ab31-7fa1ebf35a3e"; # Irina
          en = "82c99ee6-f932-423f-a4a3-d403c8914b8d"; # Jane - Neutral (British)
        };
        # "Hey Jarvis" in our voices scores 0.2-0.9 (`sudo duet-wake-test`); room noise
        # never passed 0.05. 0.35 catches most attempts; raise it if the TV wakes it.
        wakeThreshold = 0.35;
      };

      # The colour-filter layout was measured on this laptop (docs/SETUP.md, Stage 10).
      # camera.tuning.cfa = "GIGI/BGRG/GIGI/RGBG"; # only if red and blue come out swapped (default: GIGI/RGBG/GIGI/BGRG)
      # SSH uses your account password for now. Later: add sshKeys, set ssh.passwordAuth = false.
      # sshKeys = [ "ssh-ed25519 AAAA... you@laptop" ];
      # network.tailscale.authKeyFile = "/var/lib/secrets/tailscale-authkey";
      # storage.root = "/srv";
    };
  };
}
