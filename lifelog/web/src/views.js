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

// today is the day on the tablet's clock (its time zone is the owner's).
export function today() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

const asDate = (day) => new Date(day + "T12:00:00Z");
const fmt = (day, opts) => asDate(day).toLocaleDateString("en-GB", { ...opts, timeZone: "UTC" });
// "Sat 14 Nov": a day near the others, in the rail and on a step.
export const shortDay = (day) => fmt(day, { weekday: "short", day: "numeric", month: "short" }).replace(",", "");
export const weekdayOf = (day) => fmt(day, { weekday: "long" });

// An icon is a glyph of pictures/icons.png, drawn as a mask in the colour of its text (app.css).
const icon = (name) => html`<span class="icon icon-${name}" aria-hidden="true"></span>`;

// The sections of every day: the rail on a wide screen, the bottom bar on a phone.
const SECTIONS = [
  ["today", "/", "Today", "today"],
  ["browse", "/browse", "Pages", "browse"],
  ["metrics", "/metrics", "Metrics", "metrics"],
  ["capture", "/capture", "Capture", "chat"],
];

// layout is the shell (docs/plans/004-the-almanac-look.md). At 900 px and wider: the rail of wood on the left (the
// brand and today, Search, New, the sections) and the page beside it. Under 900 px the head of the rail is a top bar
// and its sections a bottom bar. It needs no script.
export function layout({ title, body, nav = "" }) {
  const now = today();
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
<a class="skip" href="#main">Skip to the content</a>
<div class="shell">
<header class="rail">
<div class="rail-head"><a class="brand" href="/">Life</a><span class="date">${shortDay(now)}</span>
<a class="button rail-search-link${nav === "search" ? " here" : ""}" href="/search" aria-label="Search">${icon("search")}</a></div>
<a class="rail-search${nav === "search" ? " here" : ""}" href="/search">${icon("search")}Search</a>
<a class="button rail-new" href="/new" aria-label="New page">${icon("new")}<span class="rail-new-words">New</span></a>
<nav aria-label="Sections"><ul>
${SECTIONS.map(([key, href, name, ic]) => html`<li><a href="${href}"${nav === key ? raw(' aria-current="page"') : ""}>${icon(ic)}${name}</a></li>`)}
</ul></nav>
<p id="queue" class="queue" role="status" hidden></p>
</header>
<div class="column">
<main id="main">
${body}
</main>
</div>
</div>
</body>
</html>`;
}

// toast is what a write did, at the top of the page: an open dialog that Close or Escape closes, with no script.
function toast(words) {
  return html`<dialog open closedby="closerequest" class="toast" aria-label="Result"><h2>${words}</h2>
<form method="dialog"><button class="small close">Close</button></form></dialog>`;
}

// panelHead is the head of a part of a page: its heading, and a link at its end.
function panelHead(title, link = "") {
  return html`<div class="panel-head"><h2>${title}</h2>${link}</div>`;
}

function facts(page) {
  const entries = Object.entries(page?.props ?? {}).filter(([k, v]) => k !== "aliases" && v.length > 0);
  if (entries.length === 0 && !(page?.aliases?.length > 0)) return "";
  return html`<section class="group" aria-label="Properties">${panelHead("Properties")}
<dl class="props">
${page.aliases.length > 0 ? html`<dt>also</dt><dd>${page.aliases.join(", ")}</dd>` : ""}
${entries.map(([k, v]) => html`<dt>${k}</dt><dd>${v.join(", ")}</dd>`)}
</dl></section>`;
}

// problemsBox is the checker's word on a page after a save: an alert, red when one problem is an error.
function problemsBox(problems) {
  if (!problems || problems.length === 0) return "";
  const bad = problems.some((p) => p.class === "error" || p.class === "loss");
  return html`<div class="alert${bad ? " danger" : ""}" role="alert">
<p><strong>The checker found ${problems.length === 1 ? "a problem" : `${problems.length} problems`}.</strong> The page is saved.</p>
<ul>${problems.map((p) => html`<li><span class="tag">${p.class}</span> ${p.message}. Fix: ${p.fix}</li>`)}</ul>
</div>`;
}

function backlinksBox(list) {
  if (!list || list.length === 0) return "";
  return html`<section class="group" aria-label="Linked from">${panelHead("Linked from")}
<ul class="plain">${list.map((p) => html`<li><a href="${pageHref(p.path)}">${p.title}</a></li>`)}</ul>
</section>`;
}

// The two forms of the offline queue (public/app.js). Each works with no script: the browser posts it.
export function noteForm(day, { primary = true } = {}) {
  return html`<form class="note-form" method="post" action="/api/capture" data-capture="note">
<input type="hidden" name="type" value="note">
<input type="hidden" name="day" value="${day}">
<label><span>Note</span><textarea name="text" rows="3" placeholder="${day ? `A note for ${shortDay(day)}` : "A note for today"}" required></textarea></label>
<button${primary ? raw(' class="primary"') : ""}>Add</button>
</form>`;
}

export function readingForm(metrics, chosen = "", day = "") {
  return html`<form class="inline reading-form" method="post" action="/api/capture" data-capture="reading">
<input type="hidden" name="type" value="reading">
${day ? html`<input type="hidden" name="day" value="${day}">` : ""}
<label><span>Metric</span><select name="metric" required>
${chosen ? "" : html`<option value="">Choose</option>`}
${metrics.map((m) => html`<option value="${m.name}" ${m.name === chosen ? raw("selected") : ""}>${m.name}${m.unit ? ` (${m.unit})` : ""}</option>`)}
</select></label>
<label><span>Value</span><input name="value" inputmode="decimal" required autocomplete="off"></label>
<button>Add</button>
</form>`;
}

function dayShift(day, n) {
  const d = asDate(day);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

// step is the link to the day before or after: its arrow, and the day where the column has room for it.
function step(day, rel) {
  const label = `${rel === "prev" ? "The day before" : "The day after"}, ${shortDay(day)}`;
  return html`<a class="button step" rel="${rel}" href="/day/${day}" aria-label="${label}">${rel === "prev" ? html`<span aria-hidden="true">‹</span>` : ""}<span class="step-day">${shortDay(day)}</span>${rel === "next" ? html`<span aria-hidden="true">›</span>` : ""}</a>`;
}

// The day (aminte plan 095): a calendar leaf heads it. The sheet holds what is written and the note to add; the
// margin holds the readings and the pages that link here. On a narrow column the margin comes after the sheet.
export function dayView({ day, today, page, rendered, dated, readings, metrics, backlinks }) {
  const isToday = day === today;
  return layout({
    title: day,
    nav: isToday ? "today" : "",
    body: html`<header class="page-head day-head">
<div class="day-title"><a class="leaf" href="/browse/journal" aria-label="${fmt(day, { month: "long", year: "numeric" })}, the journal">
<span class="leaf-month">${fmt(day, { month: "short", year: "numeric" })}</span><span class="leaf-day">${Number(day.slice(8))}</span></a>
<div class="what"><h1>${weekdayOf(day)}</h1>
<p class="sub">${isToday ? html`<span class="tag open">today</span>` : html`<a href="/">Go to today</a>`} <span class="date">${day}</span></p></div></div>
<div class="tools">${step(dayShift(day, -1), "prev")}${step(dayShift(day, 1), "next")}</div>
</header>
<div class="sheet-margin">
<div class="sheet">
<section class="journal" aria-label="Journal">
${panelHead("Journal", html`<a href="/edit/journal/${day}.md">${page ? "Edit the day" : "Write the day"}</a>`)}
${rendered ? html`<div class="prose journal-text">${raw(rendered)}</div>` : html`<p class="empty">Nothing written on this day yet. Add a note below.</p>`}
</section>
<section class="capture" id="capture" aria-label="Add a note">
<h2>${isToday ? "Add to today" : `Add to ${shortDay(day)}`}</h2>
${noteForm(day)}
</section>
${dated.length > 0 ? html`<section class="also" aria-label="Pages of this day"><h2>Pages of this day</h2><ul class="plain">${dated.map((p) => html`<li><a href="${pageHref(p.path)}">${p.title}</a></li>`)}</ul></section>` : ""}
</div>
<div class="margin">
<section class="group" aria-label="Readings">
${panelHead("Readings", html`<a href="/metrics">Metrics</a>`)}
${readings.length > 0 ? html`<div class="readings">${readings.map((r) => html`<div class="reading-tile"><a class="name" href="/metrics/${encodeURIComponent(r.metric)}">${r.metric}</a>
<span class="reading">${r.text}</span><span class="unit">${metrics.get(r.metric)?.unit ?? ""}${r.takenAt ? ` · ${r.takenAt.slice(11, 16)}` : ""}</span></div>`)}</div>` : html`<p class="empty">No readings on this day. Add one below.</p>`}
${readingForm([...metrics.values()], "", day)}
</section>
${backlinksBox(backlinks)}
</div>
</div>`,
  });
}

// A page: the head with its kind and title; the sheet with the body; the margin with its properties and the pages
// that link to it. A save's result is a toast; the checker's problems are an alert.
export function pageView({ page, rendered, backlinks, problems, saved }) {
  return layout({
    title: page.title,
    body: html`${saved ? toast("Saved.") : ""}
<header class="page-head">
<div class="what"><p class="kind"><a href="/browse/${page.kind}">${kindName[page.kind]}</a></p><h1>${page.title}</h1>
${page.kind === "metrics" ? html`<p class="sub"><a href="/metrics/${encodeURIComponent(page.title)}">Its readings</a></p>` : ""}</div>
<div class="tools"><a class="button" href="/edit/${encPath(page.path)}">Edit</a></div>
</header>
${problemsBox(problems)}
${page.problem ? html`<div class="alert" role="alert"><p><strong>The properties do not parse.</strong> ${page.problem}</p></div>` : ""}
<div class="sheet-margin">
<div class="sheet">
${rendered.trim() ? html`<section class="page-body" aria-label="The page"><div class="prose">${raw(rendered)}</div></section>` : html`<p class="empty">Nothing written here yet. <a href="/edit/${encPath(page.path)}">Write it</a>.</p>`}
</div>
<div class="margin">
${facts(page)}
${backlinksBox(backlinks)}
</div>
</div>`,
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
