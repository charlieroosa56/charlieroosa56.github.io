/* Machine List background helper. It keeps a copy of the app on this phone so the app opens with no
   signal, and on Android it sends waiting updates by itself once there's service, even with the app closed.
   The build fills in the version and file list below; a new version replaces the old copy. */
self.ML_VERSION = "2026.10.30-2e606b";
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
 "icons/badge-96.png",
 "icons/icon-192.png",
 "icons/icon-512.png",
 "icons/icon-maskable-512.png",
 "index.html",
 "manifest.webmanifest",
 "styles.css",
 "sync-core.js",
 "version.js"
];
// It only answers for this app's own pages and files. Other apps on this site (Parts lives under /parts/)
// have their own helper, so their pages and files go straight past this one.
const SCOPE = new URL(self.registration.scope);
const PAGES = new Set([SCOPE.pathname, SCOPE.pathname + "index.html"]);
const OWN = new Set(FILES.map(f => new URL(f, SCOPE).pathname));
const isOurPage = href => { try { return PAGES.has(new URL(href).pathname); } catch (e) { return false; } };

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
    if (!PAGES.has(url.pathname)) return;   // another app's page
    event.respondWith((async () => {
      const cache = await caches.open(CACHE);
      const page = await cache.match("index.html");
      if (page) return page;
      try { return await fetch(req); } catch (e) { return new Response("Machine List needs signal the first time it opens.", { status: 503, headers: { "Content-Type": "text/plain" } }); }
    })());
    return;
  }
  if (!OWN.has(url.pathname)) return;   // not one of this app's files
  event.respondWith((async () => {
    const cache = await caches.open(CACHE);
    const hit = await cache.match(req, { ignoreSearch: true });
    return hit || fetch(req);
  })());
});

// The daily reminder: your sheet sends an empty push around 6:30 PM; this gets the latest from the sheet if it
// can (a few seconds at most), then says what's waiting from this phone's own copy.
async function reminderText() {
  const base = await MLSync.get("base");
  const st = base && base.state;
  if (!st) return { title: "Machine List", body: "Tap to check today's updates." };
  const changes = Array.isArray(st.changes) ? st.changes : [];
  const waiting = changes.filter(c => c && !c.synced && !c.approval && !/^not used/i.test(c.note || "")).length;
  const probs = (st.problems || []).filter(p => p && p.status === "open").length;
  const fuel = (st.units || []).filter(u => u && u.fuel && u.fuel.needs).length;
  const out = [];
  if (waiting) out.push(waiting === 1 ? "1 change is waiting for your OK." : waiting + " changes are waiting for your OK.");
  if (probs) out.push(probs === 1 ? "1 problem is open." : probs + " problems are open.");
  if (fuel) out.push(fuel === 1 ? "1 unit needs fuel." : fuel + " units need fuel.");
  return { title: (st.config && st.config.brand) || "Machine List", body: out.length ? out.join(" ") : "Nothing is waiting on you. Tap to look things over." };
}
self.addEventListener("push", event => {
  event.waitUntil((async () => {
    try { await Promise.race([MLSync.withLock(() => MLSync.syncAll({ timeout: 7000 })), new Promise(r => setTimeout(r, 8000))]); }
    catch (e) { /* show what's on the phone */ }
    let t = { title: "Machine List", body: "Tap to check today's updates." };
    try { t = await reminderText(); } catch (e) { /* plain note */ }
    await self.registration.showNotification(t.title, {
      body: t.body, tag: "ml-daily", renotify: true, icon: "icons/icon-192.png", badge: "icons/badge-96.png",
      data: { url: new URL("./?open=changes", SCOPE).href }
    });
  })());
});
// Tapping it opens the app on the Changes tab (or brings the open app forward and switches to it).
self.addEventListener("notificationclick", event => {
  event.notification.close();
  event.waitUntil((async () => {
    const wins = (await self.clients.matchAll({ type: "window", includeUncontrolled: true })).filter(w => isOurPage(w.url));
    if (wins.length) {
      const w = wins.find(x => x.visibilityState === "visible") || wins[0];
      try { await w.focus(); } catch (e) { /* not allowed to focus */ }
      w.postMessage({ t: "open", tab: "changes" });
      return;
    }
    await self.clients.openWindow((event.notification.data && event.notification.data.url) || SCOPE.href);
  })());
});
// The push service changed this phone's address: sign up again with the same key and tell the sheet.
self.addEventListener("pushsubscriptionchange", event => {
  event.waitUntil((async () => {
    const base = await MLSync.get("base"), setup = await MLSync.get("setup");
    const key = base && base.state && base.state.config && base.state.config.pushKey;
    if (!key || !setup) return;
    const raw = atob((key + "===".slice((key.length + 3) % 4)).replace(/-/g, "+").replace(/_/g, "/"));
    const sub = await self.registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: Uint8Array.from(raw, c => c.charCodeAt(0)) });
    const id = "O-" + Date.now().toString(36).toUpperCase() + "-SUBX";
    await MLSync.addOp({ id, t: "push", at: new Date().toISOString(), on: true, sub: sub.toJSON(), device: setup.device || "" });
    await MLSync.withLock(() => MLSync.syncAll({ timeout: 20000 }));
  })());
});

// Android: the browser wakes this up once there's signal again.
self.addEventListener("sync", event => {
  if (event.tag !== "ml-push") return;
  event.waitUntil((async () => {
    const wins = (await self.clients.matchAll({ type: "window", includeUncontrolled: true })).filter(w => isOurPage(w.url));
    if (wins.some(w => w.visibilityState === "visible")) return;   // an open app sends its own
    const r = await MLSync.withLock(() => MLSync.syncAll({ timeout: 40000 }));
    wins.forEach(w => w.postMessage({ t: "synced" }));
    if (r && !r.ok && r.offline) throw new Error("No signal yet");   // the browser tries again later
  })());
});
