# The Balaur agent: the owner's one agent, the same on every machine. It is pi
# (pi.dev) with the fleet's models, instructions made here and a memory in the life
# log. It looks after the owner, and after the machines as a part of the owner:
# their notes and their days, the services, the configuration, the debugging.
#
#   balaur                     the agent, in a terminal
#   balaur -p "question"       one answer, then exit
#   balaur -c                  continue the last conversation in this directory
#   balaur-ask HOST "question" ask the agent on another machine, which answers from
#                              what it sees there (its journal, units, hardware)
#   balaur-think "question"    a harder question, to Claude Code (the owner's Claude
#                              subscription): Opus, or `-m fable`. The agent runs it
#                              itself when it is out of its depth; in a session,
#                              `/think question` and `/fable question` ask for it.
#   pi                         the engine alone: the same agent without its memory
#
# How it is made, and nothing more than this:
#
#   - pi's own directory, ~/.pi/agent (its logins and sessions stay there too,
#     unmanaged), gets three read-only files:
#       models.json    the fleet's AI entryway (ai.nix) as the provider `balaur`,
#                      with the entryway's names: balaur, balaur-local,
#                      balaur-remote, and one for each remote API
#       settings.json  that provider, `balaur.agent.model` as the default, the
#                      skills and the extensions. A default saved from inside pi
#                      does not stick.
#       AGENTS.md      who it is, every machine and service of the fleet, where the
#                      configuration is and how a change reaches the machines, the
#                      life log's rules. Made from the registry (fleet.nix) and each
#                      host's `balaur.services`, so a new machine or service is
#                      known to every agent after a push.
#   - Its memory, on a machine with the life folder (lifelog.nix): the page
#     `pages/Balaur.md`, which `balaur` puts into every session's instructions, and
#     the pages that are `part-of` it. The folder is synced, so it is one memory
#     for every machine; the owner reads and corrects it like any other page, and
#     the keeper versions it.
#   - pi's own tools (shell, files), without asking, as the admin account. sudo
#     still wants the password and the admin is not a trusted Nix user (base.nix),
#     so root is reached through a pushed commit, not directly.
#
# All of it is set here and in `balaur.agent`: the model, more instructions,
# skills, extensions, any other pi setting.
#
# Agents reach each other the way everything in the fleet does: SSH over the
# tailnet, with the admin keys the registry already authorizes. Nothing listens,
# nothing runs while nobody asks. An asked agent reports and changes nothing; a
# fix is a commit pushed by the one who asked, which every machine then follows
# (auto-deploy.nix). One hop only: an asked agent cannot ask a third.
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
      a = cfg.agent;
      me = config.networking.hostName;
      pi = inputs.llm-agents.packages.${pkgs.stdenv.hostPlatform.system}.pi;
      claude = inputs.llm-agents.packages.${pkgs.stdenv.hostPlatform.system}.claude-code;
      aiUrl = cfg.ai.url or (throw "the `agent` aspect needs the `ai` aspect on ${me}");
      # The life folder, on a machine with a lifelog aspect: the agent's memory.
      life = cfg.lifelog-folder or null;
      memory = "${life}/pages/Balaur.md";

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
            # 128k is the local model's window (local-llm, contextSize 131072) and no more than Mistral's.
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
                (
                  [
                    {
                      id = "balaur";
                      name = "Balaur (the entryway's route: local GPU first, a remote API second)";
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
                      name = "Balaur remote (the entryway's remote API only)";
                    }
                  ]
                  ++ map (r: {
                    id = "balaur-${r.name}";
                    name = "${r.label}, through the entryway";
                  }) (cfg.ai.remotes or [ ])
                );
          };
        }
      );

      # pi finds a project's skills by itself only in a project the user trusted in
      # an interactive session, so `balaur -p` (balaur-ask) would go without the
      # repository's; a path in the settings needs no trust.
      settings = pkgs.writeText "pi-settings.json" (
        builtins.toJSON (
          {
            defaultProvider = "balaur";
            defaultModel = a.model;
            inherit (a) skills extensions;
            prompts = [ "${prompts}" ];
          }
          // a.settings
        )
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
          }.${lib.optionalString (lib.elem h peers) " The agent there: `balaur-ask ${h} \"...\"`."}

          ${lib.concatMapStrings (
            s:
            "- ${s.name}${lib.optionalString (s.description != "") ": ${s.description}"}${
              lib.optionalString (s.unit != "") " (`${s.unit}`)"
            }\n"
          ) services}
        '';

      instructions = pkgs.writeText "pi-AGENTS.md" ''
        # The Balaur agent, on ${me}

        You are the Balaur agent: the one agent of the owner of these machines (user
        `${cfg.user}`), here on `${me}`. You are the same agent on every machine of
        their small home fleet (the Balaur fleet), with the same instructions and the
        same memory. The machines are a part of the owner, so everything on them is
        your work: their notes, their days, their health and plans, and just as much
        what runs on the machines, how they are configured and what is wrong with
        them. Be brief and plain; say what you did, how you checked it and what you
        are not sure of.

        ${
          lib.optionalString (life != null) ''
            ## Your memory

            You start every conversation knowing only these instructions and the page
            `${memory}`, which is added to them. That page is your memory, and you keep
            it:

            - When you learn something that will matter again (a fact about the owner, a
              preference, a correction, how they want a thing done, a fault of a machine
              and its cure), write it there before the conversation ends. A corrected
              mistake is worth a line.
            - Keep the page short enough to read every time: the facts and one line per
              longer note. A longer note (a procedure you worked out, a project, a
              topic) is a page of its own in `pages/`, with the frontmatter
              `part-of: "[[Balaur]]"`, and a link to it from the memory page:
              `[[Title]]`. Read such a page when its line says it fits the question.
            - A procedure page says when to use it and the steps that worked. Fix it
              when a step fails; that is how you improve.
            - The owner reads and edits these pages too. What they wrote there wins.
            - The folder is synced between the machines, so it is one memory. You have
              no other.

            ## The life log

            `${life}` is the owner's life log: plain files, synced between their
            machines and their phone. It is the record of their life, so read it
            before you answer a question about them, and write to it with care.

            - `journal/2026-11-14.md`: a day page; the filename is the day.
            - `pages/`, `people/`, `places/`: one markdown page each. The filename is
              the title, and links are by title: `[[Ferritin]]`.
            - `metrics/weight.md`: a metric's page (frontmatter: `unit`, `min`, `max`,
              `daily`). Its readings are CSV files in `metrics/weight/`, one per year
              and writer, with the header `day,taken_at,value,source`.
            - `files/<year>/`: extracted text of documents, next to a small image.
            - `_check.md`: the checker's report, when it has something to say. It is
              for the owner to read and delete; tell them about it, never delete it.

            How to write:

            - A reading: `lifelog add -machine ${me} -source balaur METRIC VALUE`
              (`-day 2026-11-14` for another day). Never type into another writer's
              CSV, except to correct a line the owner asked you to correct.
            - A new page: `lifelog new KIND TITLE < text` (KIND is `pages`, `people`
              or `places`). `lifelog index` lists what exists.
            - A note for a day: append to that day's page in `journal/`.
            - A rename: move the file, then `lifelog rename-links OLD NEW`.
            - After you wrote, run `lifelog check ${life}` and fix what it reports
              about your change. The keeper (on the server) commits every settled
              state, so a page comes back with `lifelog restore PATH`, but do not lean
              on that: never delete a page or a CSV, and never empty one, unless the
              owner asked for exactly that.
            - Titles: no `# ^ [ ] |` characters; two pages cannot share a title, also
              not in another case (`Iron`, `iron`).

            It holds health data and private notes. Nothing from it goes anywhere but
            to the owner: not into a web request, not to another service, not into a
            message to another person, and never into the fleet's repository, which
            is public.

          ''
        }## The machines and what runs on them

        ${lib.concatMapStrings machine (lib.attrNames fleet)}
        The addresses of the web pages, as this machine reaches them, are in
        `/etc/balaur/services.json`. A unit written `user:<unit>` runs in the desktop
        session (`systemctl --user`). Machines reach each other at the names above, over
        the tailnet (Tailscale), and `ssh <name>` works between all of them.

        ## Models

        You answer through the fleet's AI entryway, `${aiUrl}`: the model `balaur` is the
        fleet's GPU when it is free and a remote API otherwise, `balaur-local` and
        `balaur-remote` are one of the two, and ${
          lib.concatMapStringsSep ", " (r: "`balaur-${r.name}`") (cfg.ai.remotes or [ ])
        }
        are each one remote API by name. `curl -s ${lib.removeSuffix "/v1" aiUrl}/health` shows
        which are up.

        ## The configuration

        Everything on these machines is declared in one repository, cloned at
        `${a.clone}` on this machine. Nothing is installed or configured by
        hand: a change is a change to that repository.

        - Work in that clone. Before you change it, read its `AGENTS.md` (loaded by
          itself when you start there): the repository's rules are yours too.
        - Its procedures are skills, which you have: `fleet-status` to find out how a
          machine is doing, `check-change` before a commit, `deploy` to ship it, and
          `add-aspect`, `add-machine`, `secrets`, `update-inputs`. Load the one that
          fits before you start.
        - Look first (`balaur-fleet-status`, `systemctl status`, `journalctl -u <unit>`,
          the module in `modules/`).
        - Deploying is `git commit` and `git push`. Every machine checks `main` every few
          minutes and switches to it by itself (`journalctl -u balaur-auto-deploy`).
        - What you want for yourself (a tool, a skill, another instruction) is a
          change to `modules/agent.nix` or a host's `balaur.agent`, like any other.
        - The repository is public. Never commit a secret, a key, a token or personal
          data: not in a file, a commit message or an issue.
        - `sudo` asks for a password you do not have. Do not work around it: what needs
          root belongs in the configuration.
        - Say what you are about to do before something that is hard to undo
          (deleting data, a push that changes how a service runs).

        ## A harder question

        `balaur-think "<question>"` asks Claude Code, a stronger model than you
        (${a.think.model}; `balaur-think -m fable "<question>"` is the strongest and
        the slowest), on the owner's Claude subscription. It answers once and
        remembers nothing, so the question must carry everything: what you were
        asked, what you found, the paths of the files worth reading (it can read
        files and search the web, and changes nothing). Use it when you are out of
        your depth: a diagnosis you are not sure of, a design with consequences, a
        medical or legal reading, anything the owner asks you to think hard about or
        to check with Claude. Not for what you can answer yourself: it is slower and
        draws on the owner's subscription. Tell the owner the answer came from it,
        and add what you make of it. What you put in the question goes to Anthropic
        (the United States), the life log's text included: send what the question
        needs and no more.

        ## Yourself on the other machines

        `balaur-ask <machine> "<question>"` asks the agent of another machine and prints
        its answer. Use it for what only that machine can see: its journal, its units,
        its hardware, its disk. Say what you already know and what you want back. For
        one plain command, `ssh <machine> <command>` is quicker.

        When the agent of another machine asks you (its question says so), find out
        and report: what you ran, what you saw, what you conclude. Change nothing and
        commit nothing; the one who asked makes the change, so two agents never write
        to the repository at once. You cannot ask a third machine from there.
        ${lib.optionalString (a.instructions != "") "\n${a.instructions}"}
      '';

      # The memory's first state: `balaur` writes it when the page is not there.
      seed = pkgs.writeText "Balaur.md" ''
        What the Balaur agent (`balaur` in a terminal) knows and how it works. It
        reads this page at the start of every conversation and keeps it itself;
        correct it freely. Longer notes are pages of their own, part of this one.

        ## About you

        ## How you want me to work

        ## The machines

        ## Procedures

        ## Open threads
      '';

      balaur = pkgs.writeShellApplication {
        name = "balaur";
        runtimeInputs = [ pkgs.lifelog ];
        text = ''
          # The Balaur agent: pi with the fleet's instructions${
            lib.optionalString (life != null) " and its memory, a page of the life log"
          } (agent.nix).
          ${
            if life == null then
              ''
                exec ${pi}/bin/pi "$@"
              ''
            else
              ''
                # What it writes in the life folder stays writable by the folder's group
                # (the keeper, the web page, Syncthing).
                umask 0002
                args=()
                if [ -d ${lib.escapeShellArg life}/pages ]; then
                  if [ ! -e ${lib.escapeShellArg memory} ]; then
                    lifelog new -folder ${lib.escapeShellArg life} pages Balaur < ${seed} >&2 || true
                  fi
                  if [ -r ${lib.escapeShellArg memory} ]; then
                    args=(--append-system-prompt ${lib.escapeShellArg memory})
                  fi
                fi
                exec ${pi}/bin/pi "''${args[@]}" "$@"
              ''
          }
        '';
      };

      # The harder question: Claude Code, once, with the owner's login (~/.claude) and
      # tools that read only.
      think = pkgs.writeShellApplication {
        name = "balaur-think";
        text = ''
          usage() { echo "usage: balaur-think [-m opus|fable|MODEL] QUESTION...   (or the question on its input)" >&2; exit 2; }
          model=${lib.escapeShellArg a.think.model}
          while getopts m:h opt; do
            case $opt in
              m) model=$OPTARG ;;
              *) usage ;;
            esac
          done
          shift $((OPTIND - 1))
          case $model in
            opus) model=claude-opus-5-5 ;;
            fable) model=claude-fable-5-2 ;;
          esac
          if [ $# -gt 0 ]; then question=$*; else question=$(cat); fi
          [ -n "$question" ] || usage
          exec ${claude}/bin/claude -p --model "$model" --no-session-persistence \
            --tools "Read,Grep,Glob,WebSearch,WebFetch" \
            --allowedTools "Read,Grep,Glob,WebSearch,WebFetch" \
            --append-system-prompt "You are asked by the Balaur agent, the owner's own agent on this machine, which is a weaker model than you and passes your answer on. Answer the question itself, completely and plainly, and say what you are unsure of. You can read files and search the web; you change nothing." \
            -- "$question"
        '';
      };
      # `/think` and `/fable` in a session: the owner asks for the harder question.
      prompts = pkgs.runCommand "pi-prompts" { } ''
        mkdir $out
        cat > $out/think.md <<'EOF_'
        ---
        description: Ask Claude Code (Opus) through balaur-think and report its answer
        argument-hint: "<question>"
        ---
        Put this to Claude Code with `balaur-think`, with everything it needs to answer (what you know, the paths of the files worth reading), then give me its answer and what you make of it: $@
        EOF_
        cat > $out/fable.md <<'EOF_'
        ---
        description: Ask Claude Code (Fable, the strongest) through balaur-think -m fable
        argument-hint: "<question>"
        ---
        Put this to Claude Code with `balaur-think -m fable`, with everything it needs to answer (what you know, the paths of the files worth reading), then give me its answer and what you make of it: $@
        EOF_
        sed -i 's/^        //' $out/*.md
      '';

      ask = pkgs.writeShellApplication {
        name = "balaur-ask";
        runtimeInputs = [ pkgs.openssh ];
        text = ''
          # Ask the Balaur agent on another machine: one question, one answer.
          usage() { echo "usage: balaur-ask MACHINE QUESTION...   (machines: ${lib.concatStringsSep ", " peers})" >&2; exit 2; }
          [ $# -ge 2 ] || usage
          if [ -n "''${BALAUR_ASKED_BY:-}" ]; then
            echo "balaur-ask: this agent was itself asked by $BALAUR_ASKED_BY; report to it instead of asking a third machine" >&2
            exit 1
          fi
          host=$1; shift
          case $host in
          ${lib.concatMapStrings (
            h:
            "  ${h}) dir=${lib.escapeShellArg (hostConfig h).balaur.agent.clone}; address=${
                lib.escapeShellArg fleet.${h}.address
              } ;;\n"
          ) peers}
            *) echo "balaur-ask: no agent on '$host'" >&2; usage ;;
          esac
          question="The agent of ${me} asks you, the agent of $host. Find out and report; change nothing and commit nothing.

          $*"
          # In the fleet's clone when it is there, so the agent has the repository at hand.
          remote=$(printf 'cd %q 2>/dev/null; BALAUR_ASKED_BY=%q exec balaur -p --no-session %q' "$dir" ${lib.escapeShellArg me} "$question")
          # -n: the question is the arguments, never this command's input.
          exec ssh -n -o BatchMode=yes -o ConnectTimeout=5 "$address" "$remote"
        '';
      };
    in
    {
      options.balaur.agent = {
        model = lib.mkOption {
          type = lib.types.str;
          default = "balaur-mistral";
          example = "balaur-claude";
          description = "The entryway's model the agent starts with (ai.nix): `balaur`, `balaur-local`, `balaur-remote`, or `balaur-<remote API>`. It reads the life log, so this is where the life log's text goes.";
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
        instructions = lib.mkOption {
          type = lib.types.lines;
          default = "";
          example = "Answer in Romanian.";
          description = "More instructions, added after the aspect's own (markdown).";
        };
        skills = lib.mkOption {
          type = lib.types.listOf lib.types.str;
          default = [ "${a.clone}/.agents/skills" ];
          defaultText = lib.literalMD "the repository's skills (`.agents/skills` in the clone, shared with Claude Code)";
          description = "Skill files or directories it has (Agent Skills: a folder with a `SKILL.md`).";
        };
        extensions = lib.mkOption {
          type = lib.types.listOf lib.types.str;
          default = [ ];
          example = lib.literalExpression ''[ "''${./agent/remind.ts}" ]'';
          description = "pi extensions it loads (TypeScript files or directories): its own tools and commands.";
        };
        think.model = lib.mkOption {
          type = lib.types.str;
          default = "claude-opus-5-5";
          example = "claude-fable-5-2";
          description = "Claude Code's model for `balaur-think` without `-m`.";
        };
        settings = lib.mkOption {
          type = (pkgs.formats.json { }).type;
          default = { };
          example = {
            defaultThinkingLevel = "high";
          };
          description = "Any other key of pi's settings.json (docs.pi.dev/latest/settings); these win over the ones above.";
        };
      };

      config = lib.mkMerge [
        {
          environment.systemPackages = [
            pi
            balaur
            think
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
