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
