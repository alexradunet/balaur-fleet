// The service worker: the app shell works offline, so a note or a reading
// can be written into the queue (app.js) with no tablet in reach. Pages are
// always asked of the tablet first; offline, the capture page answers.
// The server writes the version (a hash of the static files) below.

const VERSION = "__VERSION__";
const CACHE = `lifelog-${VERSION}`;
// The server writes the shell: /capture and every static file (staticFiles() in server.js).
const SHELL = "__SHELL__";

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k.startsWith("lifelog-") && k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (e) => {
  const req = e.request;
  if (req.method !== "GET") return; // writes go to the network, or into app.js's queue
  const url = new URL(req.url);
  if (url.origin !== location.origin) return;
  if (url.pathname.startsWith("/static/") || url.pathname === "/manifest.webmanifest") {
    e.respondWith(caches.match(req).then((hit) => hit || fetch(req)));
    return;
  }
  if (req.mode === "navigate") {
    e.respondWith(
      fetch(req)
        .then((res) => {
          // The capture page with the newest list of metrics.
          if (url.pathname === "/capture" && res.ok) {
            const copy = res.clone();
            caches.open(CACHE).then((c) => c.put("/capture", copy));
          }
          return res;
        })
        .catch(() => caches.match("/capture")),
    );
  }
});
