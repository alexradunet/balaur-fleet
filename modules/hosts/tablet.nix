# tablet: the Lenovo Yoga Duet 7 in the living room. A home server whose built-in
# screen is the household tablet. The aspects it runs are listed below; its own
# choices (account, assistant voices, ...) are the settings after them.
# Machine-generated files (hardware-configuration.nix) live in hosts/tablet/.
{ inputs, config, ... }:
let
  aspects = config.flake.modules.nixos;
in
{
  fleet.tablet = {
    description = "Yoga Duet 7 in the living room: home server + household tablet";
    tailnetIp = "100.118.102.119";
    lanIp = "192.168.50.233"; # reserved in the router
    sshHostKey = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIKgXcAskVb3sHgL8Z0VlVpSYHB2yDirUQ3GV5xfDvKQo";
    syncthingId = "MEDQJ5M-PGUYPER-IEGEHM4-NZMCWBM-LKCJVXL-W72PFVP-5OJUMTG-4X3CQAS";
    torrentsPort = 8080;
    devHost = true;
    userKeys = [ "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIE0ZoRQpfEL3tB7gO5XBC9B9eG9qvlgcGpExvmhVoMMI" ];
  };

  flake.nixosConfigurations.tablet = inputs.nixpkgs.lib.nixosSystem {
    modules = [ aspects.host-tablet ];
  };

  flake.modules.nixos.host-tablet =
    { config, ... }:
    {
      imports =
        (with aspects; [
          yoga-duet-7
          # What every machine has, in the same order on every host.
          base
          fleet
          home
          secrets
          network
          gnome
          # The household screen, in place of `desktop`.
          tablet
          dev
          files
          torrents-client
          assistant
          auto-deploy
          ai
          # pi, the OS agent: knows the fleet, asks the other machines' agents (balaur-ask).
          agent
          # This machine's own: the home's server, so it never sleeps.
          never-sleep
          always-on
          # Every machine's `dev` lands here: the sessions live on the one that never sleeps.
          dev-host
          # The fleet's AI entryway for every machine (http://tablet:4000/v1, page at
          # https://ai.balaur.space): the pc's GPU first, Mistral second.
          ai-gateway
          torrents
          media
          adblock
          web
          aminte
          # The household's notes: an account for each person the tablet is shared with.
          memos
          home-assistant
          camera
        ])
        # Its own disk/boot layout, copied from /etc/nixos (the `add-machine` skill,
        # .agents/skills). It must be `git add`ed or flakes cannot see it.
        ++ [ ../../hosts/tablet/hardware-configuration.nix ];

      networking.hostName = "tablet";

      # The value this machine's first install wrote (/etc/nixos/configuration.nix).
      # Never "upgrade" it by hand.
      system.stateVersion = "26.05";

      balaur = {
        # An EXISTING login on the Duet (its password is kept as is). If this differed from `whoami`, NixOS would
        # create a new user and drop yours, so set it before the first rebuild.
        user = "alex";

        # The living-room Samsung (UE65AU7172, Tizen 6) is at 192.168.50.106, this machine at
        # 192.168.50.233 (both reserved in the router); AdGuard (the adblock aspect) blocks its ads.

        # Voice assistant: "Hey Jarvis", Romanian + English; Mistral for speech, pi (RPC mode, gnome/home-agent) for the rest.
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
        # The screen goes off after 15 minutes with nobody there, so the photos
        # (ambient screen, after a minute) stay up a while. Movement still keeps it on.
        camera.screenTimeout = 15 * 60;

        # camera.tuning.cfa ="GIGI/BGRG/GIGI/RGBG"; # only if red and blue come out swapped (default: GIGI/RGBG/GIGI/BGRG)
      };

      # FileList's username and passkey are two entries in this machine's own sops
      # file (secrets/hosts/tablet.yaml); the search plugin wants them as one JSON
      # object, so sops renders it.
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
      balaur.torrents = {
        filelistCredentialsFile = config.sops.templates."filelist.json".path;
        manageFilelistCredentials = false;
      };

      # https://balaur.space: its A record at Gandi points at this machine's tailnet
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
      };

      # aminte's bearer token: the browser's login at https://aminte.balaur.space, and
      # the laptop's `aminte-prod` reads the same one (modules/aminte.nix).
      sops.secrets."aminte-token".owner = "aminte";
      balaur.aminte.tokenFile = config.sops.secrets."aminte-token".path;
    };
}
