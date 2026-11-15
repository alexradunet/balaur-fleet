// The app end to end: its HTTP server on a Unix socket, as Caddy reaches it,
// on a synthetic folder, with the real lifelog program.

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import http from "node:http";
import path from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";

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
    "pages/Long walk.md": "---\nday: 2026-11-14\n---\nTo the hills.\n",
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
  // A tile: the metric, its value and its unit.
  assert.match(r.body, /<a class="name" href="\/metrics\/weight">weight<\/a>\s*<span class="reading">81\.4<\/span><span class="unit">kg<\/span>/);
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

test("each screen has one loud button at most, and the shell", async () => {
  // The Almanac look: ember is the one loud button of a screen (plan 004).
  for (const url of ["/day/2026-11-15", "/week/2026-W46", "/month/2026-11", "/year/2026", "/p/pages/Iron.md", "/browse", "/browse/journal", "/search?q=iron", "/metrics", "/metrics/weight", "/capture", "/new", "/edit/pages/Iron.md"]) {
    const r = await get(url);
    assert.equal(r.status, 200, url);
    assert.ok((r.body.match(/class="(button )?primary"/g) ?? []).length <= 1, `${url} has more than one loud button`);
    assert.match(r.body, /<header class="rail">[\s\S]*<nav aria-label="Sections">/, url);
    assert.doesNotMatch(r.body, /style=|<style/, `${url} has an inline style, which the CSP refuses`);
  }
  assert.match((await get("/metrics")).body, /<a href="\/metrics" aria-current="page">/);
});

test("a save is a toast that Close shuts, with no script", async () => {
  const r = await get("/p/pages/Iron.md?saved");
  assert.match(r.body, /<dialog open closedby="closerequest" class="toast" aria-label="Result"><h2>Saved\.<\/h2>/);
  assert.match(r.body, /<form method="dialog"><button class="small close">Close<\/button><\/form>/);
  assert.doesNotMatch((await get("/p/pages/Iron.md")).body, /class="toast"/);
});

test("a week lists its days: the first line, the dated pages, the readings", async () => {
  const r = await get("/week/2026-W46");
  assert.equal(r.status, 200);
  assert.match(r.body, /<a class="day-link" href="\/day\/2026-11-15">[\s\S]*?<p class="first">08:00 Walked\.<\/p>/);
  assert.match(r.body, /href="\/day\/2026-11-14">[\s\S]*?<p class="dated"><a href="\/p\/pages\/Long%20walk\.md">Long walk<\/a><\/p>/);
  assert.match(r.body, /href="\/day\/2026-11-10">[\s\S]*?<a href="\/metrics\/weight">weight <span class="value">81\.4 kg<\/span><\/a>/);
  assert.equal((r.body.match(/<li class="week-day/g) ?? []).length, 7);
  assert.match(r.body, /rel="prev" href="\/week\/2026-W45"/);
  assert.equal((await get("/week/2025-W53")).status, 404); // 2025 has 52 weeks
});

test("a month is its calendar, and the year its twelve months", async () => {
  const m = await get("/month/2026-11");
  assert.equal(m.status, 200);
  assert.match(m.body, /<td class="written"[^>]*><a href="\/day\/2026-11-15"[^>]*><span class="n">15<\/span><span class="first">08:00 Walked\.<\/span>/);
  assert.match(m.body, /<td><a href="\/day\/2026-11-14"[^>]*><span class="n">14<\/span><span class="meta">1 page<\/span>/);
  assert.match(m.body, /<th scope="row"><a href="\/week\/2026-W44"/); // the row of the 1st, a Sunday
  // The count in the head is the number of tinted days (other tests write days too).
  const written = (m.body.match(/<td class="written"/g) ?? []).length;
  assert.ok(written >= 1);
  assert.match(m.body, new RegExp(`>${written} days? written<`));
  assert.equal((await get("/month/2026-13")).status, 404);
  const y = await get("/year/2026");
  assert.equal(y.status, 200);
  assert.equal((y.body.match(/<section class="month-box"/g) ?? []).length, 12);
  assert.match(y.body, /<a href="\/day\/2026-11-15" class="written"/);
  assert.match((await get("/calendar")).headers.location, /^\/month\/\d{4}-\d{2}$/);
  assert.match((await get("/day/2026-11-15")).body, /<a class="leaf" href="\/month\/2026-11"[\s\S]*<a href="\/week\/2026-W46">Week 46<\/a>/);
});

test("every static file is served, in the cache's hash and in the shell", async () => {
  // Walked here on its own, not by the server's list: a file the server forgets fails.
  const pub = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "public");
  const walk = (dir) =>
    readdirSync(path.join(pub, dir), { withFileTypes: true }).flatMap((e) =>
      e.isDirectory() ? walk(path.join(dir, e.name)) : e.name.endsWith(".md") ? [] : [path.join(dir, e.name).split(path.sep).join("/")],
    );
  const files = walk("").sort();
  for (const want of ["base.css", "app.css", "fonts/jersey-15-400-latin.woff2", "fonts/OFL-jersey-15.txt", "pictures/wood.png", "icon-192.png"]) {
    assert.ok(files.includes(want), want);
  }
  const route = (rel) => (rel === "sw.js" || rel === "manifest.webmanifest" ? `/${rel}` : `/static/${rel}`);
  const hash = createHash("sha256");
  for (const rel of files) {
    const data = readFileSync(path.join(pub, rel));
    hash.update(data);
    if (rel === "sw.js") continue;
    const r = await get(route(rel));
    assert.equal(r.status, 200, rel);
    assert.equal(r.body, data.toString(), rel);
  }
  hash.update(readFileSync(path.join(pub, "..", "node_modules", "htmx.org", "dist", "htmx.min.js")));
  const sw = (await get("/sw.js")).body;
  assert.match(sw, new RegExp(`const VERSION = "${hash.digest("hex").slice(0, 12)}"`));
  const shell = JSON.parse(/const SHELL = (\[.*\]);/.exec(sw)[1]);
  const want = ["/capture", "/static/htmx.min.js", ...files.filter((f) => f !== "sw.js" && !f.endsWith(".txt")).map(route)];
  assert.deepEqual([...shell].sort(), want.sort());
});

test("a face has a cache of a year; the sheets are checked each time", async () => {
  assert.match((await get("/static/fonts/atkinson-hyperlegible-400-latin.woff2")).headers["cache-control"], /max-age=31536000/);
  assert.equal((await get("/static/base.css")).headers["cache-control"], "no-cache");
  assert.match((await get("/static/base.css")).headers["content-security-policy"], /style-src 'self';/);
});

test("the applied ids are kept in the state folder only", () => {
  assert.equal(statSync(path.join(t.state, "captures")).mode & 0o077, 0);
});
