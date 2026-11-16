"""Tests of router.py (the flake check `python`, modules/flake/packages.nix).

    python3 -I modules/ai/test_router.py

Stdlib only, like the router. The router reads its config when it is imported, so
this writes one first: a local endpoint and two remote APIs, all three of them
servers made here, on loopback.
"""

import http.client
import json
import os
import socket
import sys
import tempfile
import threading
import time
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

HERE = os.path.dirname(os.path.abspath(__file__))
TMP = tempfile.mkdtemp()


class Upstream(BaseHTTPRequestHandler):
    """An OpenAI-compatible API that answers with what it was sent."""
    protocol_version = "HTTP/1.1"
    seen = []

    def log_message(self, fmt, *args):
        pass

    def do_GET(self):  # /health, /status
        data = b"{}"
        self.send_response(200)
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_POST(self):
        body = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
        Upstream.seen.append((self.headers.get("Authorization"), body))
        data = json.dumps({"echo": body, "usage": {"prompt_tokens": 3, "completion_tokens": 5}}).encode()
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)


def serve(handler):
    srv = ThreadingHTTPServer(("127.0.0.1", 0), handler)
    srv.daemon_threads = True
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    return srv.server_address[1]


# A local endpoint that takes the request and never answers: a model still computing.
silent = socket.socket()
silent.bind(("127.0.0.1", 0))
silent.listen(8)
silent_conns = []


def hold():
    while True:
        silent_conns.append(silent.accept()[0])


threading.Thread(target=hold, daemon=True).start()

upstream = serve(Upstream)
os.environ["CREDENTIALS_DIRECTORY"] = TMP
os.environ["STATE_DIRECTORY"] = TMP
for name in ("key-mistral", "key-claude"):
    with open(os.path.join(TMP, name), "w") as f:
        f.write(f"secret-{name}\n")
config = os.path.join(TMP, "config.json")
with open(config, "w") as f:
    json.dump({
        "name": "balaur", "listen": "127.0.0.1", "port": 0, "readTimeout": 30,
        "local": [{"name": "gpu", "url": f"http://127.0.0.1:{silent.getsockname()[1]}/v1", "model": "local"}],
        "remotes": [
            {"name": "mistral", "label": "Mistral", "url": f"http://127.0.0.1:{upstream}/v1",
             "model": "mistral-medium-latest", "dialect": "mistral", "prefixes": [],
             "keyCredential": "key-mistral"},
            {"name": "claude", "label": "Claude", "url": f"http://127.0.0.1:{upstream}/v1",
             "model": "claude-opus-5-5", "dialect": "claude", "prefixes": ["claude-"],
             "keyCredential": "key-claude"},
        ],
        "origins": ["ai.example"],
    }, f)
sys.argv = [sys.argv[0], config]
sys.path.insert(0, HERE)
import router  # noqa: E402

PORT = serve(router.Handler)


def post(path, body, headers=None, raw=None):
    c = http.client.HTTPConnection("127.0.0.1", PORT, timeout=10)
    data = raw if raw is not None else json.dumps(body).encode()
    c.request("POST", path, body=data, headers={"Content-Type": "application/json", **(headers or {})})
    r = c.getresponse()
    out = r.status, json.loads(r.read() or b"null"), dict(r.getheaders())
    c.close()
    return out


class Shapes(unittest.TestCase):
    def test_mistral_id(self):
        self.assertEqual(router.mistral_id("abcDEF123"), "abcDEF123")
        made = router.mistral_id("call_0123456789abcdef")
        self.assertRegex(made, r"^[A-Za-z0-9]{9}$")
        self.assertEqual(made, router.mistral_id("call_0123456789abcdef"))
        self.assertNotEqual(made, router.mistral_id("call_other"))
        self.assertIsNone(router.mistral_id(None))

    def test_for_mistral(self):
        out = router.for_remote({
            "model": "m", "max_completion_tokens": 7, "store": True, "reasoning_effort": "high",
            "messages": [
                {"role": "developer", "content": "be brief"},
                {"role": "assistant", "reasoning_content": "hm", "tool_calls": [{"id": "call_long_id", "type": "function"}]},
                {"role": "tool", "tool_call_id": "call_long_id", "content": "4"},
            ],
            "tools": [{"type": "function", "function": {"name": "f", "strict": True}}],
        }, "/v1/chat/completions", "mistral")
        self.assertEqual(out["max_tokens"], 7)
        self.assertNotIn("store", out)
        self.assertNotIn("reasoning_effort", out)
        self.assertNotIn("max_completion_tokens", out)
        self.assertEqual(out["messages"][0]["role"], "system")
        self.assertNotIn("reasoning_content", out["messages"][1])
        call = out["messages"][1]["tool_calls"][0]["id"]
        self.assertRegex(call, r"^[A-Za-z0-9]{9}$")
        self.assertEqual(out["messages"][2]["tool_call_id"], call)
        self.assertEqual(out["tools"][0]["function"], {"name": "f"})

    def test_for_claude(self):
        out = router.for_remote({
            "model": "m", "temperature": 0.2, "top_p": 0.9, "n": 2, "tool_choice": "required",
            "response_format": {"type": "json_object"}, "store": True,
            "messages": [{"role": "assistant", "content": "x", "reasoning_content": "hm"}],
        }, "/v1/chat/completions", "claude")
        for gone in ("temperature", "top_p", "n", "response_format"):
            self.assertNotIn(gone, out)
        self.assertEqual(out["tool_choice"], "auto")
        self.assertTrue(out["store"])  # what it does not know, it ignores by itself
        self.assertEqual(out["messages"], [{"role": "assistant", "content": "x"}])
        strict = {"type": "json_schema", "json_schema": {"strict": True}}
        self.assertEqual(router.for_claude({"response_format": strict})["response_format"], strict)

    def test_other_paths_and_dialects_pass(self):
        body = {"model": "m", "input": "x", "anything": 1}
        self.assertEqual(router.for_remote(body, "/v1/embeddings", "mistral"), body)
        self.assertEqual(router.for_remote(body, "/v1/chat/completions", "openai"), body)

    def test_usage_tokens(self):
        self.assertEqual(router.usage_tokens(b'{"usage": {"prompt_tokens": 3, "completion_tokens": 5}}'), [3, 5])
        stream = b'data: {"usage": null}\n\ndata: {"usage":{"input_tokens":1,"output_tokens":2,"d":{}}}\n\ndata: [DONE]\n'
        self.assertEqual(router.usage_tokens(stream), [1, 2])
        self.assertIsNone(router.usage_tokens(b'kens": 3}} no usage here'))

    def test_split(self):
        self.assertEqual(router.split("https://api.mistral.ai/v1"), ("https", "api.mistral.ai", 443, "/v1"))
        self.assertEqual(router.split("http://server:8090/v1/"), ("http", "server", 8090, "/v1"))


class Tiers(unittest.TestCase):
    def labels(self, model):
        return [(label, m) for label, _, m, _ in router.tiers(model)]

    def test_names(self):
        local, mistral = ("gpu", "local"), ("mistral", "mistral-medium-latest")
        self.assertEqual(self.labels("balaur"), [local, mistral])
        self.assertEqual(self.labels(None), [local, mistral])
        self.assertEqual(self.labels("balaur-local"), [local])
        self.assertEqual(self.labels("balaur-remote"), [mistral])
        self.assertEqual(self.labels("balaur-claude"), [("claude", "claude-opus-5-5")])
        self.assertEqual(self.labels("claude/claude-haiku-5-5"), [("claude", "claude-haiku-5-5")])
        self.assertEqual(self.labels("claude-sonnet-5-5"), [("claude", "claude-sonnet-5-5")])
        self.assertEqual(self.labels("mistral-small-latest"), [("mistral", "mistral-small-latest")])


class Served(unittest.TestCase):
    def setUp(self):
        post("/api/reset", {})
        Upstream.seen.clear()

    def test_remote_answers_with_its_key(self):
        status, body, headers = post("/v1/chat/completions", {
            "model": "balaur-mistral", "messages": [{"role": "user", "content": "hi"}], "store": True})
        self.assertEqual(status, 200)
        self.assertEqual(headers["X-Balaur-Tier"], "mistral")
        self.assertEqual(body["echo"]["model"], "mistral-medium-latest")
        self.assertNotIn("store", body["echo"])
        self.assertEqual(Upstream.seen[0][0], "Bearer secret-key-mistral")

    def test_without_the_v1(self):
        status, body, _ = post("/chat/completions", {"model": "balaur-claude", "messages": []})
        self.assertEqual((status, body["echo"]["model"]), (200, "claude-opus-5-5"))

    def test_local_first_falls_back_when_the_gpu_is_down(self):
        router.set_state("gpu", False, "off")
        status, _, headers = post("/v1/chat/completions", {"model": "balaur", "messages": []})
        self.assertEqual((status, headers["X-Balaur-Tier"]), (200, "mistral"))
        status, body, _ = post("/v1/chat/completions", {"model": "balaur-local", "messages": []})
        self.assertEqual(status, 503)
        self.assertIn("gpu", body["error"]["message"])

    def test_not_json_and_not_a_request(self):
        self.assertEqual(post("/v1/chat/completions", None, raw=b"{nope")[0], 400)
        self.assertEqual(post("/v1/chat/completions", [1])[0], 400)
        self.assertEqual(post("/v1/chat/completions", {"model": 3})[0], 400)
        # JSON, and an object, but not a chat request: answered, not dropped.
        for bad in ({"messages": ["hi"]}, {"messages": [{"role": "assistant", "tool_calls": [1]}]},
                    {"messages": 5}):
            status, body, _ = post("/v1/chat/completions", dict(bad, model="balaur-mistral"))
            self.assertEqual(status, 400, bad)
            self.assertIn("message", body["error"])
        self.assertEqual(Upstream.seen, [])

    def test_chunked_body_is_refused(self):
        c = http.client.HTTPConnection("127.0.0.1", PORT, timeout=10)
        c.request("POST", "/v1/chat/completions", body=iter([b'{"model":"balaur-mistral"}']),
                  headers={"Content-Type": "application/json"}, encode_chunked=True)
        r = c.getresponse()
        self.assertEqual(r.status, 411)
        r.read()
        c.close()
        self.assertEqual(Upstream.seen, [])

    def test_another_sites_page_is_refused(self):
        body = {"route": "remote"}
        self.assertEqual(post("/api/settings", body, {"Origin": "https://evil.example"})[0], 403)
        self.assertEqual(post("/api/settings", body, {"Origin": "null"})[0], 403)
        self.assertEqual(router.settings["route"], "local-first")
        self.assertEqual(post("/api/settings", body, {"Origin": "https://ai.example"})[0], 200)
        self.assertEqual(router.settings["route"], "remote")

    def test_settings(self):
        for bad in ({"route": "sideways"}, {"remote": "nobody"}, {"remote": []}, {"remote": {}},
                    {"remoteModels": {"nobody": "x"}}, {"remoteModels": {"claude": ""}},
                    {"localEnabled": {"gpu": "yes"}}):
            self.assertEqual(post("/api/settings", bad)[0], 400, bad)
        self.assertFalse(os.path.exists(router.SETTINGS_FILE))
        status, body, _ = post("/api/settings", {"remote": "claude", "remoteModels": {"claude": " claude-haiku-5-5 "},
                                                 "localEnabled": {"gpu": False}})
        self.assertEqual(status, 200)
        self.assertEqual([(lb, m) for lb, _, m, _ in router.tiers("balaur")], [("claude", "claude-haiku-5-5")])
        self.assertEqual(router.load_settings(), router.settings)  # what the file says
        post("/api/reset", {})
        self.assertEqual(router.settings, router.DEFAULTS)

    def test_caller_that_hangs_up_frees_the_gpu(self):
        router.set_state("gpu", True, "ready")
        s = socket.create_connection(("127.0.0.1", PORT))
        data = json.dumps({"model": "balaur-local", "messages": []}).encode()
        s.sendall(b"POST /v1/chat/completions HTTP/1.1\r\nHost: x\r\nContent-Type: application/json\r\n"
                  b"Content-Length: %d\r\n\r\n%s" % (len(data), data))
        deadline = time.time() + 5
        while router.inflight["gpu"] == 0 and time.time() < deadline:
            time.sleep(0.02)
        self.assertEqual(router.inflight["gpu"], 1, "the request did not reach the local endpoint")
        s.close()
        while router.inflight["gpu"] and time.time() < deadline:
            time.sleep(0.02)
        self.assertEqual(router.inflight["gpu"], 0, "the endpoint stayed taken after the caller left")
        self.assertEqual(router.recent[0]["status"], 499)


if __name__ == "__main__":
    unittest.main(argv=sys.argv[:1], verbosity=1)
