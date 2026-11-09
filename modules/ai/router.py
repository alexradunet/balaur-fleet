"""balaur-ai: the fleet's AI entryway, an OpenAI-compatible server with a page.

One address for every program on every machine, and three model names:

  balaur          as the page's route says; by default local first: the fleet's
                  own GPUs (Strata on zmeu) when one is up, loaded and not already
                  answering someone else, otherwise the remote API (Mistral).
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

The page (GET /) shows the tiers and the last requests, and changes the route,
the remote model and which GPUs are used. Those changes are kept in
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
REMOTE = CFG["remote"]  # {"url", "model", "keyCredential"}
CONNECT_TIMEOUT = CFG.get("connectTimeout", 3)
READ_TIMEOUT = CFG.get("readTimeout", 600)
PROBE_INTERVAL = CFG.get("probeInterval", 10)
# Host names the page may be opened under (an Origin with another host is refused).
ORIGINS = set(CFG.get("origins", [])) | {"localhost", "127.0.0.1"}
SETTINGS_FILE = os.path.join(os.environ.get("STATE_DIRECTORY", "."), "settings.json")

ROUTES = ("local-first", "remote", "local")
DEFAULTS = {"route": "local-first", "remoteModel": REMOTE["model"], "localEnabled": {e["name"]: True for e in LOCAL}}

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
USAGE = re.compile(rb'"usage"\s*:\s*\{[^{}]*\}')

state = {e["name"]: {"up": False, "since": 0.0, "detail": "not probed yet"} for e in LOCAL}
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
    if isinstance(saved.get("remoteModel"), str) and saved["remoteModel"].strip():
        s["remoteModel"] = saved["remoteModel"].strip()
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


def remote_models():
    """The remote API's chat models, for the page's picker."""
    data = get_json(REMOTE["url"], "/models", 10, {"Authorization": f"Bearer {remote_key()}"}, root=False)
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
    with lock:
        s = json.loads(json.dumps(settings))
    local = [(e["name"], e["url"], e["model"], True) for e in LOCAL if s["localEnabled"].get(e["name"], True)]
    remote = [("remote", REMOTE["url"], s["remoteModel"], False)]
    if model in (None, "", NAME):
        return {"local-first": local + remote, "remote": remote, "local": local}[s["route"]]
    if model == f"{NAME}-local":
        return local
    if model == f"{NAME}-remote":
        return remote
    return [("remote", REMOTE["url"], model, False)]


def record(asked, label, model, status, seconds, tail=b""):
    entry = {"at": time.time(), "asked": asked, "tier": label, "model": model, "status": status,
             "seconds": round(seconds, 1)}
    m = USAGE.findall(tail)
    if m:
        try:
            u = json.loads(m[-1].split(b":", 1)[1])
            entry["tokens"] = [u.get("prompt_tokens"), u.get("completion_tokens")]
        except ValueError:
            pass
    with lock:
        recent.appendleft(entry)


# ---- HTTP ----

class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    server_version = "balaur-ai"

    def log_message(self, fmt, *args):
        pass  # one line per request is written by forward()

    def send(self, status, data, ctype):
        self.send_response(status)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(data)

    def reply(self, status, obj):
        self.send(status, json.dumps(obj).encode(), "application/json")

    def foreign(self):
        """A browser request from another site's page (its Origin is not one of ours)."""
        origin = self.headers.get("Origin")
        if not origin or origin == "null":
            return origin == "null"
        host = urllib.parse.urlsplit(origin).hostname or ""
        if host in ORIGINS:
            return False
        self.reply(403, {"error": {"message": f"requests from web pages of {origin} are not accepted"}})
        return True

    def do_GET(self):
        path = urllib.parse.urlsplit(self.path).path.rstrip("/")
        if path in ("/v1/models", "/models"):
            names = [NAME, f"{NAME}-local", f"{NAME}-remote"]
            self.reply(200, {"object": "list", "data": [
                {"id": n, "object": "model", "owned_by": "balaur"} for n in names]})
        elif path in ("/health", "/status", "/api/state"):
            with lock:
                body = {"local": {k: dict(v) for k, v in state.items()},
                        "localUrls": {e["name"]: e["url"] for e in LOCAL},
                        "remote": {"url": REMOTE["url"], "key": bool(remote_key())},
                        "settings": settings, "defaults": DEFAULTS,
                        "customised": os.path.exists(SETTINGS_FILE),
                        "recent": list(recent) if path == "/api/state" else None}
            self.reply(200, body)
        elif path == "/api/remote-models":
            try:
                self.reply(200, {"models": remote_models()})
            except Exception as ex:
                self.reply(502, {"error": {"message": f"{type(ex).__name__}: {ex}"}})
        elif path == "":
            self.send(200, PAGE, "text/html; charset=utf-8")
        else:
            self.reply(404, {"error": {"message": f"no GET {path} here"}})

    def read_json(self):
        length = int(self.headers.get("Content-Length") or 0)
        raw = self.rfile.read(length) if length else b""
        body = json.loads(raw or b"{}")
        if not isinstance(body, dict):
            raise ValueError("not an object")
        return body

    def do_POST(self):
        if self.foreign():
            return
        try:
            body = self.read_json()
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
        candidates = tiers(asked)
        last_error = "no tier is enabled for it" if not candidates else None
        for i, (label, url, model, is_local) in enumerate(candidates):
            final = i == len(candidates) - 1
            if is_local:
                with lock:
                    up, detail = state[label]["up"], state[label]["detail"]
                if not up:
                    last_error = f"{label}: {detail}"
                    continue
                # Local first moves on rather than queue behind someone else's
                # answer; a request for local only waits its turn.
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
        if body.get("remoteModel") is not None:
            if not isinstance(body["remoteModel"], str) or not body["remoteModel"].strip():
                self.reply(400, {"error": {"message": "remoteModel is a model id"}})
                return
            new["remoteModel"] = body["remoteModel"].strip()
        for k, v in (body.get("localEnabled") or {}).items():
            if k in new["localEnabled"] and isinstance(v, bool):
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
                tail = (tail + chunk)[-4096:]
                self.wfile.write(b"%x\r\n%s\r\n" % (len(chunk), chunk))
                self.wfile.flush()
            self.wfile.write(b"0\r\n\r\n")
        except (BrokenPipeError, ConnectionResetError):
            pass  # the caller went away; dropping the upstream connection stops the answer
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
<p class="sub">One endpoint for the fleet: <code id="endpoint"></code>, models <code>balaur</code>, <code>balaur-local</code>, <code>balaur-remote</code>.</p>
<h2>Tiers</h2><div class="card" id="tiers"></div>
<h2>Settings</h2><div class="card">
 <div class="row"><div class="t"><b>Route for <code>balaur</code></b><span>What the default model uses. The other two names always mean what they say.</span></div></div>
 <div class="row"><div class="seg" id="route">
  <label><input type="radio" name="route" value="local-first"><span>Local first, then remote</span></label>
  <label><input type="radio" name="route" value="remote"><span>Remote only</span></label>
  <label><input type="radio" name="route" value="local"><span>Local only</span></label></div></div>
 <div class="row"><div class="t"><b>Remote model</b><span id="remoteinfo"></span></div>
  <select id="remoteModel"></select></div>
 <div id="locals"></div>
 <div class="row"><div class="t"><span id="custom"></span></div><button class="flat" id="reset">Reset to defaults</button></div>
</div><div id="msg"></div>
<h2>Last requests</h2><div class="card scroll"><table><thead><tr><th>When</th><th>Asked</th><th>Tier</th><th>Model</th><th>Status</th><th>Time</th><th>Tokens in/out</th></tr></thead><tbody id="recent"></tbody></table></div>
<p class="note">Changes are saved on this machine and apply at once. The defaults come from the fleet's configuration (modules/ai.nix).</p>
</main><script>
const $=s=>document.querySelector(s);let models=null,st=null;
document.getElementById('endpoint').textContent=location.origin+'/v1';
async function api(p,b){const r=await fetch(p,b?{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(b)}:{});
 const j=await r.json();if(!r.ok)throw new Error(j.error?.message||r.status);return j}
function ago(t){const s=Math.round(Date.now()/1000-t);return s<60?s+' s ago':s<3600?Math.round(s/60)+' min ago':new Date(t*1000).toLocaleTimeString()}
function el(tag,attrs,...kids){const e=document.createElement(tag);Object.assign(e,attrs||{});e.append(...kids);return e}
function render(){const s=st.settings,t=$('#tiers');t.replaceChildren();
 for(const [n,v] of Object.entries(st.local)){const on=s.localEnabled[n];
  t.append(el('div',{className:'row'},el('span',{className:'dot '+(!on?'off':v.up?'up':'down')}),
   el('div',{className:'t'},el('b',{},n+' (local GPU)'),el('span',{},(on?(v.up?'ready':v.detail):'turned off here')+' \\u00b7 '+st.localUrls[n]))))}
 t.append(el('div',{className:'row'},el('span',{className:'dot '+(st.remote.key?'up':'down')}),
  el('div',{className:'t'},el('b',{},'Remote: '+s.remoteModel),el('span',{},(st.remote.key?'key present':'no key')+' \\u00b7 '+st.remote.url))));
 document.querySelectorAll('#route input').forEach(i=>i.checked=i.value===s.route);
 const sel=$('#remoteModel');const list=[...new Set([s.remoteModel,...(models||[])])];
 if(sel.dataset.k!==list.join()){sel.replaceChildren(...list.map(m=>el('option',{value:m,textContent:m})));sel.dataset.k=list.join()}
 sel.value=s.remoteModel;$('#remoteinfo').textContent=models?'Default: '+st.defaults.remoteModel:'Loading the list\\u2026';
 const L=$('#locals');L.replaceChildren(...Object.keys(st.local).map(n=>{const c=el('input',{type:'checkbox',checked:s.localEnabled[n]});
  c.onchange=()=>save({localEnabled:{[n]:c.checked}});return el('div',{className:'row'},el('div',{className:'t'},el('b',{},'Use '+n),el('span',{},'Its GPU, for local and local-first requests')),c)}));
 $('#custom').textContent=st.customised?'Changed on this page.':'The fleet\\u2019s defaults.';
 $('#recent').replaceChildren(...st.recent.map(r=>el('tr',{},el('td',{},ago(r.at)),el('td',{},r.asked||''),el('td',{},r.tier),el('td',{},r.model||''),
  el('td',{},String(r.status)),el('td',{},r.seconds+' s'),el('td',{},r.tokens?r.tokens.join(' / '):''))))}
async function refresh(){try{st=await api('/api/state');render()}catch(e){$('#msg').textContent=e.message}}
async function save(b){try{await api('/api/settings',b);$('#msg').textContent='';await refresh()}catch(e){$('#msg').textContent=e.message}}
document.querySelectorAll('#route input').forEach(i=>i.onchange=()=>save({route:i.value}));
$('#remoteModel').onchange=e=>save({remoteModel:e.target.value});
$('#reset').onclick=async()=>{await api('/api/reset',{});refresh()};
refresh();setInterval(refresh,5000);
api('/api/remote-models').then(j=>{models=j.models;render()}).catch(e=>{$('#remoteinfo').textContent='Could not list models: '+e.message});
</script></body></html>"""


def main():
    threading.Thread(target=prober, daemon=True).start()
    srv = ThreadingHTTPServer((CFG.get("listen", "127.0.0.1"), CFG["port"]), Handler)
    srv.daemon_threads = True
    log(f"balaur-ai on {CFG.get('listen', '127.0.0.1')}:{CFG['port']}: "
        f"local {[e['name'] for e in LOCAL]}, remote {REMOTE['url']}; settings {json.dumps(settings)}")
    srv.serve_forever()


if __name__ == "__main__":
    main()
