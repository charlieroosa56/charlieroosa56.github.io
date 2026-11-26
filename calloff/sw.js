/* Call Off List background helper. Keeps a copy of the app on this phone so it opens with no signal.
   A new version (the line below changes) replaces the old copy. */
const VERSION = "2026.11.25-140ecd";
const CACHE = "calloff-" + VERSION;
const FILES = [
 "./",
 "index.html",
 "app.js",
 "config.js",
 "manifest.webmanifest",
 "icons/icon-192.png",
 "icons/icon-512.png",
 "icons/icon-maskable-512.png",
 "icons/apple-touch-icon.png"
];
// Only answers for this app's own files under /calloff/. The Machine List app at the site's top has its own helper.
const SCOPE = new URL(self.registration.scope);
const PAGES = new Set([SCOPE.pathname, SCOPE.pathname + "index.html"]);
const OWN = new Set(FILES.map(f => new URL(f, SCOPE).pathname));

self.addEventListener("install", event => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE);
    await cache.addAll(FILES.map(f => new Request(f, { cache: "reload" })));
    await self.skipWaiting();
  })());
});
self.addEventListener("activate", event => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter(k => k.startsWith("calloff-") && k !== CACHE).map(k => caches.delete(k)));
    await self.clients.claim();
  })());
});
// Pages: try the web first (so updates show up), fall back to the saved copy with no signal.
// Files: saved copy first.
self.addEventListener("fetch", event => {
  const req = event.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;   // the master sheet always goes to the web
  if (req.mode === "navigate") {
    if (!PAGES.has(url.pathname)) return;
    event.respondWith((async () => {
      const cache = await caches.open(CACHE);
      try {
        const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), 4000);
        const fresh = await fetch(req, { signal: ctl.signal }); clearTimeout(t);
        if (fresh.ok) return fresh;
      } catch (e) { /* no signal */ }
      return (await cache.match("index.html")) || (await cache.match("./")) || new Response("Call Off List needs signal the first time it opens.", { status: 503, headers: { "Content-Type": "text/plain" } });
    })());
    return;
  }
  if (!OWN.has(url.pathname)) return;
  event.respondWith((async () => {
    const cache = await caches.open(CACHE);
    const hit = await cache.match(req, { ignoreSearch: true });
    return hit || fetch(req);
  })());
});
