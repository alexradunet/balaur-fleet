import assert from "node:assert/strict";
import { test } from "node:test";

import { firstLine, render, splitFrontmatter } from "../src/markdown.js";

test("a wikilink goes where the index resolved it", () => {
  const links = { Iron: "pages/Iron.md", Nowhere: "", "2026-11-15": "journal/2026-11-15.md" };
  const html = render("[[Iron]], [[Iron|the metal]], [[Iron#Uses]], [[Nowhere]], [[2026-11-15]]", { links });
  assert.match(html, /<a href="\/p\/pages\/Iron\.md" class="wikilink">Iron<\/a>/);
  assert.match(html, /<a href="\/p\/pages\/Iron\.md" class="wikilink">the metal<\/a>/);
  assert.match(html, /<a href="\/p\/pages\/Iron\.md" class="wikilink">Iron#Uses<\/a>/);
  assert.match(html, /<a href="\/new\?title=Nowhere" class="wikilink missing">Nowhere<\/a>/);
  assert.match(html, /<a href="\/day\/2026-11-15" class="wikilink">2026-11-15<\/a>/);
});

test("a title with spaces is encoded in the address", () => {
  const html = render("[[Ana Maria]]", { links: { "Ana Maria": "people/Ana Maria.md" } });
  assert.match(html, /href="\/p\/people\/Ana%20Maria\.md"/);
});

test("an embedded picture is shown from files/", () => {
  const html = render("![[scan.jpg]]", { images: new Map([["scan.jpg", "files/2026/scan.jpg"]]) });
  assert.match(html, /<img src="\/raw\/files\/2026\/scan\.jpg" alt="scan\.jpg" loading="lazy">/);
});

test("the text of a page never becomes markup", () => {
  const html = render('<script>x</script> [[a"><b>|<i>]] [x](javascript:alert(1))', { links: { 'a"><b>': "" } });
  assert.doesNotMatch(html, /<script>|<b>|<i>|href="javascript:/);
});

test("a #tag links to a search for it, and a heading does not", () => {
  const html = render("Ran today #health, and (#run).\n\n# Heading", {});
  assert.match(html, /<a href="\/search\?q=%23health" class="tag">#health<\/a>/);
  assert.match(html, /<a href="\/search\?q=%23run" class="tag">#run<\/a>/);
  assert.match(html, /<h1>Heading<\/h1>/);
});

test("splitFrontmatter removes the properties block only", () => {
  assert.deepEqual(splitFrontmatter("---\nunit: kg\n---\nBody\n"), { front: "unit: kg\n", body: "Body\n" });
  assert.equal(splitFrontmatter("---\n---\n").body, "");
  assert.equal(splitFrontmatter("No block\n---\n").body, "No block\n---\n");
  assert.equal(splitFrontmatter("---\nunclosed\n").body, "---\nunclosed\n");
});

test("the first line of a day is plain words", () => {
  assert.equal(firstLine("\n\n- 08:00 Walked to the river with [[Ana Pop|Ana]].\n- later"), "08:00 Walked to the river with Ana.");
  assert.equal(firstLine("## Morning\n"), "Morning");
  assert.equal(firstLine("- [x] **Read** about [[Iron#Uses]] and [a link](https://x.test)"), "Read about Iron and a link");
  assert.equal(firstLine("<script>x</script>"), "<script>x</script>"); // text: the view escapes it
  assert.equal(firstLine("a".repeat(200)).length, 120);
  assert.equal(firstLine("\n  \n"), "");
});
