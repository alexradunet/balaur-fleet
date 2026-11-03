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
      const t = el(kiosk || !s.port ? "div" : "a", "tile");
      if (!kiosk && s.port) t.href = serviceURL(s);
      if (kiosk) {
        t.setAttribute("role", "button");
        t.tabIndex = 0;
        t.addEventListener("click", () => openSheet(s.name));
      }
      t.append(el("span", "dot"), el("span", "icon", s.icon || "•"), el("span", "name", s.name), el("span", "desc", s.description || ""));
      tiles.set(s.name, t);
      root.append(t);
    }
  }
  serviceData = new Map(services.map((s) => [s.name, s]));
  for (const s of services) tiles.get(s.name).dataset.state = s.state;
  if (sheetFor) fillSheet(); // keep an open sheet live
}

// ---- kiosk: tabs, detail sheet, idle reset ----
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
}
function openSheet(name) { sheetFor = name; fillSheet(); sheet.hidden = false; }
function closeSheet() { sheetFor = null; sheet.hidden = true; }
$("sheet-close").addEventListener("click", closeSheet);
sheet.addEventListener("click", (e) => { if (e.target === sheet) closeSheet(); });

function showTab(name) {
  closeSheet();
  document.querySelectorAll("[data-page]").forEach((p) => p.classList.toggle("active", p.dataset.page === name));
  document.querySelectorAll(".tab").forEach((t) => t.classList.toggle("active", t.dataset.tab === name));
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

// ---- front camera preview (kiosk only) ----
// The device is the "Duet Front Camera" webcam that duet-camera-relay exposes;
// Chromium may not offer the raw IPU nodes, so prefer it by label. Tap the
// preview to switch it off (the camera is released) and on again.
const cam = $("cam");
const camVideo = $("cam-v");
let camWanted = false;   // the server says a camera is configured (and we are the kiosk)
let camOn = true;        // user's tap toggle
let camStream = null;
let camBusy = false;
let camRetry = 0;

function camState(state, msg) {
  cam.dataset.state = state;
  $("cam-msg").textContent = msg || "";
}

function camStop(state, msg) {
  const s = camStream;
  camStream = null;
  camVideo.srcObject = null;
  if (s) s.getTracks().forEach((t) => t.stop());
  camState(state, msg);
}

async function camFind() {
  const devs = await navigator.mediaDevices.enumerateDevices();
  return devs.find((d) => d.kind === "videoinput" && d.label.toLowerCase().includes("duet front camera"));
}

async function camStart() {
  if (camBusy || camStream || !camOn || !camWanted) return;
  if (!navigator.mediaDevices?.getUserMedia) { camState("error", "Camera not supported"); return; }
  camBusy = true;
  if (cam.dataset.state !== "error") camState("starting", "Camera starting…"); // no flicker while retrying
  let s = null;
  try {
    const video = { width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 30, max: 30 } };
    let dev = await camFind();
    s = await navigator.mediaDevices.getUserMedia({ audio: false, video: dev ? { ...video, deviceId: { exact: dev.deviceId } } : video });
    if (!dev) { // labels are only visible after the first grant; switch if Chromium picked another node
      dev = await camFind();
      if (dev && dev.deviceId !== s.getVideoTracks()[0]?.getSettings().deviceId) {
        s.getTracks().forEach((t) => t.stop());
        s = await navigator.mediaDevices.getUserMedia({ audio: false, video: { ...video, deviceId: { exact: dev.deviceId } } });
      }
    }
    camStream = s;
    camVideo.srcObject = s;
    await camVideo.play();
    s.getVideoTracks()[0]?.addEventListener("ended", () => {
      if (camStream === s) camStop("error", "Camera stream stopped");
    }, { once: true });
    camState("live");
  } catch (e) {
    if (s && s !== camStream) s.getTracks().forEach((t) => t.stop());
    camStop("error", e?.name === "NotFoundError" || e?.name === "OverconstrainedError" ? "No camera found" : "Camera unavailable");
  } finally {
    camBusy = false;
  }
}

cam.addEventListener("click", () => {
  camOn = !camOn;
  if (camOn) camStart();
  else camStop("off", "Camera off — tap to turn on");
});

// Called from render(): show the tile once, then keep trying while it is wanted.
function camSync(enabled) {
  camWanted = kiosk && !!enabled;
  $("camview").hidden = !camWanted;
  $("tab-camera").hidden = !camWanted;
  if (!camWanted && $("camview").classList.contains("active")) showTab("services");
  if (camWanted && camOn && !camStream && !camBusy && Date.now() >= camRetry) {
    camRetry = Date.now() + 10000; // the relay may start after the dashboard
    camStart();
  }
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
  camSync(st.camera);
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
