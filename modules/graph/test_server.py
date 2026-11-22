"""Tests for the graph page's server (server.py), with a fake systemctl:

    python3 -I modules/graph/test_server.py
"""

import json
import os
import socket
import sys
import tempfile
import threading
import unittest
import urllib.error
import urllib.request

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import server  # noqa: E402

SHOW = """Id=caddy.service
LoadState=loaded
ActiveState=active
SubState=running
Result=success
ActiveEnterTimestamp=Sat 2026-11-21 10:00:00 EET

Id=money-check.timer
LoadState=loaded
ActiveState=active
SubState=waiting
Result=success
ActiveEnterTimestamp=

Id=money-check.service
LoadState=loaded
ActiveState=failed
SubState=failed
Result=exit-code
ActiveEnterTimestamp=
"""

GRAPH = {
    "me": "server",
    "hosts": [
        {
            "host": "server",
            "aspects": [
                {"name": "web", "nodes": [{"id": "n0", "units": ["caddy.service"]}]},
                {
                    "name": "money",
                    "nodes": [
                        {"id": "n1", "units": ["money-check.timer", "money-check.service"]},
                        {"id": "n2", "units": ["caddy.service"]},
                    ],
                },
            ],
            "shared": [{"id": "s0", "units": ["restic-backups-balaur.service"]}],
        },
        {
            "host": "laptop",
            "aspects": [{"name": "gaming", "nodes": [{"id": "l0", "units": ["steam.service"]}]}],
            "shared": [],
        },
    ],
}


class Parsing(unittest.TestCase):
    def test_units_once_in_order(self):
        self.assertEqual(
            server.units_of(GRAPH, "server"),
            [
                "caddy.service",
                "money-check.timer",
                "money-check.service",
                "restic-backups-balaur.service",
            ],
        )
        self.assertEqual(server.units_of(GRAPH, "laptop"), ["steam.service"])

    def test_show(self):
        units = server.parse_show(SHOW)
        self.assertEqual(units["caddy.service"]["sub"], "running")
        self.assertEqual(units["money-check.service"]["active"], "failed")
        self.assertEqual(units["money-check.service"]["result"], "exit-code")
        self.assertEqual(len(units), 3)

    def test_deploy(self):
        d = server.parse_deploy("abc123 degraded - 0 money-check.service,x.service reboot")
        self.assertEqual(d["deployed"], "abc123")
        self.assertEqual(d["state"], "degraded")
        self.assertIsNone(d["trying"])
        self.assertEqual(d["failed"], ["money-check.service", "x.service"])
        self.assertTrue(d["reboot"])
        d = server.parse_deploy("abc123 running def456 2 - -")
        self.assertEqual(d["trying"], "def456")
        self.assertEqual(d["attempts"], 2)
        self.assertEqual(d["failed"], [])
        self.assertFalse(d["reboot"])
        self.assertIsNone(server.parse_deploy(""))


class Serving(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tmp = tempfile.mkdtemp()
        site = os.path.join(cls.tmp, "site")
        os.mkdir(site)
        with open(os.path.join(site, "index.html"), "w") as f:
            f.write("<!doctype html><title>Graph</title>")
        graph = os.path.join(site, "graph.json")
        with open(graph, "w") as f:
            json.dump(GRAPH, f)
        with open(os.path.join(cls.tmp, "secret"), "w") as f:
            f.write("not for the page")
        show = os.path.join(cls.tmp, "show.txt")
        with open(show, "w") as f:
            f.write(SHOW)
        # The fake systemctl prints SHOW and records the units it was asked for.
        cls.asked = os.path.join(cls.tmp, "asked")
        systemctl = os.path.join(cls.tmp, "systemctl")
        with open(systemctl, "w") as f:
            f.write(f'#!/bin/sh\necho "$@" > {cls.asked}\ncat {show}\n')
        deploy = os.path.join(cls.tmp, "deploy-state")
        with open(deploy, "w") as f:
            f.write("#!/bin/sh\necho 'abc123 running - 0 - -'\n")
        os.chmod(systemctl, 0o755)
        os.chmod(deploy, 0o755)

        class Args:
            pass

        def start(host, peers):
            args = Args()
            args.host, args.peer = host, peers
            args.site, args.graph, args.listen = site, graph, "127.0.0.1:0"
            args.systemctl, args.deploy_state = systemctl, deploy
            srv = server.server(args)
            threading.Thread(target=srv.serve_forever, daemon=True).start()
            return srv, "http://127.0.0.1:%d" % srv.server_address[1]

        # The laptop answers; `gone` is asleep (nothing listens there).
        cls.laptop, laptop_url = start("laptop", None)
        cls.srv, cls.url = start("server", [f"laptop={laptop_url}", "gone=http://127.0.0.1:1"])

    @classmethod
    def tearDownClass(cls):
        cls.srv.shutdown()
        cls.laptop.shutdown()

    def get(self, path):
        with urllib.request.urlopen(self.url + path) as r:
            return r.status, r.headers["Content-Type"], r.read()

    def test_page(self):
        code, ctype, body = self.get("/")
        self.assertEqual(code, 200)
        self.assertTrue(ctype.startswith("text/html"))
        self.assertIn(b"Graph", body)

    def test_graph(self):
        _, ctype, body = self.get("/graph.json")
        self.assertEqual(ctype, "application/json")
        self.assertEqual(json.loads(body)["me"], "server")

    def test_state(self):
        _, _, body = self.get("/state.json")
        hosts = json.loads(body)["hosts"]
        state = hosts["server"]
        self.assertEqual(state["units"]["money-check.service"]["active"], "failed")
        self.assertEqual(state["deploy"]["deployed"], "abc123")
        self.assertIn("load", state["machine"])
        # The laptop's own answer, passed on; the asleep one is null.
        self.assertEqual(hosts["laptop"]["deploy"]["deployed"], "abc123")
        self.assertIn("units", hosts["laptop"])
        self.assertIsNone(hosts["gone"])
        self.assertEqual(sorted(hosts), ["gone", "laptop", "server"])

    def test_asks_for_own_units(self):
        server.State(self.srv_args(), GRAPH).collect()
        with open(self.asked) as f:
            asked = f.read().split()
        self.assertEqual(
            asked[asked.index("--") + 1 :],
            [
                "caddy.service",
                "money-check.timer",
                "money-check.service",
                "restic-backups-balaur.service",
            ],
        )

    def srv_args(self):
        class Args:
            host, peer = "server", None
            systemctl = os.path.join(self.tmp, "systemctl")
            deploy_state = os.path.join(self.tmp, "deploy-state")

        return Args()

    def test_unix_socket(self):
        # As under systemd: a listening Unix socket handed over, and no other
        # address family allowed (the unit's RestrictAddressFamilies).
        path = os.path.join(self.tmp, "http.sock")
        sock = socket.socket(socket.AF_UNIX)
        sock.bind(path)
        sock.listen()
        real = socket.socket.__init__

        def unix_only(s, family=-1, *a, **k):
            if family not in (-1, socket.AF_UNIX):
                raise OSError(97, "Address family not supported by protocol")
            real(s, family, *a, **k)

        socket.socket.__init__ = unix_only
        try:
            srv = server.on_socket(sock, self.srv.RequestHandlerClass)
        finally:
            socket.socket.__init__ = real
        threading.Thread(target=srv.serve_forever, daemon=True).start()
        try:
            c = socket.socket(socket.AF_UNIX)
            c.connect(path)
            c.sendall(b"GET /graph.json HTTP/1.0\r\n\r\n")
            reply = b""
            while chunk := c.recv(65536):
                reply += chunk
            c.close()
            self.assertTrue(reply.startswith(b"HTTP/1.0 200"), reply[:80])
            self.assertIn(b'"me": "server"', reply)
        finally:
            srv.shutdown()
            srv.server_close()

    def test_only_site_files(self):
        for path in ("/../secret", "/%2e%2e/secret", "/nothing.js", "/.hidden"):
            with self.assertRaises(urllib.error.HTTPError) as e:
                self.get(path)
            self.assertEqual(e.exception.code, 404, path)


if __name__ == "__main__":
    unittest.main(verbosity=2)
