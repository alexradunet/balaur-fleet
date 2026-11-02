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
      t.append(el("span", "dot"), el("span", "icon", s.icon || "•"), el("span", "name", s.name), el("span", "desc", s.description || ""));
      tiles.set(s.name, t);
      root.append(t);
    }
  }
  for (const s of services) tiles.get(s.name).dataset.state = s.state;
}

// ---- brightness ----
let brightBusy = false;
const slider = $("bright-r");
slider.addEventListener("input", () => { $("bright-v").textContent = slider.value + "%"; });
slider.addEventListener("change", async () => {
  brightBusy = true;
  try {
    await fetch("/api/brightness", { method: "POST", body: JSON.stringify({ percent: +slider.value }) });
  } finally {
    brightBusy = false;
  }
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
