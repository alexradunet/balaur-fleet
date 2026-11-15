// The HTML of each view. Every value is escaped unless it is marked raw():
// a page's title or text never becomes markup.

import { encPath, pageHref } from "./markdown.js";

class Raw {
  constructor(s) {
    this.s = s;
  }
  toString() {
    return this.s;
  }
}
export const raw = (s) => new Raw(s);

export function esc(v) {
  return String(v).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
}

function value(v) {
  if (v === null || v === undefined || v === false) return "";
  if (v instanceof Raw) return v.s;
  if (Array.isArray(v)) return v.map(value).join("");
  return esc(v);
}

export function html(strings, ...values) {
  let out = strings[0];
  for (let i = 0; i < values.length; i++) out += value(values[i]) + strings[i + 1];
  return raw(out);
}

const KINDS = [
  ["journal", "Journal"],
  ["pages", "Pages"],
  ["people", "People"],
  ["places", "Places"],
  ["metrics", "Metrics"],
  ["files", "Files"],
];
export const kindName = Object.fromEntries(KINDS);

export function layout({ title, body, nav = "" }) {
  return html`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>${title} · Life</title>
<link rel="manifest" href="/manifest.webmanifest">
<link rel="icon" href="/static/icon.svg" type="image/svg+xml">
<meta name="theme-color" content="#3a2210" media="(prefers-color-scheme: light)">
<meta name="theme-color" content="#2a1709" media="(prefers-color-scheme: dark)">
<link rel="stylesheet" href="/static/base.css">
<link rel="stylesheet" href="/static/app.css">
<meta name="htmx-config" content='{"includeIndicatorStyles":false}'>
<script src="/static/htmx.min.js" defer></script>
<script src="/static/app.js" type="module"></script>
</head>
<body>
<header class="bar">
  <nav>
    <a href="/" class="${nav === "today" ? "on" : ""}">Today</a>
    <a href="/browse" class="${nav === "browse" ? "on" : ""}">Pages</a>
    <a href="/metrics" class="${nav === "metrics" ? "on" : ""}">Metrics</a>
    <a href="/search" class="${nav === "search" ? "on" : ""}">Search</a>
  </nav>
  <span id="queue" class="queue" hidden></span>
</header>
<main>
${body}
</main>
</body>
</html>`;
}

function props(page) {
  const entries = Object.entries(page?.props ?? {}).filter(([k, v]) => k !== "aliases" && v.length > 0);
  if (entries.length === 0 && !(page?.aliases?.length > 0)) return "";
  return html`<dl class="props">
${page.aliases.length > 0 ? html`<dt>also</dt><dd>${page.aliases.join(", ")}</dd>` : ""}
${entries.map(([k, v]) => html`<dt>${k}</dt><dd>${v.join(", ")}</dd>`)}
</dl>`;
}

function problemsBox(problems) {
  if (!problems || problems.length === 0) return "";
  return html`<section class="problems">
<h2>The checker found</h2>
<ul>${problems.map((p) => html`<li class="${p.class}"><b>${p.class}</b> ${p.message}. <i>Fix:</i> ${p.fix}</li>`)}</ul>
</section>`;
}

function backlinksBox(list) {
  if (!list || list.length === 0) return "";
  return html`<section class="backlinks">
<h2>Linked from</h2>
<ul>${list.map((p) => html`<li><a href="${pageHref(p.path)}">${p.title}</a></li>`)}</ul>
</section>`;
}

export function noteForm(day) {
  return html`<form class="capture" method="post" action="/api/capture" data-capture="note">
<input type="hidden" name="type" value="note">
<input type="hidden" name="day" value="${day}">
<textarea name="text" rows="2" placeholder="${day ? `A note for ${day}` : "A note for today"}" required></textarea>
<button>Add</button>
</form>`;
}

export function readingForm(metrics, chosen = "", day = "") {
  return html`<form class="capture reading" method="post" action="/api/capture" data-capture="reading">
<input type="hidden" name="type" value="reading">
${day ? html`<input type="hidden" name="day" value="${day}">` : ""}
<select name="metric" required>
${chosen ? "" : html`<option value="">Metric</option>`}
${metrics.map((m) => html`<option value="${m.name}" ${m.name === chosen ? raw("selected") : ""}>${m.name}${m.unit ? ` (${m.unit})` : ""}</option>`)}
</select>
<input name="value" inputmode="decimal" placeholder="Value" required autocomplete="off">
<button>Add</button>
</form>`;
}

function dayShift(day, n) {
  const d = new Date(day + "T12:00:00Z");
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

export function dayView({ day, today, page, rendered, dated, readings, metrics, backlinks }) {
  const weekday = new Date(day + "T12:00:00Z").toLocaleDateString("en-GB", { weekday: "long", timeZone: "UTC" });
  return layout({
    title: day,
    nav: day === today ? "today" : "",
    body: html`<div class="dayhead">
<a href="/day/${dayShift(day, -1)}" aria-label="the day before">‹</a>
<h1>${day} <small>${weekday}</small></h1>
<a href="/day/${dayShift(day, 1)}" aria-label="the day after">›</a>
</div>
${day !== today ? html`<p class="center"><a href="/">Today</a></p>` : ""}
${noteForm(day)}
<article class="page">${rendered ? raw(rendered) : html`<p class="dim">Nothing written on this day yet.</p>`}</article>
<p class="actions"><a href="/edit/journal/${day}.md">${page ? "Edit the day" : "Write the day"}</a></p>
${dated.length > 0 ? html`<section><h2>Pages of this day</h2><ul>${dated.map((p) => html`<li><a href="${pageHref(p.path)}">${p.title}</a></li>`)}</ul></section>` : ""}
<section><h2>Readings</h2>
${readings.length > 0 ? html`<ul class="readings">${readings.map((r) => html`<li><a href="/metrics/${encodeURIComponent(r.metric)}">${r.metric}</a> ${r.text} ${metrics.get(r.metric)?.unit ?? ""}${r.takenAt ? html` <span class="dim">${r.takenAt.slice(11, 16)}</span>` : ""}</li>`)}</ul>` : html`<p class="dim">None.</p>`}
${readingForm([...metrics.values()], "", day)}
</section>
${backlinksBox(backlinks)}`,
  });
}

export function pageView({ page, rendered, backlinks, problems, saved }) {
  return layout({
    title: page.title,
    body: html`<p class="crumb"><a href="/browse/${page.kind}">${kindName[page.kind]}</a></p>
<h1>${page.title}</h1>
${saved ? html`<p class="ok">Saved.</p>` : ""}
${problemsBox(problems)}
${page.problem ? html`<p class="warn">The properties do not parse: ${page.problem}</p>` : ""}
${props(page)}
<article class="page">${raw(rendered)}</article>
<p class="actions"><a href="/edit/${encPath(page.path)}">Edit</a>${page.kind === "metrics" ? html` · <a href="/metrics/${encodeURIComponent(page.title)}">Readings</a>` : ""}</p>
${backlinksBox(backlinks)}`,
  });
}

export function editView({ rel, title, text, sha, conflict }) {
  return layout({
    title: `Edit ${title}`,
    body: html`<h1>${title}</h1>
${conflict ? html`<section class="problems"><h2>The page changed since you opened it</h2>
<p>Another editor (Obsidian, or Syncthing from another machine) saved it. Your text is in the editor; the text that is saved now is below. Merge what you want to keep, then save again.</p>
<pre class="theirs">${conflict.text}</pre></section>` : ""}
<form method="post" action="/edit/${encPath(rel)}" class="editor">
<input type="hidden" name="sha" value="${sha}">
<textarea name="text" spellcheck="true" autofocus>${text}</textarea>
<div class="actions"><button>Save</button> <a href="${rel.startsWith("journal/") ? `/day/${rel.slice(8, 18)}` : `/p/${encPath(rel)}`}">Cancel</a></div>
</form>`,
  });
}

export function newView({ title = "", kind = "pages", text = "", refused = "" }) {
  const kinds = KINDS.filter(([k]) => k !== "journal" && k !== "files");
  return layout({
    title: "New page",
    body: html`<h1>New page</h1>
${refused ? html`<p class="warn">${refused}</p>` : ""}
<form method="post" action="/new" class="editor">
<label>Title <input name="title" value="${title}" required autocomplete="off"></label>
<label>Kind <select name="kind">${kinds.map(([k, n]) => html`<option value="${k}" ${k === kind ? raw("selected") : ""}>${n}</option>`)}</select></label>
<textarea name="text" placeholder="Text">${text}</textarea>
<div class="actions"><button>Create</button></div>
</form>`,
  });
}

export function browseView({ counts }) {
  return layout({
    title: "Pages",
    nav: "browse",
    body: html`<h1>Pages</h1>
<ul class="kinds">${KINDS.map(([k, n]) => html`<li><a href="/browse/${k}">${n}</a> <span class="dim">${counts[k] ?? 0}</span></li>`)}</ul>
<p class="actions"><a href="/new">New page</a></p>`,
  });
}

export function kindView({ kind, pages }) {
  let list;
  if (kind === "journal") {
    const byMonth = new Map();
    for (const p of [...pages].sort((a, b) => b.title.localeCompare(a.title))) {
      const m = p.title.slice(0, 7);
      if (!byMonth.has(m)) byMonth.set(m, []);
      byMonth.get(m).push(p);
    }
    list = [...byMonth].map(([m, ps]) => html`<h2>${m}</h2><ul class="days">${ps.map((p) => html`<li><a href="${pageHref(p.path)}">${p.title.slice(8)}</a></li>`)}</ul>`);
  } else {
    list = html`<ul>${[...pages].sort((a, b) => a.title.localeCompare(b.title)).map((p) => html`<li><a href="${pageHref(p.path)}">${p.title}</a></li>`)}</ul>`;
  }
  return layout({
    title: kindName[kind],
    nav: "browse",
    body: html`<p class="crumb"><a href="/browse">Pages</a></p><h1>${kindName[kind]}</h1>${list}`,
  });
}

export function searchView({ q, hits, partial }) {
  const results = html`<div id="results">${
    q === ""
      ? ""
      : hits.length === 0
        ? html`<p class="dim">Nothing holds “${q}”. <a href="/new?title=${encodeURIComponent(q)}">Create the page ${q}</a>.</p>`
        : html`<ul class="hits">${hits.map((h) => html`<li><a href="${pageHref(h.page.path)}">${h.page.title}</a> <span class="dim">${kindName[h.page.kind]}</span><br><span class="snippet">${h.snippet}</span></li>`)}</ul>`
  }</div>`;
  if (partial) return results;
  return layout({
    title: "Search",
    nav: "search",
    body: html`<h1>Search</h1>
<form action="/search" class="search">
<input type="search" name="q" value="${q}" placeholder="Words or #tag" autofocus autocomplete="off"
  hx-get="/search" hx-trigger="input changed delay:300ms, search" hx-target="#results" hx-swap="outerHTML">
</form>
${results}`,
  });
}

export function metricsView({ metrics, last }) {
  return layout({
    title: "Metrics",
    nav: "metrics",
    body: html`<h1>Metrics</h1>
${readingForm(metrics)}
<ul class="metrics">${metrics.map((m) => {
      const r = last.get(m.name);
      return html`<li><a href="/metrics/${encodeURIComponent(m.name)}">${m.name}</a> ${r ? html`<span>${r.text} ${m.unit}</span> <span class="dim">${r.day}</span>` : html`<span class="dim">no reading</span>`}</li>`;
    })}</ul>
<p class="actions"><a href="/new?kind=metrics">New metric</a></p>`,
  });
}

export function metricView({ metric, page, readings, span, svg, metrics }) {
  const spans = [
    ["30", "30 days"],
    ["365", "1 year"],
    ["all", "All"],
  ];
  const recent = readings.slice(-30).reverse();
  return layout({
    title: metric.name,
    nav: "metrics",
    body: html`<p class="crumb"><a href="/metrics">Metrics</a></p>
<h1>${metric.name} ${metric.unit ? html`<small>${metric.unit}</small>` : ""}</h1>
${readingForm(metrics, metric.name)}
<p class="spans">${spans.map(([s, n]) => (s === span ? html`<b>${n}</b>` : html`<a href="?span=${s}">${n}</a>`))}</p>
${svg ? raw(svg) : html`<p class="dim">No reading in this span.</p>`}
<table class="readings"><tr><th>Day</th><th>Value</th><th>Source</th></tr>
${recent.map((r) => html`<tr><td><a href="/day/${r.day}">${r.day}</a>${r.takenAt ? html` <span class="dim">${r.takenAt.slice(11, 16)}</span>` : ""}</td><td>${r.text}</td><td class="dim">${r.source}</td></tr>`)}
</table>
<p class="actions">${page ? html`<a href="${pageHref(page.path)}">The metric's page</a>` : ""}</p>`,
  });
}

export function captureView({ metrics }) {
  return layout({
    title: "Capture",
    body: html`<h1>Capture</h1>
<p class="dim">What you add here waits on the phone while it is offline, and goes to the day it was written on.</p>
${noteForm("")}
${readingForm(metrics)}
<p class="center"><a href="/">Today</a></p>`,
  });
}

export function messageView({ title, message, status }) {
  return layout({ title, body: html`<h1>${title}</h1><p>${message}</p><p><a href="/">Today</a></p>`, status });
}
