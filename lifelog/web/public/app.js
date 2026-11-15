// The offline queue. A note or a reading is written into IndexedDB on the
// phone first, with its day and instant from the phone's clock and an id,
// then sent. What the tablet does not answer stays queued and is sent again
// when the phone is online; the id makes a second send do nothing.

const DB = "lifelog";
const STORE = "captures";

function open() {
  return new Promise((resolve, reject) => {
    const r = indexedDB.open(DB, 1);
    r.onupgradeneeded = () => r.result.createObjectStore(STORE, { keyPath: "id" });
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}

async function store(mode, fn) {
  const db = await open();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, mode);
    const out = fn(tx.objectStore(STORE));
    tx.oncomplete = () => resolve(out?.result ?? out);
    tx.onerror = () => reject(tx.error);
  });
}

const put = (c) => store("readwrite", (s) => s.put(c));
const remove = (id) => store("readwrite", (s) => s.delete(id));
const all = () => store("readonly", (s) => s.getAll());

// The phone's own day and instant, with its offset: 2026-11-15T08:30:00+02:00.
function now() {
  const d = new Date();
  const p = (n) => String(Math.abs(n)).padStart(2, "0");
  const day = `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
  const off = -d.getTimezoneOffset();
  const at = `${day}T${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}${off >= 0 ? "+" : "-"}${p(Math.trunc(off / 60))}:${p(off % 60)}`;
  return { day, at };
}

let flushing = false;
async function flush() {
  if (flushing) return;
  flushing = true;
  let sent = 0;
  try {
    for (const c of await all()) {
      if (c.failed) continue;
      const { failed, ...body } = c;
      let res;
      try {
        res = await fetch("/api/capture", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        });
      } catch {
        break; // offline: keep the rest for later
      }
      if (res.ok) {
        await remove(c.id);
        sent++;
      } else if (res.status === 422 || res.status === 400) {
        const answer = await res.json().catch(() => ({}));
        await put({ ...c, failed: answer.message || `refused (${res.status})` });
      } else {
        break; // the tablet has a problem: try again later
      }
    }
  } finally {
    flushing = false;
  }
  await show();
  if (sent > 0 && document.body.dataset.reload !== "no" && navigator.onLine) location.reload();
}

async function show() {
  const el = document.getElementById("queue");
  if (!el) return;
  const items = await all();
  const waiting = items.filter((c) => !c.failed);
  const failed = items.filter((c) => c.failed);
  el.hidden = items.length === 0;
  el.textContent = "";
  if (waiting.length > 0) el.append(`${waiting.length} waiting to send`);
  for (const c of failed) {
    const b = document.createElement("button");
    b.textContent = `Not saved: ${c.type === "note" ? c.text.slice(0, 30) : `${c.metric} ${c.value}`}: ${c.failed}. Discard`;
    b.addEventListener("click", async () => {
      if (c.type === "note") await navigator.clipboard?.writeText(c.text).catch(() => {});
      await remove(c.id);
      show();
    });
    el.append(b);
  }
}

document.addEventListener("submit", async (e) => {
  const form = e.target;
  if (!form.dataset.capture || !("indexedDB" in window)) return; // without IndexedDB the form posts itself
  e.preventDefault();
  const data = Object.fromEntries(new FormData(form));
  const clock = now();
  const c = { ...data, id: crypto.randomUUID() };
  if (!c.day || c.day === clock.day) {
    c.day = clock.day;
    c.at = clock.at;
  } else {
    // A note or a reading for another day: that day, and no instant.
    c.at = "";
  }
  await put(c);
  form.reset();
  await show();
  await flush();
});

window.addEventListener("online", flush);
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible") flush();
});

if ("serviceWorker" in navigator) navigator.serviceWorker.register("/sw.js").catch(() => {});
if ("indexedDB" in window) flush();
