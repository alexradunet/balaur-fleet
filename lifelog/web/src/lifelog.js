// The Go program `lifelog`: the home of the rules, the title key and the link
// grammar. The app asks it, and never repeats what it decides.

import { execFile } from "node:child_process";
import { watch } from "node:fs";

export class Refused extends Error {} // lifelog refused, and changed nothing (exit 1)

export class Lifelog {
  constructor({ bin, folder }) {
    this.bin = bin;
    this.folder = folder;
  }

  run(args, input) {
    return new Promise((resolve, reject) => {
      const child = execFile(
        this.bin,
        args,
        { timeout: 60_000, maxBuffer: 256 << 20, env: { ...process.env, LIFELOG_FOLDER: this.folder } },
        (err, stdout, stderr) => {
          if (!err) return resolve({ code: 0, stdout, stderr });
          if (err.code === 1) return resolve({ code: 1, stdout, stderr });
          reject(new Error(`lifelog ${args[0]} did not finish: ${stderr.trim() || err.message}`));
        },
      );
      child.stdin.end(input ?? "");
    });
  }

  async index() {
    const r = await this.run(["index", "-folder", this.folder]);
    return JSON.parse(r.stdout);
  }

  // newPage creates KIND/TITLE.md and returns its path.
  async newPage(kind, title, text) {
    const r = await this.run(["new", "-folder", this.folder, "--", kind, title], text);
    if (r.code === 1) throw new Refused(r.stderr.replace(/^lifelog new: /, "").trim());
    return r.stdout.trim();
  }

  // add appends a reading to the CSV of the machine "web".
  async add({ metric, value, day, at }) {
    const args = ["add", "-folder", this.folder, "-machine", "web"];
    if (day) args.push("-day", day);
    if (at) args.push("-at", at);
    args.push("--", metric, value);
    const r = await this.run(args);
    if (r.code === 1) throw new Refused(r.stderr.replace(/^lifelog add: /, "").trim());
  }

  async problems() {
    const r = await this.run(["check", "-json", this.folder]);
    return JSON.parse(r.stdout);
  }
}

// Index keeps the last answer of `lifelog index` until a file in the folder
// changes. It derives what the pages need: backlinks, and pages by title.
export class Index {
  constructor(lifelog, folder) {
    this.lifelog = lifelog;
    this.stale = true;
    this.pending = null;
    this.data = null;
    try {
      this.watcher = watch(folder, { recursive: true, persistent: false }, () => {
        this.stale = true;
      });
      this.watcher.on("error", () => {
        this.stale = true;
      });
    } catch {
      this.watcher = null; // then each request reads the index again
    }
  }

  invalidate() {
    this.stale = true;
  }

  async get() {
    if (!this.stale && this.data && this.watcher) return this.data;
    if (!this.pending) {
      this.stale = false;
      this.pending = this.lifelog
        .index()
        .then((idx) => (this.data = derive(idx)))
        .catch((err) => {
          this.stale = true;
          throw err;
        })
        .finally(() => (this.pending = null));
    }
    return this.pending;
  }

  close() {
    this.watcher?.close();
  }
}

function derive(idx) {
  const byPath = new Map();
  const backlinks = new Map();
  for (const p of idx.pages) {
    byPath.set(p.path, p);
  }
  for (const p of idx.pages) {
    for (const target of new Set(Object.values(p.links))) {
      if (!target || target === p.path) continue;
      if (!backlinks.has(target)) backlinks.set(target, []);
      backlinks.get(target).push(p);
    }
  }
  for (const list of backlinks.values()) list.sort((a, b) => a.title.localeCompare(b.title));
  const metrics = new Map(idx.metrics.map((m) => [m.name, m]));
  return { pages: idx.pages, metrics, byPath, backlinks };
}
