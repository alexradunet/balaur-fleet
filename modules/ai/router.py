"""balaur-ai: the fleet's model router, an OpenAI-compatible server on 127.0.0.1.

One address for every program on the machine, and three model names:

  balaur          local first: the fleet's own GPUs (Strata on zmeu), when one is
                  up, loaded and not already answering someone else; otherwise
                  the remote API (Mistral). The default for everything.
  balaur-local    only the fleet's GPUs (fails when none is up).
  balaur-remote   only the remote API, even when a local one is up.

Any other model name goes to the remote API unchanged ("mistral-small-latest").

Each local endpoint is probed in the background (GET /health), so a machine that
is off, asleep, gaming or still loading its model is skipped at once instead of
timed out on. A request that fails on a local endpoint before its answer starts
is retried on the next tier, so a caller never sees the difference.

Requests bound for the remote API are trimmed to what Mistral accepts: unknown
fields dropped, `developer` messages sent as `system`, `max_completion_tokens`
renamed, and tool-call ids (Mistral wants exactly nine letters or digits)
rewritten consistently, so a conversation begun on a local model can carry on
remotely.

Stdlib only. Usage: router.py CONFIG.json  (written by modules/ai.nix)
"""

import hashlib
import http.client
import json
import os
import re
import string
import sys
import threading
import time
import urllib.parse
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

CFG = json.load(open(sys.argv[1]))
NAME = CFG["name"]  # "balaur"
LOCAL = CFG["local"]  # [{"name", "url", "model"}], in order of preference
REMOTE = CFG["remote"]  # {"url", "model", "keyCredential"}
CONNECT_TIMEOUT = CFG.get("connectTimeout", 3)
READ_TIMEOUT = CFG.get("readTimeout", 600)
PROBE_INTERVAL = CFG.get("probeInterval", 10)

# What Mistral's chat completions accept; everything else is dropped on the way there.
REMOTE_FIELDS = {
    "model", "messages", "temperature", "top_p", "max_tokens", "stream", "stop",
    "random_seed", "response_format", "tools", "tool_choice", "presence_penalty",
    "frequency_penalty", "n", "parallel_tool_calls", "prediction", "safe_prompt",
}
MISTRAL_ID = re.compile(r"^[A-Za-z0-9]{9}$")
ALPHABET = string.ascii_letters + string.digits
HOP_BY_HOP = {"connection", "keep-alive", "transfer-encoding", "content-length", "upgrade",
              "proxy-authenticate", "proxy-authorization", "te", "trailer"}

state = {e["name"]: {"up": False, "since": 0.0, "detail": "not probed yet"} for e in LOCAL}
lock = threading.Lock()


def log(*a):
    print(*a, file=sys.stderr, flush=True)


def split(url):
    u = urllib.parse.urlsplit(url)
    port = u.port or (443 if u.scheme == "https" else 80)
    return u.scheme, u.hostname, port, u.path.rstrip("/")


def connect(url, timeout):
    scheme, host, port, _ = split(url)
    cls = http.client.HTTPSConnection if scheme == "https" else http.client.HTTPConnection
    return cls(host, port, timeout=timeout)


def get_json(url, path, timeout):
    """GET <server root><path> -> parsed JSON, or raises."""
    scheme, host, port, base = split(url)
    root = base[: -len("/v1")] if base.endswith("/v1") else base
    c = connect(url, timeout)
    try:
        c.request("GET", root + path, headers={"Host": host})
        r = c.getresponse()
        body = r.read()
        if r.status != 200:
            raise OSError(f"HTTP {r.status}")
        return json.loads(body)
    finally:
        c.close()


def set_state(name, up, detail):
    with lock:
        s = state[name]
        if s["up"] != up:
            log(f"{name}: {'up' if up else 'down'} ({detail})")
            s["since"] = time.time()
        s["up"], s["detail"] = up, detail


def probe(e):
    try:
        h = get_json(e["url"], "/health", CONNECT_TIMEOUT)
        if h.get("loaded") is False:
            set_state(e["name"], False, "loading its model")
        else:
            set_state(e["name"], True, "ready")
    except Exception as ex:  # off, asleep, stopped for a game, ...
        set_state(e["name"], False, f"{type(ex).__name__}: {ex}")


def prober():
    while True:
        for e in LOCAL:
            probe(e)
        time.sleep(PROBE_INTERVAL)


def busy(e):
    """True when the endpoint is already answering or queueing someone (Strata answers one at a time)."""
    try:
        s = get_json(e["url"], "/status", CONNECT_TIMEOUT)
        return bool(s.get("busy")) or int(s.get("queued") or 0) > 0
    except Exception:
        return False  # no /status (not Strata): just try it


def remote_key():
    path = os.path.join(os.environ.get("CREDENTIALS_DIRECTORY", ""), REMOTE["keyCredential"])
    try:
        return open(path).read().strip()
    except OSError:
        return ""


def mistral_id(i):
    if not isinstance(i, str) or MISTRAL_ID.match(i):
        return i
    n = int.from_bytes(hashlib.sha256(i.encode()).digest()[:8], "big")
    return "".join(ALPHABET[(n >> (6 * k)) % len(ALPHABET)] for k in range(9))


def for_remote(body):
    out = {k: v for k, v in body.items() if k in REMOTE_FIELDS}
    if "max_tokens" not in out and "max_completion_tokens" in body:
        out["max_tokens"] = body["max_completion_tokens"]
    msgs = []
    for m in body.get("messages") or []:
        m = dict(m)
        if m.get("role") == "developer":
            m["role"] = "system"
        m.pop("reasoning_content", None)
        if m.get("tool_calls"):
            m["tool_calls"] = [dict(c, id=mistral_id(c.get("id"))) for c in m["tool_calls"]]
        if "tool_call_id" in m:
            m["tool_call_id"] = mistral_id(m["tool_call_id"])
        msgs.append(m)
    if msgs:
        out["messages"] = msgs
    if out.get("tools"):
        tools = []
        for t in out["tools"]:
            t = dict(t)
            if isinstance(t.get("function"), dict):
                t["function"] = {k: v for k, v in t["function"].items() if k != "strict"}
            tools.append(t)
        out["tools"] = tools
    return out


def tiers(model):
    """[(label, url, upstream model, is_local)] to try in order, for the requested model name."""
    local = [(e["name"], e["url"], e["model"], True) for e in LOCAL]
    remote = [("remote", REMOTE["url"], REMOTE["model"], False)]
    if model in (None, "", NAME):
        return local + remote
    if model == f"{NAME}-local":
        return local
    if model == f"{NAME}-remote":
        return remote
    return [("remote", REMOTE["url"], model, False)]


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    server_version = "balaur-ai"

    def log_message(self, fmt, *args):
        pass  # one line per request is written by forward()

    def reply(self, status, obj):
        data = json.dumps(obj).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self):
        path = urllib.parse.urlsplit(self.path).path.rstrip("/")
        if path in ("/v1/models", "/models"):
            names = [NAME, f"{NAME}-local", f"{NAME}-remote"]
            self.reply(200, {"object": "list", "data": [
                {"id": n, "object": "model", "owned_by": "balaur"} for n in names]})
        elif path in ("", "/health", "/status"):
            with lock:
                local = {k: dict(v) for k, v in state.items()}
            self.reply(200, {"local": local, "remote": {"url": REMOTE["url"], "model": REMOTE["model"],
                                                        "key": bool(remote_key())}})
        else:
            self.reply(404, {"error": {"message": f"no GET {path} here"}})

    def do_POST(self):
        length = int(self.headers.get("Content-Length") or 0)
        raw = self.rfile.read(length) if length else b""
        try:
            body = json.loads(raw or b"{}")
            if not isinstance(body, dict):
                raise ValueError("not an object")
        except ValueError as ex:
            self.reply(400, {"error": {"message": f"the body is not a JSON object: {ex}"}})
            return
        path = urllib.parse.urlsplit(self.path).path
        if not path.startswith("/v1/"):
            path = "/v1" + path  # clients configured without the /v1
        asked = body.get("model")
        candidates = tiers(asked)
        last_error = None
        for i, (label, url, model, is_local) in enumerate(candidates):
            final = i == len(candidates) - 1
            if is_local:
                with lock:
                    up = state[label]["up"]
                if not up:
                    last_error = f"{label}: {state[label]['detail']}"
                    continue
                # "balaur" moves on rather than queue behind someone else's answer;
                # "balaur-local" asked for local and waits its turn.
                if not final and busy(next(e for e in LOCAL if e["name"] == label)):
                    last_error = f"{label}: busy"
                    continue
                payload = dict(body, model=model)
                headers = {}
            else:
                payload = for_remote(dict(body, model=model))
                headers = {"Authorization": f"Bearer {remote_key()}"}
            if self.forward(label, url, path, payload, headers, final, asked):
                return
            last_error = f"{label}: failed"
        self.reply(503, {"error": {"type": "unavailable", "message": f"no tier could answer ({last_error})"}})

    def forward(self, label, url, path, payload, headers, final, asked):
        """Sends the request on; True once an answer (any answer, when final) has been passed back."""
        _, host, _, base = split(url)
        target = base + path[len("/v1"):] if base.endswith("/v1") else base + path
        data = json.dumps(payload).encode()
        hdrs = {"Host": host, "Content-Type": "application/json",
                "Accept": self.headers.get("Accept", "application/json"), **headers}
        t0 = time.time()
        c = connect(url, CONNECT_TIMEOUT)
        try:
            c.connect()
            c.sock.settimeout(READ_TIMEOUT)
            c.request("POST", target, body=data, headers=hdrs)
            r = c.getresponse()
        except Exception as ex:
            c.close()
            log(f"{asked} -> {label}: {type(ex).__name__}: {ex}")
            if label in state:
                set_state(label, False, f"{type(ex).__name__}: {ex}")
            return False
        if r.status >= 500 and not final:
            log(f"{asked} -> {label}: HTTP {r.status}, trying the next tier")
            r.read()
            c.close()
            return False
        log(f"{asked} -> {label} ({payload.get('model')}): HTTP {r.status} after {time.time() - t0:.1f}s")
        try:
            self.send_response(r.status)
            for k, v in r.getheaders():
                if k.lower() not in HOP_BY_HOP:
                    self.send_header(k, v)
            self.send_header("X-Balaur-Tier", label)
            self.send_header("Transfer-Encoding", "chunked")
            self.end_headers()
            while True:
                chunk = r.read1(65536)
                if not chunk:
                    break
                self.wfile.write(b"%x\r\n%s\r\n" % (len(chunk), chunk))
                self.wfile.flush()
            self.wfile.write(b"0\r\n\r\n")
        except (BrokenPipeError, ConnectionResetError):
            pass  # the caller went away; dropping the upstream connection stops the answer
        finally:
            c.close()
        return True


def main():
    threading.Thread(target=prober, daemon=True).start()
    srv = ThreadingHTTPServer((CFG.get("listen", "127.0.0.1"), CFG["port"]), Handler)
    srv.daemon_threads = True
    log(f"balaur-ai on {CFG.get('listen', '127.0.0.1')}:{CFG['port']}: "
        f"local {[e['name'] for e in LOCAL]}, remote {REMOTE['url']} ({REMOTE['model']})")
    srv.serve_forever()


if __name__ == "__main__":
    main()
