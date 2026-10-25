/* Machine List background helper. It keeps a copy of the app on this phone so the app opens with no
   signal, and on Android it sends waiting updates by itself once there's service, even with the app closed.
   The build fills in the version and file list below; a new version replaces the old copy. */
self.ML_VERSION = "2026.10.25-aef78a";
importScripts("sync-core.js");

const CACHE = "ml-" + self.ML_VERSION;
const FILES = [
 "app.js",
 "config.js",
 "core.js",
 "fonts/barlow-condensed-latin-600-normal.woff2",
 "fonts/barlow-condensed-latin-700-normal.woff2",
 "fonts/barlow-latin-400-normal.woff2",
 "fonts/barlow-latin-500-normal.woff2",
 "fonts/barlow-latin-600-normal.woff2",
 "fonts/fonts.css",
 "fonts/ibm-plex-mono-latin-400-normal.woff2",
 "fonts/ibm-plex-mono-latin-500-normal.woff2",
 "fonts/ibm-plex-mono-latin-600-normal.woff2",
 "icons/apple-touch-icon.png",
 "icons/icon-192.png",
 "icons/icon-512.png",
 "icons/icon-maskable-512.png",
 "index.html",
 "manifest.webmanifest",
 "styles.css",
 "sync-core.js",
 "version.js"
];

self.addEventListener("install", event => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE);
    // Straight from the web, not the browser's short-term cache, so a new version is really new.
    await cache.addAll(FILES.map(f => new Request(f, { cache: "reload" })));
    await self.skipWaiting();
  })());
});

self.addEventListener("activate", event => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter(k => k.startsWith("ml-") && k !== CACHE).map(k => caches.delete(k)));
    await self.clients.claim();
  })());
});

self.addEventListener("fetch", event => {
  const req = event.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;   // the trip to your sheet always goes to the web
  if (req.mode === "navigate") {
    event.respondWith((async () => {
      const cache = await caches.open(CACHE);
      const page = await cache.match("index.html");
      if (page) return page;
      try { return await fetch(req); } catch (e) { return new Response("Machine List needs signal the first time it opens.", { status: 503, headers: { "Content-Type": "text/plain" } }); }
    })());
    return;
  }
  event.respondWith((async () => {
    const cache = await caches.open(CACHE);
    const hit = await cache.match(req, { ignoreSearch: true });
    return hit || fetch(req);
  })());
});

// Android: the browser wakes this up once there's signal again.
self.addEventListener("sync", event => {
  if (event.tag !== "ml-push") return;
  event.waitUntil((async () => {
    const wins = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    if (wins.some(w => w.visibilityState === "visible")) return;   // an open app sends its own
    const r = await MLSync.withLock(() => MLSync.syncAll({ timeout: 40000 }));
    wins.forEach(w => w.postMessage({ t: "synced" }));
    if (r && !r.ok && r.offline) throw new Error("No signal yet");   // the browser tries again later
  })());
});
