# The Yoga Duet 7 home server. Everything opinionated lives in ../../modules;
# this file holds only the choices that are specific to *your* install.
{ lib, ... }:
{
  imports = [
    ./hardware.nix
    ../../modules
  ]
  # Your machine's own disk/boot layout, copied from /etc/nixos on the Duet
  # (see docs/SETUP.md). It must be `git add`ed or flakes cannot see it.
  ++ (
    if builtins.pathExists ./hardware-configuration.nix
    then [ ./hardware-configuration.nix ]
    else [ ./fallback-filesystems.nix ]
  );

  networking.hostName = "duet";
  time.timeZone = "Europe/Bucharest"; # change me
  i18n.defaultLocale = "en_US.UTF-8";

  # TEMPORARY, development only: wheel users (alex) get sudo without a password so
  # Claude Code can rebuild and tune the camera. Delete this line when development is done.
  security.sudo.wheelNeedsPassword = false;

  # Keep the same value your first install put in /etc/nixos/configuration.nix.
  # system.stateVersion = "26.05";
  # boot.loader.efi.efiSysMountPoint = "/boot/efi";   # only if your EFI partition is mounted there

  duet = {
    # An EXISTING login on the Duet (its password is kept as is). If this differed from `whoami`, NixOS would
    # create a new user and drop yours, so set it before the first rebuild.
    user = "alex";

    # Front camera: patched kernel modules + the RGB-IR pipeline in camera/; GNOME Snapshot shows it, movement wakes the screen.
    camera.enable = true;

    # Jellyfin (:8096) + qBittorrent with torrent search (:8080), media in /srv/media.
    media.enable = true;

    # AdGuard Home (DNS :53, UI :3000). Point the TV's DNS (or the router's) at this machine.
    adblock.enable = true;

    # The living-room Samsung (UE65AU7172, Tizen 6) is at 192.168.50.106, this machine at
    # 192.168.50.233 (both reserved in the router); AdGuard above blocks its ads.

    # Voice assistant: "Hey Jarvis", Romanian + English; Mistral for speech, a pi SDK agent for the rest.
    # Key: Duet app > Assistant settings (GNOME Keyring), or `sudo duet-assistant-login` (/var/lib/secrets).
    assistant = {
      enable = true;
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
      # location = { name = "Bucharest"; latitude = 44.4268; longitude = 26.1025; };
    };

    # The colour-filter layout was measured on this laptop (docs/SETUP.md, Stage 10).
    # camera.tuning.cfa = "GIGI/BGRG/GIGI/RGBG"; # only if red and blue come out swapped (default: GIGI/RGBG/GIGI/BGRG)
    # SSH uses your account password for now. Later: add sshKeys, set ssh.passwordAuth = false.
    # sshKeys = [ "ssh-ed25519 AAAA... you@laptop" ];
    # network.tailscale.authKeyFile = "/var/lib/secrets/tailscale-authkey";
    # storage.root = "/srv";
  };
}
