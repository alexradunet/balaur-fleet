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
    };
}
