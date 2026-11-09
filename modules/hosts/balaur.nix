# balaur: the Lenovo Yoga Duet 7 in the living room. A home server whose built-in
# screen is the household tablet. The aspects it runs are listed below; its own
# choices (account, assistant voices, ...) are the settings after them.
# Machine-generated files (hardware-configuration.nix) live in hosts/balaur/.
{ inputs, config, ... }:
let
  aspects = config.flake.modules.nixos;
in
{
  fleet.balaur = {
    description = "Yoga Duet 7 in the living room: home server + household tablet";
    tailnetIp = "100.118.102.119";
    lanIp = "192.168.50.233"; # reserved in the router
    sshHostKey = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIKgXcAskVb3sHgL8Z0VlVpSYHB2yDirUQ3GV5xfDvKQo";
    syncthingId = "MEDQJ5M-PGUYPER-IEGEHM4-NZMCWBM-LKCJVXL-W72PFVP-5OJUMTG-4X3CQAS";
    torrentsPort = 8080;
    userKeys = [ "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIE0ZoRQpfEL3tB7gO5XBC9B9eG9qvlgcGpExvmhVoMMI" ];
  };

  flake.nixosConfigurations.balaur = inputs.nixpkgs.lib.nixosSystem {
    modules = [ aspects.balaur ];
  };

  flake.modules.nixos.balaur =
    { config, ... }:
    {
    imports = with aspects; [
      yoga-duet-7
      base
      fleet
      home
      secrets
      always-on
      network
      files
      torrents
      torrents-client
      media
      adblock
      web
      aminte
      assistant
      dev
      auto-deploy
      # The fleet's AI endpoint on 127.0.0.1:4000: zmeu's GPU first, Mistral second.
      ai
      camera
      gnome
      tablet
    ]
    # Its own disk/boot layout, copied from /etc/nixos (see docs/SETUP.md).
    ++ [ ../../hosts/balaur/hardware-configuration.nix ];

    networking.hostName = "balaur";
    time.timeZone = "Europe/Bucharest";
    i18n.defaultLocale = "en_US.UTF-8";

    # The value this machine's first install wrote (/etc/nixos/configuration.nix).
    # Never "upgrade" it by hand.
    system.stateVersion = "26.05";

    balaur = {
      # An EXISTING login on the Duet (its password is kept as is). If this differed from `whoami`, NixOS would
      # create a new user and drop yours, so set it before the first rebuild.
      user = "alex";

      # The living-room Samsung (UE65AU7172, Tizen 6) is at 192.168.50.106, this machine at
      # 192.168.50.233 (both reserved in the router); AdGuard (the adblock aspect) blocks its ads.

      # Voice assistant: "Hey Jarvis", Romanian + English; Mistral for speech, a pi SDK agent for the rest.
      # Mistral, the voices and the sops key are the aspect's defaults (assistant.nix).
      assistant = {
        # This machine's microphone array at 16 kHz (`arecord -l`: DMIC16kHz). Without
        # it PipeWire picks the 48 kHz DMIC, whose processing leaves a voice far too
        # quiet for the wake word. A laptop with an ordinary mic leaves this null.
        audio.input = "plughw:0,7";
        # "Hey Jarvis" in our voices scores 0.2-0.9 (`sudo balaur-wake-test`); room noise
        # never passed 0.05. 0.35 catches most attempts; raise it if the TV wakes it.
        wakeThreshold = 0.35;
      };

      # The colour-filter layout was measured on this laptop (docs/SETUP.md, Stage 10).
      # camera.tuning.cfa = "GIGI/BGRG/GIGI/RGBG"; # only if red and blue come out swapped (default: GIGI/RGBG/GIGI/BGRG)
    };

    # FileList's username and passkey are two readable entries in the sops file;
    # the search plugin wants them as one JSON object, so sops renders it.
    sops.secrets."filelist-username" = { };
    sops.secrets."filelist-passkey" = { };
    sops.templates."filelist.json" = {
      owner = config.services.qbittorrent.user;
      mode = "0400";
      content = builtins.toJSON {
        username = config.sops.placeholder."filelist-username";
        passkey = config.sops.placeholder."filelist-passkey";
      };
    };
    balaur.torrents = {
      filelistCredentialsFile = config.sops.templates."filelist.json".path;
      manageFilelistCredentials = false;
    };

    # https://balaur.space: its A record at Gandi points at this machine's tailnet
    # address. The certificate's DNS challenge uses a Gandi personal access token
    # (Domain > "Manage domain technical configurations", balaur.space only).
    sops.secrets."gandi-token" = { };
    sops.templates."gandi.env".content = ''
      GANDIV5_PERSONAL_ACCESS_TOKEN=${config.sops.placeholder."gandi-token"}
    '';
    balaur.web = {
      domain = "balaur.space";
      dnsProvider = "gandiv5";
      dnsCredentialsFile = config.sops.templates."gandi.env".path;
    };

    # aminte's bearer token: the browser's login at https://aminte.balaur.space, and
    # the laptop's `aminte-prod` reads the same one (modules/aminte.nix).
    sops.secrets."aminte-token".owner = "aminte";
    balaur.aminte.tokenFile = config.sops.secrets."aminte-token".path;
    # The one number aminte-whatsapp listens to. In sops because the repo is public;
    # changing it restarts aminte, which aminte-whatsapp needs to pick it up.
    sops.secrets."aminte-owner-number" = {
      owner = "aminte";
      restartUnits = [ "aminte.service" ];
    };
    balaur.aminte.ownerNumberFile = config.sops.secrets."aminte-owner-number".path;
  };
}
