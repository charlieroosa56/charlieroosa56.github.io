/* Machine List: what's saved on this phone, and the trip to your sheet and back.
   The app page and the background helper (sw.js) both use this, so they always agree.

   Saved on the phone (IndexedDB "machine-list"):
     setup   { key, url, device }        the setup code and the sheet's sync link
     base    { ver, state, at }          the last copy of everything the sheet sent
     outbox  [op, ...]                   things you did that the sheet hasn't confirmed yet
     pin     { salt, hash, after }       the app lock
     lastOk  time of the last good trip to the sheet */
(function (root) {
  "use strict";
  const DB_NAME = "machine-list";
  const STORE = "kv";
  const OPEN_MS = 4000;
  let dbp = null, conn = null, gen = 0;

  // Opens this phone's storage. Now and then a phone (iPhones especially, right after the app comes back)
  // can't reach its storage for a moment: a stuck open gives up after a few seconds so the next try starts fresh.
  function open() {
    if (dbp) return dbp;
    const my = ++gen;
    const p = new Promise((resolve, reject) => {
      let req, timer = null, done = false;
      const fail = err => { if (done) return; done = true; clearTimeout(timer); reject(err); };
      timer = setTimeout(() => fail(new Error("This phone's storage didn't answer")), OPEN_MS);
      try { req = indexedDB.open(DB_NAME, 1); } catch (e) { fail(e); return; }
      req.onupgradeneeded = () => {
        const d = req.result;
        if (!d.objectStoreNames.contains(STORE)) d.createObjectStore(STORE);
      };
      req.onsuccess = () => {
        const d = req.result;
        if (done || gen !== my) { try { d.close(); } catch (e) { /* a late answer nobody is waiting for */ } fail(new Error("Storage reopened")); return; }
        done = true;
        clearTimeout(timer);
        d.onversionchange = () => { try { d.close(); } catch (e) { /* already closed */ } if (gen === my) { dbp = null; conn = null; } };
        d.onclose = () => { if (gen === my) { dbp = null; conn = null; } };
        conn = d;
        resolve(d);
      };
      req.onerror = () => fail(req.error || new Error("Couldn't open this phone's storage"));
    });
    dbp = p;
    p.catch(() => { if (gen === my) { dbp = null; conn = null; } });
    return p;
  }

  // Drops the connection, so the next step opens a fresh one.
  function reset() {
    gen++;
    dbp = null;
    const d = conn;
    conn = null;
    if (d) { try { d.close(); } catch (e) { /* already closed */ } }
  }

  function attempt(mode, body) {
    return open().then(d => new Promise((resolve, reject) => {
      let t;
      try { t = d.transaction(STORE, mode); } catch (e) { reject(e); return; }
      let out;
      try { out = body(t.objectStore(STORE)); }
      catch (e) {
        try { t.abort(); } catch (x) { /* done */ }
        try { e.mine = true; } catch (x) { /* plain value */ }
        reject(e);
        return;
      }
      t.oncomplete = () => resolve(typeof out === "function" ? out() : out);
      t.onerror = () => reject(t.error || new Error("Storage error"));
      t.onabort = () => reject(t.error || new Error("Storage write was cancelled"));
    }));
  }

  // Runs one transaction. Phones sometimes drop their storage connection while the app is in the background
  // (the step fails, nothing is half-saved), so a failed step gets one more try on a fresh connection.
  function run(mode, body) {
    return attempt(mode, body).catch(err => {
      if (err && (err.mine || err.name === "QuotaExceededError" || err.name === "DataCloneError")) throw err;
      reset();
      return new Promise(r => setTimeout(r, 150)).then(() => attempt(mode, body));
    });
  }

  function get(key) {
    return run("readonly", s => { const q = s.get(key); return () => q.result; });
  }
  function set(key, val) {
    return run("readwrite", s => { s.put(val, key); return val; });
  }
  function del(key) {
    return run("readwrite", s => { s.delete(key); return true; });
  }
  function clearAll() {
    return run("readwrite", s => { s.clear(); return true; });
  }
  // Read, change and write one value in a single step, so two writers can't step on each other.
  function update(key, fn) {
    return run("readwrite", s => {
      let out;
      const q = s.get(key);
      q.onsuccess = () => { out = fn(q.result); s.put(out, key); };
      return () => out;
    });
  }

  const list = v => (Array.isArray(v) ? v : []);
  const addOp = op => update("outbox", ob => list(ob).concat([op]));
  function dropOps(ids) {
    const gone = new Set(ids);
    return update("outbox", ob => list(ob).filter(op => op && !gone.has(op.id)));
  }

  // The sheet's sync link is a Google Apps Script web app. Plain text keeps the browser from asking
  // permission first (Google doesn't answer that), and Google redirects to the answer.
  async function post(url, body, ms) {
    const ctl = typeof AbortController === "function" ? new AbortController() : null;
    const timer = setTimeout(() => { if (ctl) ctl.abort(); }, ms || 45000);
    try {
      const r = await fetch(url, {
        method: "POST", body: JSON.stringify(body), redirect: "follow", credentials: "omit", cache: "no-store",
        headers: { "Content-Type": "text/plain;charset=utf-8" }, signal: ctl ? ctl.signal : undefined
      });
      const text = await r.text();
      try { return JSON.parse(text); } catch (e) {
        const err = new Error(r.ok ? "The sheet sent back something unexpected." : "The sheet answered with error " + r.status + ".");
        err.server = true; err.status = r.status;
        throw err;
      }
    } finally { clearTimeout(timer); }
  }

  // One trip: send up to 40 waiting updates, and get everything back if anything changed.
  async function syncOnce(opts) {
    opts = opts || {};
    const setup = await get("setup");
    if (!setup || !setup.key || !setup.url) return { ok: false, error: "not_setup" };
    const base = await get("base");
    const outbox = list(await get("outbox"));
    const ops = outbox.slice(0, 40);
    const req = {
      key: setup.key, device: setup.device || "", app: root.ML_VERSION || "",
      ver: base && base.ver ? String(base.ver) : "", full: !!opts.full || !base, ops
    };
    if (opts.hello) req.hello = opts.hello;   // a note for the sheet's Sync tab: this phone just set up, or got past a storage hiccup
    let res;
    try { res = await post(setup.url, req, opts.timeout); }
    catch (e) {
      if (e && e.server) return { ok: false, error: "server", message: e.message };
      return { ok: false, offline: true, error: e && e.name === "AbortError" ? "timeout" : "network" };
    }
    if (!res || res.ok !== true) return { ok: false, error: (res && res.error) || "server", message: (res && res.message) || "" };
    const done = list(res.applied).concat(list(res.rejected).map(r => r && r.id)).filter(Boolean);
    if (done.length) await dropOps(done);
    const now = Date.now();
    if (res.state) await set("base", { ver: String(res.ver || ""), state: res.state, at: now });
    else if (base) await set("base", Object.assign({}, base, { ver: String(res.ver || base.ver || ""), checked: now }));
    await set("lastOk", now);
    const left = list(await get("outbox")).length;
    return { ok: true, sent: ops.length, applied: list(res.applied), rejected: list(res.rejected), left, gotState: !!res.state, ver: String(res.ver || "") };
  }

  // Keeps going until nothing is waiting (or a trip fails).
  async function syncAll(opts) {
    let last = null;
    for (let i = 0; i < 8; i++) {
      last = await syncOnce(i === 0 ? opts : { timeout: opts && opts.timeout });
      if (!last.ok || !last.left || !last.sent) break;
    }
    return last;
  }

  // The page and the background helper never talk to the sheet at the same time.
  function withLock(fn) {
    const nav = root.navigator;
    if (nav && nav.locks && typeof nav.locks.request === "function") return nav.locks.request("ml-sync", fn);
    return fn();
  }

  root.MLSync = { open, reset, get, set, del, clearAll, update, addOp, dropOps, post, syncOnce, syncAll, withLock };
})(typeof self !== "undefined" ? self : globalThis);
