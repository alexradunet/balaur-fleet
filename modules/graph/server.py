"""The graph page's server (graph.nix): the page and the graph from the store, and
the machine's live state as JSON.

    python3 -I server.py --host NAME --site DIR --graph graph.json --systemctl PATH \
        [--deploy-state PATH] [--peer NAME=URL ...] [--listen HOST:PORT]

Without --listen it takes the socket systemd passes it (LISTEN_FDS, the socket
unit's). GET /state.json runs one `systemctl show` for every unit of this host in
graph.json and `balaur-deploy-state`, and asks each --peer (another machine's
server) for its own, at most once every few seconds however many pages are open:
{"time", "hosts": {NAME: state, PEER: state or null when it does not answer}}.
It changes nothing: it only reads.
"""

import argparse
import json
import os
import socket
import subprocess
import threading
import time
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

CACHE_SECONDS = 5
PEER_TIMEOUT = 3
PROPS = "Id,LoadState,ActiveState,SubState,Result,ActiveEnterTimestamp"
TYPES = {
    ".html": "text/html; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".json": "application/json",
    ".svg": "image/svg+xml",
    ".css": "text/css; charset=utf-8",
}


def units_of(graph, host):
    """Every unit the graph shows for this host, once each, in the graph's order."""
    seen = []
    for h in graph["hosts"]:
        if h["host"] != host:
            continue
        for node in [n for a in h["aspects"] for n in a["nodes"]] + h.get("shared", []):
            for unit in node["units"]:
                if unit not in seen:
                    seen.append(unit)
    return seen


def parse_show(text):
    """`systemctl show -p ... a b c`: one block per unit, blank lines between."""
    units = {}
    for block in text.strip().split("\n\n"):
        fields = {}
        for line in block.splitlines():
            key, sep, value = line.partition("=")
            if sep:
                fields[key] = value
        if "Id" not in fields:
            continue
        units[fields["Id"]] = {
            "load": fields.get("LoadState", ""),
            "active": fields.get("ActiveState", ""),
            "sub": fields.get("SubState", ""),
            "result": fields.get("Result", ""),
            "since": fields.get("ActiveEnterTimestamp", ""),
        }
    return units


def parse_deploy(line):
    """balaur-deploy-state's one line (auto-deploy.nix):
    <deployed> <state> <trying or -> <attempts> <failed units or -> <reboot or ->"""
    parts = line.split()
    if len(parts) < 6:
        return None
    deployed, state, tried, attempts, failed, reboot = parts[:6]
    return {
        "deployed": None if deployed == "-" else deployed,
        "state": state,
        "trying": None if tried == "-" else tried,
        "attempts": int(attempts) if attempts.isdigit() else 0,
        "failed": [] if failed == "-" else failed.split(","),
        "reboot": reboot == "reboot",
    }


def read(path, default=""):
    try:
        with open(path) as f:
            return f.read()
    except OSError:
        return default


def machine():
    """Load, uptime, memory, and which system generation runs."""
    load = read("/proc/loadavg").split()[:3]
    uptime = read("/proc/uptime").split()
    mem = {}
    for line in read("/proc/meminfo").splitlines():
        key, _, value = line.partition(":")
        if key in ("MemTotal", "MemAvailable"):
            mem[key] = int(value.split()[0]) * 1024
    system = os.path.realpath("/run/current-system")
    return {
        "load": [float(x) for x in load] if load else [],
        "uptime": float(uptime[0]) if uptime else None,
        "memory": {"total": mem.get("MemTotal"), "available": mem.get("MemAvailable")},
        "system": os.path.basename(system),
        "nixos": read("/run/current-system/nixos-version").strip() or None,
        "booted": os.path.basename(os.path.realpath("/run/booted-system")),
    }


class State:
    def __init__(self, args, graph):
        self.args = args
        self.units = units_of(graph, args.host)
        self.peers = dict(p.split("=", 1) for p in args.peer or [])
        self.lock = threading.Lock()
        self.at = 0.0
        self.body = b""

    def collect(self):
        units = {}
        try:
            out = subprocess.run(
                [self.args.systemctl, "show", "-p", PROPS, "--", *self.units],
                capture_output=True,
                text=True,
                timeout=10,
            ).stdout
            units = parse_show(out)
        except (OSError, subprocess.SubprocessError):
            pass
        deploy = None
        if self.args.deploy_state and os.path.exists(self.args.deploy_state):
            try:
                out = subprocess.run(
                    [self.args.deploy_state], capture_output=True, text=True, timeout=10
                ).stdout
                deploy = parse_deploy(out.strip())
            except (OSError, subprocess.SubprocessError):
                pass
        return {"units": units, "deploy": deploy, "machine": machine()}

    def peer(self, name):
        """A peer's own state, or None: asleep, off the tailnet, or not yet deployed."""
        try:
            url = self.peers[name].rstrip("/") + "/state.json"
            with urllib.request.urlopen(url, timeout=PEER_TIMEOUT) as r:
                return json.load(r)["hosts"][name]
        except (OSError, ValueError, KeyError, TypeError):
            return None

    def everything(self):
        with ThreadPoolExecutor(max_workers=len(self.peers) + 1) as pool:
            theirs = {n: pool.submit(self.peer, n) for n in self.peers}
            hosts = {self.args.host: self.collect()}
            hosts.update({n: f.result() for n, f in theirs.items()})
        return {"time": time.time(), "hosts": hosts}

    def json(self):
        with self.lock:
            if time.monotonic() - self.at > CACHE_SECONDS:
                self.body = json.dumps(self.everything()).encode()
                self.at = time.monotonic()
            return self.body


def handler(site, state):
    class Handler(BaseHTTPRequestHandler):
        def send(self, code, body, ctype):
            self.send_response(code)
            self.send_header("Content-Type", ctype)
            self.send_header("Content-Length", str(len(body)))
            self.send_header("Cache-Control", "no-cache")
            self.end_headers()
            if self.command != "HEAD":
                self.wfile.write(body)

        def do_GET(self):
            path = self.path.split("?", 1)[0]
            if path == "/state.json":
                return self.send(200, state.json(), "application/json")
            name = "index.html" if path == "/" else path.lstrip("/")
            # Only the site's own files, by name: no subfolders, no `..`.
            if "/" in name or name.startswith(".") or name not in os.listdir(site):
                return self.send(404, b"not found\n", "text/plain")
            with open(os.path.join(site, name), "rb") as f:
                body = f.read()
            ctype = TYPES.get(os.path.splitext(name)[1], "application/octet-stream")
            return self.send(200, body, ctype)

        do_HEAD = do_GET

        # A Unix socket has no client address, and the journal needs no access log.
        def log_message(self, *args):
            pass

    return Handler


def server(args):
    with open(args.graph) as f:
        graph = json.load(f)
    h = handler(args.site, State(args, graph))
    if args.listen:
        host, _, port = args.listen.rpartition(":")
        return ThreadingHTTPServer((host, int(port)), h)
    if os.environ.get("LISTEN_PID") != str(os.getpid()) or os.environ.get("LISTEN_FDS") != "1":
        raise SystemExit("no --listen and no socket from systemd")
    return on_socket(socket.socket(fileno=3), h)


class UnixHTTPServer(ThreadingHTTPServer):
    # The unit allows Unix sockets only, so even the one socketserver makes
    # before it is replaced must be one.
    address_family = socket.AF_UNIX


def on_socket(sock, h):
    """A server on a socket that already listens (systemd's)."""
    srv = UnixHTTPServer("", h, bind_and_activate=False)
    srv.socket.close()
    srv.socket = sock
    return srv


def main():
    p = argparse.ArgumentParser()
    p.add_argument("--host", required=True)
    p.add_argument("--site", required=True)
    p.add_argument("--graph", required=True)
    p.add_argument("--systemctl", default="systemctl")
    p.add_argument("--deploy-state")
    p.add_argument("--peer", action="append", help="NAME=URL of another machine's server")
    p.add_argument("--listen")
    server(p.parse_args()).serve_forever()


if __name__ == "__main__":
    main()
