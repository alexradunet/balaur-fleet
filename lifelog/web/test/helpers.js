// Test helpers: a synthetic life folder, and the real lifelog program.

import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

export function tempFolder(files = {}) {
  const root = mkdtempSync(path.join(tmpdir(), "lifelog-web-"));
  const life = path.join(root, "life");
  const state = path.join(root, "state");
  mkdirSync(life);
  mkdirSync(state);
  for (const [rel, text] of Object.entries(files)) {
    const p = path.join(life, ...rel.split("/"));
    mkdirSync(path.dirname(p), { recursive: true });
    writeFileSync(p, text);
  }
  return { root, life, state };
}

// The tests that write run the real Go program: its rules are the ones the
// app relies on. The build of the package gives it; by hand:
//   (cd .. && go build -o /tmp/lifelog .) && LIFELOG_BIN=/tmp/lifelog npm test
export const bin = process.env.LIFELOG_BIN || "lifelog";

export const weight = "---\nunit: kg\nmin: 20\nmax: 300\n---\nMorning weight.\n";
