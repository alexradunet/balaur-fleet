# Tests that boot machines (NixOS VM tests): what no evaluation shows, tried in
# virtual machines made from the aspects themselves.
#
#   nix build -L .#checks.x86_64-linux.web-gate
#
# They need KVM, and build the machines' systems first: minutes, not seconds.
# GitHub Actions runs them on every push (.github/workflows/check.yml).
{ config, ... }:
let
  aspects = config.flake.modules.nixos;

  # A machine of the fleet, as far as a test needs one: `base`, without what only
  # makes it slower to build and boot.
  machine =
    { lib, ... }:
    {
      imports = [ aspects.base ];
      nixpkgs.hostPlatform = "x86_64-linux";
      system.stateVersion = "26.05";
      boot.plymouth.enable = lib.mkForce false;
      boot.consoleLogLevel = lib.mkForce 7; # the test reads the console; base quiets it
      services.printing.enable = lib.mkForce false;
      services.fwupd.enable = lib.mkForce false;
      documentation.enable = false;
      # Nobody logs in to a test machine; this quiets base's warning about it.
      balaur.ssh.passwordAuth = true;
    };
in
{
  perSystem =
    { pkgs, ... }:
    {
      # Who the `web` aspect serves what (modules/web.nix): the owner's devices get
      # everything, any other device the `household` services only, and a `private`
      # service is also kept from the machine's own address (its screen).
      #
      # The machine under test is called `server`, so it is the registry's `server`
      # to the aspect: its tailnet address there is the one a `private` service
      # refuses. The owner's device is a second machine, named in `ownerAddresses`
      # like the phone; the third is anybody else. Certificates are Caddy's own here,
      # not Let's Encrypt's: the gate is what is tested, not the certificate.
      checks.web-gate = pkgs.testers.runNixOSTest {
        name = "web-gate";
        # The aspects set nixpkgs options (base: the overlay, unfree).
        node.pkgsReadOnly = false;

        nodes.server =
          { lib, nodes, ... }:
          let
            domain = "balaur.test";
            backends = {
              owner = 8001;
              private = 8002;
              house = 8003;
            };
            names = [ domain ] ++ map (n: "${n}.${domain}") (lib.attrNames backends);
          in
          {
            imports = [
              aspects.base
              aspects.web
            ];
            nixpkgs.hostPlatform = "x86_64-linux";
            system.stateVersion = "26.05";

            # Only what the test is about.
            boot.plymouth.enable = lib.mkForce false;
            boot.consoleLogLevel = lib.mkForce 7; # the test reads the console; base quiets it
            services.printing.enable = lib.mkForce false;
            services.fwupd.enable = lib.mkForce false;
            documentation.enable = false;

            # Nobody logs in to a test machine; this quiets base's warning about it.
            balaur.ssh.passwordAuth = true;

            balaur.web = {
              inherit domain;
              dnsProvider = "none";
              dnsCredentialsFile = "/dev/null";
              ownerAddresses = [ nodes.owner.networking.primaryIPAddress ];
            };
            balaur.services = [
              {
                name = "Owner thing";
                port = backends.owner;
                subdomain = "owner";
              }
              {
                name = "Private thing";
                port = backends.private;
                subdomain = "private";
                audience = "private";
              }
              {
                name = "House thing";
                port = backends.house;
                subdomain = "house";
                audience = "household";
              }
            ];

            # No Let's Encrypt in a test: Caddy signs the names itself.
            security.acme.certs = lib.mkForce { };
            services.caddy.globalConfig = ''
              local_certs
              skip_install_trust
            '';
            services.caddy.virtualHosts =
              lib.genAttrs names (_: {
                useACMEHost = lib.mkForce null;
              })
              # What each name is a door to. Any Host: Caddy passes the browser's on.
              // lib.mapAttrs' (
                n: port:
                lib.nameValuePair "http://:${toString port}" {
                  extraConfig = ''
                    bind 127.0.0.1
                    respond "${n} backend"
                  '';
                }
              ) backends;

            # On the real machine, 443 comes in over tailscale0 (`network` trusts it).
            networking.firewall.allowedTCPPorts = [ 443 ];
          };

        nodes.owner = { };
        nodes.stranger = { };

        testScript =
          { nodes, ... }:
          let
            ip = nodes.server.networking.primaryIPAddress;
            tailnetIp = config.fleet.server.tailnetIp;
          in
          ''
            def get(machine, host, at="${ip}", more=""):
                """(status, body) of https://<host>.balaur.test/ as that machine sees it."""
                name = f"{host}.balaur.test" if host else "balaur.test"
                out = machine.succeed(
                    f"curl -sk --max-time 10 {more} --resolve {name}:443:{at} -w '\\n%{{http_code}}' https://{name}/"
                )
                body, _, status = out.rpartition("\n")
                return int(status), body

            start_all()
            server.wait_for_unit("caddy.service")
            server.wait_for_open_port(443)
            owner.wait_for_unit("multi-user.target")
            stranger.wait_for_unit("multi-user.target")
            # Caddy answers before it has signed every name.
            owner.wait_until_succeeds("curl -sk --resolve house.balaur.test:443:${ip} https://house.balaur.test/ | grep -q backend", timeout=120)

            with subtest("the owner's device opens everything"):
                for name in ["owner", "private", "house"]:
                    status, body = get(owner, name)
                    assert (status, body) == (200, f"{name} backend"), f"{name}: {status} {body}"
                status, page = get(owner, "")
                assert status == 200, status
                for thing in ["Owner thing", "Private thing", "House thing"]:
                    assert thing in page, f"the owner's home page lacks {thing}"

            with subtest("any other device opens the household's services only"):
                assert get(stranger, "house") == (200, "house backend")
                for name in ["owner", "private"]:
                    status, body = get(stranger, name)
                    assert status == 403, f"{name}: a stranger got {status}"
                    assert "backend" not in body, f"{name}: a stranger was served the page"
                status, page = get(stranger, "")
                assert status == 200, status
                assert "House thing" in page, "the household's home page lacks its service"
                for thing in ["Owner thing", "Private thing"]:
                    assert thing not in page, f"the household's home page lists {thing}"

            with subtest("a forwarded address is not believed"):
                status, _ = get(stranger, "owner", more="-H 'X-Forwarded-For: ${nodes.owner.networking.primaryIPAddress}'")
                assert status == 403, f"a stranger naming the owner's address got {status}"

            with subtest("the machine's own address: an owner, but not for a private service"):
                server.succeed("ip addr add ${tailnetIp}/32 dev lo")
                assert get(server, "owner", at="${tailnetIp}") == (200, "owner backend")
                status, _ = get(server, "private", at="${tailnetIp}")
                assert status == 403, f"the machine's own screen got {status} from a private service"
                # Loopback is nobody's address (web.nix: nothing of ours reaches Caddy that way).
                status, _ = get(server, "owner", at="127.0.0.1")
                assert status == 403, f"loopback got {status}"
          '';
      };

      # qBittorrent (modules/torrents.nix) comes back whatever stopped it, a lock
      # left by a power cut included, and stays down without its downloads' disk.
      checks.torrents = pkgs.testers.runNixOSTest {
        name = "torrents";
        node.pkgsReadOnly = false;

        nodes.machine = {
          imports = [
            machine
            aspects.torrents
          ];
          # The downloads' disk, as on the server: its own filesystem, `nofail`.
          virtualisation.fileSystems."/srv/media" = {
            device = "tmpfs";
            fsType = "tmpfs";
            options = [ "nofail" ];
          };
        };
        # The same machine with that disk missing.
        nodes.nodisk = {
          imports = [
            machine
            aspects.torrents
          ];
          virtualisation.fileSystems."/srv/media" = {
            device = "/dev/disk/by-label/absent";
            fsType = "ext4";
            options = [
              "nofail"
              "x-systemd.device-timeout=5s"
            ];
          };
        };

        testScript = ''
          lock = "/var/lib/qBittorrent/qBittorrent/config/lockfile"
          version = "curl -fsS --max-time 5 http://127.0.0.1:8080/api/v2/app/version"

          start_all()
          machine.wait_for_unit("qbittorrent.service")
          machine.wait_until_succeeds(version, timeout=60)

          with subtest("it starts with the lock of a run that was cut off"):
              # The lock as qBittorrent wrote it, but naming a process that runs
              # (after a power cut its old process id is somebody else's).
              machine.succeed(f"cp -p {lock} /tmp/lock && sed -i '1s/.*/1/' /tmp/lock")
              machine.succeed("systemctl stop qbittorrent")
              machine.succeed(f"cp -p /tmp/lock {lock}")
              machine.succeed("systemctl start qbittorrent")
              machine.wait_until_succeeds(version, timeout=60)

          with subtest("killed, it comes back by itself"):
              machine.succeed("systemctl kill -s KILL qbittorrent")
              machine.wait_until_succeeds(version, timeout=60)
              machine.succeed("systemctl is-active qbittorrent")

          with subtest("without the downloads' disk it stays down"):
              nodisk.wait_for_unit("multi-user.target")
              nodisk.fail("mountpoint -q /srv/media")
              nodisk.wait_until_fails("systemctl is-active qbittorrent srv-media.mount", timeout=60)
              nodisk.fail(version)
        '';
      };

      # A failed unit is told to Home Assistant (modules/notify.nix): once per unit,
      # with its last log lines, and the notifier's own failure tells nobody, so it
      # cannot go round. Home Assistant is a small server that keeps what it is sent.
      checks.notify = pkgs.testers.runNixOSTest {
        name = "notify";
        node.pkgsReadOnly = false;

        nodes.machine =
          { pkgs, ... }:
          {
            imports = [
              machine
              aspects.notify
            ];
            balaur.notify = {
              url = "http://127.0.0.1:8123";
              tokenFile = "${pkgs.writeText "token" "the-token"}";
            };
            services.smartd.enable = pkgs.lib.mkForce false; # no drives to watch here

            systemd.services.fake-hass = {
              wantedBy = [ "multi-user.target" ];
              serviceConfig.ExecStart = "${pkgs.python3}/bin/python3 ${pkgs.writeText "fake-hass.py" ''
                import json
                from http.server import BaseHTTPRequestHandler, HTTPServer


                class H(BaseHTTPRequestHandler):
                    def answer(self, body):
                        data = json.dumps(body).encode()
                        self.send_response(200 if self.headers.get("Authorization") == "Bearer the-token" else 401)
                        self.send_header("Content-Length", str(len(data)))
                        self.end_headers()
                        self.wfile.write(data)

                    def do_GET(self):  # /api/services
                        self.answer([{"domain": "notify", "services": {"notify": {}, "mobile_app_phone": {}}}])

                    def do_POST(self):
                        body = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
                        with open("/tmp/sent", "a") as f:
                            f.write(json.dumps({"path": self.path, **body}) + "\n")
                        self.answer([])


                HTTPServer(("127.0.0.1", 8123), H).serve_forever()
              ''}";
              serviceConfig.PrivateTmp = false;
            };
            systemd.services.boom = {
              description = "A unit that fails";
              serviceConfig.Type = "oneshot";
              script = ''
                echo "the reason it failed"
                exit 1
              '';
            };
          };

        testScript = ''
          import json

          def sent():
              out = machine.succeed("cat /tmp/sent 2>/dev/null || true")
              return [json.loads(line) for line in out.splitlines()]

          machine.wait_for_unit("fake-hass.service")
          machine.wait_for_open_port(8123)

          with subtest("a failed unit is told, to the notifications and to the phone"):
              machine.fail("systemctl start boom")
              machine.wait_until_succeeds("test $(wc -l < /tmp/sent) -ge 2", timeout=30)
              told = sent()
              paths = sorted(m["path"] for m in told)
              assert paths == ["/api/services/notify/mobile_app_phone",
                               "/api/services/persistent_notification/create"], paths
              for m in told:
                  assert m["title"] == "machine: boom.service failed", m
                  assert "the reason it failed" in m["message"], m

          with subtest("the same unit failing again is not told twice"):
              machine.fail("systemctl start boom")
              machine.wait_until_succeeds("journalctl -u 'balaur-notify-failure@*' | grep -q 'already said'", timeout=30)
              assert len(sent()) == 2, sent()

          with subtest("with Home Assistant down nothing fails, and the unit is told about the next time"):
              machine.succeed("systemctl stop fake-hass && rm -rf /var/lib/private/balaur-notify/*")
              machine.fail("systemctl start boom")
              machine.wait_until_succeeds("journalctl -u 'balaur-notify-failure@*' | grep -q 'took nothing'", timeout=30)
              machine.sleep(2)
              # Not the notifier (a failed notifier would be told about by a notifier),
              # and so no failed unit but the one that did fail.
              failed = machine.succeed("systemctl --failed --plain --no-legend | cut -d' ' -f1").split()
              assert failed == ["boom.service"], failed
              # What nixos-rebuild switches in: a transient unit, collected when it
              # fails. A failed notifier held on to it, and the next switch was refused
              # as "already loaded" (the server, 2026-11-17).
              machine.fail("systemd-run --wait --collect --unit=a-switch false")
              machine.wait_until_succeeds("journalctl -u 'balaur-notify-failure@a-switch.service.service' | grep -q 'took nothing'", timeout=30)
              machine.sleep(2)
              machine.succeed("systemd-run --wait --collect --unit=a-switch true")
              machine.succeed("systemctl start fake-hass")
              machine.wait_for_open_port(8123)
              machine.fail("systemctl start boom")
              machine.wait_until_succeeds("test $(wc -l < /tmp/sent) -ge 4", timeout=30)

          with subtest("a report that cannot be sent fails nothing either"):
              machine.succeed("systemctl stop fake-hass")
              machine.succeed("systemctl start balaur-fleet-report")
              failed = machine.succeed("systemctl --failed --plain --no-legend | cut -d' ' -f1").split()
              assert failed == ["boom.service"], failed
        '';
      };

      # A backup that comes back (modules/backup.nix): what the aspects declare as
      # their state (`balaur.state`) is backed up without what they leave out, the
      # restore drill restores it and runs each state's own check, a state that comes
      # back damaged fails the drill, and a lost folder is restored in place.
      checks.backup-restore = pkgs.testers.runNixOSTest {
        name = "backup-restore";
        node.pkgsReadOnly = false;

        nodes.machine =
          { pkgs, ... }:
          {
            imports = [
              machine
              aspects.backup
            ];
            balaur.backup = {
              repository = "/var/backup-test";
              passwordFile = "${pkgs.writeText "password" "test"}";
            };
            # Two aspects' worth of state: one with something left out, one whose check
            # runs as another user, as the ledger's does (money.nix).
            balaur.state.thing = {
              path = "/var/lib/thing";
              exclude = [ "/var/lib/thing/cache" ];
              verify = ''grep -qx precious "$restored/data"'';
            };
            balaur.state.other-thing = {
              path = "/var/lib/other";
              verify = ''
                cp "$restored/note" "$scratch/note"
                chown -R nobody "$scratch"
                setpriv --reuid=nobody --regid=nogroup --clear-groups grep -qx hello "$scratch/note"
              '';
            };
          };

        testScript = ''
          machine.wait_for_unit("multi-user.target")
          machine.succeed(
              "mkdir -p /var/lib/thing/cache /var/lib/other",
              "echo precious > /var/lib/thing/data",
              "echo junk > /var/lib/thing/cache/junk",
              "echo hello > /var/lib/other/note",
              "chmod 0700 /var/lib/other",
          )

          with subtest("the declared state is backed up, without what it leaves out"):
              machine.succeed("systemctl start restic-backups-balaur")
              files = machine.succeed("restic-balaur ls latest")
              assert "/var/lib/thing/data" in files, files
              assert "/var/lib/other/note" in files, files
              assert "junk" not in files, files

          with subtest("the drill restores it, checks it and leaves nothing behind"):
              machine.succeed("systemctl start balaur-restore-drill")
              said = machine.succeed("journalctl -u balaur-restore-drill --no-pager")
              assert "thing: /var/lib/thing came back whole" in said, said
              assert "other-thing: /var/lib/other came back whole" in said, said
              machine.succeed("test ! -e /var/cache/balaur-restore-drill/restored")
              machine.succeed("test ! -e /var/cache/balaur-restore-drill/scratch")

          with subtest("a state that comes back damaged fails the drill"):
              machine.succeed("echo broken > /var/lib/thing/data", "systemctl start restic-backups-balaur")
              machine.fail("systemctl start balaur-restore-drill")
              said = machine.succeed("journalctl -u balaur-restore-drill --no-pager")
              assert "thing: /var/lib/thing came back, and its check failed" in said, said
              machine.succeed("test ! -e /var/cache/balaur-restore-drill/restored")

          with subtest("a lost folder comes back in place"):
              machine.succeed("echo precious > /var/lib/thing/data", "systemctl start restic-backups-balaur")
              machine.succeed("rm -rf /var/lib/thing")
              machine.succeed("restic-balaur restore latest --target / --include /var/lib/thing")
              machine.succeed("grep -qx precious /var/lib/thing/data")
              machine.succeed("systemctl start balaur-restore-drill")
        '';
      };

      # The keeper's side of plan 005 (lifelog/docs/plans/005-git-sync.md): another
      # machine pushes to life.git and the keeper merges it into live and the folder.
      # The owner plays that machine here, with a clone on this one: the hook, the
      # permissions of a push by another user, the merge and its conflict copy, and
      # the report reaching the clone and its deletion coming back as the
      # acknowledgement. SSH between two machines is the client's test (P4).
      checks.lifelog-keeper = pkgs.testers.runNixOSTest {
        name = "lifelog-keeper";
        node.pkgsReadOnly = false;

        nodes.server =
          { lib, ... }:
          {
            imports = [
              machine
              aspects.lifelog
            ];
            # The keeper's web app goes through `web` (Caddy), which this test does not
            # need: an empty stand-in satisfies the aspect's assertion.
            options.balaur.web = lib.mkOption {
              type = lib.types.attrs;
              default = { };
            };
            config.balaur.lifelog.quietSeconds = 1;
          };

        testScript = ''
          import shlex

          owner = "sudo -u balaur env HOME=/home/balaur"
          def as_owner(cmd):
              return server.succeed(f"{owner} sh -euc {shlex.quote(cmd)}")

          def keep():
              server.succeed("sleep 2", "systemctl start lifelog-keeper")

          git = "git --git-dir /var/lib/lifelog/life.git"
          server.wait_for_unit("multi-user.target")

          with subtest("the keeper commits the folder"):
              as_owner("mkdir -p /srv/life/pages && echo 'The first line.' > /srv/life/pages/A.md")
              keep()
              server.succeed(f"{git} cat-file -e live:pages/A.md")

          as_owner(
              "git config --global user.name owner && git config --global user.email owner@test"
              " && git clone -q -b live /var/lib/lifelog/life.git ~/clone"
          )

          with subtest("a push may move from/<host> only"):
              as_owner("cd ~/clone && echo 'From the clone.' > pages/B.md && git add -A && git commit -qm b")
              server.fail(f"{owner} git -C /home/balaur/clone push -q origin live:live")
              as_owner("cd ~/clone && git push -q origin live:refs/heads/from/laptop")

          with subtest("the keeper merges it into the folder, and can write what the push wrote"):
              keep()
              server.succeed("grep -qx 'From the clone.' /srv/life/pages/B.md")
              server.succeed(f"{git} merge-base --is-ancestor from/laptop live")
              server.succeed("test -z \"$(find /var/lib/lifelog/life.git/objects -type d ! -perm -g+w)\"")

          with subtest("one page on both sides: the folder's stays, the other is a copy, and the report is committed"):
              as_owner("cd ~/clone && git pull -q && echo 'The laptop line.' > pages/A.md && git commit -qam a"
                       " && git push -q origin live:refs/heads/from/laptop")
              as_owner("echo 'The server line.' > /srv/life/pages/A.md")
              keep()
              server.succeed("grep -qx 'The server line.' /srv/life/pages/A.md")
              copy = server.succeed("ls /srv/life/pages | grep -x 'A.sync-conflict-[0-9]*-[0-9]*-laptop.md'").strip()
              server.succeed(f"grep -qx 'The laptop line.' '/srv/life/pages/{copy}'")
              server.succeed(f"{git} show live:_check.md | grep -q sync-conflict")
              server.succeed(f"test -z \"$({git} --work-tree /srv/life status --porcelain)\"")

          with subtest("the copy merged by hand and the report deleted on the clone: acknowledged, nothing left to say"):
              as_owner(f"cd ~/clone && git pull -q && test -f _check.md && git rm -q '_check.md' 'pages/{copy}'"
                       " && git commit -qm fixed && git push -q origin live:refs/heads/from/laptop")
              keep()
              server.succeed("test ! -e /srv/life/_check.md")
              keep()
              server.succeed("test ! -e /srv/life/_check.md")
              server.fail(f"{git} cat-file -e live:_check.md")
              server.succeed(f"{git} merge-base --is-ancestor seen live")
              server.succeed(f"{git} merge-base --is-ancestor from/laptop checked")
        '';
      };

      # Plan 005 between two machines (P4): the laptop's `lifelog-sync` against the
      # server's keeper, over SSH, as the owner. The clone is made, an edit on each side
      # reaches the other, one page changed on both ends as a conflict copy on both,
      # the report is acknowledged from the laptop, and a laptop cut off from the
      # server commits and catches up when it is back. The timers are off: the test
      # starts each run itself, so the order is the one it reads.
      checks.lifelog-sync = pkgs.testers.runNixOSTest {
        name = "lifelog-sync";
        node.pkgsReadOnly = false;

        nodes.server =
          { lib, ... }:
          {
            imports = [
              machine
              aspects.lifelog
            ];
            # The web app's assertion wants `web`; this test does not need it.
            options.balaur.web = lib.mkOption {
              type = lib.types.attrs;
              default = { };
            };
            config = {
              balaur.lifelog.quietSeconds = 1;
              systemd.timers.lifelog-keeper.wantedBy = lib.mkForce [ ];
            };
          };

        nodes.laptop =
          { lib, ... }:
          {
            imports = [
              machine
              aspects.lifelog-client
            ];
            # Obsidian comes through home-manager, which this test does not need.
            options.home-manager = lib.mkOption {
              type = lib.types.anything;
              default = { };
            };
            config = {
              balaur.lifelog-client = {
                syncWith = "server";
                quietSeconds = 1;
              };
              systemd.timers.lifelog-sync.wantedBy = lib.mkForce [ ];
            };
          };

        testScript = ''
          import shlex

          owner = "sudo -u balaur env HOME=/home/balaur"
          def as_owner(m, cmd):
              return m.succeed(f"{owner} sh -euc {shlex.quote(cmd)}")

          def keep():
              server.succeed("sleep 2", "systemctl start lifelog-keeper")

          def sync():
              laptop.succeed("sleep 2", "systemctl start lifelog-sync")

          git = "git --git-dir /var/lib/lifelog/life.git"
          start_all()
          server.wait_for_unit("sshd.service")
          laptop.wait_for_unit("multi-user.target")

          # The owner's key on the laptop, let in on the server, and the server's host key known.
          as_owner(laptop, "mkdir -p ~/.ssh && ssh-keygen -q -t ed25519 -N ''' -f ~/.ssh/id_ed25519")
          key = laptop.succeed("cat /home/balaur/.ssh/id_ed25519.pub").strip()
          as_owner(server, f"mkdir -p -m 700 ~/.ssh && echo {shlex.quote(key)} >> ~/.ssh/authorized_keys && chmod 600 ~/.ssh/authorized_keys")
          as_owner(laptop, "ssh-keyscan -q -t ed25519 server > ~/.ssh/known_hosts")

          as_owner(server, "mkdir -p /srv/life/pages && echo 'The first line.' > /srv/life/pages/A.md")
          keep()

          with subtest("before init, a run does nothing"):
              sync()
              laptop.succeed("test ! -e /home/balaur/.local/share/lifelog/sync.git")

          with subtest("init refuses a folder with something in it"):
              as_owner(laptop, "mkdir -p /srv/life/pages && echo old > /srv/life/pages/Old.md")
              laptop.fail(f"{owner} lifelog-sync init")
              as_owner(laptop, "rm -r /srv/life/pages")

          with subtest("init makes the clone"):
              as_owner(laptop, "lifelog-sync init")
              laptop.succeed("grep -qx 'The first line.' /srv/life/pages/A.md")

          with subtest("a laptop edit reaches the server"):
              as_owner(laptop, "echo 'From the laptop.' > /srv/life/pages/B.md")
              sync()
              keep()
              server.succeed("grep -qx 'From the laptop.' /srv/life/pages/B.md")
              server.succeed(f"{git} log --format=%an live | grep -qx 'lifelog laptop'")

          with subtest("a server edit reaches the laptop"):
              as_owner(server, "echo 'From the web app.' > /srv/life/pages/C.md")
              keep()
              sync()
              laptop.succeed("grep -qx 'From the web app.' /srv/life/pages/C.md")

          with subtest("one page on both sides: a conflict copy, on both machines"):
              as_owner(laptop, "echo 'The laptop line.' > /srv/life/pages/A.md")
              sync()
              as_owner(server, "echo 'The server line.' > /srv/life/pages/A.md")
              keep()
              copy = server.succeed("ls /srv/life/pages | grep -x 'A.sync-conflict-[0-9]*-[0-9]*-laptop.md'").strip()
              sync()
              laptop.succeed("grep -qx 'The server line.' /srv/life/pages/A.md")
              laptop.succeed(f"grep -qx 'The laptop line.' '/srv/life/pages/{copy}'")
              laptop.succeed("grep -q sync-conflict /srv/life/_check.md")

          with subtest("the report deleted on the laptop: acknowledged on the server"):
              as_owner(laptop, f"rm /srv/life/_check.md '/srv/life/pages/{copy}'")
              sync()
              keep()
              keep()
              server.succeed("test ! -e /srv/life/_check.md")
              server.succeed(f"{git} merge-base --is-ancestor from/laptop checked")
              sync()
              laptop.succeed("test ! -e /srv/life/_check.md")

          with subtest("cut off, the laptop commits; back, it catches up"):
              laptop.block()
              as_owner(laptop, "echo 'Written offline.' > /srv/life/pages/D.md")
              sync()
              laptop.succeed("journalctl -u lifelog-sync --no-pager | grep -q 'does not answer'")
              as_owner(laptop, "git --git-dir ~/.local/share/lifelog/sync.git cat-file -e work:pages/D.md")
              laptop.unblock()
              sync()
              keep()
              server.succeed("grep -qx 'Written offline.' /srv/life/pages/D.md")

          with subtest("both machines end up at one state"):
              sync()
              laptop_tree = as_owner(laptop, "git --git-dir ~/.local/share/lifelog/sync.git rev-parse 'work^{tree}'").strip()
              server_tree = server.succeed(f"{git} rev-parse 'live^{{tree}}'").strip()
              assert laptop_tree == server_tree, (laptop_tree, server_tree)
        '';
      };

      # Not a check: it builds Home Assistant, which no cache has with our set of
      # integrations, so on GitHub it would cost a quarter of an hour on every push.
      # By hand, after a change to home-assistant.nix or the report in notify.nix:
      #
      #   nix build -L .#heavy-tests.fleet-in-home-assistant
      #
      # The real Home Assistant with the fleet's sensors and rules: the machine's own
      # report is taken, a disk over 90 % and a backup three days old are told, and
      # nothing in its log complains about what is declared here.
      legacyPackages.heavy-tests.fleet-in-home-assistant = pkgs.testers.runNixOSTest {
        name = "fleet-in-home-assistant";
        node.pkgsReadOnly = false;

        # `server`: a machine of the registry, so it has a webhook and sensors.
        nodes.server =
          { pkgs, lib, ... }:
          {
            imports = [
              machine
              aspects.home-assistant
              aspects.notify
              aspects.backup
            ];
            virtualisation.memorySize = 3072;
            services.smartd.enable = lib.mkForce false;
            balaur.notify.tokenFile = "${pkgs.writeText "token" "unused"}";
            balaur.backup = {
              repository = "/var/backup-test";
              passwordFile = "${pkgs.writeText "password" "test"}";
            };
            # What is told lands in a file instead of on a phone.
            balaur.home-assistant.notify = [ "test" ];
            # At this level it says when it is up, and when a webhook is not known.
            services.home-assistant.config.logger.default = "info";
            services.home-assistant.extraComponents = [ "command_line" ];
            services.home-assistant.config.command_line = [
              {
                notify = {
                  name = "test";
                  command = "cat >> /var/lib/hass/told; echo >> /var/lib/hass/told";
                };
              }
            ];
          };

        testScript = ''
          import json

          def report(**fields):
              body = json.dumps({"state": "running", "failed": [], "deployed": "0123456789abcdef", "trying": "",
                                 "reboot": False, "disks": {"/": 50}, **fields})
              server.succeed(f"curl -fsS -H 'Content-Type: application/json' -d '{body}' "
                             "http://127.0.0.1:8123/api/webhook/balaur-fleet-server")

          server.wait_for_unit("home-assistant.service")
          server.wait_for_open_port(8123)
          # It answers 200 to a webhook it has not made yet: wait until it is all up.
          server.wait_until_succeeds("journalctl -u home-assistant | grep -q 'Home Assistant initialized'", timeout=180)

          with subtest("the machine's own report is taken"):
              server.succeed("systemctl start balaur-fleet-report")
              server.fail("journalctl -u home-assistant --since -5s | grep -q 'unregistered webhook'")

          with subtest("a disk over 90 % is told"):
              report()
              report(disks={"/": 50, "/srv/full": 95})
              server.wait_until_succeeds("grep -q '/srv/full' /var/lib/hass/told", timeout=60)

          with subtest("a backup three days old is told, a fresh one is not"):
              report(backup_at=server.succeed("date -Iseconds").strip())
              server.sleep(70)
              server.fail("grep -q 'nightly backup' /var/lib/hass/told")
              report(backup_at=server.succeed("date -d '3 days ago' -Iseconds").strip())
              server.wait_until_succeeds("grep -q 'nightly backup' /var/lib/hass/told", timeout=150)

          with subtest("Home Assistant has no complaint about what is declared"):
              journal = server.succeed("journalctl -u home-assistant --no-pager")
              bad = [line for line in journal.splitlines()
                     if "ERROR" in line and any(w in line.lower() for w in ("template", "fleet", "webhook", "automation"))]
              assert not bad, "\n".join(bad)
        '';
      };
    };
}
