// The life folder on disk: paths kept inside it, reads, and atomic writes.
// The rules about what a file may hold are the Go checker's (design §6); this
// module only keeps a path inside the folder and never half-writes a file.

import { createHash, randomBytes } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";

export const CONTENT_FOLDERS = ["journal", "pages", "people", "places", "metrics", "files"];

export class PathError extends Error {}
export class ConflictError extends Error {
  constructor(current) {
    super("the file changed since it was opened");
    this.current = current; // { text, sha } of the file as it is now
  }
}

export function sha256(text) {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

// The browser sends a text area's lines with CRLF; the folder holds LF.
export function toLF(text) {
  return text.replace(/\r\n?/g, "\n");
}

export class Folder {
  constructor(root) {
    this.root = path.resolve(root);
  }

  // rel checks a path given by a request and returns it relative to the
  // folder, slash separated. It must be inside a content folder, with no
  // part that is empty, ".", ".." or hidden (Syncthing's and Obsidian's own
  // files start with a point).
  rel(p) {
    if (typeof p !== "string" || p.length === 0 || p.length > 400 || p.includes("\0") || p.includes("\\")) {
      throw new PathError("not a path in the life folder");
    }
    const parts = p.split("/");
    if (parts.some((s) => s === "" || s === "." || s === ".." || s.startsWith("."))) {
      throw new PathError("not a path in the life folder");
    }
    if (parts.length < 2 || !CONTENT_FOLDERS.includes(parts[0])) {
      throw new PathError("not a path in a content folder");
    }
    return parts.join("/");
  }

  // abs resolves a checked path. A symbolic link in the way could point out
  // of the folder, so the real path of its folder must stay inside.
  async abs(rel) {
    const full = path.join(this.root, ...this.rel(rel).split("/"));
    let dir = path.dirname(full);
    let real;
    for (;;) {
      try {
        real = await fs.realpath(dir);
        break;
      } catch (err) {
        if (err.code !== "ENOENT" || dir === this.root) throw err;
        dir = path.dirname(dir); // a folder that a write will create
      }
    }
    const root = await fs.realpath(this.root);
    if (real !== root && !real.startsWith(root + path.sep)) {
      throw new PathError("the path leads out of the life folder");
    }
    const st = await fs.lstat(full).catch(() => null);
    if (st?.isSymbolicLink()) throw new PathError("a symbolic link is not followed");
    return full;
  }

  // read returns { text, sha } of a file, or null when it does not exist.
  async read(rel) {
    try {
      const data = await fs.readFile(await this.abs(rel));
      const text = toLF(data.toString("utf8"));
      return { text, sha: sha256(data.toString("utf8")) };
    } catch (err) {
      if (err.code === "ENOENT") return null;
      throw err;
    }
  }

  async readBytes(rel) {
    return fs.readFile(await this.abs(rel));
  }

  // save replaces a page with text, when the file is still the one the editor
  // opened: expectSha is the sha of that text, or "" for a page that did not
  // exist. Otherwise it throws ConflictError and changes nothing.
  async save(rel, text, expectSha) {
    const current = await this.read(rel);
    const currentSha = current ? current.sha : "";
    if (currentSha !== expectSha) throw new ConflictError(current);
    await this.write(rel, toLF(text));
  }

  // write replaces a file by a write and a rename, so Syncthing and the keeper
  // never see half of it. The temporary name is one Syncthing ignores.
  async write(rel, text) {
    const full = await this.abs(rel);
    const dir = path.dirname(full);
    await fs.mkdir(dir, { recursive: true, mode: 0o770 });
    let mode = 0o660;
    try {
      mode = (await fs.stat(full)).mode & 0o777;
    } catch (err) {
      if (err.code !== "ENOENT") throw err;
    }
    const tmp = path.join(dir, `.syncthing.${path.basename(full)}.${randomBytes(6).toString("hex")}.tmp`);
    const fh = await fs.open(tmp, "wx", mode);
    try {
      await fh.writeFile(text, "utf8");
      await fh.chmod(mode);
      await fh.sync();
    } catch (err) {
      await fh.close();
      await fs.rm(tmp, { force: true });
      throw err;
    }
    await fh.close();
    try {
      await fs.rename(tmp, full);
    } catch (err) {
      await fs.rm(tmp, { force: true });
      throw err;
    }
  }

  // append adds text at the end of a file, after a final newline.
  async append(rel, text) {
    const current = await this.read(rel);
    let old = current ? current.text : "";
    if (old !== "" && !old.endsWith("\n")) old += "\n";
    await this.write(rel, old + text);
  }

  // list returns the files under a folder, relative and slash separated,
  // without Syncthing's temporary files and conflict copies.
  async list(top) {
    const out = [];
    const walk = async (rel) => {
      let entries;
      try {
        entries = await fs.readdir(path.join(this.root, ...rel.split("/")), { withFileTypes: true });
      } catch (err) {
        if (err.code === "ENOENT") return;
        throw err;
      }
      for (const e of entries) {
        if (e.name.startsWith(".") || e.name.startsWith("~syncthing~") || e.name.includes(".sync-conflict-")) continue;
        const p = `${rel}/${e.name}`;
        if (e.isDirectory()) await walk(p);
        else if (e.isFile()) out.push(p);
      }
    };
    await walk(top);
    return out.sort();
  }

  async mtime(rel) {
    return (await fs.stat(await this.abs(rel))).mtimeMs;
  }
}
