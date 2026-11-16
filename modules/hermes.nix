# Hermes: the owner's personal agent (Hermes Agent, Nous Research), always on, on
# the server. Unlike pi (agent.nix), which looks after the machines and answers
# when asked, this one is a standing agent for the person: it keeps a memory of
# the owner, writes its own skills as it learns what they need, runs scheduled
# jobs, and reads and writes the life log (lifelog.nix).
#
#   https://hermes.<domain>    its dashboard, with the Chat tab: sessions, memory,
#                              skills, cron, logs (the owner's devices only)
#   hermes                     the same agent in a terminal on this machine
#                              (`ssh server`, or a terminal in Orca)
#   journalctl -u hermes-agent    the gateway: messaging platforms and cron
#   journalctl -u hermes-backend  the dashboard
#
# How it is set up, with upstream's NixOS module (`services.hermes-agent`):
#
#   - Native, not in a container: a systemd service of its own user `hermes`,
#     with the tools Nix gives it. It develops itself in its state
#     (/var/lib/hermes/.hermes: memories, skills, sessions, cron), never by
#     installing software; a new tool is a commit to this repository.
#   - Models: the fleet's AI entryway (ai.nix), like every other consumer.
#   - The life log: `hermes` is in the group `lifelog` and its units may write the
#     folder. The keeper commits and checks every settled state, so what it
#     breaks comes back with `lifelog restore`. Its instructions for the folder
#     are the workspace's AGENTS.md, below.
#   - The dashboard listens on loopback and Caddy (web.nix) serves it to the
#     owner's devices only. Unlike the fleet's other pages it has a login (the
#     admin's name; the password is `hermes-dashboard-password` in the machine's
#     sops file): the dashboard refuses any name but loopback's unless it is
#     declared as its public address, and a public address always turns its
#     login on. That suits what is behind it: a shell and the life log.
#   - The owner's own `hermes` in a terminal shares that state (the group
#     `hermes`), but runs as the owner, outside the service's sandbox.
#
# It needs the `ai` aspect; the life log and the web address are optional.
{ inputs, ... }:
{
  flake.modules.nixos.hermes =
    {
      config,
      options,
      lib,
      pkgs,
      ...
    }:
    let
      cfg = config.balaur;
      h = cfg.hermes;
      me = config.networking.hostName;
      aiUrl = cfg.ai.url or (throw "the `hermes` aspect needs the `ai` aspect on ${me}");
      # The life folder, on a machine with a lifelog aspect.
      life = cfg.lifelog-folder or null;
      # The web front's domain, on a machine with the `web` aspect.
      domain = cfg.web.domain or null;
      svc = config.services.hermes-agent;
      workspace = "${svc.stateDir}/workspace";

      instructions = ''
        # Hermes, the owner's personal agent

        You run on `${me}`, the always-on server of a small home fleet of NixOS
        machines (the Balaur fleet), as the user `hermes`. You work for one person,
        the owner of these machines, and for nobody else.

        ## This machine is not yours to change

        The machines are configured by one repository that other agents look after.
        You cannot install software (`apt`, `pip install` and `npm -g` do not work
        here, and `sudo` is not for you). When you need a tool you do not have, say
        so: the owner adds it to your configuration (`modules/hermes.nix`). What you
        learn goes into your own memory and skills, which are yours to write.

        ## Models

        You answer through the fleet's AI entryway, `${aiUrl}`: the model `balaur`
        is the fleet's local GPU when it is free and Mistral otherwise.
        ${lib.optionalString (life != null) ''

          ## The life log

          `${life}` is the owner's life log: plain files, synced between their
          machines and their phone. It is the record of their life, so read it
          before you answer a question about them, and write to it with care.

          - `journal/2026-11-14.md`: a day page; the filename is the day.
          - `pages/`, `people/`, `places/`: one markdown page each. The filename
            is the title, and links are by title: `[[Ferritin]]`.
          - `metrics/weight.md`: a metric's page (frontmatter: `unit`, `min`,
            `max`, `daily`). Its readings are CSV files in `metrics/weight/`, one
            per year and writer, with the header `day,taken_at,value,source`.
          - `files/<year>/`: extracted text of documents, next to a small image.
          - `_check.md`: the checker's report, when it has something to say. It is
            for the owner to read and delete; tell them about it, never delete it.

          How to write:

          - A reading: `lifelog add -machine hermes -source hermes METRIC VALUE`
            (`-day 2026-11-14` for another day). Never type into another writer's
            CSV, except to correct a line the owner asked you to correct.
          - A new page: `lifelog new KIND TITLE < text` (KIND is `pages`, `people`
            or `places`). `lifelog index` lists what exists.
          - A note for a day: append to that day's page in `journal/`.
          - A rename: move the file, then `lifelog rename-links OLD NEW`.
          - After you wrote, run `lifelog check ${life}` and fix what it reports
            about your change. A checker on this machine commits every settled
            state, so nothing you overwrite is lost, but do not lean on that:
            never delete a page or a CSV, and never empty one, unless the owner
            asked for exactly that.
          - Titles: no `# ^ [ ] |` characters; two pages cannot share a title,
            also not in another case (`Iron`, `iron`).

          It holds health data and private notes. Nothing from it goes anywhere
          but to the owner: not into a web search, not to another service, not
          into a message to another person.
        ''}
      '';
    in
    {
      imports = [ inputs.hermes-agent.nixosModules.default ];

      options.balaur.hermes = {
        port = lib.mkOption {
          type = lib.types.port;
          default = 9119;
          description = "The dashboard's port, on loopback.";
        };
        model = lib.mkOption {
          type = lib.types.enum [
            "balaur"
            "balaur-local"
            "balaur-remote"
          ];
          default = "balaur";
          description = "The entryway's model Hermes thinks with (ai.nix).";
        };
      };

      config = lib.mkMerge [
        {
          services.hermes-agent = {
            enable = true;
            # The lean build: the agent, the dashboard and the WhatsApp bridge, without
            # the libraries of the platforms and clouds nobody here uses (0.8 GiB less).
            package = inputs.hermes-agent.packages.${pkgs.stdenv.hostPlatform.system}.minimal;
            # `hermes` for the owner's terminal, on the service's state.
            addToSystemPackages = true;
            workingDirectory = workspace;
            documents."AGENTS.md" = instructions;
            extraPackages = lib.optional (life != null) pkgs.lifelog;

            settings = {
              model = {
                provider = "custom";
                base_url = aiUrl;
                default = h.model;
                # Not a secret: the entryway takes no key (ai.nix).
                api_key = "balaur";
                # The local model's window (local-llm), and no more than Mistral's.
                context_length = 128000;
              };
              memory = {
                memory_enabled = true;
                user_profile_enabled = true;
              };
            };

            backend = {
              mode = "dashboard";
              inherit (h) port;
            };
          };

          # The owner's terminal shares the service's state.
          users.users.${cfg.user}.extraGroups = [ svc.group ];

          balaur.services = [
            {
              name = "Hermes";
              description = "The owner's personal agent: chat, memory, skills, schedules";
              icon = "🪽";
              inherit (h) port;
              subdomain = "hermes";
              # It answers from the life log: the owner's own devices, like the log.
              audience = "private";
              login = domain != null;
              unit = "hermes-agent.service";
              group = "Personal";
            }
          ];
        }
        # The dashboard's address, where this machine has the web front. Declaring it
        # is what lets the dashboard answer under that name behind Caddy, and it
        # always turns the login on: Hermes's own username and password provider.
        (lib.mkIf (domain != null) (
          {
            assertions = [
              {
                assertion = options ? sops;
                message = "the `hermes` aspect keeps its dashboard's password in sops: add `secrets` to ${me}";
              }
            ];
          }
          // lib.optionalAttrs (options ? sops) {
            services.hermes-agent = {
              settings.dashboard = {
                public_url = "https://hermes.${domain}";
                # Caddy, for the address the login's rate limit counts by.
                trusted_proxies = [ "127.0.0.1" ];
              };
              environment.HERMES_DASHBOARD_BASIC_AUTH_USERNAME = cfg.user;
              environmentFiles = [ config.sops.templates."hermes-dashboard.env".path ];
            };
            # The password the owner types once per device, and the key that signs
            # the sessions, so that they outlive a restart. Both random, in this
            # machine's own sops file.
            sops.secrets."hermes-dashboard-password".sopsFile = cfg.secrets.hostFile;
            sops.secrets."hermes-dashboard-secret".sopsFile = cfg.secrets.hostFile;
            sops.templates."hermes-dashboard.env".content = ''
              HERMES_DASHBOARD_BASIC_AUTH_PASSWORD=${config.sops.placeholder."hermes-dashboard-password"}
              HERMES_DASHBOARD_BASIC_AUTH_SECRET=${config.sops.placeholder."hermes-dashboard-secret"}
            '';
          }
        ))
        (lib.mkIf (life != null) {
          # The life log: its group, and the folder in what the units may write
          # (they run with ProtectSystem=strict). Their UMask is 0007 and the folder
          # is setgid, so what Hermes writes is the group's, like any writer's.
          users.users.${svc.user}.extraGroups = [ "lifelog" ];
          systemd.services.hermes-agent = {
            after = [ "syncthing.service" ];
            serviceConfig.ReadWritePaths = [ life ];
            environment.LIFELOG_FOLDER = life;
          };
          systemd.services.hermes-backend = {
            serviceConfig.ReadWritePaths = [ life ];
            environment.LIFELOG_FOLDER = life;
          };
        })
      ];
    };
}
