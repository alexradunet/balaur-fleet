// A capture is a note or a reading sent from the phone, maybe long after it
// was written (the phone was offline). It carries its own day and instant,
// from the phone's clock, and an id. A capture is applied once: the ids that
// were applied are kept in the app's state folder, so a resend does nothing.

import { promises as fs } from "node:fs";
import path from "node:path";
import { Refused } from "./lifelog.js";

const ID = /^[A-Za-z0-9-]{8,64}$/;
const DAY = /^\d{4}-\d{2}-\d{2}$/;
const INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?([+-]\d{2}:\d{2}|Z)$/;

export class BadCapture extends Error {}

export class Captures {
  constructor({ stateDir, folder, lifelog, index }) {
    this.log = path.join(stateDir, "captures");
    this.folder = folder;
    this.lifelog = lifelog;
    this.index = index;
    this.applied = null;
    this.queue = Promise.resolve(); // one capture at a time
  }

  async load() {
    if (this.applied) return;
    try {
      const text = await fs.readFile(this.log, "utf8");
      this.applied = new Set(text.split("\n").filter(Boolean));
    } catch (err) {
      if (err.code !== "ENOENT") throw err;
      this.applied = new Set();
    }
  }

  // apply returns "applied" or "already"; it throws BadCapture for a capture
  // that cannot be read, and Refused for one that lifelog refuses.
  apply(c) {
    const run = this.queue.then(() => this.applyOne(c));
    this.queue = run.catch(() => {});
    return run;
  }

  async applyOne(c) {
    check(c);
    await this.load();
    if (this.applied.has(c.id)) return "already";
    if (c.type === "note") {
      await this.note(c);
    } else {
      await this.lifelog.add({ metric: c.metric, value: c.value, day: c.day, at: c.at });
    }
    this.index.invalidate();
    await fs.appendFile(this.log, c.id + "\n", { mode: 0o600 });
    this.applied.add(c.id);
    return "applied";
  }

  // note adds a line to the day page: "- HH:MM text", the time of the
  // phone's clock. A day page that does not exist yet is made by lifelog,
  // which refuses a day that is not real.
  async note(c) {
    const rel = `journal/${c.day}.md`;
    const time = c.at ? c.at.slice(11, 16) : "";
    const lines = c.text.replace(/\r\n?/g, "\n").trim().split("\n");
    const entry = `- ${time ? time + " " : ""}${lines[0]}\n` + lines.slice(1).map((l) => `  ${l}\n`).join("");
    if (!(await this.folder.read(rel))) {
      await this.lifelog.newPage("journal", c.day, entry);
      return;
    }
    await this.folder.append(rel, entry);
  }
}

function check(c) {
  if (typeof c !== "object" || c === null) throw new BadCapture("not a capture");
  if (typeof c.id !== "string" || !ID.test(c.id)) throw new BadCapture("a capture needs an id");
  if (typeof c.day !== "string" || !DAY.test(c.day)) throw new BadCapture("a capture needs its day, YYYY-MM-DD");
  if (c.at !== undefined && c.at !== "" && (typeof c.at !== "string" || !INSTANT.test(c.at))) {
    throw new BadCapture("the instant of a capture has its offset, such as 2026-11-15T08:30:00+02:00");
  }
  if (c.type === "note") {
    if (typeof c.text !== "string" || c.text.trim() === "") throw new BadCapture("a note needs its text");
    if (c.text.length > 100_000) throw new BadCapture("a note is at most 100 000 characters");
  } else if (c.type === "reading") {
    if (typeof c.metric !== "string" || c.metric === "") throw new BadCapture("a reading needs its metric");
    if (typeof c.value !== "string" || c.value.trim() === "") throw new BadCapture("a reading needs its value");
    c.value = c.value.trim().replace(",", "."); // a phone keyboard in Romanian types a comma
  } else {
    throw new BadCapture("a capture is a note or a reading");
  }
}

export { Refused };
