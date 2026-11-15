// The app end to end: its HTTP server on a Unix socket, as Caddy reaches it,
// on a synthetic folder, with the real lifelog program.

import assert from "node:assert/strict";
import { existsSync, readFileSync, statSync } from "node:fs";
import http from "node:http";
import path from "node:path";
import { after, before, test } from "node:test";

import { sha256 } from "../src/folder.js";
import { createApp } from "../src/server.js";
import { bin, tempFolder, weight } from "./helpers.js";

let t, app, server, socket;

before(async () => {
  t = tempFolder({
    "metrics/weight.md": weight,
    "metrics/weight/2026.laptop.csv": "day,taken_at,value,source\n2026-11-10,,81.4,manual\n",
    "pages/Iron.md": "---\naliases:\n  - Fe\n---\nIron is [[Ferritin|stored]]. #health\n",
    "pages/Ferritin.md": "Holds [[fe]] and [[Nowhere]].\n",
    "journal/2026-11-15.md": "- 08:00 Walked.\n",
  });
  app = createApp({ folder: t.life, bin, stateDir: t.state });
  server = http.createServer(app.handle);
  socket = path.join(t.root, "http.sock");
  await new Promise((resolve) => server.listen(socket, resolve));
});

after(() => {
  server.close();
  app.close();
});

function request(method, url, { body, type, headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { socketPath: socket, method, path: url, headers: { Host: "life.test", ...(type ? { "Content-Type": type } : {}), ...headers } },
      (res) => {
        let data = "";
        res.setEncoding("utf8");
        res.on("data", (c) => (data += c));
        res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body: data }));
      },
    );
    req.on("error", reject);
    req.end(body);
  });
}

const get = (url) => request("GET", url);
const form = (url, fields, headers) =>
  request("POST", url, { body: new URLSearchParams(fields).toString(), type: "application/x-www-form-urlencoded", headers });
const capture = (c, headers) => request("POST", "/api/capture", { body: JSON.stringify(c), type: "application/json", headers });
const file = (rel) => readFileSync(path.join(t.life, rel), "utf8");

test("a page shows its links, its aliases and its backlinks", async () => {
  const r = await get("/p/pages/Iron.md");
  assert.equal(r.status, 200);
  assert.match(r.body, /<a href="\/p\/pages\/Ferritin\.md" class="wikilink">stored<\/a>/);
  assert.match(r.body, /<dt>also<\/dt><dd>Fe<\/dd>/);
  assert.match(r.body, /Linked from[\s\S]*href="\/p\/pages\/Ferritin\.md"/); // [[fe]] is Iron's alias
  const f = await get("/p/pages/Ferritin.md");
  assert.match(f.body, /href="\/p\/pages\/Iron\.md" class="wikilink">fe</);
  assert.match(f.body, /class="wikilink missing">Nowhere</);
});

test("the day view shows the day page and the day's readings", async () => {
  const r = await get("/day/2026-11-10");
  assert.equal(r.status, 200);
  assert.match(r.body, /weight<\/a> 81\.4 kg/);
  assert.match((await get("/day/2026-11-15")).body, /08:00 Walked\./);
  assert.equal((await get("/")).status, 303);
});

test("a note is added to its day once, though it is sent twice", async () => {
  const c = { id: "note-0001", type: "note", day: "2026-11-15", at: "2026-11-15T09:30:00+02:00", text: "Coffee.\r\nThen tea." };
  assert.deepEqual(JSON.parse((await capture(c)).body), { ok: true, result: "applied" });
  assert.deepEqual(JSON.parse((await capture(c)).body), { ok: true, result: "already" });
  assert.equal(file("journal/2026-11-15.md"), "- 08:00 Walked.\n- 09:30 Coffee.\n  Then tea.\n");
  // A day with no page yet: lifelog makes it.
  await capture({ id: "note-0002", type: "note", day: "2026-11-16", at: "2026-11-16T07:00:00+02:00", text: "New day." });
  assert.equal(file("journal/2026-11-16.md"), "- 07:00 New day.\n");
});

test("a reading goes to the CSV of the machine web; lifelog refuses one out of range", async () => {
  const ok = await capture({ id: "reading-01", type: "reading", day: "2026-11-15", at: "2026-11-15T09:31:00+02:00", metric: "weight", value: "80,9" });
  assert.equal(ok.status, 200);
  assert.equal(file("metrics/weight/2026.web.csv"), "day,taken_at,value,source\n2026-11-15,2026-11-15T09:31:00+02:00,80.9,manual\n");
  const refused = await capture({ id: "reading-02", type: "reading", day: "2026-11-15", metric: "weight", value: "900" });
  assert.equal(refused.status, 422);
  assert.match(JSON.parse(refused.body).message, /outside the range/);
  const bad = await capture({ id: "reading-03", type: "note", day: "2026-02-30", text: "x" });
  assert.equal(bad.status, 422);
  assert.equal(existsSync(path.join(t.life, "journal/2026-02-30.md")), false);
  assert.equal((await capture({ type: "note", day: "2026-11-15", text: "x" })).status, 422); // no id
});

test("a save writes LF, and refuses a file that changed since it was opened", async () => {
  const opened = file("pages/Ferritin.md");
  const edit = await get("/edit/pages/Ferritin.md");
  assert.match(edit.body, new RegExp(`name="sha" value="${sha256(opened)}"`));
  const saved = await form("/edit/pages/Ferritin.md", { text: "Holds [[Iron]].\r\nMore.", sha: sha256(opened) });
  assert.equal(saved.status, 303);
  assert.equal(file("pages/Ferritin.md"), "Holds [[Iron]].\nMore.");
  const after = await get(saved.headers.location);
  assert.match(after.body, /Saved\./);
  const stale = await form("/edit/pages/Ferritin.md", { text: "Mine", sha: sha256(opened) });
  assert.equal(stale.status, 409);
  assert.match(stale.body, /changed since you opened it/);
  assert.equal(file("pages/Ferritin.md"), "Holds [[Iron]].\nMore.");
  // The save shows what the checker finds in the page.
  const broken = await form("/edit/pages/Ferritin.md", { text: "---\nkey: [a\n---\n", sha: sha256(file("pages/Ferritin.md")) });
  assert.match((await get(broken.headers.location)).body, /The checker found[\s\S]*error/);
});

test("the editor does not create a page; New page does, through lifelog", async () => {
  assert.equal((await form("/edit/pages/Ghost.md", { text: "x", sha: "" })).status, 404);
  assert.equal(existsSync(path.join(t.life, "pages/Ghost.md")), false);
  const made = await form("/new", { title: "Ana Maria", kind: "people", text: "Friend.\r\n" });
  assert.equal(made.status, 303);
  assert.equal(made.headers.location, "/p/people/Ana%20Maria.md?saved");
  assert.equal(file("people/Ana Maria.md"), "Friend.\n");
  const taken = await form("/new", { title: "IRON", kind: "places", text: "" });
  assert.equal(taken.status, 422);
  assert.match(taken.body, /held by pages\/Iron\.md/);
  // A day page's first text: lifelog makes it.
  assert.equal((await form("/edit/journal/2026-11-20.md", { text: "First.", sha: "" })).status, 303);
  assert.equal(file("journal/2026-11-20.md"), "First.");
});

test("search finds words in titles and texts", async () => {
  const r = await get("/search?q=iron");
  assert.match(r.body, /href="\/p\/pages\/Iron\.md">Iron</);
  const partial = await request("GET", "/search?q=%23health", { headers: { "HX-Request": "true" } });
  assert.doesNotMatch(partial.body, /<html/);
  assert.match(partial.body, /Iron/);
});

test("the metric page draws a chart", async () => {
  const r = await get("/metrics/weight?span=all");
  assert.equal(r.status, 200);
  assert.match(r.body, /<svg class="chart"/);
  assert.equal((await get("/metrics/nothing")).status, 404);
});

test("a write from another site is refused", async () => {
  const c = { id: "cross-0001", type: "note", day: "2026-11-15", text: "evil" };
  assert.equal((await capture(c, { "Sec-Fetch-Site": "cross-site" })).status, 403);
  assert.equal((await capture(c, { Origin: "https://evil.example" })).status, 403);
  assert.doesNotMatch(file("journal/2026-11-15.md"), /evil/);
  assert.equal((await capture({ ...c, id: "same-00001", text: "mine" }, { Origin: "http://life.test" })).status, 200);
});

test("a path out of the folder is not served", async () => {
  for (const url of ["/p/..%2F..%2Fetc%2Fpasswd", "/p/pages/..%2F..%2Fx.md", "/edit/_check.md", "/raw/files/2026/..%2F..%2Fx.jpg", "/p/.stfolder/x"]) {
    assert.equal((await get(url)).status, 404, url);
  }
});

test("the service worker carries the version of the static files", async () => {
  const r = await get("/sw.js");
  assert.match(r.body, /const VERSION = "[0-9a-f]{12}"/);
  assert.equal((await get("/static/htmx.min.js")).status, 200);
});

test("the applied ids are kept in the state folder only", () => {
  assert.equal(statSync(path.join(t.state, "captures")).mode & 0o077, 0);
});
