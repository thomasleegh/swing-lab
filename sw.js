// App shell: network-first so redeploys show up on the next open; cache is the offline fallback.
// Pose model + MediaPipe runtime: cache-first (large and versioned by path), so they download once.
// Bump CACHE whenever you ship so installed copies refresh (the page reloads itself once).
const CACHE = "swinglab-v2";
const BIG = "swinglab-models-v1";
const SHELL = ["./", "index.html", "manifest.json", "js/app.js", "js/core.js", "js/rig.js", "js/render.js", "js/store.js", "js/tracker.js", "icon-192.png", "icon-512.png", "apple-touch-icon.png"];
self.addEventListener("install", (e) => { e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL))); self.skipWaiting(); });
self.addEventListener("activate", (e) => {
  e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== CACHE && k !== BIG).map((k) => caches.delete(k)))));
  self.clients.claim();
});
self.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== "GET" || url.origin !== location.origin) return;
  if (url.pathname.includes("/vendor/") || url.pathname.includes("/models/")) {
    e.respondWith(caches.open(BIG).then((c) => c.match(e.request).then((m) => m || fetch(e.request).then((r) => { if (r.ok) c.put(e.request, r.clone()); return r; }))));
    return;
  }
  e.respondWith(fetch(e.request).then((r) => { if (r.ok) { const copy = r.clone(); caches.open(CACHE).then((c) => c.put(e.request, copy)); } return r; })
    .catch(() => caches.match(e.request).then((m) => m || caches.match("index.html"))));
});
