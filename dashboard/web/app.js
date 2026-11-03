"use strict";

// Samsung TVs from 2021 (Tizen 6) run Chromium 76: no optional chaining, no
// Element.replaceChildren. Keep this file to ES2019 and polyfill the rest.
if (!Element.prototype.replaceChildren) {
  Element.prototype.replaceChildren = function (...nodes) {
    while (this.firstChild) this.removeChild(this.firstChild);
    this.append(...nodes);
  };
}
const activeTab = () => { const t = document.querySelector(".tab.active"); return t ? t.dataset.tab : ""; };
// Flexbox gap arrived in Chromium 84; older ones get margins instead (style.css, .no-flexgap).
(() => {
  const f = document.createElement("div");
  f.style.cssText = "display:flex;flex-direction:column;row-gap:1px;position:absolute";
  f.append(document.createElement("div"), document.createElement("div"));
  document.documentElement.append(f);
  if (f.scrollHeight !== 1) document.documentElement.classList.add("no-flexgap");
  f.remove();
})();

const params = new URLSearchParams(location.search);
const kiosk = params.has("kiosk");
// The "Duet" app on the Samsung TV (tv-app/) opens the dashboard with ?tv:
// remote-control navigation and services opened in place.
const tvMode = params.has("tv");
if (kiosk) document.body.classList.add("kiosk");
if (tvMode) document.body.classList.add("tv");

const $ = (id) => document.getElementById(id);
const el = (tag, cls, text) => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
};

const fmtBytes = (n) => {
  const u = ["B", "KB", "MB", "GB", "TB"];
  let i = 0;
  while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
  return n.toFixed(n >= 100 || i === 0 ? 0 : 1) + " " + u[i];
};
const fmtUptime = (s) => {
  const d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600), m = Math.floor((s % 3600) / 60);
  return d ? `${d}d ${h}h` : h ? `${h}h ${m}m` : `${m}m`;
};
const level = (pct, warn = 75, bad = 90) => (pct >= bad ? "bad" : pct >= warn ? "warn" : "");

function setBar(id, pct, warn, bad) {
  const b = $(id);
  b.style.width = Math.max(0, Math.min(100, pct)) + "%";
  b.className = level(pct, warn, bad);
}

// ---- clock (local, independent of polling) ----
function tick() {
  const now = new Date();
  $("clock").textContent = now.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  $("date").textContent = now.toLocaleDateString([], { weekday: "long", day: "numeric", month: "long" });
}
tick();
setInterval(tick, 1000);

// ---- services ----
const tiles = new Map(); // name -> element
let tileOrderKey = "";

function serviceURL(s) {
  return `${location.protocol}//${location.hostname}:${s.port}${s.path || ""}`;
}

function renderServices(services) {
  const key = services.map((s) => s.name).join("|");
  if (key !== tileOrderKey) {
    tileOrderKey = key;
    tiles.clear();
    const root = $("tiles");
    root.replaceChildren();
    let group = null;
    for (const s of services) {
      if (s.group !== group) {
        group = s.group;
        if (group) root.append(el("div", "group", group));
      }
      const t = el("div", "tile");
      t.setAttribute("role", "button");
      t.tabIndex = 0;
      t.addEventListener("click", () => openSheet(s.name));
      t.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); openSheet(s.name); } });
      t.append(el("span", "dot"), el("span", "icon", s.icon || "•"), el("span", "name", s.name), el("span", "desc", s.description || ""));
      tiles.set(s.name, t);
      root.append(t);
    }
  }
  serviceData = new Map(services.map((s) => [s.name, s]));
  for (const s of services) tiles.get(s.name).dataset.state = s.state;
  if (sheetFor) fillSheet(); // keep an open sheet live
}

// ---- tabs, detail sheet, idle reset (kiosk) ----
let serviceData = new Map();
let sheetFor = null;
const sheet = $("sheet");

function fillSheet() {
  const s = serviceData.get(sheetFor);
  if (!s) { closeSheet(); return; }
  $("sheet-icon").textContent = s.icon || "•";
  $("sheet-name").textContent = s.name;
  $("sheet-desc").textContent = s.description || "";
  $("sheet-state").textContent = s.state;
  $("sheet-state").dataset.state = s.state;
  $("sheet-url").textContent = s.port ? serviceURL(s).replace(/^https?:\/\//, "") : "—";
  $("sheet-unit").textContent = s.unit || "—";
  // The kiosk opens the service in place (it has one window; its Home button,
  // modules/kiosk-home, comes back here); other browsers use a new tab.
  const open = $("sheet-open");
  open.hidden = !s.port;
  open.href = s.port ? serviceURL(s) : "";
  open.target = kiosk || tvMode ? "_self" : "_blank";
}
function openSheet(name) { sheetFor = name; fillSheet(); sheet.hidden = false; }
function closeSheet() { sheetFor = null; sheet.hidden = true; }
$("sheet-close").addEventListener("click", closeSheet);
sheet.addEventListener("click", (e) => { if (e.target === sheet) closeSheet(); });
$("sheet-open").addEventListener("click", closeSheet);
addEventListener("keydown", (e) => { if (e.key === "Escape" && sheetFor) closeSheet(); });

function showTab(name) {
  closeSheet();
  document.querySelectorAll("[data-page]").forEach((p) => p.classList.toggle("active", p.dataset.page === name));
  document.querySelectorAll(".tab").forEach((t) => t.classList.toggle("active", t.dataset.tab === name));
  camUpdate();
}
document.querySelectorAll(".tab").forEach((t) => t.addEventListener("click", () => showTab(t.dataset.tab)));

// After a minute without touches, fall back to the home (services) page.
if (kiosk) {
  let idle;
  const arm = () => {
    clearTimeout(idle);
    idle = setTimeout(() => {
      if (activeTab() !== "services" || sheetFor) showTab("services");
    }, 60000);
  };
  addEventListener("pointerdown", arm, true);
  arm();
}

// ---- brightness ----
let brightBusy = false;
const slider = $("bright-r");
slider.addEventListener("input", () => { $("bright-v").textContent = slider.value + "%"; });
async function sendBrightness() {
  brightBusy = true;
  try {
    await fetch("/api/brightness", { method: "POST", body: JSON.stringify({ percent: +slider.value }) });
  } finally {
    brightBusy = false;
  }
}
slider.addEventListener("change", sendBrightness);
const nudge = (d) => () => {
  slider.value = Math.max(+slider.min, Math.min(+slider.max, +slider.value + d));
  $("bright-v").textContent = slider.value + "%";
  sendBrightness();
};
$("bright-dn").addEventListener("click", nudge(-10));
$("bright-up").addEventListener("click", nudge(10));

// ---- live camera view ----
// The relay's MJPEG stream, proxied by the dashboard: the same picture on the
// kiosk and on any allowed remote browser. It only streams while the Camera
// tab is open, switched on and visible, so nobody keeps the encoder busy by
// accident. Tap the picture to stop/start it.
const cam = $("cam");
const camImg = $("cam-v");
let camAllowed = false; // the server lets this client watch
let camOn = true;       // user's tap toggle
let camRetry = 0;

function camState(state, msg) {
  cam.dataset.state = state;
  $("cam-msg").textContent = msg || "";
}

function camUpdate() {
  const want = camAllowed && camOn && !document.hidden && $("camview").classList.contains("active");
  const open = camImg.hasAttribute("src");
  if (want && !open && Date.now() >= camRetry) {
    camState("starting", "Camera starting…");
    camImg.src = "/api/camera?t=" + Date.now();
  } else if (!want && open) {
    camImg.removeAttribute("src"); // closes the stream
    if (!camOn) camState("off", "Camera off — tap to turn on");
  } else if (open && camImg.naturalWidth) {
    camState("live");
  }
}

camImg.addEventListener("load", () => camState("live"));
camImg.addEventListener("error", () => {
  if (!camImg.hasAttribute("src")) return;
  camImg.removeAttribute("src");
  camRetry = Date.now() + 5000; // the relay may be (re)starting
  camState("error", "Camera unavailable — retrying");
});
cam.addEventListener("click", () => { camOn = !camOn; camUpdate(); });
document.addEventListener("visibilitychange", camUpdate);

// Called from render(): show the tab only to clients that may watch.
function camSync(allowed, viewers) {
  camAllowed = !!allowed;
  $("camview").hidden = !camAllowed;
  $("tab-camera").hidden = !camAllowed;
  if (!camAllowed && $("camview").classList.contains("active")) showTab("services");
  // Everyone, the person in front of the screen included, sees when it is watched.
  const p = $("cam-pill");
  p.hidden = !viewers;
  p.textContent = viewers > 1 ? `◉ camera live · ${viewers}` : "◉ camera live";
  camUpdate();
}

// ---- TV remote (duet.tv) ----
let tvPower = "off";
let tvAppsKey = "";
let tvMsgTimer;

function tvMsg(text, bad) {
  const m = $("tv-msg");
  m.textContent = text;
  m.classList.toggle("bad", !!bad);
  m.hidden = !text;
  clearTimeout(tvMsgTimer);
  if (text) tvMsgTimer = setTimeout(() => { m.hidden = true; }, bad ? 8000 : 2500);
}

async function tvPost(path, body, busyText) {
  if (busyText) tvMsg(busyText);
  try {
    const r = await fetch("/api/tv/" + path, { method: "POST", body: JSON.stringify(body) });
    if (!r.ok) throw new Error((await r.text()).trim() || r.statusText);
    tvRender(await r.json());
    if (busyText) tvMsg("");
  } catch (e) {
    tvMsg(e.message, true);
  }
}

function tvRender(t) {
  tvPower = t.power;
  $("tv-name").textContent = t.name;
  const s = $("tv-state");
  s.textContent = { on: "On", standby: "Standby", off: "Off" }[t.power] || t.power;
  s.dataset.state = t.power;
  const key = t.apps.map((a) => a.id).join("|");
  if (key !== tvAppsKey) {
    tvAppsKey = key;
    $("tv-apps").replaceChildren(...t.apps.map((a) => {
      const b = el("button", "btn app");
      b.type = "button";
      b.append(el("span", "icon", a.icon || "▶"), el("span", "", a.name));
      b.addEventListener("click", () => tvPost("launch", { id: a.id }, tvPower === "on" ? `Opening ${a.name}…` : `Turning on the TV and opening ${a.name}…`));
      return b;
    }));
  }
}

function tvSync(t) {
  $("tab-tv").hidden = !t;
  $("tvpage").hidden = !t;
  if (t) tvRender(t);
}

$("tv-power").addEventListener("click", () => tvPost("power", { on: tvPower !== "on" }, tvPower === "on" ? "Turning off…" : "Turning on…"));
document.querySelectorAll("[data-key]").forEach((b) => b.addEventListener("click", () => tvPost("key", { key: b.dataset.key })));

// ---- TV mode: arrow keys move focus to the nearest control in that direction ----
if (tvMode) {
  const focusables = () => [...document.querySelectorAll(sheetFor
      ? "#sheet .btn:not([hidden])"
      : ".page.active .tile, .page.active .btn:not([hidden]), .page.active input, .tab:not([hidden])")]
    .filter((e) => e.offsetParent !== null);
  const dirs = { 37: [-1, 0], 38: [0, -1], 39: [1, 0], 40: [0, 1] };
  const center = (r) => [r.left + r.width / 2, r.top + r.height / 2];

  function move([dx, dy]) {
    const all = focusables();
    const cur = all.includes(document.activeElement) ? document.activeElement : null;
    if (!cur) { if (all[0]) all[0].focus(); return; }
    const [cx, cy] = center(cur.getBoundingClientRect());
    let best = null, bestScore = Infinity;
    for (const e of all) {
      if (e === cur) continue;
      const [x, y] = center(e.getBoundingClientRect());
      const along = (x - cx) * dx + (y - cy) * dy;   // distance in the pressed direction
      if (along <= 1) continue;
      const across = Math.abs((x - cx) * dy) + Math.abs((y - cy) * dx);
      const score = along + across * 2;              // prefer staying in line
      if (score < bestScore) { bestScore = score; best = e; }
    }
    if (best) { best.focus(); best.scrollIntoView({ block: "nearest" }); }
  }

  addEventListener("keydown", (e) => {
    if (dirs[e.keyCode] && e.target.type !== "range") { e.preventDefault(); move(dirs[e.keyCode]); return; }
    if (e.keyCode === 10009 || e.key === "Backspace") { // Back on the remote
      e.preventDefault();
      if (sheetFor) closeSheet();
      else if (activeTab() !== "services") showTab("services");
      else history.back(); // to the app's start page, which exits the app
    }
  });
  // Something always has focus, so the first press does something visible.
  const ensureFocus = () => { if (!focusables().includes(document.activeElement)) { const f = focusables(); if (f[0]) f[0].focus(); } };
  setInterval(ensureFocus, 500);
}

// ---- voice assistant (duet.assistant) ----
// Live state comes from a long-poll (/api/assistant/status?wait=1), so the
// listening/speaking overlay on the built-in screen follows the voice at once.
let asLoop = false;
let asSt = null;
let asVolBusy = false;
const asCards = new Map(); // list name -> {card, ul, clear}
const listTitle = { shopping: "🛒 Shopping", tasks: "🧹 Tasks" };
const asStateText = {
  idle: "", listening: "Listening…", thinking: "Thinking…", speaking: "Speaking", ringing: "⏰ Ringing",
};

function asWake(s) {
  return (s.wakeWord || "").split(",")[0].trim().replace(/_v[\d.]+$/, "").split("_")
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(" ");
}

function asErr(text) {
  const e = $("as-err");
  e.textContent = text || "";
  e.hidden = !text;
}

async function asApi(method, path, body) {
  try {
    const r = await fetch("/api/assistant/" + path, {
      method, body: body === undefined ? undefined : JSON.stringify(body),
      headers: body === undefined ? undefined : { "Content-Type": "application/json" },
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(j.error || r.statusText);
    if (j.state) asRender(j);
    return j;
  } catch (e) {
    asErr(e.message);
    throw e;
  }
}

async function asPoll(wait) {
  try {
    const r = await fetch("/api/assistant/status" + (wait ? "?wait=1" : ""), { cache: "no-store" });
    if (!r.ok) throw new Error(r.statusText);
    asRender(await r.json());
    setTimeout(() => asPoll(true), 50);
  } catch {
    asOffline();
    setTimeout(() => asPoll(false), 3000);
  }
}

function asOffline() {
  $("as-state").textContent = "Assistant offline";
  $("as-orb").dataset.state = "off";
  $("as-overlay").hidden = true;
}

function asSync(on) {
  $("tab-assistant").hidden = !on;
  $("aspage").hidden = !on;
  if (on && !asLoop) { asLoop = true; asPoll(false); }
}

function fmtLeft(sec) {
  sec = Math.max(0, Math.round(sec));
  const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
  const p = (n) => String(n).padStart(2, "0");
  return h ? `${h}:${p(m)}:${p(s)}` : `${m}:${p(s)}`;
}
const fmtWhen = (iso) => new Date(iso).toLocaleString([], { weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });

function xButton(label, onClick) {
  const b = el("button", "x", "×");
  b.type = "button";
  b.setAttribute("aria-label", label);
  b.addEventListener("click", onClick);
  return b;
}

function asListCard(name) {
  let c = asCards.get(name);
  if (c) return c;
  const card = el("div", "card");
  const h = el("h3", "", listTitle[name] || name.charAt(0).toUpperCase() + name.slice(1));
  const ul = el("ul", "as-items");
  const form = el("form", "as-add");
  const input = el("input");
  input.type = "text";
  input.placeholder = "Add…";
  input.setAttribute("aria-label", "Add to " + name);
  const add = el("button", "btn", "+");
  add.type = "submit";
  form.append(input, add);
  form.addEventListener("submit", (e) => {
    e.preventDefault();
    const text = input.value.trim();
    if (!text) return;
    input.value = "";
    asApi("POST", `lists/${encodeURIComponent(name)}/items`, { text }).catch(() => {});
  });
  const clear = el("button", "btn as-clear", "Clear done");
  clear.type = "button";
  clear.addEventListener("click", () => asApi("POST", `lists/${encodeURIComponent(name)}/clear-done`).catch(() => {}));
  card.append(h, ul, form, clear);
  c = { card, ul, clear };
  asCards.set(name, c);
  return c;
}

function asRender(s) {
  asSt = s;
  const state = s.muted && s.state === "idle" ? "muted" : s.state;
  $("as-name").textContent = s.name;
  $("as-state").textContent = state === "muted" ? "Microphone off · type below"
    : state === "idle" ? `Say “${asWake(s)}”` : asStateText[state] || state;
  $("as-orb").dataset.state = state;
  $("as-mute").textContent = s.muted ? "🔇 Mic off" : "🎙 Mic on";
  $("as-mute").setAttribute("aria-pressed", String(s.muted));
  $("as-mute").classList.toggle("off", s.muted);
  $("as-stop").hidden = state === "idle" || state === "muted";
  asErr(s.error);

  // Conversation, newest at the bottom.
  const log = $("as-log");
  log.replaceChildren(...s.log.slice(-6).map((x) => {
    const li = el("li");
    if (x.heard) li.append(el("p", "you", (x.typed ? "⌨ " : "🗣 ") + x.heard));
    li.append(el("p", "bot", x.reply));
    return li;
  }));
  if (!s.log.length) log.append(el("li", "empty", "Nothing yet."));
  log.scrollTop = log.scrollHeight;

  // House lists.
  const lists = $("as-lists");
  const order = s.listOrder;
  if (lists.dataset.key !== order.join("|")) {
    lists.dataset.key = order.join("|");
    lists.replaceChildren(...order.map((n) => asListCard(n).card));
  }
  for (const name of order) {
    const c = asListCard(name);
    const items = s.lists[name] || [];
    c.ul.replaceChildren(...items.map((it) => {
      const li = el("li", it.done ? "done" : "");
      const lab = el("label");
      const cb = el("input");
      cb.type = "checkbox";
      cb.checked = it.done;
      cb.addEventListener("change", () => asApi("POST", `lists/${encodeURIComponent(name)}/items/${it.id}/done`, { done: cb.checked }).catch(() => {}));
      lab.append(cb, el("span", "", it.text));
      const meta = [it.assignee, it.due].filter(Boolean).join(" · ");
      if (meta) lab.append(el("small", "", meta));
      li.append(lab, xButton("Remove " + it.text, () => asApi("DELETE", `lists/${encodeURIComponent(name)}/items/${it.id}`).catch(() => {})));
      return li;
    }));
    if (!items.length) c.ul.append(el("li", "empty", "Empty"));
    c.clear.hidden = !items.some((it) => it.done);
  }

  // Timers and reminders.
  const alarms = $("as-alarms");
  alarms.replaceChildren(
    ...s.timers.map((t) => {
      const li = el("li");
      const left = el("b", "count");
      left.dataset.ends = t.ends;
      left.textContent = fmtLeft((new Date(t.ends) - Date.now()) / 1000);
      li.append(el("span", "", "⏱ " + (t.label || "Timer")), left, xButton("Cancel timer", () => asApi("DELETE", "timers/" + t.id).catch(() => {})));
      return li;
    }),
    ...s.reminders.map((r) => {
      const li = el("li");
      li.append(el("span", "", "🔔 " + r.text), el("small", "", fmtWhen(r.at) + (r.repeat ? " · " + r.repeat : "")),
        xButton("Delete reminder", () => asApi("DELETE", "reminders/" + r.id).catch(() => {})));
      return li;
    }),
  );
  if (!s.timers.length && !s.reminders.length) alarms.append(el("li", "empty", "None"));

  // Memory.
  const mem = $("as-mem");
  mem.replaceChildren(...s.memories.map((m) => {
    const li = el("li");
    li.append(el("span", "", m.fact), xButton("Forget", () => asApi("DELETE", "memories/" + m.id).catch(() => {})));
    return li;
  }));
  if (!s.memories.length) mem.append(el("li", "empty", "Nothing yet. Tell it about yourself, or add facts here."));

  if (!asVolBusy) {
    $("as-vol").value = s.volume;
    $("as-vol-v").textContent = s.volume + "%";
  }

  // The built-in screen shows what the assistant is doing, full screen.
  const ov = $("as-overlay");
  ov.hidden = !kiosk || state === "idle" || state === "muted";
  if (!ov.hidden) {
    $("as-orb-big").dataset.state = state;
    $("as-ov-state").textContent = asStateText[state] || state;
    const last = s.log[s.log.length - 1];
    $("as-ov-text").textContent = (state === "speaking" || state === "ringing") && last ? last.reply : "";
  }
}

setInterval(() => {
  document.querySelectorAll(".count[data-ends]").forEach((e) => { e.textContent = fmtLeft((new Date(e.dataset.ends) - Date.now()) / 1000); });
}, 1000);

$("as-ask").addEventListener("submit", async (e) => {
  e.preventDefault();
  const input = $("as-input");
  const text = input.value.trim();
  if (!text) return;
  $("as-send").disabled = true;
  $("as-send").textContent = "…";
  try {
    await asApi("POST", "chat", { text, speak: $("as-speak").checked });
    input.value = "";
  } catch {
    // shown in the error line
  } finally {
    $("as-send").disabled = false;
    $("as-send").textContent = "Send";
  }
});
$("as-mute").addEventListener("click", () => asApi("POST", "mute", { muted: !(asSt && asSt.muted) }).catch(() => {}));
$("as-stop").addEventListener("click", () => asApi("POST", "stop").catch(() => {}));
$("as-ov-stop").addEventListener("click", () => asApi("POST", "stop").catch(() => {}));
document.querySelector("form[data-mem]").addEventListener("submit", (e) => {
  e.preventDefault();
  const input = e.target.querySelector("input");
  const fact = input.value.trim();
  if (!fact) return;
  input.value = "";
  asApi("POST", "memories", { fact }).catch(() => {});
});
const asVol = $("as-vol");
asVol.addEventListener("input", () => { asVolBusy = true; $("as-vol-v").textContent = asVol.value + "%"; });
asVol.addEventListener("change", () => {
  asApi("POST", "volume", { percent: Number(asVol.value) }).catch(() => {}).then(() => { asVolBusy = false; });
});

// ---- status polling ----
function render(st) {
  document.title = st.hostname;
  $("host").textContent = st.hostname;
  $("up-pill").textContent = "up " + fmtUptime(st.uptimeSec);

  const b = st.battery;
  const bp = $("bat-pill");
  bp.hidden = !b.present;
  if (b.present) {
    bp.textContent = (b.onBattery ? "🔋 on battery " : "⚡ ") + b.percent + "%";
    bp.className = "pill" + (b.onBattery ? (b.percent <= 15 ? " bad" : " warn") : "");
  }

  $("cpu-v").textContent = st.cpu.toFixed(0) + "%";
  setBar("cpu-b", st.cpu);

  const mp = st.memTotal ? (st.memUsed / st.memTotal) * 100 : 0;
  $("mem-v").textContent = `${fmtBytes(st.memUsed)} / ${fmtBytes(st.memTotal)}`;
  setBar("mem-b", mp, 80, 92);

  const disks = $("disks");
  disks.replaceChildren(...st.disks.map((d) => {
    const pct = d.total ? (d.used / d.total) * 100 : 0;
    const m = el("div", "meter");
    const l = el("label", "", `Disk ${d.mount}`);
    l.append(el("b", "", `${fmtBytes(d.used)} / ${fmtBytes(d.total)}`));
    const bar = el("div", "bar");
    const i = el("i");
    i.style.width = pct + "%";
    i.className = level(pct, 80, 92);
    bar.append(i);
    m.append(l, bar);
    return m;
  }));

  const hot = st.temps.reduce((m, t) => Math.max(m, t.C), 0);
  $("temp-v").textContent = st.temps.length ? hot.toFixed(0) + " °C" : "n/a";
  setBar("temp-b", hot, 75, 90);

  $("load-v").textContent = st.load.map((n) => n.toFixed(2)).join("  ");

  const br = st.brightness;
  $("bright").hidden = !br.available;
  if (br.available && !brightBusy && document.activeElement !== slider) {
    slider.value = br.percent;
    $("bright-v").textContent = br.percent + "%";
  }

  renderServices(st.services);
  camSync(st.camera, st.cameraViewers);
  tvSync(st.tv);
  asSync(st.assistant);
}

let failures = 0;
async function poll() {
  try {
    const r = await fetch("/api/status", { cache: "no-store" });
    if (!r.ok) throw new Error(r.statusText);
    render(await r.json());
    failures = 0;
  } catch {
    failures++;
  }
  $("offline").hidden = failures < 2;
  setTimeout(poll, 3000);
}
poll();
