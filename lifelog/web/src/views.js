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

export function readingForm(metrics, chosen = "", day = "", { primary = false } = {}) {
  return html`<form class="inline reading-form" method="post" action="/api/capture" data-capture="reading">
<input type="hidden" name="type" value="reading">
${day ? html`<input type="hidden" name="day" value="${day}">` : ""}
<label><span>Metric</span><select name="metric" required>
${chosen ? "" : html`<option value="">Choose</option>`}
${metrics.map((m) => html`<option value="${m.name}" ${m.name === chosen ? raw("selected") : ""}>${m.name}${m.unit ? ` (${m.unit})` : ""}</option>`)}
</select></label>
<label><span>Value</span><input name="value" inputmode="decimal" required autocomplete="off"></label>
<button${primary ? raw(' class="primary"') : ""}>Add</button>
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

// pageHead is the head of a view that is not a day or a page: what it is in, its title, and its tools.
function pageHead({ kind = "", title, sub = "", tools = "" }) {
  return html`<header class="page-head">
<div class="what">${kind ? html`<p class="kind">${kind}</p>` : ""}<h1>${title}</h1>${sub ? html`<p class="sub">${sub}</p>` : ""}</div>
${tools ? html`<div class="tools">${tools}</div>` : ""}
</header>`;
}

const backTo = (rel) => (rel.startsWith("journal/") ? `/day/${rel.slice(8, 18)}` : `/p/${encPath(rel)}`);

// The editor: a plain text area on the sheet. A save that would overwrite a change it did not see is refused, and
// the alert shows the text that is saved now.
export function editView({ rel, title, text, sha, conflict }) {
  return layout({
    title: `Edit ${title}`,
    body: html`${pageHead({ kind: "Editing", title })}
${conflict ? html`<div class="alert danger" role="alert"><p><strong>The page changed since you opened it.</strong> Another editor (Obsidian, or Syncthing from another machine) saved it. Your text is in the editor; the text that is saved now is below. Merge what you want to keep, then save again.</p>
<pre class="theirs">${conflict.text}</pre></div>` : ""}
<div class="sheet">
<form method="post" action="/edit/${encPath(rel)}" class="editor">
<input type="hidden" name="sha" value="${sha}">
<label><span>Text</span><textarea name="text" spellcheck="true" autofocus>${text}</textarea></label>
<div class="actions"><button class="primary">Save</button><a class="button" href="${backTo(rel)}">Cancel</a></div>
</form>
</div>`,
  });
}

export function newView({ title = "", kind = "pages", text = "", refused = "" }) {
  const kinds = KINDS.filter(([k]) => k !== "journal" && k !== "files");
  return layout({
    title: "New page",
    body: html`${pageHead({ title: "New page" })}
${refused ? html`<div class="alert danger" role="alert"><p><strong>The page is not made.</strong> ${refused}</p></div>` : ""}
<div class="sheet">
<form method="post" action="/new" class="editor">
<div class="fields"><label><span>Title</span><input name="title" value="${title}" required autocomplete="off"${refused ? raw(' aria-invalid="true"') : ""}></label>
<label><span>Kind</span><select name="kind">${kinds.map(([k, n]) => html`<option value="${k}" ${k === kind ? raw("selected") : ""}>${n}</option>`)}</select></label></div>
<label><span>Text</span><textarea name="text">${text}</textarea></label>
<div class="actions"><button class="primary">Create</button></div>
</form>
</div>`,
  });
}

// A row of a list: the whole row is the link, its count or its kind at the end.
const row = (href, first, meta = "") =>
  html`<li><a class="entry" href="${href}"><span class="first">${first}</span>${meta ? html`<span class="meta">${meta}</span>` : ""}</a></li>`;

export function browseView({ counts }) {
  return layout({
    title: "Pages",
    nav: "browse",
    body: html`${pageHead({ title: "Pages", tools: html`<a class="button" href="/new">New page</a>` })}
<div class="sheet list"><ul class="plain rows">${KINDS.map(([k, n]) => row(`/browse/${k}`, n, String(counts[k] ?? 0)))}</ul></div>`,
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
    list =
      byMonth.size === 0
        ? html`<p class="empty">No day is written yet. <a href="/">Write today</a>.</p>`
        : [...byMonth].map(
            ([m, ps]) => html`<section class="group" aria-label="${m}">${panelHead(fmt(m + "-01", { month: "long", year: "numeric" }))}
<ul class="days">${ps.map((p) => html`<li><a href="${pageHref(p.path)}" aria-label="${shortDay(p.title)}">${Number(p.title.slice(8))}</a></li>`)}</ul></section>`,
          );
  } else {
    const sorted = [...pages].sort((a, b) => a.title.localeCompare(b.title));
    list =
      sorted.length === 0
        ? html`<p class="empty">No page here yet. <a href="/new?kind=${kind}">Make one</a>.</p>`
        : html`<div class="sheet list"><ul class="plain rows">${sorted.map((p) => row(pageHref(p.path), p.title))}</ul></div>`;
  }
  return layout({
    title: kindName[kind],
    nav: "browse",
    body: html`${pageHead({ kind: html`<a href="/browse">Pages</a>`, title: kindName[kind], tools: kind === "journal" || kind === "files" ? "" : html`<a class="button" href="/new?kind=${kind}">New</a>` })}
${list}`,
  });
}

export function searchView({ q, hits, partial }) {
  const results = html`<div id="results">${
    q === ""
      ? ""
      : hits.length === 0
        ? html`<p class="empty">Nothing holds “${q}”. <a href="/new?title=${encodeURIComponent(q)}">Create the page ${q}</a>.</p>`
        : html`<div class="sheet list"><ul class="plain rows">${hits.map(
            (h) => html`<li class="hit"><a class="hit-link" href="${pageHref(h.page.path)}">${h.page.title}</a> <span class="tag">${kindName[h.page.kind]}</span><span class="snippet">${h.snippet}</span></li>`,
          )}</ul></div>`
  }</div>`;
  if (partial) return results;
  return layout({
    title: "Search",
    nav: "search",
    body: html`${pageHead({ title: "Search" })}
<form action="/search" class="search" role="search">
<label><span>Words or #tag</span><input type="search" name="q" value="${q}" autofocus autocomplete="off"
  hx-get="/search" hx-trigger="input changed delay:300ms, search" hx-target="#results" hx-swap="outerHTML"></label>
</form>
${results}`,
  });
}

export function metricsView({ metrics, last }) {
  return layout({
    title: "Metrics",
    nav: "metrics",
    body: html`${pageHead({ title: "Metrics", tools: html`<a class="button" href="/new?kind=metrics">New metric</a>` })}
<section class="record" aria-label="Add a reading"><h2>Add a reading</h2>${readingForm(metrics, "", "", { primary: true })}</section>
${
  metrics.length === 0
    ? html`<p class="empty">No metric yet. <a href="/new?kind=metrics">Make the first one</a>.</p>`
    : html`<div class="readings metric-tiles">${metrics.map((m) => {
        const r = last.get(m.name);
        return html`<a class="reading-tile" href="/metrics/${encodeURIComponent(m.name)}"><span class="name">${m.name}</span>
${r ? html`<span class="reading">${r.text}</span><span class="unit">${m.unit ? `${m.unit} · ` : ""}${r.day}</span>` : html`<span class="unit">no reading yet</span>`}</a>`;
      })}</div>`
}`,
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
    body: html`${pageHead({
      kind: html`<a href="/metrics">Metrics</a>`,
      title: metric.name,
      sub: html`${metric.unit ? html`<span class="unit">${metric.unit}</span>` : ""}${page ? html`<a href="${pageHref(page.path)}">The metric's page</a>` : ""}`,
    })}
<section class="record" aria-label="Add a reading"><h2>Add a reading</h2>${readingForm(metrics, metric.name, "", { primary: true })}</section>
<nav class="spans" aria-label="Span">${spans.map(([s, n]) => (s === span ? html`<span aria-current="true">${n}</span>` : html`<a href="?span=${s}">${n}</a>`))}</nav>
${svg ? raw(svg) : html`<p class="empty">No reading in this span. <a href="?span=all">See them all</a>.</p>`}
${recent.length > 0 ? html`<div class="scroll"><table class="series"><thead><tr><th scope="col">Day</th><th scope="col">Value</th><th scope="col">Source</th></tr></thead><tbody>
${recent.map((r) => html`<tr><td class="date"><a href="/day/${r.day}">${r.day}</a>${r.takenAt ? ` ${r.takenAt.slice(11, 16)}` : ""}</td><td class="value">${r.text}</td><td>${r.source}</td></tr>`)}
</tbody></table></div>` : ""}`,
  });
}

// Capture works offline: the service worker keeps this page, and app.js queues what is added.
export function captureView({ metrics }) {
  return layout({
    title: "Capture",
    nav: "capture",
    body: html`${pageHead({ title: "Capture", sub: "What you add here waits on the phone while it is offline, and goes to the day it was written on." })}
<div class="sheet">
<section class="capture" aria-label="Add a note"><h2>A note</h2>${noteForm("")}</section>
<section class="capture" aria-label="Add a reading"><h2>A reading</h2>${readingForm(metrics)}</section>
</div>`,
  });
}

export function messageView({ title, message, status }) {
  return layout({ title, body: html`${pageHead({ title })}<div class="alert" role="alert"><p>${message}</p></div><p><a class="button" href="/">Today</a></p>`, status });
}
