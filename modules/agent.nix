# The OS agent: pi (pi.dev), the same on every machine, set up to know the fleet.
#
#   pi                         the agent, in a terminal (start it in the fleet's clone
#                              to work on this configuration)
#   pi -p "question"           one answer, then exit
#   balaur-ask HOST "question" ask the agent on another machine, which answers from
#                              what it sees there (its journal, units, hardware)
#
# What the aspect gives the admin account, in ~/.pi/agent (pi's own directory;
# its logins and sessions stay there too, unmanaged):
#
#   models.json    the fleet's AI entryway (ai.nix) as the provider `balaur`, with
#                  the entryway's three names: balaur, balaur-local, balaur-remote
#   settings.json  that provider and `balaur.agent.model` as the default. It is
#                  read-only: a default saved from inside pi does not stick.
#   AGENTS.md      who it is, every machine and service of the fleet, where the
#                  configuration is and how a change reaches the machines. Made
#                  from the registry (fleet.nix) and each host's `balaur.services`,
#                  so a new machine or service is known to every agent after a push.
#
# Agents reach each other the way everything in the fleet does: SSH over the
# tailnet, with the admin keys the registry already authorizes. Nothing listens,
# nothing runs while nobody asks. An asked agent reports and changes nothing; a
# fix is a commit pushed by the one who asked, which every machine then follows
# (auto-deploy.nix). One hop only: an asked agent cannot ask a third.
#
# pi runs its tools (shell, files) without asking, as the admin account. sudo
# still wants the password, so root is reached through a pushed commit, not directly.
#
# It needs the `ai` aspect, and `home` to write the files.
{ inputs, config, ... }:
let
  nixosConfigs = config.flake.nixosConfigurations;
  fleet = config.fleet;
in
{
  flake.modules.nixos.agent =
    {
      config,
      options,
      lib,
      pkgs,
      ...
    }:
    let
      cfg = config.balaur;
      me = config.networking.hostName;
      pi = inputs.llm-agents.packages.${pkgs.stdenv.hostPlatform.system}.pi;
      aiUrl = cfg.ai.url or (throw "the `agent` aspect needs the `ai` aspect on ${me}");

      known = h: h == me || nixosConfigs ? ${h};
      hostConfig = h: if h == me then config else nixosConfigs.${h}.config;
      # The other machines that have an agent to ask.
      peers = lib.filter (h: h != me && known h && (hostConfig h).balaur ? agent) (lib.attrNames fleet);

      models = pkgs.writeText "pi-models.json" (
        builtins.toJSON {
          providers.balaur = {
            baseUrl = aiUrl;
            api = "openai-completions";
            apiKey = "balaur"; # not a secret: the entryway takes no key (ai.nix)
            # 128k is Strata's window on zmeu (n_ctx 131072) and no more than Mistral's.
            models =
              map
                (
                  m:
                  m
                  // {
                    contextWindow = 128000;
                    maxTokens = 16384;
                  }
                )
                [
                  {
                    id = "balaur";
                    name = "Balaur (the entryway's route: local GPU first, Mistral second)";
                  }
                  {
                    id = "balaur-local";
                    name = "Balaur local (the fleet's GPU only)";
                    input = [
                      "text"
                      "image"
                    ];
                  }
                  {
                    id = "balaur-remote";
                    name = "Balaur remote (Mistral only)";
                  }
                ];
          };
        }
      );

      settings = pkgs.writeText "pi-settings.json" (
        builtins.toJSON {
          defaultProvider = "balaur";
          defaultModel = cfg.agent.model;
        }
      );

      machine =
        h:
        let
          e = fleet.${h};
          services = lib.optionals (known h) (hostConfig h).balaur.services;
        in
        ''
          ### ${h}${lib.optionalString (h == me) " (this machine)"}

          ${e.description}
          Address: `${if h == me then "127.0.0.1" else e.address}`${
            lib.optionalString (h != me && e.tailnetIp != null) " (tailnet ${e.tailnetIp})"
          }.${lib.optionalString (lib.elem h peers) " Its agent: `balaur-ask ${h} \"...\"`."}

          ${lib.concatMapStrings (
            s:
            "- ${s.name}${lib.optionalString (s.description != "") ": ${s.description}"}${
              lib.optionalString (s.unit != "") " (`${s.unit}`)"
            }\n"
          ) services}
        '';

      instructions = pkgs.writeText "pi-AGENTS.md" ''
        # The OS agent of ${me}

        You are the agent of this operating system: NixOS on `${me}`, one machine of a
        small home fleet (the Balaur fleet) that one flake configures. You look after
        the machines, their services and that configuration. Each machine has an agent
        like you, with the same instructions.

        ## The machines and what runs on them

        ${lib.concatMapStrings machine (lib.attrNames fleet)}
        The addresses of the web pages, as this machine reaches them, are in
        `/etc/balaur/services.json`. A unit written `user:<unit>` runs in the desktop
        session (`systemctl --user`). Machines reach each other at the names above, over
        the tailnet (Tailscale), and `ssh <name>` works between all of them.

        ## Models

        You answer through the fleet's AI entryway, `${aiUrl}`: the model `balaur` is the
        fleet's GPU when it is free and Mistral otherwise, `balaur-local` and
        `balaur-remote` are one of the two. `curl -s ${lib.removeSuffix "/v1" aiUrl}/health` shows
        which are up.

        ## The configuration

        Everything on these machines is declared in one repository, cloned at
        `${cfg.agent.clone}` on this machine. Nothing is installed or configured by
        hand: a change is a change to that repository.

        - Read its `CLAUDE.md` before you change anything. Its rules are yours too.
        - Look first (`systemctl status`, `journalctl -u <unit>`, the module in `modules/`).
        - Check a change before it leaves: evaluate or build the hosts it touches, as
          `CLAUDE.md` describes.
        - Deploying is `git commit` and `git push`. Every machine checks `main` every few
          minutes and switches to it by itself (`journalctl -u balaur-auto-deploy`).
        - The repository is public. Never commit a secret, a key, a token or personal data.
        - `sudo` asks for a password you do not have. Do not work around it: what needs
          root belongs in the configuration.

        ## The other agents

        `balaur-ask <machine> "<question>"` asks the agent of another machine and prints
        its answer. Use it for what only that machine can see: its journal, its units,
        its hardware, its disk. Say what you already know and what you want back. For
        one plain command, `ssh <machine> <command>` is quicker.

        When another agent asks you (its question says so), find out and report: what
        you ran, what you saw, what you conclude. Change nothing and commit nothing; the
        one who asked makes the change, so two agents never write to the repository at
        once. You cannot ask a third machine from there.
      '';

      ask = pkgs.writeShellApplication {
        name = "balaur-ask";
        runtimeInputs = [ pkgs.openssh ];
        text = ''
          # Ask the OS agent of another machine: one question, one answer.
          usage() { echo "usage: balaur-ask MACHINE QUESTION...   (machines: ${lib.concatStringsSep ", " peers})" >&2; exit 2; }
          [ $# -ge 2 ] || usage
          if [ -n "''${BALAUR_ASKED_BY:-}" ]; then
            echo "balaur-ask: this agent was itself asked by $BALAUR_ASKED_BY; report to it instead of asking a third machine" >&2
            exit 1
          fi
          host=$1; shift
          case $host in
          ${lib.concatMapStrings (
            h: "  ${h}) dir=${lib.escapeShellArg (hostConfig h).balaur.agent.clone} ;;\n"
          ) peers}
            *) echo "balaur-ask: no agent on '$host'" >&2; usage ;;
          esac
          question="The agent of ${me} asks you, the agent of $host. Find out and report; change nothing and commit nothing.

          $*"
          # In the fleet's clone when it is there, so the agent has the repository at hand.
          remote=$(printf 'cd %q 2>/dev/null; BALAUR_ASKED_BY=%q exec pi -p --no-session %q' "$dir" ${lib.escapeShellArg me} "$question")
          # -n: the question is the arguments, never this command's input.
          exec ssh -n -o BatchMode=yes -o ConnectTimeout=5 "$host" "$remote"
        '';
      };
    in
    {
      options.balaur.agent = {
        model = lib.mkOption {
          type = lib.types.enum [
            "balaur"
            "balaur-local"
            "balaur-remote"
          ];
          default = "balaur";
          description = "The entryway's model pi starts with (ai.nix).";
        };
        clone = lib.mkOption {
          type = lib.types.str;
          default =
            let
              c = cfg.autoDeploy.clone or null;
            in
            if c != null then c else "/home/${cfg.user}/Projects/balaur-fleet";
          defaultText = lib.literalMD "auto-deploy's clone, else `~/Projects/balaur-fleet` of the admin";
          description = "The checkout of the fleet's repository the agent works in.";
        };
      };

      config = lib.mkMerge [
        {
          environment.systemPackages = [
            pi
            ask
          ];

          # Nix owns the version, and nothing reports home.
          environment.sessionVariables = {
            PI_SKIP_VERSION_CHECK = "1";
            PI_TELEMETRY = "0";
          };

          # Fetch the pre-built pi instead of compiling it (as dev.nix does for the others).
          nix.settings = {
            extra-substituters = [ "https://cache.numtide.com" ];
            extra-trusted-public-keys = [ "niks3.numtide.com-1:DTx8wZduET09hRmMtKdQDxNNthLQETkc/yaX7M4qK0g=" ];
          };
        }
        (lib.optionalAttrs (options ? home-manager) {
          home-manager.users.${cfg.user}.home.file = {
            ".pi/agent/models.json".source = models;
            ".pi/agent/settings.json".source = settings;
            ".pi/agent/AGENTS.md".source = instructions;
          };
        })
      ];
    };
}
