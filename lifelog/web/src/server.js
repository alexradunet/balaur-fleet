#!/usr/bin/env node
// lifelog-web: the life folder on the phone (docs/plans/003-the-web-app.md).
//
//   LIFELOG_FOLDER         the life folder (default /srv/life)
//   LIFELOG_BIN            the lifelog program (default: lifelog on PATH)
//   (systemd)              the socket it passes (LISTEN_FDS), for Caddy; or
//   LIFELOG_WEB_SOCKET     a Unix socket to listen on; or
//   LIFELOG_WEB_PORT       a port on 127.0.0.1 (development only)
//   LIFELOG_WEB_STATE      the app's state folder (the ids of applied captures)

import { createHash } from "node:crypto";
import { promises as fs, readdirSync, readFileSync } from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { BadCapture, Captures } from "./captures.js";
import { ConflictError, Folder, PathError } from "./folder.js";
import { Index, Lifelog, Refused } from "./lifelog.js";
import { render, splitFrontmatter } from "./markdown.js";
import { Readings, chart } from "./readings.js";
import { Search } from "./search.js";
import * as v from "./views.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const MAX_BODY = 8 << 20;
const DAY = /^\d{4}-\d{2}-\d{2}$/;

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

// The static files: every file of public/ (but its READMEs), and htmx from its
// package. Each is read once. One list makes the routes, the hash that names
// the service worker's cache, and the shell that the service worker keeps, so
// a new file cannot be left out of the cache (test: "every static file").
const TYPES = {
  ".css": "text/css",
  ".js": "text/javascript",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".woff2": "font/woff2",
  ".txt": "text/plain; charset=utf-8",
  ".webmanifest": "application/manifest+json",
};
const AT_ROOT = new Set(["manifest.webmanifest", "sw.js"]);
// A face is never changed in place: a changed file gets a new name (public/fonts/README.md).
const YEAR = "public, max-age=31536000, immutable";

export function staticFiles(pub = path.join(here, "..", "public")) {
  const list = [];
  const walk = (dir) => {
    for (const e of readdirSync(path.join(pub, dir), { withFileTypes: true })) {
      const rel = dir ? `${dir}/${e.name}` : e.name;
      if (e.isDirectory()) walk(rel);
      else if (!e.name.endsWith(".md")) list.push(rel);
    }
  };
  walk("");
  return list.sort().map((rel) => {
    const type = TYPES[path.extname(rel)];
    if (!type) throw new Error(`public/${rel}: no type for its extension`);
    return { rel, route: AT_ROOT.has(rel) ? `/${rel}` : `/static/${rel}`, type, file: path.join(pub, rel) };
  });
}

function loadStatic() {
  const out = new Map();
  const hash = createHash("sha256");
  for (const { route, type, file, rel } of staticFiles()) {
    const data = readFileSync(file);
    hash.update(data);
    out.set(route, { data, type, cache: rel.startsWith("fonts/") ? YEAR : "no-cache" });
  }
  const htmx = readFileSync(path.join(here, "..", "node_modules", "htmx.org", "dist", "htmx.min.js"));
  hash.update(htmx);
  out.set("/static/htmx.min.js", { data: htmx, type: "text/javascript", cache: "no-cache" });
  const version = hash.digest("hex").slice(0, 12);
  // The shell: the capture page and every static file but the worker itself and the licences.
  const shell = ["/capture", ...[...out.keys()].filter((r) => r !== "/sw.js" && !r.endsWith(".txt"))];
  const sw = out.get("/sw.js");
  sw.data = Buffer.from(sw.data.toString("utf8").replace("__VERSION__", version).replace('"__SHELL__"', JSON.stringify(shell)));
  return out;
}

export function createApp({ folder: root, bin = "lifelog", stateDir }) {
  const folder = new Folder(root);
  const lifelog = new Lifelog({ bin, folder: folder.root });
  const index = new Index(lifelog, folder.root);
  const readings = new Readings(folder);
  const search = new Search(folder);
  const captures = new Captures({ stateDir, folder, lifelog, index });
  const statics = loadStatic();

  async function images() {
    const map = new Map();
    for (const f of await folder.list("files")) {
      if (f.endsWith(".jpg")) map.set(path.posix.basename(f), f);
    }
    return map;
  }

  async function renderPage(rel, idx) {
    const r = await folder.read(rel);
    if (!r) return null;
    const page = idx.byPath.get(rel);
    const { body } = splitFrontmatter(r.text);
    return { r, page, rendered: render(body, { links: page?.links ?? {}, images: await images() }) };
  }

  async function problemsOf(rel) {
    try {
      return (await lifelog.problems()).filter((p) => p.path === rel);
    } catch {
      return [{ class: "warning", message: "the check did not run", fix: "look at the page again later" }];
    }
  }

  const routes = [
    ["GET", /^\/$/, async () => redirect(`/day/${v.today()}`)],

    [
      "GET",
      /^\/day\/(\d{4}-\d{2}-\d{2})$/,
      async (req, m) => {
        const day = m[1];
        const idx = await index.get();
        const rel = `journal/${day}.md`;
        const shown = await renderPage(rel, idx);
        const dated = idx.pages.filter((p) => p.kind !== "journal" && p.props.day?.[0] === day);
        const ofDay = [];
        for (const name of idx.metrics.keys()) {
          for (const r of await readings.of(name)) if (r.day === day) ofDay.push({ ...r, metric: name });
        }
        return page(
          v.dayView({
            day,
            today: v.today(),
            page: shown?.page,
            rendered: shown?.rendered,
            dated,
            readings: ofDay,
            metrics: idx.metrics,
            backlinks: idx.backlinks.get(rel),
          }),
        );
      },
    ],

    [
      "GET",
      /^\/p\/(.+)$/,
      async (req, m, url) => {
        const rel = folder.rel(m[1]);
        if (rel.startsWith("journal/")) return redirect(`/day/${rel.slice(8, 18)}`);
        const idx = await index.get();
        const shown = await renderPage(rel, idx);
        if (!shown || !shown.page) throw new HttpError(404, "There is no such page.");
        const saved = url.searchParams.has("saved");
        return page(
          v.pageView({
            page: shown.page,
            rendered: shown.rendered,
            backlinks: idx.backlinks.get(rel),
            problems: saved ? await problemsOf(rel) : [],
            saved,
          }),
        );
      },
    ],

    [
      "GET",
      /^\/edit\/(.+)$/,
      async (req, m) => {
        const rel = editable(folder.rel(m[1]));
        const r = await folder.read(rel);
        if (!r && !rel.startsWith("journal/")) throw new HttpError(404, "There is no such page.");
        return page(v.editView({ rel, title: titleOf(rel), text: r?.text ?? "", sha: r?.sha ?? "" }));
      },
    ],

    [
      "POST",
      /^\/edit\/(.+)$/,
      async (req, m) => {
        const rel = editable(folder.rel(m[1]));
        const form = await formOf(req);
        const text = form.get("text") ?? "";
        const sha = form.get("sha") ?? "";
        const exists = (await folder.read(rel)) !== null;
        if (!exists && !rel.startsWith("journal/")) throw new HttpError(404, "The page does not exist: create it with New page.");
        if (!exists && sha === "") {
          // The first text of a day: lifelog makes the page (and refuses a day that is not real).
          try {
            await lifelog.newPage("journal", rel.slice(8, 18), text.replace(/\r\n?/g, "\n"));
          } catch (err) {
            if (err instanceof Refused) throw new HttpError(422, err.message);
            throw err;
          }
        } else {
          try {
            await folder.save(rel, text, sha);
          } catch (err) {
            if (!(err instanceof ConflictError)) throw err;
            const current = err.current ?? { text: "", sha: "" };
            return page(v.editView({ rel, title: titleOf(rel), text, sha: current.sha, conflict: current }), 409);
          }
        }
        index.invalidate();
        if (rel.startsWith("journal/")) return redirect(`/day/${rel.slice(8, 18)}`);
        return redirect(`/p/${rel.split("/").map(encodeURIComponent).join("/")}?saved`);
      },
    ],

    [
      "GET",
      /^\/new$/,
      async (req, m, url) =>
        page(v.newView({ title: url.searchParams.get("title") ?? "", kind: url.searchParams.get("kind") ?? "pages" })),
    ],

    [
      "POST",
      /^\/new$/,
      async (req) => {
        const form = await formOf(req);
        const title = (form.get("title") ?? "").trim();
        const kind = form.get("kind") ?? "pages";
        const text = (form.get("text") ?? "").replace(/\r\n?/g, "\n");
        if (!["pages", "people", "places", "metrics"].includes(kind)) throw new HttpError(422, "That is not a kind of page.");
        try {
          const rel = await lifelog.newPage(kind, title, text);
          index.invalidate();
          return redirect(`/p/${rel.split("/").map(encodeURIComponent).join("/")}?saved`);
        } catch (err) {
          if (err instanceof Refused) return page(v.newView({ title, kind, text, refused: err.message }), 422);
          throw err;
        }
      },
    ],

    [
      "GET",
      /^\/browse$/,
      async () => {
        const idx = await index.get();
        const counts = {};
        for (const p of idx.pages) counts[p.kind] = (counts[p.kind] ?? 0) + 1;
        return page(v.browseView({ counts }));
      },
    ],

    [
      "GET",
      /^\/browse\/(journal|pages|people|places|metrics|files)$/,
      async (req, m) => {
        const idx = await index.get();
        return page(v.kindView({ kind: m[1], pages: idx.pages.filter((p) => p.kind === m[1]) }));
      },
    ],

    [
      "GET",
      /^\/search$/,
      async (req, m, url) => {
        const q = (url.searchParams.get("q") ?? "").slice(0, 200);
        const idx = await index.get();
        const hits = q.trim() ? await search.find(idx.pages, q) : [];
        return page(v.searchView({ q, hits, partial: req.headers["hx-request"] === "true" }));
      },
    ],

    [
      "GET",
      /^\/metrics$/,
      async () => {
        const idx = await index.get();
        const metrics = [...idx.metrics.values()];
        const last = new Map();
        for (const mt of metrics) {
          const rs = await readings.of(mt.name);
          if (rs.length > 0) last.set(mt.name, rs[rs.length - 1]);
        }
        return page(v.metricsView({ metrics, last }));
      },
    ],

    [
      "GET",
      /^\/metrics\/([^/]+)$/,
      async (req, m, url) => {
        const name = m[1];
        const idx = await index.get();
        const metric = idx.metrics.get(name);
        if (!metric) throw new HttpError(404, "There is no such metric.");
        const span = ["30", "365", "all"].includes(url.searchParams.get("span")) ? url.searchParams.get("span") : "365";
        let rs = await readings.of(name);
        if (span !== "all") {
          const from = new Date(Date.now() - Number(span) * 86_400_000).toISOString().slice(0, 10);
          rs = rs.filter((r) => r.day >= from);
        }
        return page(
          v.metricView({
            metric,
            page: idx.byPath.get(`metrics/${name}.md`),
            readings: rs,
            span,
            svg: chart(rs, { unit: metric.unit }),
            metrics: [...idx.metrics.values()],
          }),
        );
      },
    ],

    ["GET", /^\/capture$/, async () => page(v.captureView({ metrics: [...(await index.get()).metrics.values()] }))],

    [
      "POST",
      /^\/api\/capture$/,
      async (req) => {
        const isJSON = (req.headers["content-type"] ?? "").startsWith("application/json");
        let c;
        if (isJSON) {
          try {
            c = JSON.parse(await bodyOf(req));
          } catch {
            throw new HttpError(400, "the body is not JSON");
          }
        } else {
          // A form sent without the app's script: the tablet's clock gives the day.
          const form = await formOf(req);
          c = Object.fromEntries(form);
          c.id = createHash("sha256").update(JSON.stringify(c) + Date.now() + Math.random()).digest("hex").slice(0, 32);
          if (!c.day) c.day = v.today();
        }
        try {
          const result = await captures.apply(c);
          if (isJSON) return json({ ok: true, result });
          return redirect(c.type === "note" ? `/day/${c.day}` : `/metrics/${encodeURIComponent(c.metric)}`);
        } catch (err) {
          if (err instanceof BadCapture || err instanceof Refused) {
            if (isJSON) return json({ ok: false, message: err.message }, 422);
            throw new HttpError(422, err.message);
          }
          throw err;
        }
      },
    ],

    [
      "GET",
      /^\/raw\/(files\/\d{4}\/[^/]+\.jpg)$/,
      async (req, m) => {
        const rel = folder.rel(m[1]);
        try {
          return { status: 200, type: "image/jpeg", body: await folder.readBytes(rel), cache: "private, max-age=86400" };
        } catch (err) {
          if (err.code === "ENOENT") throw new HttpError(404, "There is no such file.");
          throw err;
        }
      },
    ],
  ];

  async function handle(req, res) {
    const started = Date.now();
    let route = "static";
    let status = 500;
    try {
      const url = new URL(req.url, "http://lifelog.invalid");
      const st = statics.get(url.pathname);
      let out;
      if (st && req.method === "GET") {
        out = { status: 200, type: st.type, body: st.data, cache: st.cache };
      } else {
        let pathname;
        try {
          pathname = decodeURIComponent(url.pathname);
        } catch {
          throw new HttpError(400, "The address is not valid.");
        }
        const found = match(req.method, pathname);
        route = found ? found.name : "none";
        if (!found) throw new HttpError(found === null ? 404 : 405, "There is no such page.");
        if (req.method === "POST") sameOrigin(req);
        const m = found.re.exec(pathname);
        out = await found.fn(req, m, url);
      }
      status = out.status;
      send(res, out);
    } catch (err) {
      status = err instanceof HttpError ? err.status : err instanceof PathError ? 404 : 500;
      if (status === 500) console.error(`error: ${route}: ${err.message}`);
      const message = status === 500 ? "Something failed on the tablet. Its log says what." : err.message;
      send(res, page(v.messageView({ title: status === 404 ? "Not found" : "Not done", message }), status));
    } finally {
      // The route's name, never its path: a path holds a page's title.
      console.log(`${req.method} ${route} ${status} ${Date.now() - started}ms`);
    }
  }

  function match(method, pathname) {
    let other = false;
    for (const [m, re, fn] of routes) {
      if (!re.test(pathname)) continue;
      if (m === method) return { re, fn, name: re.source.replace(/\\\//g, "/").replace(/[\^$]/g, "").replace(/\(.*$/, "…") };
      other = true;
    }
    return other ? false : null;
  }

  return { handle, close: () => index.close() };
}

function editable(rel) {
  if (!rel.endsWith(".md") || rel.startsWith("files/")) throw new HttpError(404, "Only pages are edited here.");
  if (rel.startsWith("journal/") && !/^journal\/\d{4}-\d{2}-\d{2}\.md$/.test(rel)) throw new HttpError(404, "There is no such day page.");
  if (rel.startsWith("journal/") && !DAY.test(rel.slice(8, 18))) throw new HttpError(404, "There is no such day page.");
  return rel;
}

function titleOf(rel) {
  return path.posix.basename(rel, ".md");
}

// sameOrigin refuses a write that another site's page sends.
function sameOrigin(req) {
  const site = req.headers["sec-fetch-site"];
  if (site && site !== "same-origin" && site !== "none") throw new HttpError(403, "A request from another site is refused.");
  const origin = req.headers.origin;
  if (origin && origin !== "null") {
    let host;
    try {
      host = new URL(origin).host;
    } catch {
      throw new HttpError(403, "A request from another site is refused.");
    }
    if (host !== req.headers.host) throw new HttpError(403, "A request from another site is refused.");
  }
}

async function bodyOf(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY) throw new HttpError(413, "The text is too long.");
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
}

async function formOf(req) {
  const type = req.headers["content-type"] ?? "";
  if (!type.startsWith("application/x-www-form-urlencoded")) throw new HttpError(415, "A form is sent as application/x-www-form-urlencoded.");
  return new URLSearchParams(await bodyOf(req));
}

function page(body, status = 200) {
  return { status, type: "text/html; charset=utf-8", body: String(body) };
}

function json(data, status = 200) {
  return { status, type: "application/json", body: JSON.stringify(data) };
}

function redirect(location) {
  return { status: 303, location };
}

function send(res, out) {
  const headers = {
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "same-origin",
    "Content-Security-Policy": "default-src 'self'; img-src 'self' data:; style-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
  };
  if (out.location) {
    res.writeHead(out.status, { ...headers, Location: out.location });
    return res.end();
  }
  headers["Content-Type"] = out.type;
  headers["Cache-Control"] = out.cache ?? "no-store";
  res.writeHead(out.status, headers);
  res.end(out.body);
}

async function main() {
  const folder = process.env.LIFELOG_FOLDER || "/srv/life";
  const stateDir = process.env.LIFELOG_WEB_STATE || process.env.STATE_DIRECTORY || ".";
  const app = createApp({ folder, bin: process.env.LIFELOG_BIN || "lifelog", stateDir });
  await fs.access(folder);
  const server = http.createServer(app.handle);
  server.requestTimeout = 60_000;
  const socket = process.env.LIFELOG_WEB_SOCKET;
  if (process.env.LISTEN_FDS === "1" && process.env.LISTEN_PID === String(process.pid)) {
    // systemd made the socket (socket activation): it is file descriptor 3.
    server.listen({ fd: 3 }, () => console.log("listening on the socket from systemd"));
  } else if (socket) {
    await fs.rm(socket, { force: true });
    server.listen(socket, () => console.log("listening on the socket"));
  } else {
    const port = Number(process.env.LIFELOG_WEB_PORT || 7795);
    server.listen(port, "127.0.0.1", () => console.log(`listening on http://127.0.0.1:${port}`));
  }
  const stop = () => {
    server.close(() => {
      app.close();
      process.exit(0);
    });
    setTimeout(() => process.exit(0), 10_000).unref();
  };
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === (await fs.realpath(process.argv[1]).catch(() => process.argv[1]))) {
  main().catch((err) => {
    console.error(err.message);
    process.exit(1);
  });
}
