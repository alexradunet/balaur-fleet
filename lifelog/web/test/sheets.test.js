// The sheets of the Almanac look (docs/plans/004-the-almanac-look.md), ported
// from aminte's view/sheets_test.go: the contrast of the tokens in both themes,
// the four layers, logical properties, and the base sheet that knows no class
// of the app.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const pub = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "public");
const comments = /\/\*[\s\S]*?\*\//g;
const read = (name) => readFileSync(path.join(pub, name), "utf8");
const baseCSS = read("base.css");
const appCSS = read("app.css");
const rules = (css) => css.replace(comments, "");

// The custom properties of the :root block of the tokens, name (without --)
// to the light value and to the dark value. light-dark(a, b) gives a to light
// and b to dark; any other value goes to both.
function tokenBlock(css) {
  const m = /\n:root\{([\s\S]*?)\n\}/.exec(css);
  assert.ok(m, "base.css has no :root block");
  const light = {};
  const dark = {};
  const pair = /^light-dark\(\s*([^,()]+?)\s*,\s*([^,()]+?)\s*\)$/;
  for (const [, name, raw] of m[1].matchAll(/--([a-z0-9-]+):([^;]+);/g)) {
    const v = raw.trim();
    const p = pair.exec(v);
    if (p) {
      assert.notEqual(p[1], p[2], `--${name} is light-dark(${p[1]}, ${p[2]}): write it once as the colour`);
      light[name] = p[1];
      dark[name] = p[2];
    } else {
      light[name] = dark[name] = v;
    }
  }
  return { light, dark };
}

// resolve follows var(--x) to a colour #rrggbb.
function resolve(tokens, name) {
  let v = tokens[name];
  for (let i = 0; i < 8 && v?.startsWith("var(--"); i++) v = tokens[v.slice(6, -1)];
  assert.match(v ?? "", /^#[0-9a-f]{6}$/, `--${name} is ${v}, not a colour #rrggbb`);
  return v;
}

// contrast is the WCAG 2 contrast ratio of two colours #rrggbb.
function contrast(a, b) {
  const lum = (c) => {
    const l = [0, 1, 2].map((i) => {
      const s = parseInt(c.slice(1 + 2 * i, 3 + 2 * i), 16) / 255;
      return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
    });
    return 0.2126 * l[0] + 0.7152 * l[1] + 0.0722 * l[2];
  };
  const x = lum(a);
  const y = lum(b);
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
}

test("the tokens hold their contrast in both themes", () => {
  const { light, dark } = tokenBlock(rules(baseCSS));
  const pairs = [];
  const text = (fg, ...grounds) => grounds.forEach((bg) => pairs.push([fg, bg, 4.5]));
  const mark = (fg, ...grounds) => grounds.forEach((bg) => pairs.push([fg, bg, 3]));
  // The pairs of aminte's README and its test, as the sheets use them.
  text("ink", "surface", "surface-deep", "accent-soft", "mark", "danger-soft");
  text("muted", "surface", "surface-deep");
  text("page-ink", "desk");
  text("page-strong", "desk");
  text("page-muted", "desk");
  text("rail-ink", "rail", "rail-deep");
  text("rail-accent", "rail", "rail-deep");
  text("accent", "desk");
  text("accent-ink", "surface", "surface-deep");
  text("link", "surface", "surface-deep");
  text("link-page", "desk");
  text("on-accent", "accent", "primary", "primary-hover");
  text("warn", "surface");
  text("warn-ink", "surface");
  text("done", "surface");
  text("danger", "surface");
  text("danger-ink", "danger-soft");
  text("toast-ink", "toast-bg");
  text("toast-link", "toast-bg");
  mark("edge", "surface");
  mark("outline", "surface", "surface-deep");
  mark("danger-line", "surface");
  mark("focus", "desk", "rail", "surface");
  const low = [];
  for (const [theme, tokens] of [
    ["light", light],
    ["dark", dark],
  ]) {
    for (const [fg, bg, min] of pairs) {
      const a = resolve(tokens, fg);
      const b = resolve(tokens, bg);
      const r = contrast(a, b);
      if (r < min) low.push(`${theme}: --${fg} ${a} on --${bg} ${b} is ${r.toFixed(2)}:1, want ${min}:1 or more`);
    }
  }
  assert.deepEqual(low, []);
});

test("the contrast check fails a pair that is too faint", () => {
  // The check itself: grey on white is 4.48:1, black on white 21:1.
  assert.ok(contrast("#777777", "#ffffff") < 4.5);
  assert.equal(Math.round(contrast("#000000", "#ffffff")), 21);
});

test("no colour is written outside the token block", () => {
  for (const [name, css] of [
    ["base.css", rules(baseCSS).replace(/\n:root\{[\s\S]*?\n\}/, "")],
    ["app.css", rules(appCSS)],
  ]) {
    // The print sheet is black on white by design.
    const outside = css.replace(/@media print\{[\s\S]*$/, "");
    assert.deepEqual(outside.match(/#[0-9a-fA-F]{3,8}\b/g) ?? [], [], `${name} names a colour outside the tokens`);
  }
});

test("the base sheet carries no class of the app", () => {
  const base = rules(baseCSS);
  for (const name of [".wikilink", ".chart", ".rail", ".bar", ".page", ".toast", ".alert", ".dim", ".capture", ".props"]) {
    assert.ok(!base.includes(name), `base.css styles ${name}, which belongs to app.css`);
  }
  for (const want of ["table", "label", "button", "details", "article", "aside", "@media print"]) {
    assert.ok(base.includes(want), `base.css does not style ${want}`);
  }
  for (const want of ["a.wikilink", "svg.chart"]) {
    assert.ok(rules(appCSS).includes(want), `app.css lost ${want}`);
  }
});

// The head of each block at the top of a sheet with no comments.
function topBlocks(sheet) {
  const heads = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < sheet.length; i++) {
    if (sheet[i] === "{") {
      if (depth === 0) heads.push(sheet.slice(start, i).trim());
      depth++;
    } else if (sheet[i] === "}") {
      depth--;
      if (depth === 0) start = i + 1;
    }
  }
  const rest = sheet.slice(start).trim();
  if (rest) heads.push(rest);
  return heads;
}

test("the sheets are one cascade in four layers", () => {
  const base = rules(baseCSS).trim();
  const app = rules(appCSS);
  assert.ok(base.startsWith("@layer tokens, base, components, utilities;"), "base.css does not start with the layer order");
  const before = base.slice(0, base.indexOf("@layer tokens{"));
  assert.equal(before.replace(/@layer [^;]+;|@font-face\{[^}]*\}|\s/g, ""), "", "base.css has a rule outside the layers");
  for (const want of ["@layer tokens{", "@layer base{"]) assert.equal(base.split(want).length - 1, 1, want);
  for (const want of ["@layer components{", "@layer utilities{"]) assert.equal(app.split(want).length - 1, 1, want);
  assert.ok(!/@layer (tokens|base)|@layer [^{]*;/.test(app), "app.css declares a layer order or a layer of base.css");
  assert.deepEqual(
    topBlocks(app).filter((h) => h !== "@layer components" && h !== "@layer utilities"),
    [],
    "app.css has a rule outside its layers",
  );
});

test("the sheets close every block", () => {
  for (const [name, css] of [
    ["base.css", baseCSS],
    ["app.css", appCSS],
  ]) {
    const lines = css.replace(comments, (c) => "\n".repeat(c.split("\n").length - 1)).split("\n");
    let depth = 0;
    lines.forEach((line, i) => {
      // A line at the margin that is not a close starts a rule of a layer, or of the sheet.
      if (line !== "" && !" \t}".includes(line[0])) assert.ok(depth <= 1, `${name}:${i + 1} starts inside ${depth} open blocks`);
      depth += (line.match(/\{/g) ?? []).length - (line.match(/\}/g) ?? []).length;
    });
    assert.equal(depth, 0, `${name} ends with blocks open`);
  }
});

test("the sheets use logical properties", () => {
  const physical = [
    /(^|[{;\s])(margin|padding|border)-(left|right|top|bottom)(-[a-z]+)?\s*:/g,
    /(^|[{;\s])(left|right|top|bottom|width|height|min-width|max-width|min-height|max-height)\s*:/g,
    /(^|[{;\s])(text-align|float)\s*:\s*(left|right)\b/g,
  ];
  for (const [name, css] of [
    ["base.css", baseCSS],
    ["app.css", appCSS],
  ]) {
    for (const re of physical) assert.deepEqual(rules(css).match(re) ?? [], [], `${name} uses a physical property`);
  }
});

test("the motions ask first", () => {
  // Every animation, transition into the top layer and @starting-style is
  // inside a block that asks for motion; the reduce block turns them all off.
  for (const [name, css] of [
    ["base.css", baseCSS],
    ["app.css", appCSS],
  ]) {
    const sheet = rules(css);
    for (const token of ["@starting-style", "allow-discrete", "animation:"]) {
      let at = sheet.indexOf(token);
      while (at >= 0) {
        const stack = [];
        let start = 0;
        for (let i = 0; i < at; i++) {
          if (sheet[i] === "{") {
            stack.push(sheet.slice(start, i).trim());
            start = i + 1;
          } else if (sheet[i] === "}") {
            stack.pop();
            start = i + 1;
          } else if (sheet[i] === ";") start = i + 1;
        }
        const asks = stack.some((p) => p.includes("prefers-reduced-motion:no-preference"));
        const off = sheet.startsWith("animation:none", at) && stack.some((p) => p.includes("prefers-reduced-motion:reduce"));
        assert.ok(asks || off, `${name}: ${token} at ${stack.join(" > ") || "the top"} does not ask for motion`);
        at = sheet.indexOf(token, at + token.length);
      }
    }
  }
  assert.match(rules(baseCSS), /prefers-reduced-motion:reduce\)\{[^\n]*animation:none!important/, "base.css: no switch for reduced motion");
});
