# The owner's personal agent: pi (pi.dev) again, with a directory, instructions and
# a memory of its own. The OS agent (agent.nix) looks after the machines; this one
# looks after the owner.
#
#   companion                  the agent, in a terminal on this machine
#                              (`ssh server`, or a terminal in Orca)
#   companion -p "question"    one answer, then exit
#   companion -c               continue the last conversation
#
# How it is made, and nothing more than this:
#
#   - pi with `~/.pi/companion` as its directory: the fleet's models (the
#     entryway, ai.nix), `balaur.companion.model` as the default, and the
#     instructions below. Its sessions stay there.
#   - Its memory is the life log (lifelog.nix): the page `pages/Companion.md`,
#     which the command puts into every session's instructions, and the pages
#     that are `part-of` it. So the owner reads and corrects what it knows at
#     the life log's own page, and the keeper versions it like every other page.
#     It learns by writing those pages, never by installing software.
#   - pi's own tools (shell, files) as the admin, started in the life folder.
#     sudo still wants the password, so root is not within its reach.
#
# It needs the `agent` aspect (pi's models) and a lifelog aspect (the folder).
{ inputs, ... }:
{
  flake.modules.nixos.companion =
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
      life = cfg.lifelog-folder or (throw "the `companion` aspect needs a lifelog aspect on ${me}");
      dir = ".pi/companion";
      memory = "${life}/pages/Companion.md";

      settings = pkgs.writeText "companion-settings.json" (
        builtins.toJSON {
          defaultProvider = "balaur";
          defaultModel = cfg.companion.model;
        }
      );

      # The memory's first state: the command writes it when the page is not there.
      seed = pkgs.writeText "Companion.md" ''
        What the companion (the personal agent, `companion` on ${me}) knows and how it
        works. It reads this page at the start of every conversation and keeps it
        itself; correct it freely. Longer notes are pages of their own, part of this one.

        ## About you

        ## How you want me to work

        ## Procedures

        ## Open threads
      '';

      instructions = pkgs.writeText "companion-AGENTS.md" ''
        # The companion

        You are the personal agent of the owner of this machine (`${me}`, user
        `${cfg.user}`): one person, who talks to you in a terminal. You help with
        their days, their health, their plans and whatever they bring, and you get
        better at it by remembering. Be brief and plain; say what you did and what
        you are not sure of.

        ## Your memory

        You start every conversation knowing only these instructions and the page
        `${memory}`, which is appended below them. That page is your memory, and you
        keep it:

        - When you learn something that will matter again (a fact about the owner, a
          preference, a correction, how they want a thing done), write it there
          before the conversation ends. A corrected mistake is worth a line.
        - Keep the page short enough to read every time: the facts and one line per
          longer note. A longer note (a procedure you worked out, a project, a
          topic) is a page of its own in `pages/`, with the frontmatter
          `part-of: "[[Companion]]"`, and a link to it from the memory page:
          `[[Title]]`. Read such a page when its line says it fits the question.
        - A procedure page says when to use it and the steps that worked. Fix it
          when a step fails; that is how you improve.
        - The owner reads and edits these pages too. What they wrote there wins.
        - You have no other memory. Do not install software or change this
          machine's configuration to extend yourself: say what you are missing.

        ## The life log

        `${life}` (where you start) is the owner's life log: plain files, synced
        between their machines and their phone. It is the record of their life, so
        read it before you answer a question about them, and write to it with care.

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

        - A reading: `lifelog add -machine companion -source companion METRIC VALUE`
          (`-day 2026-11-14` for another day). Never type into another writer's
          CSV, except to correct a line the owner asked you to correct.
        - A new page: `lifelog new KIND TITLE < text` (KIND is `pages`, `people`
          or `places`). `lifelog index` lists what exists.
        - A note for a day: append to that day's page in `journal/`.
        - A rename: move the file, then `lifelog rename-links OLD NEW`.
        - After you wrote, run `lifelog check ${life}` and fix what it reports
          about your change. A keeper on this machine commits every settled
          state, so a page comes back with `lifelog restore PATH`, but do not lean
          on that: never delete a page or a CSV, and never empty one, unless the
          owner asked for exactly that.
        - Titles: no `# ^ [ ] |` characters; two pages cannot share a title, also
          not in another case (`Iron`, `iron`).

        It holds health data and private notes. Nothing from it goes anywhere but
        to the owner: not into a web request, not to another service, not into a
        message to another person.

        ## This machine

        Your shell runs as the owner, on the home server of a small fleet that one
        repository configures (`${
          cfg.agent.clone or "~/Projects/balaur-fleet"
        }`). You may look at anything the owner can.
        The machines and their configuration are the OS agent's work (`pi`, started
        in that repository), not yours: do not commit there, and do not work around
        `sudo`, which asks for a password you do not have. Outside the life log, ask
        before you change or delete something you did not create.
      '';

      companion = pkgs.writeShellApplication {
        name = "companion";
        runtimeInputs = [ pkgs.lifelog ];
        text = ''
          # The owner's personal agent: pi with its own directory and the life log
          # as its memory (companion.nix).
          export PI_CODING_AGENT_DIR="$HOME/${dir}"
          export LIFELOG_FOLDER=${lib.escapeShellArg life}
          # What it writes in the life folder stays writable by the folder's group
          # (the keeper, the web page, Syncthing).
          umask 0002
          cd ${lib.escapeShellArg life}
          if [ ! -e ${lib.escapeShellArg memory} ]; then
            lifelog new pages Companion < ${seed} >&2
          fi
          exec ${pi}/bin/pi --append-system-prompt ${lib.escapeShellArg memory} "$@"
        '';
      };
    in
    {
      options.balaur.companion.model = lib.mkOption {
        type = lib.types.str;
        default = "balaur-mistral";
        example = "balaur-claude";
        description = "The entryway's model the companion starts with (ai.nix). It reads the life log, so this is where the life log's text goes.";
      };

      config = lib.mkMerge [
        { environment.systemPackages = [ companion ]; }
        (lib.optionalAttrs (options ? home-manager) {
          home-manager.users.${cfg.user} =
            { config, ... }:
            {
              home.file = {
                # pi's models are the OS agent's file (agent.nix).
                "${dir}/models.json".source =
                  (config.home.file.".pi/agent/models.json"
                    or (throw "the `companion` aspect needs the `agent` aspect on ${me}")
                  ).source;
                "${dir}/settings.json".source = settings;
                "${dir}/AGENTS.md".source = instructions;
              };
            };
        })
      ];
    };
}
