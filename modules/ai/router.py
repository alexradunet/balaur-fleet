"""balaur-ai: the fleet's AI entryway, an OpenAI-compatible server with a page.

One address for every program on every machine, and these model names:

  balaur            as the page's route says; by default local first: the fleet's
                    own GPUs when one is up, loaded and not already answering
                    someone else, otherwise the remote API the page chose.
  balaur-local      only the fleet's GPUs (fails when none is up).
  balaur-remote     only that remote API, even when a local one is up.
  balaur-<remote>   one remote API by its name (balaur-mistral, balaur-claude),
                    with the model the page chose for it.
  <remote>/<model>  one remote API with a model of its own ("claude/claude-haiku-5-5").

Any other model name goes unchanged to the remote API whose models start that
way ("claude-sonnet-5-5" to Claude), else to the first one ("mistral-small-latest").

The remote APIs are OpenAI-compatible ones, each with its key and its dialect:
what is trimmed from a request on the way there. Claude is reached through the
Claude API's OpenAI compatibility layer (https://api.anthropic.com/v1): no prompt
caching there, and no thinking in the answers.

Each local endpoint is probed in the background (GET /health), so a machine that
is off, asleep, gaming or still loading its model is skipped at once instead of
timed out on. A request that fails on a local endpoint before its answer starts
is retried on the next tier, so a caller never sees the difference.

Requests bound for Mistral are trimmed to what it accepts: unknown fields
dropped, `developer` messages sent as `system`, `max_completion_tokens` renamed,
and tool-call ids (Mistral wants exactly nine letters or digits) rewritten
consistently, so a conversation begun on a local model can carry on remotely.
Requests bound for Claude lose what its current models answer with a 400:
`temperature` and `top_p`, a forced `tool_choice` (sent as "auto"), `n` other
than 1, and a `response_format` that is not a strict JSON schema.

The page (GET /) shows the tiers and the last requests, and changes the route,
the remote API and each one's model, and which GPUs are used. Those changes are kept in
$STATE_DIRECTORY/settings.json, over the defaults the config file gives; "Reset"
deletes it. No login: like the fleet's other services it is for the tailnet only.
A request from a web page of another site (its Origin) is refused, so a page
cannot change the settings or spend the remote API's credits through a browser.

Stdlib only. Usage: router.py CONFIG.json  (written by modules/ai.nix)
"""

import collections
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
# [{"name", "label", "url", "model", "keyCredential", "dialect", "prefixes"}]; the first is
# the default, and takes the model names no other one claims.
REMOTES = CFG["remotes"]
BY_NAME = {r["name"]: r for r in REMOTES}
CONNECT_TIMEOUT = CFG.get("connectTimeout", 3)
READ_TIMEOUT = CFG.get("readTimeout", 600)
PROBE_INTERVAL = CFG.get("probeInterval", 10)
# The biggest request body taken (the service has little memory), and how long a
# caller's connection may sit idle or stall before it is dropped. A long wait for
# an answer is not idle: nothing is read from or written to the caller meanwhile.
MAX_BODY = CFG.get("maxBody", 16 * 1024 * 1024)
CLIENT_TIMEOUT = CFG.get("clientTimeout", 300)
# Host names the page may be opened under (an Origin with another host is refused).
ORIGINS = set(CFG.get("origins", [])) | {"localhost", "127.0.0.1"}
SETTINGS_FILE = os.path.join(os.environ.get("STATE_DIRECTORY", "."), "settings.json")

ROUTES = ("local-first", "remote", "local")
DEFAULTS = {"route": "local-first", "remote": REMOTES[0]["name"],
            "remoteModels": {r["name"]: r["model"] for r in REMOTES},
            "localEnabled": {e["name"]: True for e in LOCAL}}

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
USAGE_KEY = re.compile(r'"usage"\s*:\s*')
TAIL = 16384  # the end of an answer, where its usage is

state = {e["name"]: {"up": False, "since": 0.0, "detail": "not probed yet"} for e in LOCAL}
inflight = {e["name"]: 0 for e in LOCAL}  # requests of ours being answered by each local endpoint
recent = collections.deque(maxlen=50)
lock = threading.Lock()


def log(*a):
    print(*a, file=sys.stderr, flush=True)


# ---- settings: the config's defaults, with the page's changes over them ----

def load_settings():
    s = json.loads(json.dumps(DEFAULTS))
    try:
        saved = json.load(open(SETTINGS_FILE))
    except (OSError, ValueError):
        return s
    if saved.get("route") in ROUTES:
        s["route"] = saved["route"]
    if saved.get("remote") in BY_NAME:
        s["remote"] = saved["remote"]
    # `remoteModel`: what the page saved when Mistral was the only remote API.
    models = dict(saved.get("remoteModels") or {})
    if "remoteModel" in saved:
        models.setdefault(REMOTES[0]["name"], saved["remoteModel"])
    for k, v in models.items():
        if k in BY_NAME and isinstance(v, str) and v.strip():
            s["remoteModels"][k] = v.strip()
    for k, v in (saved.get("localEnabled") or {}).items():
        if k in s["localEnabled"] and isinstance(v, bool):
            s["localEnabled"][k] = v
    return s


settings = load_settings()


def save_settings(new):
    global settings
    tmp = SETTINGS_FILE + ".tmp"
    with open(tmp, "w") as f:
        json.dump(new, f, indent=2)
    os.replace(tmp, SETTINGS_FILE)
    with lock:
        settings = load_settings()
    log(f"settings changed: {json.dumps(settings)}")


def reset_settings():
    global settings
    try:
        os.remove(SETTINGS_FILE)
    except FileNotFoundError:
        pass
    with lock:
        settings = load_settings()
    log("settings reset to the defaults")


# ---- upstreams ----

def split(url):
    u = urllib.parse.urlsplit(url)
    port = u.port or (443 if u.scheme == "https" else 80)
    return u.scheme, u.hostname, port, u.path.rstrip("/")


def connect(url, timeout):
    scheme, host, port, _ = split(url)
    cls = http.client.HTTPSConnection if scheme == "https" else http.client.HTTPConnection
    return cls(host, port, timeout=timeout)


def get_json(url, path, timeout, headers=None, root=True):
    """GET <server root or base><path> -> parsed JSON, or raises."""
    scheme, host, port, base = split(url)
    if root and base.endswith("/v1"):
        base = base[: -len("/v1")]
    c = connect(url, timeout)
    try:
        c.request("GET", base + path, headers={"Host": host, **(headers or {})})
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
    except OSError as ex:
        if str(ex) == "HTTP 503":  # llama-server while it loads the model
            set_state(e["name"], False, "loading its model")
        else:  # off, asleep, stopped for a game, ...
            set_state(e["name"], False, f"{type(ex).__name__}: {ex}")
    except Exception as ex:
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


def remote_key(r):
    path = os.path.join(os.environ.get("CREDENTIALS_DIRECTORY", ""), r["keyCredential"])
    try:
        return open(path).read().strip()
    except OSError:
        return ""


def remote_models(r):
    """A remote API's chat models, for the page's picker."""
    if r["dialect"] == "claude":
        # The Claude API's own listing: the compatibility layer has none.
        data = get_json(r["url"], "/models?limit=1000", 10,
                        {"x-api-key": remote_key(r), "anthropic-version": "2023-06-01"}, root=False)
        return sorted({m["id"] for m in data.get("data", [])}, reverse=True)
    data = get_json(r["url"], "/models", 10, {"Authorization": f"Bearer {remote_key(r)}"}, root=False)
    ids = set()
    for m in data.get("data", []):
        caps = m.get("capabilities") or {}
        if caps.get("completion_chat", True) and not m.get("deprecation"):
            ids.add(m["id"])
    return sorted(ids)


def mistral_id(i):
    if not isinstance(i, str) or MISTRAL_ID.match(i):
        return i
    n = int.from_bytes(hashlib.sha256(i.encode()).digest()[:8], "big")
    return "".join(ALPHABET[(n >> (6 * k)) % len(ALPHABET)] for k in range(9))


def for_claude(body):
    """What the Claude API's compatibility layer would answer with a 400 is left out; the
    fields it does not know it ignores by itself."""
    out = dict(body)
    out.pop("temperature", None)  # only the default is accepted by the current models
    out.pop("top_p", None)
    if out.get("n") not in (None, 1):
        out.pop("n")
    if out.get("tool_choice") == "required" or isinstance(out.get("tool_choice"), dict):
        out["tool_choice"] = "auto"  # the current models refuse a forced tool call
    rf = out.get("response_format")
    if rf is not None and not (isinstance(rf, dict) and rf.get("type") == "json_schema"
                               and (rf.get("json_schema") or {}).get("strict") is True):
        out.pop("response_format")
    msgs = []
    for m in body.get("messages") or []:
        m = dict(m)
        m.pop("reasoning_content", None)
        msgs.append(m)
    if msgs:
        out["messages"] = msgs
    return out


def for_remote(body, path, dialect):
    if not path.rstrip("/").endswith("/chat/completions"):
        return dict(body)  # embeddings and the like: the caller's fields as they are
    if dialect == "claude":
        return for_claude(body)
    if dialect != "mistral":
        return dict(body)
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
    """[(label, url, upstream model, remote API or None for a local endpoint)] to try in
    order, for the requested model name."""
    with lock:
        s = json.loads(json.dumps(settings))

    def at(r, m=None):
        return [(r["name"], r["url"], m or s["remoteModels"][r["name"]], r)]

    local = [(e["name"], e["url"], e["model"], None) for e in LOCAL if s["localEnabled"].get(e["name"], True)]
    remote = at(BY_NAME[s["remote"]])
    if model in (None, "", NAME):
        return {"local-first": local + remote, "remote": remote, "local": local}[s["route"]]
    if model == f"{NAME}-local":
        return local
    if model == f"{NAME}-remote":
        return remote
    for r in REMOTES:
        if model == f"{NAME}-{r['name']}":
            return at(r)
        if model.startswith(r["name"] + "/") and len(model) > len(r["name"]) + 1:
            return at(r, model[len(r["name"]) + 1:])
    for r in REMOTES:
        if any(model.startswith(p) for p in r.get("prefixes", [])):
            return at(r, model)
    return at(REMOTES[0], model)


def usage_tokens(tail):
    """[tokens in, tokens out] from the last `usage` object in the end of an answer (a plain
    JSON body, or the final event of a stream), or None. The object may hold others."""
    text = tail.decode("utf-8", "replace")
    decoder = json.JSONDecoder()
    for m in reversed(list(USAGE_KEY.finditer(text))):
        try:
            u, _ = decoder.raw_decode(text, m.end())
        except ValueError:
            continue  # cut off by the start of the tail, or `null`
        if isinstance(u, dict):
            tin = u.get("prompt_tokens", u.get("input_tokens"))
            tout = u.get("completion_tokens", u.get("output_tokens"))
            if tin is not None or tout is not None:
                return [tin, tout]
    return None


def release(label):
    with lock:
        inflight[label] -= 1


def record(asked, label, model, status, seconds, tail=b""):
    entry = {"at": time.time(), "asked": asked, "tier": label, "model": model, "status": status,
             "seconds": round(seconds, 1)}
    tokens = usage_tokens(tail)
    if tokens:
        entry["tokens"] = tokens
    with lock:
        recent.appendleft(entry)


# ---- HTTP ----

class TooLarge(Exception):
    pass


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    server_version = "balaur-ai"
    timeout = CLIENT_TIMEOUT  # each read from or write to the caller, not a whole request

    def log_message(self, fmt, *args):
        pass  # one line per request is written by forward()

    def send(self, status, data, ctype):
        self.send_response(status)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "no-store")
        if self.close_connection:
            self.send_header("Connection", "close")
        self.end_headers()
        self.wfile.write(data)

    def reply(self, status, obj):
        self.send(status, json.dumps(obj).encode(), "application/json")

    def foreign(self):
        """A browser request from another site's page (its Origin is not one of ours)."""
        origin = self.headers.get("Origin")
        if not origin:
            return False  # not a browser
        if origin != "null":
            try:
                host = urllib.parse.urlsplit(origin).hostname or ""
            except ValueError:
                host = ""
            if host in ORIGINS:
                return False
        # The body is not read, so the connection cannot be used again.
        self.close_connection = True
        self.reply(403, {"error": {"message": f"requests from web pages of {origin} are not accepted"}})
        return True

    def do_GET(self):
        path = urllib.parse.urlsplit(self.path).path.rstrip("/")
        if path in ("/v1/models", "/models"):
            names = [NAME, f"{NAME}-local", f"{NAME}-remote"] + [f"{NAME}-{r['name']}" for r in REMOTES]
            self.reply(200, {"object": "list", "data": [
                {"id": n, "object": "model", "owned_by": "balaur"} for n in names]})
        elif path in ("/health", "/status", "/api/state"):
            with lock:
                body = {"local": {k: dict(v) for k, v in state.items()},
                        "localUrls": {e["name"]: e["url"] for e in LOCAL},
                        "remotes": [{"name": r["name"], "label": r["label"], "url": r["url"],
                                     "key": bool(remote_key(r))} for r in REMOTES],
                        "settings": settings, "defaults": DEFAULTS,
                        "customised": os.path.exists(SETTINGS_FILE),
                        "recent": list(recent) if path == "/api/state" else None}
            self.reply(200, body)
        elif path == "/api/remote-models":
            query = urllib.parse.parse_qs(urllib.parse.urlsplit(self.path).query)
            r = BY_NAME.get((query.get("remote") or [REMOTES[0]["name"]])[0])
            if r is None:
                self.reply(404, {"error": {"message": f"the remote APIs are {', '.join(BY_NAME)}"}})
                return
            try:
                self.reply(200, {"models": remote_models(r)})
            except Exception as ex:
                self.reply(502, {"error": {"message": f"{type(ex).__name__}: {ex}"}})
        elif path == "":
            self.send(200, PAGE, "text/html; charset=utf-8")
        else:
            self.reply(404, {"error": {"message": f"no GET {path} here"}})

    def read_json(self):
        """The JSON object in the body; raises ValueError (400) or TooLarge (413)."""
        try:
            length = int(self.headers.get("Content-Length") or 0)
        except ValueError:
            length = -1
        if length < 0:
            self.close_connection = True
            raise ValueError("Content-Length is not a size")
        if length > MAX_BODY:
            self.close_connection = True
            raise TooLarge(f"the body is over {MAX_BODY} bytes")
        raw = self.rfile.read(length) if length else b""
        if len(raw) < length:
            self.close_connection = True
            raise ValueError("the body ended early")
        try:
            body = json.loads(raw or b"{}")
        except RecursionError:
            raise ValueError("nested too deeply") from None
        if not isinstance(body, dict):
            raise ValueError("not an object")
        return body

    def do_POST(self):
        if self.foreign():
            return
        try:
            body = self.read_json()
        except TooLarge as ex:
            self.reply(413, {"error": {"message": str(ex)}})
            return
        except ValueError as ex:
            self.reply(400, {"error": {"message": f"the body is not a JSON object: {ex}"}})
            return
        path = urllib.parse.urlsplit(self.path).path
        if path == "/api/settings":
            self.settings_post(body)
            return
        if path == "/api/reset":
            reset_settings()
            self.reply(200, {"ok": True})
            return
        if not path.startswith("/v1/"):
            path = "/v1" + path  # clients configured without the /v1
        asked = body.get("model")
        if not isinstance(asked, (str, type(None))):
            self.reply(400, {"error": {"message": "model is a name"}})
            return
        candidates = tiers(asked)
        last_error = "no tier is enabled for it" if not candidates else None
        for i, (label, url, model, remote) in enumerate(candidates):
            final = i == len(candidates) - 1
            is_local = remote is None
            if is_local:
                with lock:
                    up, detail = state[label]["up"], state[label]["detail"]
                    # Local first moves on rather than queue behind someone else's
                    # answer, ours included; a request for local only waits its turn.
                    # Taking a place and looking for one is one step, so two
                    # simultaneous requests cannot both find the endpoint free.
                    taken = inflight[label] > 0
                    if up and not (taken and not final):
                        inflight[label] += 1
                        claimed = True
                    else:
                        claimed = False
                if not claimed:
                    last_error = f"{label}: {detail}" if not up else f"{label}: busy"
                    continue
                if not final and busy(next(e for e in LOCAL if e["name"] == label)):
                    release(label)  # answering someone who did not come through here
                    last_error = f"{label}: busy"
                    continue
                payload = dict(body, model=model)
                headers = {}
            else:
                key = remote_key(remote)
                if not key:
                    last_error = f"{label}: it has no API key on this machine"
                    continue
                payload = for_remote(dict(body, model=model), path, remote["dialect"])
                headers = {"Authorization": f"Bearer {key}"}
            try:
                answered = self.forward(label, url, path, payload, headers, final, asked)
            finally:
                if is_local:
                    release(label)
            if answered:
                return
            last_error = f"{label}: failed"
        record(asked, "-", None, 503, 0)
        self.reply(503, {"error": {"type": "unavailable", "message": f"no tier could answer ({last_error})"}})

    def settings_post(self, body):
        with lock:
            new = json.loads(json.dumps(settings))
        if body.get("route") is not None:
            if body["route"] not in ROUTES:
                self.reply(400, {"error": {"message": f"route is one of {', '.join(ROUTES)}"}})
                return
            new["route"] = body["route"]
        if body.get("remote") is not None:
            if body["remote"] not in BY_NAME:
                self.reply(400, {"error": {"message": f"remote is one of {', '.join(BY_NAME)}"}})
                return
            new["remote"] = body["remote"]
        models = body.get("remoteModels")
        if models is not None:
            if not isinstance(models, dict) or not all(
                    k in BY_NAME and isinstance(v, str) and v.strip() for k, v in models.items()):
                self.reply(400, {"error": {"message": "remoteModels maps a remote API's name to a model id"}})
                return
            for k, v in models.items():
                new["remoteModels"][k] = v.strip()
        enabled = body.get("localEnabled")
        if enabled is not None:
            if not isinstance(enabled, dict) or not all(isinstance(v, bool) for v in enabled.values()):
                self.reply(400, {"error": {"message": "localEnabled maps a machine's name to true or false"}})
                return
            for k, v in enabled.items():
                if k in new["localEnabled"]:
                    new["localEnabled"][k] = v
        save_settings(new)
        self.reply(200, {"settings": settings})

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
        tail = b""
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
                tail = (tail + chunk)[-TAIL:]
                self.wfile.write(b"%x\r\n%s\r\n" % (len(chunk), chunk))
                self.wfile.flush()
            self.wfile.write(b"0\r\n\r\n")
        except (BrokenPipeError, ConnectionResetError, TimeoutError):
            # The caller went away or stopped reading; dropping the upstream
            # connection stops the answer.
            self.close_connection = True
        finally:
            c.close()
            record(asked, label, payload.get("model"), r.status, time.time() - t0, tail)
        return True


PAGE = b"""<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Balaur AI</title>
<style>
:root{--bg:#fafafb;--card:#fff;--fg:#1e1e22;--dim:#6b6b73;--line:#e3e3e7;--accent:#3584e4;--ok:#26a269;--bad:#c01c28;--warn:#c88800}
@media (prefers-color-scheme:dark){:root{--bg:#222226;--card:#2e2e33;--fg:#f2f2f4;--dim:#a2a2aa;--line:#3d3d44;--accent:#78aeed;--ok:#57e389;--bad:#ff7b84;--warn:#f8e45c}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.45 Cantarell,"Adwaita Sans",system-ui,sans-serif}
main{max-width:760px;margin:0 auto;padding:24px 16px 48px}h1{font-size:24px;margin:0 0 4px}h2{font-size:15px;margin:28px 0 8px;color:var(--dim);font-weight:600}
p.sub{margin:0;color:var(--dim)}.card{background:var(--card);border:1px solid var(--line);border-radius:12px}
.row{display:flex;align-items:center;gap:12px;padding:12px 14px;border-top:1px solid var(--line)}.row:first-child{border-top:0}
.row .t{flex:1;min-width:0}.row .t b{display:block;font-weight:600}.row .t span{color:var(--dim);font-size:13px;overflow-wrap:anywhere}
.dot{width:10px;height:10px;border-radius:50%;flex:none}.up{background:var(--ok)}.down{background:var(--bad)}.off{background:var(--dim)}
select,input{font:inherit;color:var(--fg);background:var(--bg);border:1px solid var(--line);border-radius:8px;padding:6px 8px;max-width:100%}
button{font:inherit;border:0;border-radius:8px;padding:7px 14px;background:var(--accent);color:#fff;cursor:pointer}button.flat{background:transparent;color:var(--accent)}
.seg{display:flex;gap:6px;flex-wrap:wrap}.seg label{border:1px solid var(--line);border-radius:8px;padding:6px 10px;cursor:pointer}.seg input{display:none}
.seg input:checked+span{color:var(--accent);font-weight:600}table{width:100%;border-collapse:collapse;font-size:13px}
td,th{text-align:left;padding:7px 10px;border-top:1px solid var(--line);white-space:nowrap}th{color:var(--dim);font-weight:600;border-top:0}
.scroll{overflow-x:auto}.note{color:var(--dim);font-size:13px;margin:8px 2px}code{font-size:13px}#msg{min-height:20px;color:var(--warn);margin-top:8px}
</style></head><body><main>
<h1>Balaur AI</h1>
<p class="sub">One endpoint for the fleet: <code id="endpoint"></code>, models <code>balaur</code>, <code>balaur-local</code>, <code>balaur-remote</code><span id="names"></span>.</p>
<h2>Tiers</h2><div class="card" id="tiers"></div>
<h2>Settings</h2><div class="card">
 <div class="row"><div class="t"><b>Route for <code>balaur</code></b><span>What the default model uses. The other two names always mean what they say.</span></div></div>
 <div class="row"><div class="seg" id="route">
  <label><input type="radio" name="route" value="local-first"><span>Local first, then remote</span></label>
  <label><input type="radio" name="route" value="remote"><span>Remote only</span></label>
  <label><input type="radio" name="route" value="local"><span>Local only</span></label></div></div>
 <div class="row"><div class="t"><b>Remote API</b><span>What <code>balaur</code> and <code>balaur-remote</code> use. Each one also has a name of its own.</span></div>
  <select id="remote"></select></div>
 <div id="remotes"></div>
 <div id="locals"></div>
 <div class="row"><div class="t"><span id="custom"></span></div><button class="flat" id="reset">Reset to defaults</button></div>
</div><div id="msg"></div>
<h2>Last requests</h2><div class="card scroll"><table><thead><tr><th>When</th><th>Asked</th><th>Tier</th><th>Model</th><th>Status</th><th>Time</th><th>Tokens in/out</th></tr></thead><tbody id="recent"></tbody></table></div>
<p class="note">Changes are saved on this machine and apply at once. The defaults come from the fleet's configuration (modules/ai.nix).</p>
</main><script>
const $=s=>document.querySelector(s);let models={},errs={},st=null;
document.getElementById('endpoint').textContent=location.origin+'/v1';
async function api(p,b){const r=await fetch(p,b?{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(b)}:{});
 const j=await r.json();if(!r.ok)throw new Error(j.error?.message||r.status);return j}
function ago(t){const s=Math.round(Date.now()/1000-t);return s<60?s+' s ago':s<3600?Math.round(s/60)+' min ago':new Date(t*1000).toLocaleTimeString()}
function el(tag,attrs,...kids){const e=document.createElement(tag);Object.assign(e,attrs||{});e.append(...kids);return e}
function render(){const s=st.settings,t=$('#tiers');t.replaceChildren();
 for(const [n,v] of Object.entries(st.local)){const on=s.localEnabled[n];
  t.append(el('div',{className:'row'},el('span',{className:'dot '+(!on?'off':v.up?'up':'down')}),
   el('div',{className:'t'},el('b',{},n+' (local GPU)'),el('span',{},(on?(v.up?'ready':v.detail):'turned off here')+' \\u00b7 '+st.localUrls[n]))))}
 for(const r of st.remotes)t.append(el('div',{className:'row'},el('span',{className:'dot '+(r.key?'up':'down')}),
  el('div',{className:'t'},el('b',{},r.label+': '+s.remoteModels[r.name]+(r.name===s.remote?' (the remote API of balaur)':'')),
   el('span',{},(r.key?'key present':'no key on this machine')+' \\u00b7 '+r.url))));
 $('#names').textContent=st.remotes.map(r=>', balaur-'+r.name).join('');
 const rs=$('#remote');if(!rs.options.length)rs.replaceChildren(...st.remotes.map(r=>el('option',{value:r.name,textContent:r.label})));rs.value=s.remote;
 document.querySelectorAll('#route input').forEach(i=>i.checked=i.value===s.route);
 const R=$('#remotes');if(!R.children.length)R.replaceChildren(...st.remotes.map(r=>{const sel=el('select',{});sel.dataset.r=r.name;
  sel.onchange=()=>save({remoteModels:{[r.name]:sel.value}});
  return el('div',{className:'row'},el('div',{className:'t'},el('b',{},r.label+' model'),el('span',{})),sel)}));
 for(const row of R.children){const sel=row.querySelector('select'),n=sel.dataset.r,cur=s.remoteModels[n];
  const list=[...new Set([cur,...(models[n]||[])])];
  if(sel.dataset.k!==list.join()){sel.replaceChildren(...list.map(m=>el('option',{value:m,textContent:m})));sel.dataset.k=list.join()}
  sel.value=cur;row.querySelector('.t span').textContent=errs[n]?'Could not list its models: '+errs[n]:
   models[n]?'balaur-'+n+' \\u00b7 default: '+st.defaults.remoteModels[n]:'Loading the list\\u2026'}
 const L=$('#locals');L.replaceChildren(...Object.keys(st.local).map(n=>{const c=el('input',{type:'checkbox',checked:s.localEnabled[n]});
  c.onchange=()=>save({localEnabled:{[n]:c.checked}});return el('div',{className:'row'},el('div',{className:'t'},el('b',{},'Use '+n),el('span',{},'Its GPU, for local and local-first requests')),c)}));
 $('#custom').textContent=st.customised?'Changed on this page.':'The fleet\\u2019s defaults.';
 $('#recent').replaceChildren(...st.recent.map(r=>el('tr',{},el('td',{},ago(r.at)),el('td',{},r.asked||''),el('td',{},r.tier),el('td',{},r.model||''),
  el('td',{},String(r.status)),el('td',{},r.seconds+' s'),el('td',{},r.tokens?r.tokens.join(' / '):''))))}
async function refresh(){try{st=await api('/api/state');render()}catch(e){$('#msg').textContent=e.message}}
async function save(b){try{await api('/api/settings',b);$('#msg').textContent='';await refresh()}catch(e){$('#msg').textContent=e.message}}
document.querySelectorAll('#route input').forEach(i=>i.onchange=()=>save({route:i.value}));
$('#remote').onchange=e=>save({remote:e.target.value});
$('#reset').onclick=async()=>{await api('/api/reset',{});refresh()};
refresh().then(()=>{for(const r of (st?st.remotes:[]))api('/api/remote-models?remote='+encodeURIComponent(r.name))
 .then(j=>{models[r.name]=j.models;render()}).catch(e=>{errs[r.name]=e.message;render()})});setInterval(refresh,5000);
</script></body></html>"""


class Server(ThreadingHTTPServer):
    daemon_threads = True

    def handle_error(self, request, client_address):
        # A client that drops a kept-alive connection (pi does at exit) is not an
        # error worth a traceback in the journal.
        if isinstance(sys.exc_info()[1], ConnectionError):
            return
        super().handle_error(request, client_address)


def main():
    threading.Thread(target=prober, daemon=True).start()
    srv = Server((CFG.get("listen", "127.0.0.1"), CFG["port"]), Handler)
    log(f"balaur-ai on {CFG.get('listen', '127.0.0.1')}:{CFG['port']}: "
        f"local {[e['name'] for e in LOCAL]}, remote {[r['name'] for r in REMOTES]}; settings {json.dumps(settings)}")
    srv.serve_forever()


if __name__ == "__main__":
    main()
