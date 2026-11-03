"use strict";

const kiosk = new URLSearchParams(location.search).has("kiosk");
if (kiosk) document.body.classList.add("kiosk");

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
  open.target = kiosk ? "_self" : "_blank";
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
      if (document.querySelector(".tab.active")?.dataset.tab !== "services" || sheetFor) showTab("services");
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
