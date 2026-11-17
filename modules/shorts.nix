# Proof in Pictures: the short videos made in the humanshorts project (code-rendered
# lessons for TikTok, YouTube Shorts and Reels), ready to post. They are uploaded by
# hand from the laptop or the phone, so the machine that renders them serves a page
# with each video's upload kit: the file, its cover and its caption to copy.
#
# The page is the project's own script (scripts/kits.ts, Node.js with no dependencies),
# run from its folder rather than packaged here: the kits and the page change with the
# project, several times a day, and a deploy for each would be in the way. The unit is
# what the fleet adds: it runs from boot, as the admin (the folder is theirs), with the
# home hidden but for that folder, read-only. It listens on this machine only; the `web`
# aspect serves it at https://shorts.<domain>, to the owner's devices.
#
# The same project's review page (scripts/review.ts) is the second unit: the rendered
# episodes, each playable with a timeline, where the owner clicks or draws on a frame and
# says what is wrong; the agent reads the notes back (`hs notes`). It writes the notes and
# their pictures into the project, so its bind of the folder is writable, and it cuts the
# pictures with ffmpeg. It is served at https://review.<domain>.
#
#   journalctl -u shorts-kits      how many kits it found when it started
#   journalctl -u shorts-review    the episodes it found
{
  flake.modules.nixos.shorts =
    {
      config,
      lib,
      pkgs,
      ...
    }:
    let
      cfg = config.balaur.shorts;
      user = config.balaur.user;
      home = config.users.users.${user}.home;
      # the web front's domain, when this machine has one (the `web` aspect)
      domain = config.balaur.web.domain or null;
    in
    {
      options.balaur.shorts = {
        port = lib.mkOption {
          type = lib.types.port;
          default = 8787;
          description = "The page's port on this machine (127.0.0.1 only: the `web` aspect is its way in).";
        };
        reviewPort = lib.mkOption {
          type = lib.types.port;
          default = 8788;
          description = "The review page's port on this machine (127.0.0.1 only: the `web` aspect is its way in).";
        };
        dir = lib.mkOption {
          type = lib.types.str;
          default = "${home}/Projects/humanshorts";
          description = "The humanshorts project folder: its scripts/kits.ts is the page, its out/<channel>/<episode>/upload/ folders the kits.";
        };
      };

      config = {
        systemd.services.shorts-kits = {
          description = "Proof in Pictures: the upload kits of the videos ready to post (:${toString cfg.port})";
          wantedBy = [ "multi-user.target" ];
          # A machine without the project (or before its first kit page) has nothing to run.
          unitConfig.ConditionPathExists = "${cfg.dir}/scripts/kits.ts";
          environment = {
            PORT = toString cfg.port;
            HOST = "127.0.0.1";
          };
          serviceConfig = {
            # Node.js runs the TypeScript file as it is (type stripping, 23.6 and later).
            ExecStart = "${lib.getExe pkgs.nodejs} ${cfg.dir}/scripts/kits.ts";
            WorkingDirectory = cfg.dir;
            User = user;
            Restart = "on-failure";
            RestartSec = 5;
            Nice = 10;
            MemoryMax = "256M";
            CapabilityBoundingSet = "";
            NoNewPrivileges = true;
            PrivateTmp = true;
            PrivateDevices = true;
            # The script is the admin's own, but it answers the network: the home is
            # empty but for the project, which it can only read, so it reaches neither
            # ~/.ssh nor the project's .env through a mistake in the page.
            ProtectHome = "tmpfs";
            BindReadOnlyPaths = [ cfg.dir ];
            ProtectSystem = "strict";
            ProtectKernelTunables = true;
            ProtectKernelModules = true;
            ProtectControlGroups = true;
            RestrictAddressFamilies = [
              "AF_INET"
              "AF_INET6"
              "AF_UNIX"
            ];
            RestrictNamespaces = true;
            LockPersonality = true;
            SystemCallArchitectures = "native";
          };
        };

        systemd.services.shorts-review = {
          description = "humanshorts review: the rendered episodes, with the owner's notes on their frames (:${toString cfg.reviewPort})";
          wantedBy = [ "multi-user.target" ];
          unitConfig.ConditionPathExists = "${cfg.dir}/scripts/review.ts";
          # the note pictures (the frame, the drawing over it, a close-up) are cut with ffmpeg
          path = [ pkgs.ffmpeg-headless ];
          environment = {
            PORT = toString cfg.reviewPort;
            HOST = "127.0.0.1";
            # the Host header the web front sends: the only one accepted besides loopback
            PUBLIC_HOST = if domain == null then "" else "review.${domain}";
          };
          serviceConfig = {
            ExecStart = "${lib.getExe pkgs.nodejs} ${cfg.dir}/scripts/review.ts";
            WorkingDirectory = cfg.dir;
            User = user;
            Restart = "on-failure";
            RestartSec = 5;
            Nice = 10;
            # it resolves an episode's spec (a long one takes a few hundred MB) and spawns ffmpeg for a frame
            MemoryMax = "1G";
            CapabilityBoundingSet = "";
            NoNewPrivileges = true;
            PrivateTmp = true;
            PrivateDevices = true;
            # The home is empty but for the project. The page writes the notes (channels/) and
            # their pictures (out/), so the project is bound writable; it only ever serves its
            # own page files, the renders and the note pictures, never a path from a request.
            ProtectHome = "tmpfs";
            BindPaths = [ cfg.dir ];
            ProtectSystem = "strict";
            ProtectKernelTunables = true;
            ProtectKernelModules = true;
            ProtectControlGroups = true;
            RestrictAddressFamilies = [
              "AF_INET"
              "AF_INET6"
              "AF_UNIX"
            ];
            RestrictNamespaces = true;
            LockPersonality = true;
            SystemCallArchitectures = "native";
          };
        };

        balaur.services = [
          {
            name = "Proof in Pictures";
            description = "The videos ready to post: each one's file, cover and caption";
            icon = "🎬";
            port = cfg.port;
            subdomain = "shorts";
            unit = "shorts-kits.service";
            group = "Personal";
          }
          {
            name = "Review";
            description = "The rendered episodes: play one, mark what is wrong on a frame, the agent fixes it";
            icon = "✏️";
            port = cfg.reviewPort;
            subdomain = "review";
            unit = "shorts-review.service";
            group = "Personal";
          }
        ];
      };
    };
}
