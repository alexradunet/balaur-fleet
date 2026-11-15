import assert from "node:assert/strict";
import { chmodSync, readdirSync, readFileSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";

import { ConflictError, Folder, PathError, sha256 } from "../src/folder.js";
import { tempFolder } from "./helpers.js";

test("a path must stay inside a content folder", () => {
  const { life } = tempFolder({ "pages/A.md": "a\n" });
  const f = new Folder(life);
  for (const bad of ["../x.md", "pages/../../x.md", "/etc/passwd", "pages/.hidden.md", "pages//A.md", "x.md", "_check.md", ".stfolder/x", "pages/a\\b.md", "pages/a\0.md", "pages"]) {
    assert.throws(() => f.rel(bad), PathError, bad);
  }
  assert.equal(f.rel("pages/A.md"), "pages/A.md");
  assert.equal(f.rel("people/Ana Maria.md"), "people/Ana Maria.md");
});

test("a symbolic link out of the folder is refused", async () => {
  const { life, state } = tempFolder({ "pages/A.md": "a\n" });
  writeFileSync(path.join(state, "secret.md"), "outside\n");
  symlinkSync(state, path.join(life, "places"));
  const f = new Folder(life);
  await assert.rejects(f.read("places/secret.md"), PathError);
  await assert.rejects(f.write("places/new.md", "x"), PathError);
  symlinkSync(path.join(state, "secret.md"), path.join(life, "pages", "B.md"));
  await assert.rejects(f.read("pages/B.md"), PathError);
});

test("save writes LF, keeps the mode, and leaves no temporary file", async () => {
  const { life } = tempFolder({ "pages/A.md": "old\n" });
  chmodSync(path.join(life, "pages/A.md"), 0o640);
  const f = new Folder(life);
  await f.save("pages/A.md", "one\r\ntwo\r\n", sha256("old\n"));
  assert.equal(readFileSync(path.join(life, "pages/A.md"), "utf8"), "one\ntwo\n");
  assert.equal(statSync(path.join(life, "pages/A.md")).mode & 0o777, 0o640);
  assert.deepEqual(readdirSync(path.join(life, "pages")), ["A.md"]);
});

test("save refuses a file that changed since it was opened, and changes nothing", async () => {
  const { life } = tempFolder({ "pages/A.md": "theirs\n" });
  const f = new Folder(life);
  await assert.rejects(f.save("pages/A.md", "mine\n", sha256("what I opened\n")), (err) => {
    assert.ok(err instanceof ConflictError);
    assert.equal(err.current.text, "theirs\n");
    return true;
  });
  assert.equal(readFileSync(path.join(life, "pages/A.md"), "utf8"), "theirs\n");
  // A page that appeared while the editor thought it new.
  await assert.rejects(f.save("pages/A.md", "mine\n", ""), ConflictError);
});

test("a new file gets mode 0660, for the group lifelog", async () => {
  const { life } = tempFolder();
  const old = process.umask(0o007);
  try {
    await new Folder(life).write("pages/New.md", "x\n");
  } finally {
    process.umask(old);
  }
  assert.equal(statSync(path.join(life, "pages/New.md")).mode & 0o777, 0o660);
});

test("append adds a final newline first", async () => {
  const { life } = tempFolder({ "journal/2026-11-15.md": "- 08:00 Walked." });
  await new Folder(life).append("journal/2026-11-15.md", "- 09:00 Ran.\n");
  assert.equal(readFileSync(path.join(life, "journal/2026-11-15.md"), "utf8"), "- 08:00 Walked.\n- 09:00 Ran.\n");
});

test("list leaves out Syncthing's files and conflict copies", async () => {
  const { life } = tempFolder({
    "pages/A.md": "",
    "pages/.syncthing.A.md.tmp": "",
    "pages/~syncthing~B.md.tmp": "",
    "pages/A.sync-conflict-20261115-101010-ABCDEFG.md": "",
    "pages/sub/C.md": "",
  });
  assert.deepEqual(await new Folder(life).list("pages"), ["pages/A.md", "pages/sub/C.md"]);
});
