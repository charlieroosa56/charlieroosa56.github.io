/* Machine List app: same screens as the crew equipment app (Fleet, Due, Changes, and the unit page),
   but everything lives on this phone first. Updates wait in an outbox and go to your sheet by
   themselves once there's signal. */
(function () {
  "use strict";
  const C = window.EQ_CORE;
  const M = window.MLSync;
  const CFG = window.ML_CONFIG || {};
  const VERSION = window.ML_VERSION || "dev";
  const BOOT_AT = Date.now();
  const $ = (sel, el) => (el || document).querySelector(sel);
  const esc = s => String(s === null || s === undefined ? "" : s).replace(/[&<>"']/g, ch => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch]));
  const LONG_TEXT = new Set(["notes", "issues", "attnotes", "ins", "pto"]);
  const IN_CARDS = new Set(["loc", "insp"]); // shown in their own boxes near the top, not in the detail sections
  const PUMP = '<path d="M4 21V5a2 2 0 0 1 2-2h6a2 2 0 0 1 2 2v16"/><path d="M3 21h12"/><path d="M6.5 8h5"/><path d="M14 10h1.5a2 2 0 0 1 2 2v4.5a1.5 1.5 0 0 0 3 0V8.5L18 6"/>';
  const FUEL_SVG = '<svg viewBox="0 0 24 24" aria-hidden="true">' + PUMP + '</svg>';
  const NOFUEL_SVG = '<svg viewBox="0 0 24 24" aria-hidden="true">' + PUMP + '<path d="M2.5 2.5l19 19"/></svg>';
  const SHARE_SVG = '<svg class="share-ico" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 15V3"/><path d="m7 8 5-5 5 5"/><path d="M5 12v7a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-7"/></svg>';
  const POLL_MS = 120000;
  const STALE_RE = /^not used/i;
  const LOCK_CHOICES = [[0, "Every time I open it"], [15 * 60000, "After 15 minutes away"], [60 * 60000, "After an hour away"], [-1, "Never"]];

  const S = {
    phase: "boot",   // boot | setup | app
    me: { name: "", isOwner: true }, readOnly: false,
    units: new Map(), unitsLoaded: false, changes: [], changesLoaded: false, problems: [], problemsLoaded: false,
    tab: "fleet", q: "", cat: "all", st: "all", chFilter: "waiting",
    openId: null, editing: null, detailStale: false, attDraft: null, showNA: false,
    openSecs: new Set(["IDENTITY & STATUS"]), listScroll: 0,
    keyBad: false, update: false, confirmReset: false, installEvt: null, storageError: false,
    sendState: null, sendSkips: {}   // sending approved changes to the master sheet: null | "confirm" | "busy"
  };
  // The sheet's last copy, plus updates made on this phone that the sheet hasn't confirmed yet.
  const D = {
    setup: null, ver: "", baseAt: 0, loaded: false, units: new Map(), changes: [], problems: [], config: {}, sheetUrl: "", changesTotal: 0,
    outbox: [], busy: false, again: null, fails: 0, offline: false, lastOk: 0, tick: 0, timer: null, kickTimer: null, swReg: null
  };
  // The PIN lock.
  const L = { pin: null, open: false, mode: "unlock", entry: "", first: "", msg: "", bad: false, shake: false, fails: 0, until: 0, fromSetup: false };

  function lsGet(k, d) { try { const v = localStorage.getItem("ml." + k); return v === null ? d : JSON.parse(v); } catch (e) { return d; } }
  function lsSet(k, v) { try { localStorage.setItem("ml." + k, JSON.stringify(v)); } catch (e) { /* this phone's convenience only */ } }
  function lsDel(k) { try { localStorage.removeItem("ml." + k); } catch (e) { /* ignore */ } }

  const today = () => C.startOfToday();
  const unitsArr = () => [...S.units.values()].sort((a, b) => ((a.order ?? 999) - (b.order ?? 999)) || a.id.localeCompare(b.id));
  const nameOf = u => (u.v && u.v.name) || u.id;
  const openProblems = id => S.problems.filter(p => p.unit === id && p.status === "open");
  const fixedProblems = id => S.problems.filter(p => p.unit === id && p.status === "fixed");
  // Fuel flags and problem reports from a coworker sit on the Changes list too, but never go to the master sheet.
  const isMasterChange = c => !/^(fuel$|prob:|fix:)/.test(String((c && c.key) || ""));
  const needsFuel = u => !!(u.fuel && u.fuel.needs);
  const hasFuel = u => C.applies(u, "ENG");
  const firstName = n => String(n || "").trim().split(/\s+/)[0] || "";
  const normKey = s => String(s || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
  const fmtKey = c => (c && c.length === 12 ? c.slice(0, 4) + "-" + c.slice(4, 8) + "-" + c.slice(8) : c || "");
  const isOffline = () => D.offline || navigator.onLine === false;

  function whoName(by) {
    if (!by) return "Someone";
    if (S.me.name && by === S.me.name) return "You";
    return firstName(by);
  }
  function whenText(iso) {
    const d = new Date(iso);
    if (!iso || isNaN(d)) return "";
    return C.usDate(d) + " " + d.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
  }
  function shortTime(ms) {
    const d = new Date(ms);
    const t = d.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
    const day = new Date(d); day.setHours(0, 0, 0, 0);
    const diff = Math.round((today() - day) / 86400000);
    return diff === 0 ? t : diff === 1 ? "yesterday " + t : (d.getMonth() + 1) + "/" + d.getDate() + " " + t;
  }
  function standalone() {
    try { return !!(navigator.standalone || window.matchMedia("(display-mode: standalone)").matches); } catch (e) { return false; }
  }
  function isIOS() {
    return /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
  }
  function isAndroid() { return /Android/i.test(navigator.userAgent); }

  function newId(prefix) {
    const r = Math.random().toString(36).slice(2, 6).toUpperCase().padEnd(4, "0");
    return prefix + "-" + Date.now().toString(36).toUpperCase() + "-" + r;
  }
  const clone = o => JSON.parse(JSON.stringify(o));
  function merge(t, s) {
    Object.keys(s).forEach(k => {
      const v = s[k];
      if (v && typeof v === "object" && !Array.isArray(v)) {
        if (!t[k] || typeof t[k] !== "object" || Array.isArray(t[k])) t[k] = {};
        merge(t[k], v);
      } else t[k] = Array.isArray(v) ? v.slice() : v;
    });
    return t;
  }

  // ---------------------------------------------------------------- data on this phone
  function loadState(st, ver, at) {
    st = st || {};
    D.units = new Map((st.units || []).map(u => [u.id, u]));
    D.changes = st.changes || [];
    D.problems = st.problems || [];
    D.config = st.config || {};
    D.sheetUrl = st.sheetUrl || "";
    D.changesTotal = Number(st.changesTotal) || D.changes.length;
    D.ver = String(ver || "");
    D.baseAt = at || 0;
    D.loaded = true;
    applyConfig();
  }

  // Names, people and excavator groups come from the sheet's Settings tab.
  function applyConfig() {
    const c = D.config || {};
    C.configure(c);
    S.me.name = c.name || "Me";
    S.me.isOwner = c.role !== "crew";   // a coworker's code: everything they send waits for the owner's approval
    const mark = $("#brandMark"), name = $("#brandName");
    if (mark) mark.textContent = c.mark || "ML";
    if (name) name.textContent = c.brand || "Machine List";
  }

  // The sheet's copy with this phone's waiting updates laid on top, so the screen shows them right away.
  function derive() {
    const units = new Map(D.units);
    const pend = [];
    let problems = D.problems.slice();
    const appr = new Map(), copied = new Map();
    D.outbox.forEach(op => {
      if (op.t === "unit") {
        const u = units.get(op.unit); if (!u) return;
        units.set(op.unit, merge(clone(u), op.patch || {}));
        (op.log || []).forEach(l => pend.push({ id: l.cid, at: op.at, by: S.me.name, unit: op.unit, unitName: op.unitName, section: l.section,
          label: l.label, key: l.key, from: l.from, to: l.to, approval: "", synced: "", note: l.kind === "confirm" ? "Confirmed" : "", pending: true }));
      } else if (op.t === "fuel") {
        const u = units.get(op.unit); if (!u) return;
        const before = !!(u.fuel && u.fuel.needs);
        units.set(op.unit, Object.assign({}, u, { fuel: { needs: op.needs, at: op.at, by: S.me.name } }));
        if (!S.me.isOwner) pend.push(crewPending(op, op.unit, op.unitName || nameOf(u), "Fuel", before ? "Yes" : "No", op.needs ? "Yes" : "No", "fuel"));
      } else if (op.t === "prob") {
        problems.unshift({ id: op.pid, at: op.at, by: S.me.name, unit: op.unit, unitName: op.unitName, text: op.text, status: "open", pending: true });
        if (!S.me.isOwner) pend.push(crewPending(op, op.unit, op.unitName, "Problem", "", op.text, "prob:" + op.pid));
      } else if (op.t === "fix") {
        const pr = problems.find(p => p.id === op.pid);
        problems = problems.map(p => (p.id === op.pid ? Object.assign({}, p, { status: "fixed", fixedAt: op.at, fixedBy: S.me.name }) : p));
        if (!S.me.isOwner && pr) pend.push(crewPending(op, pr.unit, pr.unitName, "Problem", pr.text, "Fixed", "fix:" + op.pid));
      } else if (op.t === "probx") {
        problems = problems.map(p => (p.id === op.pid ? Object.assign({}, p, op.val === "Declined" ? { status: "declined" } : { status: "open", fixedAt: "", fixedBy: "" }) : p));
      } else if (op.t === "approve") {
        (op.cids || []).forEach(id => appr.set(id, op.val));
      } else if (op.t === "copied") {
        (op.cids || []).forEach(id => { if (!copied.has(id)) copied.set(id, op.at); });
      }
    });
    const seen = new Set(D.changes.map(c => c.id));
    let changes = pend.filter(c => !seen.has(c.id)).reverse().concat(D.changes);
    if (appr.size || copied.size) {
      changes = changes.map(c => {
        if (c.synced) return c;   // once it's in the master sheet, it stays as it was
        let x = c;
        if (appr.has(c.id)) x = Object.assign({}, x, { approval: appr.get(c.id) });
        if (copied.has(c.id)) x = Object.assign({}, x, { synced: copied.get(c.id) });
        return x;
      });
    }
    const pseen = new Set();
    problems = problems.filter(p => (pseen.has(p.id) ? false : (pseen.add(p.id), true)));
    S.units = units; S.changes = changes; S.problems = problems;
    S.unitsLoaded = S.changesLoaded = S.problemsLoaded = D.loaded;
    if (S.openId && !S.units.has(S.openId)) S.openId = null;
  }

  // A coworker's fuel flag, problem report or Mark fixed, shown on the Changes list while it sends (same ID the sheet uses).
  function crewPending(op, unit, unitName, label, from, to, key) {
    return { id: "C" + String(op.id).slice(1), at: op.at, by: S.me.name, unit, unitName, section: "", label, key, from, to, approval: "", synced: "", note: "", pending: true };
  }

  function queueOp(op) {
    op.id = newId("O");
    op.at = new Date().toISOString();
    D.outbox.push(op);
    M.addOp(op).catch(() => toast("Couldn't save that on this phone. Its storage may be full."));
    derive();
    askBackgroundSend();
    kick();
  }

  // Android can send waiting updates later even if the app is closed by then.
  function askBackgroundSend() {
    if (!("serviceWorker" in navigator)) return;
    navigator.serviceWorker.ready.then(reg => (reg.sync && reg.sync.register ? reg.sync.register("ml-push") : null)).catch(() => { /* not on this phone */ });
  }

  async function reloadFromDb() {
    const [base, outbox, lastOk] = await Promise.all([M.get("base"), M.get("outbox"), M.get("lastOk")]);
    D.outbox = Array.isArray(outbox) ? outbox : [];
    if (lastOk) D.lastOk = lastOk;
    if (base && base.state && (String(base.ver || "") !== D.ver || (base.at || 0) !== D.baseAt)) loadState(base.state, base.ver, base.at);
    derive();
  }

  function kick() { clearTimeout(D.kickTimer); D.kickTimer = setTimeout(() => sync(), 800); }
  function schedule(ms) { clearTimeout(D.timer); D.timer = setTimeout(() => sync(), ms); }

  // ---------------------------------------------------------------- talking to the sheet
  async function sync(opts) {
    opts = opts || {};
    if (S.phase !== "app" || !D.setup || S.keyBad) return;
    if (D.busy) { D.again = Object.assign(D.again || {}, opts); return; }
    if (!opts.full && !opts.user && document.visibilityState === "hidden" && !D.outbox.length) { schedule(POLL_MS); return; }
    clearTimeout(D.timer);
    D.busy = true;
    D.tick++;
    renderHeader();
    const full = !!opts.full || D.tick % 8 === 0;
    let r;
    try { r = await M.withLock(() => M.syncAll({ full })); }
    catch (e) { r = { ok: false, error: "storage", message: String((e && e.message) || e) }; }
    D.busy = false;
    try { await reloadFromDb(); } catch (e) { /* keep what's on screen */ }
    const again = D.again; D.again = null;
    if (!r || !r.ok) {
      const err = r ? r.error : "";
      if (err === "bad_key") { S.keyBad = true; D.offline = false; render(true); return; }
      D.fails++;
      D.offline = !!(r && r.offline);
      if (err === "busy") { renderHeader(); schedule(3000); return; }
      if (!D.offline && (opts.user || D.fails === 3)) toast("Couldn't sync with your sheet" + (r && r.message ? ": " + r.message : "") + ". It will keep trying.");
      else if (D.offline && opts.user) toast("No signal right now. Everything's saved on this phone and will send by itself.");
      render(true);
      schedule(navigator.onLine === false ? 60000 : Math.min(60000, 5000 * D.fails));
      return;
    }
    D.fails = 0; D.offline = false; D.lastOk = Date.now();
    (r.rejected || []).forEach(x => toast("Couldn't save one update: " + ((x && x.why) || "the sheet turned it down")));
    render(true);
    if (opts.user) toast(D.outbox.length ? "Still sending…" : "Everything's synced with your sheet.");
    if (again) { sync(again); return; }
    schedule(D.outbox.length ? 1500 : POLL_MS);
  }

  // ---------------------------------------------------------------- boot
  async function init() {
    S.tab = "fleet";   // the app always opens on the main list, where Back stays put
    S.cat = lsGet("cat", "all");   // which equipment tab was open last
    const skips = lsGet("skips", {});
    S.sendSkips = skips && typeof skips === "object" ? skips : {};
    S.showNA = lsGet("showNA", false);
    (lsGet("openSecs", null) || []).forEach(s => S.openSecs.add(s));
    registerSW();
    wireLifecycle();

    let setup = null, base = null, outbox = [], pin = null, lastOk = 0;
    try { [setup, base, outbox, pin, lastOk] = await Promise.all([M.get("setup"), M.get("base"), M.get("outbox"), M.get("pin"), M.get("lastOk")]); }
    catch (e) { S.storageError = true; }
    D.setup = setup || null;
    D.outbox = Array.isArray(outbox) ? outbox : [];
    L.pin = pin || null;
    D.lastOk = lastOk || 0;
    if (base && base.state) loadState(base.state, base.ver, base.at);
    // If this copy of the app now points at a different sync link, use it.
    if (D.setup && CFG.syncUrl && D.setup.url !== CFG.syncUrl) {
      D.setup = Object.assign({}, D.setup, { url: CFG.syncUrl });
      M.set("setup", D.setup).catch(() => { /* next time */ });
    }
    if (!D.setup || !D.loaded) { S.phase = "setup"; render(); return; }
    S.phase = "app";
    derive();
    navStart();
    if (shouldLock()) openLock("unlock");
    render();
    sync({ full: true });
  }

  function wireLifecycle() {
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "hidden") {
        if (!L.open) lsSet("seenAt", Date.now());
        if (D.outbox.length) askBackgroundSend();
        return;
      }
      if (S.phase !== "app") return;
      if (!L.open && shouldLock()) openLock("unlock");
      sync({ full: true });
      checkForUpdate(false);
    });
    window.addEventListener("online", () => { D.offline = false; renderHeader(); if (S.phase === "app") sync(); });
    window.addEventListener("offline", () => { D.offline = true; renderHeader(); });
    window.addEventListener("pagehide", () => { if (!L.open) lsSet("seenAt", Date.now()); });
    setInterval(() => { if (!L.open && document.visibilityState === "visible") lsSet("seenAt", Date.now()); }, 30000);
    window.addEventListener("beforeinstallprompt", e => {
      e.preventDefault();
      S.installEvt = e;
      if (S.phase === "setup") renderSignin(); else if (S.tab === "fleet") renderFleet(); else if (S.tab === "me") renderMe();
    });
  }

  function registerSW() {
    if (!("serviceWorker" in navigator) || location.protocol === "file:") return;
    let hadController = !!navigator.serviceWorker.controller;
    navigator.serviceWorker.register("sw.js").then(reg => { D.swReg = reg; }).catch(() => { /* app still works while open */ });
    let reloading = false;
    navigator.serviceWorker.addEventListener("controllerchange", () => {
      if (!hadController) { hadController = true; return; }   // first install: nothing to swap
      if (reloading) return;
      if (Date.now() - BOOT_AT < 8000 && !S.editing) { reloading = true; location.reload(); return; }
      S.update = true;
      render(true);
    });
    navigator.serviceWorker.addEventListener("message", e => {
      if (e.data && e.data.t === "synced" && S.phase === "app") reloadFromDb().then(() => render(true)).catch(() => { /* fine */ });
    });
  }

  let lastUpdateCheck = 0;
  function checkForUpdate(byHand) {
    const reg = D.swReg;
    if (!reg) { if (byHand) toast("Updates show up here once the app is on your home screen."); return; }
    if (!byHand && Date.now() - lastUpdateCheck < 30 * 60000) return;
    lastUpdateCheck = Date.now();
    reg.update().then(() => {
      if (!byHand) return;
      setTimeout(() => { if (!S.update) toast(reg.installing || reg.waiting ? "Getting the new version…" : "You have the latest version."); }, 2500);
    }).catch(() => { if (byHand) toast("Couldn't check for an update. No signal?"); });
  }

  // ---------------------------------------------------------------- one-time setup on this phone
  async function doSetup(form) {
    const code = normKey(form.elements.code.value);
    if (code.length !== 12) return showWarn(form, "setupWarn", "The setup code is 12 letters and numbers, like ABCD-EF23-GH45.");
    if (!CFG.syncUrl) return showWarn(form, "setupWarn", "This copy of the app isn't linked to your sheet yet.");
    if (navigator.onLine === false) return showWarn(form, "setupWarn", "No signal. You need service for this one-time step.");
    setFormBusy(form, true);
    showWarn(form, "setupWarn", "");
    const btn = form.querySelector("button[type=submit]");
    if (btn) btn.textContent = "Downloading your machines…";
    const device = newId("D");
    let res;
    try { res = await M.post(CFG.syncUrl, { key: code, device, app: VERSION, full: true, ops: [] }, 60000); }
    catch (e) {
      setFormBusy(form, false);
      if (btn) btn.textContent = "Connect";
      return showWarn(form, "setupWarn", e && e.server ? "Your sheet's sync link had a problem: " + e.message
        : "Couldn't reach your sheet. Check your signal and try again.");
    }
    if (!res || !res.ok || !res.state) {
      setFormBusy(form, false);
      if (btn) btn.textContent = "Connect";
      return showWarn(form, "setupWarn", res && res.error === "bad_key" ? "That code doesn't work. Check it and try again."
        : "Your sheet had a problem" + (res && res.message ? ": " + res.message : "") + ". Try again in a minute.");
    }
    const setup = { key: code, url: CFG.syncUrl, device, at: Date.now() };
    try {
      await M.set("setup", setup);
      await M.set("base", { ver: String(res.ver || ""), state: res.state, at: Date.now() });
      await M.set("lastOk", Date.now());
    } catch (e) {
      setFormBusy(form, false);
      if (btn) btn.textContent = "Connect";
      return showWarn(form, "setupWarn", "This phone wouldn't let the app save anything. In Safari, private browsing blocks it.");
    }
    try { if (navigator.storage && navigator.storage.persist) navigator.storage.persist(); } catch (e) { /* best effort */ }
    D.setup = setup;
    D.lastOk = Date.now();
    loadState(res.state, res.ver, 0);
    derive();
    S.phase = "app";
    S.tab = "fleet";
    navStart();
    lsSet("seenAt", Date.now());
    if (!L.pin) openLock("new", true);
    render();
    toast(`All set. ${S.units.size} units are saved on this phone.`);
    schedule(POLL_MS);
  }

  // ---------------------------------------------------------------- PIN lock
  async function pinHash(salt, pin) {
    const data = new TextEncoder().encode(salt + ":" + pin);
    if (window.crypto && crypto.subtle) {
      const buf = await crypto.subtle.digest("SHA-256", data);
      return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, "0")).join("");
    }
    let h = 2166136261;   // very old browsers: a plain checksum is enough for a screen lock
    data.forEach(b => { h ^= b; h = Math.imul(h, 16777619) >>> 0; });
    return "f" + h.toString(16);
  }
  function randomSalt() {
    const a = new Uint8Array(12);
    if (window.crypto && crypto.getRandomValues) crypto.getRandomValues(a); else a.forEach((x, i) => { a[i] = Math.floor(Math.random() * 256); });
    return [...a].map(b => b.toString(16).padStart(2, "0")).join("");
  }
  function shouldLock() {
    if (!L.pin || !(L.pin.after >= 0)) return false;
    const seen = Number(lsGet("seenAt", 0)) || 0;
    return Date.now() - seen >= Math.max(L.pin.after, 10000);
  }
  function openLock(mode, fromSetup) {
    L.open = true; L.mode = mode; L.entry = ""; L.first = ""; L.msg = ""; L.bad = false; L.shake = false; L.fromSetup = !!fromSetup;
    if (document.activeElement && document.activeElement.blur) document.activeElement.blur();
    renderLock();
  }
  function closeLock() {
    L.open = false; L.entry = ""; L.first = ""; L.msg = ""; L.bad = false; L.mode = "unlock"; L.fromSetup = false;
    lsSet("seenAt", Date.now());
    renderLock();
    render();
  }

  function renderLock() {
    const el = $("#lock");
    el.hidden = !L.open;
    document.body.classList.toggle("locked", L.open);
    if (!L.open) { el.innerHTML = ""; return; }
    const mark = esc((D.config && D.config.mark) || "ML");
    if (L.mode === "forgot") {
      el.innerHTML = `<div class="lock-card">
        <div class="brand-mark lg" aria-hidden="true">${mark}</div>
        <h2>Forgot your PIN?</h2>
        <p class="lock-sub">Type this phone's setup code to pick a new PIN.</p>
        <form class="editor" data-form="forgot" autocomplete="off">
          <label for="forgotCode">Setup code<input id="forgotCode" name="code" class="code-input" type="text" autocapitalize="characters" autocorrect="off" spellcheck="false" maxlength="14" placeholder="XXXX-XXXX-XXXX"></label>
          <p class="warn" id="forgotWarn" hidden></p>
          <div class="row-actions"><button class="btn primary wide" type="submit">Pick a new PIN</button></div>
        </form>
        <div class="lock-links"><button type="button" class="link" data-pin-act="back">Back</button></div>
      </div>`;
      const i = $("#forgotCode"); if (i) i.focus();
      return;
    }
    const title = { unlock: "Enter your PIN", change: "Enter your current PIN", new: "Pick a 4-digit PIN", confirm: "Type it again" }[L.mode] || "Enter your PIN";
    const sub = L.msg || (L.mode === "new" ? "You'll type it to open the app on this phone." : L.mode === "confirm" ? "Same 4 digits, to make sure." : "");
    const cool = L.until > Date.now();
    let links = "";
    if (L.mode === "unlock") links = `<button type="button" class="link" data-pin-act="forgot">Forgot PIN?</button>`;
    else if (L.fromSetup) links = `<button type="button" class="link" data-pin-act="skip">Skip, no PIN on this phone</button>`;
    else links = `<button type="button" class="link" data-pin-act="cancel">Cancel</button>`;
    const keys = ["1", "2", "3", "4", "5", "6", "7", "8", "9"].map(n => `<button type="button" data-pin="${n}"${cool ? " disabled" : ""}>${n}</button>`).join("");
    el.innerHTML = `<div class="lock-card">
      <div class="brand-mark lg" aria-hidden="true">${mark}</div>
      <h2>${esc(title)}</h2>
      <p class="lock-sub${L.bad ? " bad" : ""}" aria-live="polite">${esc(sub)}</p>
      <div class="pin-dots${L.shake ? " shake" : ""}" role="img" aria-label="${L.entry.length} of 4 digits">${[0, 1, 2, 3].map(i => `<span class="${i < L.entry.length ? "on" : ""}"></span>`).join("")}</div>
      <div class="pad">${keys}<button type="button" class="blank" tabindex="-1" aria-hidden="true"></button><button type="button" data-pin="0"${cool ? " disabled" : ""}>0</button><button type="button" class="del" data-pin="del" aria-label="Delete a digit">Delete</button></div>
      <div class="lock-links">${links}</div>
    </div>`;
    L.shake = false;
  }

  async function pinKey(k) {
    if (L.until > Date.now() || L.busy) return;
    if (k === "del") { L.entry = L.entry.slice(0, -1); if (L.bad) { L.bad = false; L.msg = ""; } return renderLock(); }
    if (L.entry.length >= 4) return;
    L.entry += k;
    if (L.bad) { L.bad = false; L.msg = ""; }
    renderLock();
    if (L.entry.length < 4) return;
    const entry = L.entry;
    L.busy = true;
    try {
      if (L.mode === "unlock" || L.mode === "change") {
        const ok = !!L.pin && (await pinHash(L.pin.salt, entry)) === L.pin.hash;
        if (ok) {
          L.fails = 0;
          if (L.mode === "change") { L.mode = "new"; L.entry = ""; L.msg = "Now pick the new one."; return renderLock(); }
          return closeLock();
        }
        L.fails++;
        L.entry = ""; L.bad = true; L.shake = true;
        if (L.fails >= 5) {
          L.until = Date.now() + 30000;
          L.msg = "Too many tries. Wait 30 seconds.";
          setTimeout(() => { L.fails = 3; L.msg = ""; L.bad = false; renderLock(); }, 30000);
        } else L.msg = "That's not it. Try again.";
        return renderLock();
      }
      if (L.mode === "new") { L.first = entry; L.mode = "confirm"; L.entry = ""; L.msg = ""; return renderLock(); }
      if (L.mode === "confirm") {
        if (entry !== L.first) { L.mode = "new"; L.entry = ""; L.first = ""; L.bad = true; L.shake = true; L.msg = "Those didn't match. Pick it again."; return renderLock(); }
        const salt = randomSalt();
        const pin = { salt, hash: await pinHash(salt, entry), after: L.pin && L.pin.after !== undefined ? L.pin.after : 15 * 60000 };
        try { await M.set("pin", pin); } catch (e) { L.msg = "Couldn't save the PIN on this phone."; L.bad = true; L.mode = "new"; L.entry = ""; return renderLock(); }
        L.pin = pin;
        closeLock();
        toast("PIN saved. The app asks for it after you've been away 15 minutes. You can change that under the person button.");
      }
    } finally { L.busy = false; }
  }

  function forgotPin(form) {
    const code = normKey(form.elements.code.value);
    if (!D.setup || code !== normKey(D.setup.key)) return showWarn(form, "forgotWarn", "That's not this phone's setup code.");
    L.mode = "new"; L.entry = ""; L.first = ""; L.msg = "Pick your new PIN."; L.bad = false;
    renderLock();
  }

  // ---------------------------------------------------------------- render
  function render(fromSync) {
    const ready = S.phase === "app";
    $("#signin").hidden = ready || S.phase === "boot";
    $("#layout").hidden = !ready;
    $("#tabs").hidden = !ready;
    $("#meBtn").hidden = !ready;
    renderHeader();
    if (!ready) { if (S.phase === "setup") renderSignin(); return; }
    if (!S.me.isOwner && S.tab === "approved") S.tab = "fleet";
    $("#tab-approved").hidden = !S.me.isOwner;
    ["fleet", "due", "changes", "approved"].forEach(t => {
      $("#tab-" + t).setAttribute("aria-selected", String(S.tab === t));
    });
    $("#meBtn").setAttribute("aria-pressed", String(S.tab === "me"));
    TABS.forEach(t => { $("#view-" + t).hidden = S.tab !== t; });
    if (S.tab === "fleet") renderFleet();
    if (S.tab === "due") renderDue();
    if (S.tab === "changes") renderChanges();
    if (S.tab === "approved") renderApproved();
    if (S.tab === "me" && !(fromSync && typingInMe())) renderMe();
    if (fromSync && S.editing) { S.detailStale = true; return; }
    renderDetail();
  }

  function renderHeader() {
    const n = S.units.size;
    const line = $("#subline");
    let text, warn = false;
    const waiting = D.outbox.length;
    const off = isOffline();
    const plural = k => k + " update" + (k === 1 ? "" : "s");
    if (S.phase === "boot") text = "Loading…";
    else if (S.phase === "setup") text = "Set up this phone";
    else if (!D.loaded) text = "Loading equipment…";
    else if (S.keyBad) { text = "Sync paused · setup code changed"; warn = true; }
    else if (waiting && off) { text = "No signal · " + plural(waiting) + " will send"; warn = true; }
    else if (waiting) text = "Sending " + plural(waiting) + "…";
    else if (off) text = "No signal · all saved on this phone";
    else {
      text = n + " units";
      if (D.lastOk) text += " · synced " + shortTime(D.lastOk);
    }
    line.textContent = text;
    line.classList.toggle("warn", warn);
    $("#meName").textContent = firstName(S.me.name) || "Me";
    if (S.phase !== "app") return;
    const t = today();
    let over = 0, soon = 0;
    S.units.forEach(u => C.unitIssues(u, t).forEach(i => (i.st === "over" ? over++ : soon++)));
    const dc = $("#dueCount");
    dc.hidden = !(over + soon);
    dc.textContent = String(over + soon);
    dc.classList.toggle("hot", over > 0);
    let w = 0, ap = 0;
    S.changes.forEach(c => {
      if (!S.me.isOwner && c.by !== S.me.name) return;   // a coworker counts their own
      const s = changeState(c);
      if (s === "waiting") w++; else if (s === "approved" && isMasterChange(c)) ap++;
    });
    const cc = $("#chCount");
    cc.hidden = !w;
    cc.textContent = String(w);
    const ac = $("#apCount");
    ac.hidden = !ap;
    ac.textContent = String(ap);
  }

  function stateBlock(kind) {
    if (kind === "loading") return `<div class="card empty-state"><h3>Loading equipment</h3><p>Pulling up every machine, truck, trailer and small engine.</p></div>`;
    return `<div class="card empty-state"><h3>No equipment yet</h3><p>Your sheet doesn't have any units in it. Ask Claude to load the equipment list.</p></div>`;
  }

  function installSteps() {
    const ios = isIOS(), android = isAndroid();
    const iosSteps = `<div><div class="os">iPhone</div><ol><li>Open this page in <b>Safari</b>.</li><li>Tap the Share button ${SHARE_SVG}, then <b>Add to Home Screen</b>.</li><li>Open <b>Machines</b> from your home screen and set it up there.</li></ol></div>`;
    const andSteps = `<div><div class="os">Android</div><ol><li>In <b>Chrome</b>, tap the ⋮ menu, then <b>Add to Home screen</b> or <b>Install app</b>.</li><li>Open <b>Machines</b> from your home screen.</li></ol></div>`;
    return `<div class="install-steps">${ios ? iosSteps : android ? andSteps : iosSteps + andSteps}</div>`;
  }

  function renderSignin() {
    const el = $("#signin");
    if (el.querySelector("form[data-form='setup']") && el.dataset.v === String(!!S.installEvt)) return; // keep what they're typing
    el.dataset.v = String(!!S.installEvt);
    const ios = isIOS(), app = standalone();
    let html = `<div class="card card-pad signin-card setup-card">
      <div class="brand-mark lg" aria-hidden="true">ML</div>
      <h2>Set up this phone</h2>`;
    if (S.storageError) html += `<p class="signin-msg">This browser won't let the app save anything (private browsing does that). Open it in a regular window.</p>`;
    if (!app && ios) {
      html += `<div class="card card-pad tip"><p><b>First, put it on your home screen.</b> On iPhone the home screen app keeps its own copy of everything, so set it up from there, not here in Safari.</p></div>${installSteps()}
        <p class="muted small">Already on your home screen? Open it from there. Setting up a laptop or iPad instead? Go ahead below.</p>`;
    } else if (!app) {
      html += `<p class="muted">Tip: put it on your home screen so it opens like an app.${S.installEvt ? "" : " " + (isAndroid() ? "In Chrome, tap ⋮, then <b>Add to Home screen</b>." : "")}</p>`;
      if (S.installEvt) html += `<div class="row-actions"><button class="btn" type="button" data-action="install">Add to home screen</button></div>`;
    }
    html += `<p>Type the setup code you were given. You only do this once on each phone, and it needs signal to download the machines.</p>
      <form class="editor" data-form="setup" autocomplete="off">
        <label for="setupCode">Setup code<input id="setupCode" name="code" class="code-input" type="text" inputmode="text" autocapitalize="characters" autocorrect="off" spellcheck="false" maxlength="14" placeholder="XXXX-XXXX-XXXX"></label>
        <p class="warn" id="setupWarn" hidden></p>
        <div class="row-actions"><button class="btn primary wide" type="submit">Connect</button></div>
      </form>
      ${CFG.syncUrl ? "" : `<p class="warn-text">This copy of the app isn't linked to your sheet yet.</p>`}
      <p class="muted small">After this, the app works with no signal. What you add goes to your sheet by itself once you have service.</p>
    </div>`;
    el.innerHTML = html;
  }

  // ---------------------------------------------------------------- fleet
  function haystack(u) {
    const v = u.v || {};
    return [u.id, v.name, v.make, v.model, v.owner, C.personName(v.owner), v.serial, v.loc, v.year, C.catName(u),
      C.atShop(u) ? "at shop" : "", openProblems(u.id).length ? "problem" : "", needsFuel(u) ? "needs fuel" : ""]
      .concat(u.att || []).join(" ").toLowerCase();
  }
  function matchSt(u, st) {
    switch (S.st) {
      case "all": return true;
      case "set": return st === "set" || st === "need";
      case "problem": return openProblems(u.id).length > 0;
      case "shop": return C.atShop(u);
      case "fuel": return needsFuel(u);
      default: return st === S.st;
    }
  }
  function renderFleet() {
    const body = $("#fleetBody");
    if (!S.unitsLoaded) { body.innerHTML = stateBlock("loading"); return; }
    if (!S.units.size) { body.innerHTML = noticeCards() + stateBlock("empty"); $("#summary").innerHTML = ""; $("#whoChips").innerHTML = ""; return; }
    const t = today();
    const all = unitsArr().map(u => ({ u, s: C.unitStatus(u, t), g: C.groupOf(u), p: personOf(u) }));
    const count = k => all.filter(x => {
      if (k === "set") return x.s.st === "set" || x.s.st === "need";
      if (k === "problem") return openProblems(x.u.id).length > 0;
      if (k === "shop") return C.atShop(x.u);
      if (k === "fuel") return needsFuel(x.u);
      return x.s.st === k;
    }).length;
    const tiles = [["over", "Overdue"], ["soon", "Due soon"], ["set", "Not set up"], ["problem", "Problems"], ["shop", "At shop"], ["fuel", "Needs fuel"]];
    $("#summary").innerHTML = tiles.map(([k, l]) =>
      `<button class="sum ${k}" data-st="${k}" aria-pressed="${S.st === k}"><b class="num">${count(k)}</b><span>${l}</span></button>`).join("");

    // Tabs: All, then each kind of equipment. No tabs for people or small engines.
    const chips = $("#whoChips");
    const tabs = C.GROUP_ORDER.filter(k => !C.NO_TAB.has(k) && all.some(x => x.g === k));
    if (S.cat !== "all" && !tabs.includes(S.cat)) S.cat = "all";
    chips.classList.toggle("wrap", finePointer());   // with a mouse, show every tab instead of a row to swipe
    chips.innerHTML = [["all", "All"]].concat(tabs.map(k => [k, C.groupName(k)])).map(([k, l]) =>
      `<button class="chip" data-cat="${esc(k)}" aria-pressed="${S.cat === k}">${esc(l)}</button>`).join("");
    if (!S.chipsPlaced && chips.offsetParent) { S.chipsPlaced = true; showPressedChip(chips); }

    const terms = S.q.trim().toLowerCase().split(/\s+/).filter(Boolean);
    const rows = all.filter(({ u, s, g }) =>
      (S.cat === "all" || g === S.cat) && matchSt(u, s.st) &&
      (!terms.length || terms.every(term => haystack(u).includes(term))));
    if (!rows.length) {
      body.innerHTML = noticeCards() + `<div class="card empty-state"><h3>No matches</h3><p>Nothing fits that search and filter. Clear the search or pick All.</p><p style="margin-top:12px"><button class="btn" data-action="clear-filters">Clear search and filters</button></p></div>`;
      return;
    }
    const section = (title, list, opts) => `<section class="group"><div class="group-h"><h2>${esc(title)}</h2><span>${list.length}</span></div>${list.map(r => unitRow(r.u, r.s, opts)).join("")}</section>`;
    let html = noticeCards() + tipCard();
    if (S.cat !== "all") {
      html += section(C.groupName(S.cat), rows);   // a tab shows every unit of that kind, whoever it belongs to
    } else {
      const gear = rows.filter(r => !r.p);
      const kind = k => gear.filter(r => r.g === k);
      C.GROUP_ORDER.filter(k => !C.NO_TAB.has(k)).forEach(k => { const g = kind(k); if (g.length) html += section(C.groupName(k), g); });
      // Each person's own gear in one section: their truck first, then what rides in it.
      const at = k => { const i = C.GROUP_ORDER.indexOf(k); return i < 0 ? 99 : i; };
      [...new Set(rows.filter(r => r.p).map(r => r.p))].sort((a, b) => personRank(a) - personRank(b) || a.localeCompare(b))
        .forEach(p => { html += section(p, rows.filter(r => r.p === p).sort((a, b) => at(a.g) - at(b.g)), { mine: true }); });
      C.GROUP_ORDER.filter(k => C.NO_TAB.has(k)).forEach(k => { const g = kind(k); if (g.length) html += section(C.groupName(k), g); });
      const other = gear.filter(r => !C.GROUP_ORDER.includes(r.g));
      if (other.length) html += section("Other", other);
    }
    body.innerHTML = html;
  }

  // A unit that is one person's own gear (their truck and what rides in it) sits in that person's section.
  // Shop, Everyone and Unassigned aren't people, so their gear stays with its kind of equipment.
  const NOT_PERSON = /^(everyone|shared|all|shop|unassigned)$/i;
  function personOf(u) {
    const o = C.personName((u.v || {}).owner);
    return o && !NOT_PERSON.test(o) ? o : "";
  }
  // People's sections go in the order of the People list on the sheet's Settings tab.
  function personRank(p) {
    const i = (C.PEOPLE || []).indexOf(p);
    return i < 0 ? 99 : i;
  }
  function finePointer() {
    try { return window.matchMedia("(hover: hover) and (pointer: fine)").matches; } catch (e) { return false; }
  }
  // On a phone the tabs are one row you swipe; when the app opens on a tab further along, bring it into view.
  function showPressedChip(row, smooth) {
    const on = row.querySelector('[aria-pressed="true"]');
    if (!on || row.classList.contains("wrap")) return;
    const a = row.getBoundingClientRect(), b = on.getBoundingClientRect();
    if (b.left >= a.left + 4 && b.right <= a.right - 4) return;
    const left = Math.max(0, row.scrollLeft + (b.left - a.left) - (a.width - b.width) / 2);   // in the middle, so the next ones show too
    if (smooth && typeof row.scrollTo === "function") row.scrollTo({ left, behavior: reducedMotion() ? "auto" : "smooth" });
    else row.scrollLeft = left;
  }
  function reducedMotion() {
    try { return window.matchMedia("(prefers-reduced-motion: reduce)").matches; } catch (e) { return false; }
  }

  // Swiping on the Fleet list steps through the equipment tabs, like flipping pages: finger to the left for the
  // next one (All, Mini Excavators, Zero Turn, Counterweight, Dump Trucks…), to the right to go back.
  // The tab row itself still scrolls sideways as before, and an up-and-down swipe still scrolls the list.
  const SW = { on: false, x: 0, y: 0, t: 0, dx: 0, lock: "", until: 0, pts: [] };
  const fleetCats = () => [...document.querySelectorAll("#whoChips [data-cat]")].map(b => b.dataset.cat);
  function swipeStart(e) {
    SW.on = false;
    if (S.phase !== "app" || S.tab !== "fleet" || L.open || !e.touches || e.touches.length !== 1) return;
    if (S.openId && window.innerWidth < 980) return;
    if (e.target.closest && e.target.closest("#whoChips, input, textarea, select, .editor")) return;
    const p = e.touches[0];
    if (p.clientX < 16 || p.clientX > window.innerWidth - 16) return;   // the phone's own edge swipe (Back)
    Object.assign(SW, { on: true, x: p.clientX, y: p.clientY, t: Date.now(), dx: 0, lock: "", pts: [[Date.now(), p.clientX]] });
  }
  function swipeMove(e) {
    if (!SW.on || !e.touches || e.touches.length !== 1) return;
    const p = e.touches[0], dx = p.clientX - SW.x, dy = p.clientY - SW.y;
    if (!SW.lock) {
      if (Math.abs(dx) < 12 && Math.abs(dy) < 12) return;
      SW.lock = Math.abs(dx) > Math.abs(dy) * 1.4 ? "x" : "y";
      if (SW.lock === "y") { SW.on = false; return; }   // scrolling up or down: leave it alone
    }
    if (e.cancelable) e.preventDefault();
    SW.dx = dx;
    SW.pts.push([Date.now(), p.clientX]);
    if (SW.pts.length > 8) SW.pts.shift();
    const i = fleetCats().indexOf(S.cat), j = i + (dx < 0 ? 1 : -1);
    const end = i < 0 || j < 0 || j >= fleetCats().length;
    dragFleet(dx * (end ? 0.15 : 0.45), false);
  }
  function swipeEnd() {
    if (!SW.on) return;
    SW.on = false;
    if (SW.lock !== "x") return;
    const now = Date.now();
    SW.until = now + 400;   // the lift at the end of a swipe never opens a unit
    const dx = SW.dx;
    // How fast the finger was going at the end (over the last tenth of a second or so): a quick flick counts too.
    const recent = SW.pts.filter(q => now - q[0] <= 120);
    const a = recent[0] || SW.pts[0], b = SW.pts[SW.pts.length - 1];
    const speed = a && b && b[0] > a[0] ? (b[1] - a[1]) / (b[0] - a[0]) : 0;
    const far = Math.abs(dx) >= Math.min(80, window.innerWidth * 0.2) || (Math.abs(dx) >= 36 && Math.abs(speed) > 0.35 && Math.sign(speed) === Math.sign(dx));
    stepFleet(far ? (dx < 0 ? 1 : -1) : 0);
  }
  function swipeCancel() { if (SW.on && SW.lock === "x") stepFleet(0); SW.on = false; }
  function dragFleet(x, animate) {
    const body = $("#fleetBody");
    if (!body) return;
    body.style.transition = animate && !reducedMotion() ? "transform .2s ease, opacity .2s ease" : "none";
    body.style.transform = x ? `translateX(${Math.round(x)}px)` : "";
    body.style.opacity = x ? String(Math.max(0.5, 1 - Math.abs(x) / 500)) : "";
  }
  // Move to the next (1) or previous (-1) equipment tab, or spring back (0).
  function stepFleet(step) {
    const cats = fleetCats(), i = cats.indexOf(S.cat), j = i + step;
    if (!step || i < 0 || j < 0 || j >= cats.length) { dragFleet(0, true); return false; }
    S.cat = cats[j]; lsSet("cat", S.cat);
    renderFleet();
    const row = $("#whoChips");
    if (row) showPressedChip(row, true);
    keepChipsInView();
    const body = $("#fleetBody");
    if (body && !reducedMotion()) {   // the new list slides in from the side you're heading to
      body.style.transition = "none";
      body.style.transform = `translateX(${step > 0 ? 56 : -56}px)`;
      body.style.opacity = "0.3";
      void body.offsetWidth;
      body.style.transition = "transform .24s cubic-bezier(.2,.75,.3,1), opacity .2s ease";
      body.style.transform = "";
      body.style.opacity = "";
    } else dragFleet(0, false);
    return true;
  }
  // After a swipe from far down the list, scroll back up to where the new list starts.
  function keepChipsInView() {
    const row = $("#whoChips");
    if (!row || !row.offsetParent) return;
    const behavior = reducedMotion() ? "auto" : "smooth";
    const pane = document.querySelector(".pane-list");
    if (pane && window.innerWidth >= 980) {
      const off = row.getBoundingClientRect().top - pane.getBoundingClientRect().top;
      if (off < 0) pane.scrollBy({ top: off - 8, behavior });
      return;
    }
    const bar = document.querySelector(".appbar");
    const under = bar ? bar.getBoundingClientRect().bottom : 0;
    const top = row.getBoundingClientRect().top;
    if (top < under) window.scrollBy({ top: top - under - 10, behavior });
  }
  (function wireSwipes() {
    const v = $("#view-fleet");
    if (!v) return;
    v.addEventListener("touchstart", swipeStart, { passive: true });
    v.addEventListener("touchmove", swipeMove, { passive: false });
    v.addEventListener("touchend", swipeEnd, { passive: true });
    v.addEventListener("touchcancel", swipeCancel, { passive: true });
    document.addEventListener("click", e => { if (Date.now() < SW.until) { e.preventDefault(); e.stopImmediatePropagation(); } }, true);
  })();

  // Notes at the top of the list: a new version of the app, or sync paused.
  function noticeCards() {
    let html = "";
    if (S.update) html += `<div class="card card-pad notice upd"><p><b>A new version of the app is ready.</b> Reload to use it. Nothing you saved is lost.</p><button class="btn small primary" type="button" data-action="reload-app">Reload</button></div>`;
    if (S.keyBad) html += `<div class="card card-pad notice paused"><p><b>Sync is paused.</b> This phone's setup code was changed or turned off. Everything's still saved on this phone.</p><button class="btn small" type="button" data-tab="me">Fix it</button></div>`;
    return html;
  }

  function tipCard() {
    if (S.tipClosed || standalone() || lsGet("tipDone", false)) return "";
    const how = isIOS() ? "In Safari, tap Share, then <b>Add to Home Screen</b>. The home screen app keeps its own copy, so you'll type the setup code there once."
      : isAndroid() ? "In Chrome, tap ⋮, then <b>Add to Home screen</b>."
      : "iPhone: tap Share, then <b>Add to Home Screen</b>. Android: tap ⋮, then <b>Add to Home screen</b>.";
    return `<div class="card card-pad tip"><p><b>Put this on your home screen</b> so it opens like an app, even with no signal. ${S.installEvt ? "" : how}${S.installEvt ? ` <button class="btn small primary" type="button" data-action="install" style="margin-top:8px">Add to home screen</button>` : ""}</p><button class="btn small quiet" type="button" data-action="tip-close" aria-label="Hide this tip">✕</button></div>`;
  }

  function unitRow(u, s, opts) {
    const v = u.v || {};
    const probs = openProblems(u.id).length;
    const shop = C.atShop(u);
    const fuel = needsFuel(u);
    const mine = !!(opts && opts.mine);   // in its owner's own section, so no need to repeat the name
    const bits = [v.make, v.model && v.model !== v.name ? v.model : "", mine ? "" : C.personName(v.owner)].filter(Boolean);
    const att = u.att || [];
    if (att.length && C.applies(u, "BKT")) {
      const allBuckets = att.every(a => /bucket/i.test(a));
      bits.push(att.length + (allBuckets ? (att.length === 1 ? " bucket" : " buckets") : (att.length === 1 ? " attachment" : " attachments")));
    }
    if (v.loc && !shop) bits.push(v.loc);
    const insp = C.applies(u, C.FIELDS.insp.rule) ? C.inspStatus(u, today()) : null;
    const tags = (insp && insp.st !== "ok" ? `<span class="tag insp-${insp.st}">${insp.now ? "Inspection due" : insp.st === "over" ? "Inspection expired" : "Inspection soon"}</span>` : "") +
      (probs ? `<span class="tag prob">${probs === 1 ? "Problem" : probs + " problems"}</span>` : "") + (shop ? `<span class="tag shop">At shop</span>` : "");
    const cur = C.num(v.cur);
    const hrs = C.usesMeter(u) && cur !== null ? C.fmtNum(cur) + " " + C.unitWord(u) : "";
    const cls = "unit-row" + (probs ? " has-problem" : shop ? " at-shop" : "");
    return `<button class="${cls}" data-open="${esc(u.id)}"${S.openId === u.id ? ' aria-current="true"' : ""}>
      <span class="plate">${esc(u.id)}</span>
      <span class="u-main"><span class="u-name">${esc(nameOf(u))}${fuel ? `<span class="fuel-flag" title="Needs fuel">${NOFUEL_SVG}<span class="sr">Needs fuel</span></span>` : ""}</span><span class="u-sub">${tags}${esc(bits.join(" · ") || C.catName(u))}</span></span>
      <span class="u-side">${hrs ? `<span class="hrs">${esc(hrs)}</span>` : ""}<span class="pill ${s.st}">${esc(s.label)}</span></span>
    </button>`;
  }

  // ---------------------------------------------------------------- due
  function renderDue() {
    const el = $("#view-due");
    if (!S.unitsLoaded) { el.innerHTML = stateBlock("loading"); return; }
    const t = today();
    const items = [];
    let notSet = 0;
    unitsArr().forEach(u => {
      C.unitIssues(u, t).forEach(i => items.push(Object.assign({ u }, i)));
      const st = C.unitStatus(u, t).st;
      if (st === "set" || st === "need") notSet++;
    });
    const block = (title, list, st) => !list.length ? "" :
      `<section class="group"><div class="group-h"><h2>${title}</h2><span>${list.length}</span></div><div class="list">${list.map(i => `
        <button class="item" data-open="${esc(i.u.id)}"><span class="plate">${esc(i.u.id)}</span>
          <span><span class="t">${esc(nameOf(i.u))} · ${esc(i.label)}</span><span class="s">${esc(i.detail ? (i.kind === "svc" ? "Due " + i.detail : i.detail) : "")}</span></span>
          <span class="pill ${st}">${esc(i.pill || (st === "over" ? (i.kind === "paper" ? "Expired" : "Overdue") : "Soon"))}</span></button>`).join("")}</div></section>`;
    const over = items.filter(i => i.st === "over"), soon = items.filter(i => i.st === "soon");
    let html = block("Overdue", over, "over") + block("Due soon", soon, "soon");
    if (!items.length) {
      html = `<div class="card empty-state"><h3>Nothing due</h3><p>Service shows up here once a unit has its interval and last service filled in. State inspections show up 3 months before they're due. Registration, HUT and warranty dates show up 30 days before they run out.</p></div>`;
    }
    if (notSet) html += `<p class="muted" style="margin:0 2px">${notSet} of ${S.units.size} units don't have service intervals filled in yet. Open a unit and tap Edit on a service to add one.</p>`;
    el.innerHTML = html;
  }

  // ---------------------------------------------------------------- changes
  function changeState(c) {
    if (STALE_RE.test(c.note || "")) return "stale";
    if (c.synced) return "synced";
    if (c.approval === "Declined") return "declined";
    if (c.approval === "Approved") return "approved";
    return "waiting";
  }
  const STATE_LABEL = { waiting: "Waiting for approval", approved: "Approved", declined: "Declined", synced: "In master sheet", stale: "Not used" };
  const STATE_PILL = { waiting: "need", approved: "ok", declined: "over", synced: "set", stale: "set" };
  function sectionShort(title) {
    if (!title) return "";
    if (title.startsWith("SERVICE: ")) { const s = C.SERVICES.find(x => x.title === title); return "Service · " + (s ? s.short : title.slice(9)); }
    if (title === "HOURS") return "Hours";
    const s = C.SECTIONS.find(x => x.title === title);
    return s ? s.short : title;
  }
  function fmtChangeVal(c, v) {
    if (v === null || v === undefined || v === "") return "";
    const key = c.key || "";
    const f = C.FIELDS[key];
    if (key === "owner") return C.personName(v);
    const isNum = (f && (f.type === "num" || f.type === "money")) || /\.(ih|lh|im)$/.test(key);
    if (isNum && C.num(v) !== null) return f && f.type === "money" ? "$" + C.fmtNum(C.num(v)) : C.fmtNum(C.num(v));
    return String(v);
  }
  function changeDiff(c, from, to) {
    const key = String(c.key || "");
    if (key === "fuel") return `<span class="to">${c.to === "Yes" ? "Needs fuel" : "Fueled"}</span>`;
    if (key.startsWith("prob:")) return `<span class="to">Reported: ${esc(c.to)}</span>`;
    if (key.startsWith("fix:")) return `<span class="to">Marked fixed: ${esc(c.from)}</span>`;
    if (c.note === "Confirmed") return `<span class="to">Confirmed: ${esc(to)}</span>`;
    return `<span class="from">${esc(from || "empty")}</span><span class="arrow" aria-label="changed to">→</span><span class="to">${esc(to || "cleared")}</span>`;
  }
  // "Engine oil · Oil Filter P/N", or just "Notes" when the section and the field have the same name.
  function fieldName(c) {
    const sec = sectionShort(c.section), label = String(c.label || c.key || "");
    return !sec || sec.toLowerCase() === label.toLowerCase() ? label : sec + " · " + label;
  }
  const pendingNote = c => (c.pending ? (isOffline() ? " · saved on this phone, will send" : " · sending…") : "");
  const plural = (k, word) => k + " " + word + (k === 1 ? "" : "s");

  function renderChanges() {
    const el = $("#view-changes");
    const mine = S.me.isOwner ? S.changes : S.changes.filter(c => c.by === S.me.name);   // a coworker sees their own
    const all = mine.map(c => Object.assign({ state: changeState(c) }, c));
    const n = st => all.filter(c => c.state === st).length;
    const filters = [["waiting", "Waiting"], ["declined", "Declined"], ["synced", "Sent"], ["all", "All"]];
    if (!filters.some(f => f[0] === S.chFilter)) S.chFilter = "waiting";
    const shown = S.chFilter === "all" ? all : all.filter(c => c.state === S.chFilter);
    const owner = S.me.isOwner && !S.readOnly;
    const more = D.changesTotal > D.changes.length ? D.changesTotal - D.changes.length : 0;
    const nAp = owner ? all.filter(c => c.state === "approved" && isMasterChange(c)).length : 0;
    let html = `<div class="card card-pad intro">
      ${owner ? `<p>Every change to a unit's details shows up here first, and so do fuel flags and problems from the crew. <b>Approve</b> the ones you want, or <b>decline</b> one that was a mistake. Approved details wait on the <button class="link" type="button" data-tab="approved">Approved</button> tab until you send them to the master sheet.</p>`
        : `<p>Your changes, fuel flags and problem reports show up here. Each one waits for approval, and you can see here when it's approved or declined.</p>`}
      ${owner && n("waiting") ? `<div class="row-actions"><button class="btn primary" data-action="approve-all">Approve all waiting (${n("waiting")})</button></div>` : ""}
    </div>
    <div class="chips" role="group" aria-label="Show changes: waiting, declined, sent to the master sheet, or all">${filters.map(([k, l]) =>
      `<button class="chip" data-chf="${k}" aria-pressed="${S.chFilter === k}">${l} <span class="n">${k === "all" ? all.length : n(k)}</span></button>`).join("")}</div>`;
    if (!S.changesLoaded) html += stateBlock("loading");
    else if (!shown.length) {
      const msg = {
        waiting: "Nothing is waiting. Changes you make to a unit show up here." + (nAp ? ` ${plural(nAp, "approved change")} ${nAp === 1 ? "is" : "are"} on the Approved tab.` : ""),
        declined: "Nothing declined. Declining a change keeps it out of the master sheet.",
        synced: "Nothing has been sent to the master sheet yet.",
        all: "No changes yet. Edit a unit to see it here."
      }[S.chFilter];
      html += `<div class="card empty-state"><h3>All clear</h3><p>${msg}</p>${S.chFilter === "waiting" && nAp ? `<p style="margin-top:12px"><button class="btn" data-tab="approved">Go to Approved</button></p>` : ""}</div>`;
    } else {
      html += `<section class="group">${shown.map(c => {
        const unitName = (S.units.get(c.unit) && nameOf(S.units.get(c.unit))) || c.unitName || c.unit;
        let acts = "";
        if (owner && c.state === "waiting") acts = `<button class="btn small primary" data-action="approve" data-id="${esc(c.id)}">Approve</button><button class="btn small decline" data-action="decline" data-id="${esc(c.id)}">Decline</button>`;
        else if (owner && c.state === "approved") acts = `<button class="btn small" data-action="unapprove" data-id="${esc(c.id)}">Undo approval</button>`;
        else if (owner && c.state === "declined") acts = `<button class="btn small" data-action="undecline" data-id="${esc(c.id)}">Undo decline</button>`;
        return `<div class="ch${c.state === "stale" || c.state === "declined" ? " stale" : ""}">
          <div class="ch-top"><span class="plate">${esc(c.unit)}</span><span class="t">${esc(unitName)}</span><span class="pill ${STATE_PILL[c.state]}">${STATE_LABEL[c.state]}</span></div>
          <div class="ch-field">${esc(fieldName(c))}</div>
          <div class="ch-diff">${changeDiff(c, fmtChangeVal(c, c.from), fmtChangeVal(c, c.to))}</div>
          <div class="ch-meta">${esc(whenText(c.at))} · ${esc(whoName(c.by))}${pendingNote(c)}${c.state === "stale" ? " · a newer value was saved first, so this one wasn't used" : ""}${c.state === "declined" ? " · won't go to the master sheet" : ""}</div>
          ${acts ? `<div class="row-actions">${acts}</div>` : ""}
        </div>`;
      }).join("")}</section>`;
      if (more && S.chFilter === "all" && owner) html += `<p class="muted small" style="margin:0 2px">Showing the latest ${D.changes.length}. The other ${more} are on the Changes tab of your sheet.</p>`;
    }
    el.innerHTML = html;
  }

  // ---------------------------------------------------------------- approved: ready for the master sheet
  // One line per field. A field changed more than once only needs its newest approved value in the master sheet.
  const FIELD_ORDER = (() => {
    const keys = [];
    C.SECTIONS.forEach(s => {
      if (s.title === "PAPERWORK & OWNERSHIP") C.SERVICES.forEach(sv => ["ih", "im", "ld", "lh"].forEach(sub => keys.push("svc." + sv.key + "." + sub)));
      s.fields.forEach(([k]) => { keys.push(k); if (k === "setup") keys.push("att"); });
    });
    return new Map(keys.map((k, i) => [k, i]));
  })();
  function approvedGroups() {
    const groups = new Map();
    S.changes.forEach(c => {   // newest first
      if (changeState(c) !== "approved" || !isMasterChange(c)) return;
      const k = c.unit + "\u0001" + (c.key || c.label);
      let g = groups.get(k);
      if (!g) { g = { unit: c.unit, key: c.key || "", items: [] }; groups.set(k, g); }
      g.items.push(c);
    });
    return [...groups.values()].map(g => Object.assign(g, { latest: g.items[0], first: g.items[g.items.length - 1] }));
  }

  function renderApproved() {
    const el = $("#view-approved");
    if (!S.changesLoaded) { el.innerHTML = stateBlock("loading"); return; }
    const groups = approvedGroups();
    const n = groups.reduce((s, g) => s + g.items.length, 0);
    if (!n) {
      const sent = S.changes.some(c => changeState(c) === "synced"), waiting = S.changes.some(c => changeState(c) === "waiting");
      el.innerHTML = `<div class="card empty-state"><h3>${sent ? "All sent" : "Nothing approved"}</h3><p>${sent ? "Everything you approved is in the master sheet." : "Approve changes on the Changes tab."} New approvals wait here until you send them to the master sheet.</p>${waiting ? `<p style="margin-top:12px"><button class="btn" data-tab="changes">Go to Changes</button></p>` : ""}</div>`;
      return;
    }
    const order = new Map(unitsArr().map((u, i) => [u.id, i]));
    const byUnit = new Map();
    groups.forEach(g => { if (!byUnit.has(g.unit)) byUnit.set(g.unit, []); byUnit.get(g.unit).push(g); });
    const rank = id => (order.has(id) ? order.get(id) : 99999);
    const ids = [...byUnit.keys()].sort((a, b) => rank(a) - rank(b) || a.localeCompare(b));
    const fr = g => (FIELD_ORDER.has(g.key) ? FIELD_ORDER.get(g.key) : 9999);
    let html = `<div class="card card-pad intro"><p><b>${plural(n, "approved change")}</b> to ${plural(ids.length, "unit")}, ready for the master sheet. Nothing there changes until you tap <b>Send</b> at the bottom.</p></div>`;
    ids.forEach(id => {
      const u = S.units.get(id), list = byUnit.get(id).sort((a, b) => fr(a) - fr(b));
      html += `<section class="group ap-unit"><div class="ap-h"><span class="plate">${esc(id)}</span><span class="t">${esc((u && nameOf(u)) || list[0].latest.unitName || id)}</span></div>${list.map(apRow).join("")}</section>`;
    });
    html += sendCard(n);
    el.innerHTML = html;
  }

  function apRow(g) {
    const c = g.latest, first = g.first, many = g.items.length > 1;
    const who = [...new Set(g.items.map(x => whoName(x.by)))].join(", ");
    const skip = g.items.map(x => S.sendSkips[x.id]).find(Boolean);
    const busy = S.sendState === "busy";
    return `<div class="ap-row">
      <div class="ap-main">
        <div class="ch-field">${esc(fieldName(c))}</div>
        <div class="ch-diff">${changeDiff(c, fmtChangeVal(first, first.from), fmtChangeVal(c, c.to))}</div>
        <div class="ch-meta">${many ? g.items.length + " changes, newest " : ""}${esc(whenText(c.at))} · ${esc(who)}${pendingNote(c)}</div>
        ${skip ? `<div class="ap-skip">Didn't go in last time: ${esc(skip)}</div>` : ""}
      </div>
      <button class="btn small" type="button" data-action="ap-undo" data-ids="${esc(g.items.map(x => x.id).join(" "))}" aria-label="Undo approval: ${esc(c.unit)} ${esc(c.label)}"${busy ? " disabled" : ""}>Undo</button>
    </div>`;
  }

  function sendCard(n) {
    const cfg = D.config || {};
    const linked = !!(cfg.masterUrl && cfg.masterKey);
    const busy = S.sendState === "busy", sure = S.sendState === "confirm" && linked && !isOffline();
    const what = plural(n, "change");
    let btn = `<button class="btn primary wide" type="button" disabled>Send ${what} to master sheet</button>`;
    let note = "Only those cells change in the master sheet. Formulas and cells marked n/a are left alone.";
    if (!linked) note = "The master sheet isn't linked to the app yet.";
    else if (busy) btn = `<button class="btn primary wide" type="button" disabled>Sending to the master sheet…</button>`;
    else if (isOffline()) note = "No signal right now. Sending to the master sheet needs service.";
    else btn = `<button class="btn primary wide" type="button" data-action="send-master">${sure ? `Tap again to send ${what}` : `Send ${what} to master sheet`}</button>`;
    return `<div class="card card-pad send-card${sure ? " confirm" : ""}">${btn}<p class="muted small">${esc(note)}</p></div>`;
  }

  // ---------------------------------------------------------------- you: sync, app lock, backup
  function renderMe() {
    const el = $("#view-me");
    const waiting = D.outbox.length;
    const off = isOffline();
    const lockAfter = L.pin ? L.pin.after : null;
    let html = "";
    if (S.keyBad) {
      html += `<section class="card card-pad me-card">
        <div class="eyebrow">Sync is paused</div>
        <p>This phone's setup code was changed or turned off, so it can't sync until you type the new one. Everything's still saved here${waiting ? `, including ${waiting} update${waiting === 1 ? "" : "s"} waiting to send` : ""}.</p>
        <form class="editor" data-form="newkey" autocomplete="off">
          <label for="newKey">New setup code<input id="newKey" name="code" class="code-input" type="text" autocapitalize="characters" autocorrect="off" spellcheck="false" maxlength="14" placeholder="XXXX-XXXX-XXXX"></label>
          <p class="warn" id="newKeyWarn" hidden></p>
          <div class="row-actions"><button class="btn primary" type="submit">Save and sync</button></div>
        </form>
      </section>`;
    }
    html += `<section class="card card-pad me-card">
      <div class="eyebrow">On this phone</div>
      <div class="me-name">${esc(S.me.name || "Me")}<span class="pill ok">${S.me.isOwner ? "Private" : "Crew"}</span></div>
      <p>Everything is saved right here, so the app works with no signal. What you add goes to your sheet by itself when you have service.</p>
      <dl class="sync-lines">
        <div><dt>Waiting to send</dt><dd class="${waiting ? "wait" : "ok"}">${waiting ? waiting + " update" + (waiting === 1 ? "" : "s") : "Nothing, all sent"}</dd></div>
        <div><dt>Last synced</dt><dd>${D.lastOk ? esc(shortTime(D.lastOk)) : "Not yet"}</dd></div>
        <div><dt>Signal</dt><dd>${D.busy ? "Syncing…" : off ? "None right now" : "Connected"}</dd></div>
        <div><dt>Saved here</dt><dd>${S.units.size} units · ${S.problems.filter(p => p.status !== "fixed").length} open problems</dd></div>
      </dl>
      <div class="row-actions"><button class="btn primary" type="button" data-action="sync-now"${S.keyBad ? " disabled" : ""}>Sync now</button>${D.sheetUrl ? `<a class="btn" href="${esc(D.sheetUrl)}" target="_blank" rel="noopener">Open my sheet</a>` : ""}</div>
      ${standalone() ? "" : `<details class="howto"><summary>Put the app on your home screen</summary>${installSteps()}${S.installEvt ? `<div class="row-actions" style="margin-top:8px"><button class="btn" type="button" data-action="install">Add to home screen</button></div>` : ""}</details>`}
    </section>
    <section class="card card-pad me-card">
      <div class="eyebrow">App lock</div>
      ${L.pin ? `<label class="field" for="lockAfter">Ask for my PIN<select id="lockAfter">${LOCK_CHOICES.map(([ms, label]) => `<option value="${ms}"${ms === lockAfter ? " selected" : ""}>${label}</option>`).join("")}</select></label>
        <div class="row-actions"><button class="btn" type="button" data-action="pin-change">Change PIN</button>${lockAfter >= 0 ? `<button class="btn quiet" type="button" data-action="lock-now">Lock now</button>` : ""}</div>`
        : `<p>No PIN on this phone. Anyone who picks up your unlocked phone can open the app.</p><div class="row-actions"><button class="btn primary" type="button" data-action="pin-set">Set a PIN</button></div>`}
    </section>
    <section class="card card-pad me-card">
      <div class="eyebrow">Backup</div>
      <p>Your sheet is the backup, and it fills in by itself. You can also save a file of everything on this phone, including anything that hasn't sent yet.</p>
      <div class="row-actions"><button class="btn" type="button" data-action="backup">Save a backup file</button>
        <button class="btn quiet${S.confirmReset ? " danger" : ""}" type="button" data-action="reset">${S.confirmReset ? (waiting ? `${waiting} update${waiting === 1 ? " hasn't" : "s haven't"} sent. Tap again to remove anyway` : "Tap again to remove") : "Remove from this phone"}</button></div>
      <p class="ver-line">Machine List ${esc(VERSION)} · <button class="link" type="button" data-action="check-update">Check for an app update</button></p>
    </section>`;
    el.innerHTML = html;
  }

  function typingInMe() {
    const i = $("#newKey");
    return !!(i && (i.value || document.activeElement === i));
  }

  async function saveNewKey(form) {
    const code = normKey(form.elements.code.value);
    if (code.length !== 12) return showWarn(form, "newKeyWarn", "The setup code is 12 letters and numbers.");
    if (navigator.onLine === false) return showWarn(form, "newKeyWarn", "No signal. Try again when you have service.");
    setFormBusy(form, true);
    let res;
    try { res = await M.post(D.setup.url, { key: code, device: D.setup.device, app: VERSION, ver: D.ver, full: false, ops: [] }, 45000); }
    catch (e) { setFormBusy(form, false); return showWarn(form, "newKeyWarn", "Couldn't reach your sheet. Check your signal and try again."); }
    if (!res || !res.ok) { setFormBusy(form, false); return showWarn(form, "newKeyWarn", res && res.error === "bad_key" ? "That code doesn't work." : "Your sheet had a problem. Try again in a minute."); }
    D.setup = Object.assign({}, D.setup, { key: code });
    await M.set("setup", D.setup);
    S.keyBad = false;
    toast("Code saved. Syncing now.");
    render();
    sync({ full: true, user: true });
  }

  function downloadBackup() {
    const data = {
      app: "Machine List", version: VERSION, savedAt: new Date().toISOString(),
      units: unitsArr(), changes: S.changes, problems: S.problems, waitingToSend: D.outbox
    };
    const blob = new Blob([JSON.stringify(data, null, 1)], { type: "application/json" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = "machine-list-backup-" + C.isoDate(new Date()) + ".json";
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 60000);
    toast("Backup saved.");
  }

  async function resetPhone() {
    if (!S.confirmReset) {
      S.confirmReset = true;
      renderMe();
      clearTimeout(S.resetTimer);
      S.resetTimer = setTimeout(() => { S.confirmReset = false; if (S.tab === "me") renderMe(); }, 8000);
      return;
    }
    try { await M.clearAll(); } catch (e) { /* reload anyway */ }
    ["tab", "cat", "showNA", "openSecs", "seenAt", "tipDone"].forEach(lsDel);
    location.reload();
  }

  // ---------------------------------------------------------------- unit page
  function digits(u) {
    const cur = C.num((u.v || {}).cur);
    const min = u.g === "TRK" ? 6 : 5;
    if (cur === null) return { dim: true, chars: "-".repeat(min).split("") };
    return { dim: false, chars: String(Math.round(cur)).padStart(min, "0").split("") };
  }

  function renderDetail() {
    const el = $("#detail");
    S.detailStale = false;
    const u = S.openId ? S.units.get(S.openId) : null;
    document.body.classList.toggle("detail-open", !!u);
    if (!u) {
      el.innerHTML = S.unitsLoaded && S.units.size ? `<div class="card empty-state"><h3>Pick a unit</h3><p>Tap any machine, truck, trailer or small engine to see its hours, location, problems, service, buckets, filters and paperwork.</p></div>` : "";
      return;
    }
    const t = today();
    const v = u.v || {};
    const st = C.unitStatus(u, t);
    const meta = [v.make, v.model && v.model !== v.name ? v.model : "", v.year && v.year !== "?" ? v.year : "", C.personName(v.owner)].filter(Boolean).join(" · ");
    const fuel = needsFuel(u);
    let fuelBtn = "";
    if (hasFuel(u)) {
      if (!S.readOnly) fuelBtn = `<button class="fuel-btn${fuel ? " on" : ""}" data-action="fuel" aria-pressed="${fuel}" title="${fuel ? "Tap once it's fueled" : "Tap if it needs fuel"}">${fuel ? NOFUEL_SVG + "Needs fuel" : FUEL_SVG + "Fuel"}</button>`;
      else if (fuel) fuelBtn = `<span class="fuel-btn on">${NOFUEL_SVG}Needs fuel</span>`;
    }
    let html = `<div class="d-head">
      <button class="btn quiet back" data-action="close">← All units</button>
      <div class="d-title">
        <div class="line"><span class="plate lg">${esc(u.id)}</span><span class="pill ${st.st}">${esc(st.label)}</span><span class="muted">${esc(C.catName(u))}</span></div>
        <div class="name-line"><h2>${esc(nameOf(u))}</h2>${fuelBtn}</div>
        ${meta ? `<p class="d-meta">${esc(meta)}</p>` : ""}
        ${fuel ? `<p class="fuel-note">Needs fuel · flagged ${esc(whenText(u.fuel.at))} · ${esc(whoName(u.fuel.by))}</p>` : ""}
      </div></div>`;
    if (C.usesMeter(u)) html += meterCard(u);
    if (C.applies(u, C.FIELDS.loc.rule)) html += locationCard(u);
    html += attWithCard(u);
    html += inspCard(u);
    html += problemsCard(u);
    html += serviceCard(u, t);
    if (C.applies(u, "ATT")) html += attCard(u);
    C.SECTIONS.forEach(sec => { if (!sec.special) html += sectionBlock(u, sec, t); });
    html += `<label class="toggle" for="showNA"><input type="checkbox" id="showNA" ${S.showNA ? "checked" : ""}> Show fields that don't apply to this unit</label>`;
    el.innerHTML = html;
    const inp = el.querySelector(".editor input:not([type=hidden]), .editor select, .editor textarea");
    if (inp && S.editing && S.editing.focus) { inp.focus(); S.editing.focus = false; }
  }

  function meterCard(u) {
    const v = u.v || {};
    const truck = u.g === "TRK";
    const word = C.unitWord(u);
    const d = digits(u);
    const cur = C.num(v.cur);
    const read = C.parseDate(v.read);
    const editing = S.editing && S.editing.type === "hours";
    let html = `<section class="card card-pad meter-card">
      <div class="meter-top"><div class="eyebrow">${truck ? "Odometer" : "Hour meter"}</div>
        ${!S.readOnly && !editing ? `<button class="btn primary" data-action="hours">Update ${truck ? "miles" : "hours"}</button>` : ""}</div>
      <div class="meter${d.dim ? " dim" : ""}" aria-label="${cur === null ? "No reading" : esc(C.fmtNum(cur) + " " + word)}">${d.chars.map(c => `<span>${esc(c)}</span>`).join("")}</div>
      <div class="meter-sub">${cur === null ? "No reading yet" : `<b>${esc(C.fmtNum(cur))} ${word}</b>${read ? " · read " + C.usDate(read) : ""}`}</div>`;
    if (editing) {
      html += `<form class="editor" data-form="hours">
        <div class="inputs">
          <label for="ed-hours">${truck ? "Miles" : "Hours"}<input id="ed-hours" name="hrs" type="text" inputmode="decimal" autocomplete="off" value="${cur === null ? "" : esc(cur)}"></label>
          <label for="ed-read">Date read<input id="ed-read" name="date" type="date" value="${esc(C.isoDate(today()))}"></label>
        </div>
        <p class="warn" id="hoursWarn" hidden></p>
        <div class="row-actions"><button class="btn primary" type="submit">Save</button><button class="btn" type="button" data-action="cancel">Cancel</button></div>
      </form>`;
    }
    if (truck) html += `<div class="f-row" style="margin:0 -16px -14px">${fieldCell(u, C.FIELDS.enghrs, false)}</div>`;
    return html + `</section>`;
  }

  function latestChange(unitId, key) { return S.changes.find(c => c.unit === unitId && c.key === key && changeState(c) !== "stale") || null; }

  function locationPicks(u) {
    const counts = new Map();
    S.units.forEach(x => {
      const l = ((x.v || {}).loc || "").trim();
      if (l && !/\bshop\b/i.test(l)) counts.set(l, (counts.get(l) || 0) + 1);
    });
    const cur = ((u.v || {}).loc || "").trim();
    return ["Shop"].concat([...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(e => e[0]).filter(l => l !== cur).slice(0, 6));
  }

  function locationCard(u) {
    const loc = ((u.v || {}).loc || "").trim();
    const shop = C.atShop(u);
    const last = latestChange(u.id, "loc");
    const editing = S.editing && S.editing.type === "loc";
    let html = `<section class="card card-pad loc-card${shop ? " shop" : ""}">
      <div class="meter-top"><div class="eyebrow">Location</div>
        ${!S.readOnly && !editing ? `<button class="btn primary" data-action="loc">Update location</button>` : ""}</div>
      <div class="loc-now">${loc ? esc(loc) : `<span class="muted loc-none">No location set</span>`}${shop ? `<span class="pill shop">At shop</span>` : ""}</div>
      ${last ? `<div class="meter-sub">Updated ${esc(whenText(last.at))} · ${esc(whoName(last.by))}</div>` : ""}`;
    if (editing) {
      html += `<form class="editor" data-form="loc">
        <label for="ed-loc">Where is it now?<input id="ed-loc" name="val" type="text" autocomplete="off" value="${esc(loc)}" placeholder="Job name, address or Shop"></label>
        <div class="chips wrap">${locationPicks(u).map(p => `<button type="button" class="chip" data-action="loc-pick" data-val="${esc(p)}">${esc(p)}</button>`).join("")}</div>
        <p class="warn" id="locWarn" hidden></p>
        <div class="row-actions"><button class="btn primary" type="submit">Save</button><button class="btn" type="button" data-action="cancel">Cancel</button></div>
      </form>`;
    }
    return html + `</section>`;
  }

  // Which of the machine's attachments are with it right now (picked from its list under Buckets & attachments).
  // null means nobody has said yet; [] means none of them are with it.
  function attWithList(u) {
    const w = (u.v || {}).attwith;
    return Array.isArray(w) ? (u.att || []).filter(a => w.includes(a)) : null;
  }
  function attWithCard(u) {
    const list = u.att || [];
    if (!C.applies(u, "ATT") || !list.length) return "";
    if ((u.v || {}).setup === "Fixed pin" && list.length < 2) return "";   // a pinned bucket never leaves the machine
    const v = u.v || {};
    const withIt = attWithList(u);
    const editing = S.editing && S.editing.type === "attwith";
    let html = `<section class="card card-pad loc-card attw-card">
      <div class="meter-top"><div class="eyebrow">Attachments with it</div>
        ${!S.readOnly && !editing ? `<button class="btn primary" data-action="attwith">Update attachments</button>` : ""}</div>`;
    if (editing) {
      html += `<form class="editor" data-form="attwith">
        <fieldset class="picks"><legend>Check the ones that are with it now</legend>
          ${list.map(a => `<label class="pick"><input type="checkbox" name="w" value="${esc(a)}"${withIt && withIt.includes(a) ? " checked" : ""}><span>${esc(a)}</span></label>`).join("")}
        </fieldset>
        <div class="row-actions"><button class="btn primary" type="submit">Save</button><button class="btn" type="button" data-action="cancel">Cancel</button></div>
        <p class="hint">Not on the list? Add it under ${C.applies(u, "BKT") ? "Buckets &amp; attachments" : "Attachments"} further down.</p>
      </form>`;
    } else if (withIt === null) {
      html += `<p class="attw-none muted">Not set yet.${S.readOnly ? "" : " Tap Update attachments and check the ones that are with it."}</p>`;
    } else {
      html += withIt.length ? `<div class="att-list attw-list">${withIt.map(a => `<span class="att">${esc(a)}</span>`).join("")}</div>`
        : `<p class="attw-none">None of its attachments are with it.</p>`;
      if (v.attwithat) html += `<div class="meter-sub">Updated ${esc(whenText(v.attwithat))} · ${esc(whoName(v.attwithby))}</div>`;
    }
    return html + `</section>`;
  }

  // State inspection on trucks, trailers and tow-behinds: the month it was done. It's good through the end of
  // that month next year; the box turns yellow 3 months before and red in that last month.
  function inspCard(u) {
    if (!C.applies(u, C.FIELDS.insp.rule)) return "";
    const s = C.inspStatus(u, today());
    const done = C.inspDone(u);
    const last = latestChange(u.id, "insp");
    const editing = S.editing && S.editing.type === "insp";
    let html = `<section class="card card-pad loc-card insp-card${s && s.st !== "ok" ? " " + s.st : ""}">
      <div class="meter-top"><div class="eyebrow">State inspection</div>
        ${!S.readOnly && !editing ? `<button class="btn primary" data-action="insp">Update inspection</button>` : ""}</div>`;
    if (s) {
      const meta = [done ? `Inspected <b>${esc(C.monthYear(done))}</b>` : "", last ? `updated ${esc(whenText(last.at))} · ${esc(whoName(last.by))}` : ""].filter(Boolean).join(" · ");
      html += `<div class="loc-now">${s.st === "over" && !s.now ? "Was good through" : "Good through"} ${esc(C.monthYear(s.due))}<span class="pill ${s.st}">${esc(s.label)}</span></div>
        ${meta ? `<div class="meter-sub">${meta}</div>` : ""}`;
    } else if (!editing) {
      html += `<p class="attw-none muted">No inspection entered yet.</p>`;
    }
    if (editing) {
      const now = today();
      const pick = done || now;
      const years = [];
      for (let y = now.getFullYear() + 1; y >= now.getFullYear() - 4; y--) years.push(y);
      if (!years.includes(pick.getFullYear())) years.push(pick.getFullYear());
      html += `<form class="editor" data-form="insp">
        <div class="inputs">
          <label for="ed-insp-m">Month inspected<select id="ed-insp-m" name="m">${C.MONTHS.map((n, i) => `<option value="${i + 1}"${i === pick.getMonth() ? " selected" : ""}>${n}</option>`).join("")}</select></label>
          <label for="ed-insp-y">Year<select id="ed-insp-y" name="y">${years.map(y => `<option${y === pick.getFullYear() ? " selected" : ""}>${y}</option>`).join("")}</select></label>
        </div>
        <p class="hint">It's good through the end of that month next year. This box turns yellow 3 months before and red in that last month.</p>
        <p class="warn" id="inspWarn" hidden></p>
        <div class="row-actions"><button class="btn primary" type="submit">Save</button><button class="btn" type="button" data-action="cancel">Cancel</button></div>
      </form>`;
    }
    return html + `</section>`;
  }

  function problemItem(p, open) {
    // A coworker's problem report (or their Mark fixed) waits for approval: say so, and let the owner decide right here.
    const rep = S.changes.find(c => c.key === (open ? "prob:" : "fix:") + p.id);
    const waiting = !!rep && changeState(rep) === "waiting";
    const owner = S.me.isOwner && !S.readOnly;
    let acts = "";
    if (waiting && owner) acts = `<button class="btn small primary" data-action="approve" data-id="${esc(rep.id)}">Approve</button><button class="btn small decline" data-action="decline" data-id="${esc(rep.id)}">Decline</button>`;
    if (open && !S.readOnly) acts += `<button class="btn small" data-action="prob-fixed" data-id="${esc(p.id)}">Mark fixed</button>`;
    return `<div class="prob-item">
      <p class="prob-text">${esc(p.text)}${waiting ? ` <span class="pill need">Waiting for approval</span>` : ""}</p>
      <div class="prob-meta">Reported ${esc(whenText(p.at))} · ${esc(whoName(p.by))}${p.pending ? (isOffline() ? " · saved on this phone, will send" : " · sending…") : ""}${!open && p.fixedAt ? ` · fixed ${esc(whenText(p.fixedAt))} · ${esc(whoName(p.fixedBy))}` : ""}</div>
      ${acts ? `<div class="row-actions">${acts}</div>` : ""}
    </div>`;
  }

  function problemsCard(u) {
    const open = openProblems(u.id), fixed = fixedProblems(u.id);
    const editing = S.editing && S.editing.type === "problem";
    let html = `<section class="card card-pad prob-card${open.length ? " has" : ""}">
      <div class="meter-top"><div class="eyebrow">Problems${open.length ? ` <span class="prob-count">${open.length} open</span>` : ""}</div>
        ${!S.readOnly && !editing ? `<button class="btn warn" data-action="problem">Report a problem</button>` : ""}</div>`;
    if (editing) {
      html += `<form class="editor" data-form="problem">
        <label for="ed-prob">What's wrong?<textarea id="ed-prob" name="text" rows="3" placeholder="What you saw, where on the machine, and whether it's safe to run"></textarea></label>
        <p class="warn" id="probWarn" hidden></p>
        <div class="row-actions"><button class="btn warn solid" type="submit">Report problem</button><button class="btn" type="button" data-action="cancel">Cancel</button></div>
      </form>`;
    }
    if (open.length) html += `<div class="prob-list">${open.map(p => problemItem(p, true)).join("")}</div>`;
    else if (!editing) html += `<p class="muted" style="margin:0">No problems reported.</p>`;
    if (fixed.length) html += `<details class="fixed"><summary>Fixed (${fixed.length})</summary>${fixed.map(p => problemItem(p, false)).join("")}</details>`;
    return html + `</section>`;
  }

  function serviceCard(u, t) {
    const list = C.servicesFor(u);
    const meter = C.usesMeter(u);
    const word = C.unitWord(u);
    return `<section class="card card-pad"><div class="card-h"><h3>Service</h3><span class="muted">${list.length} items</span></div>
      <div class="svc-list">${list.map(s => {
        const r = C.serviceStatus(u, s.key, t);
        const d = (u.svc || {})[s.key] || {};
        const ld = C.parseDate(d.ld);
        const last = ld ? `Last done <b>${C.usDate(ld)}</b>${meter && C.num(d.lh) !== null ? ` at <b>${C.fmtNum(C.num(d.lh))} ${word}</b>` : ""}` : "No service logged yet";
        const every = [meter && C.num(d.ih) !== null ? C.fmtNum(C.num(d.ih)) + " " + word : "", C.num(d.im) !== null ? C.num(d.im) + " months" : ""].filter(Boolean).join(" or ");
        const editing = S.editing && S.editing.type === "svc" && S.editing.svc === s.key;
        return `<div class="svc">
          <div class="svc-top"><span class="svc-name">${esc(s.short)}</span><span class="pill ${r.st}">${esc(r.label)}</span></div>
          ${r.next ? `<div class="svc-line">Next due <b>${esc(r.next)}</b></div>` : ""}
          <div class="svc-line">${last}${every ? ` · every <b>${esc(every)}</b>` : " · no interval set"}</div>
          ${!S.readOnly && !editing ? `<div class="row-actions"><button class="btn small" data-action="svc-done" data-svc="${s.key}">Done today</button><button class="btn small" data-action="svc-edit" data-svc="${s.key}">Edit</button></div>` : ""}
          ${editing ? svcEditor(u, s, d) : ""}
        </div>`;
      }).join("")}</div></section>`;
  }

  function svcEditor(u, s, d) {
    const meter = C.usesMeter(u);
    const word = C.unitWord(u);
    const ldIso = C.parseDate(d.ld) ? C.isoDate(C.parseDate(d.ld)) : "";
    return `<form class="editor" data-form="svc" data-svc="${s.key}">
      <div class="inputs">
        ${meter ? `<label for="ed-ih">Every (${word})<input id="ed-ih" name="ih" type="text" inputmode="decimal" autocomplete="off" value="${esc(d.ih ?? "")}"></label>` : ""}
        <label for="ed-im">Every (months)<input id="ed-im" name="im" type="text" inputmode="decimal" autocomplete="off" value="${esc(d.im ?? "")}"></label>
        <label for="ed-ld">Last done (date)<input id="ed-ld" name="ld" type="date" value="${esc(ldIso)}"></label>
        ${meter ? `<label for="ed-lh">Last done at (${word})<input id="ed-lh" name="lh" type="text" inputmode="decimal" autocomplete="off" value="${esc(d.lh ?? "")}"></label>` : ""}
      </div>
      <p class="hint">Typical: ${esc(s.typical)} Check the machine's manual for the real interval.</p>
      <p class="warn" id="svcWarn" hidden></p>
      <div class="row-actions"><button class="btn primary" type="submit">Save</button><button class="btn" type="button" data-action="cancel">Cancel</button></div>
    </form>`;
  }

  function attCard(u) {
    const editing = S.editing && S.editing.type === "att";
    const list = editing ? S.attDraft : (u.att || []);
    const setup = (u.v || {}).setup;
    let html = `<section class="card card-pad" style="display:grid;gap:12px">
      <div class="card-h"><h3>${C.applies(u, "BKT") ? "Buckets & attachments" : "Attachments"}</h3>
        ${!S.readOnly && !editing ? `<button class="btn small" data-action="att-edit">Edit</button>` : ""}</div>
      ${setup && C.applies(u, "BKT") ? `<div class="svc-line">Setup <b>${esc(setup === "?" ? "Not known yet" : setup)}</b></div>` : ""}
      <div class="att-list">${list.length ? list.map((a, i) => `<span class="att">${esc(a)}${editing ? `<button type="button" data-action="att-remove" data-i="${i}" aria-label="Remove ${esc(a)}">×</button>` : ""}</span>`).join("") : `<span class="muted">None listed</span>`}</div>`;
    if (editing) {
      html += `<form class="editor" data-form="att">
        <div class="inputs"><label for="ed-att">Add one${list.length >= 6 ? " (the master sheet holds 6)" : ""}<input id="ed-att" name="add" type="text" autocomplete="off" placeholder="e.g. 3 ft bucket" ${list.length >= 6 ? "disabled" : ""}></label></div>
        <div class="row-actions"><button class="btn" type="button" data-action="att-add" ${list.length >= 6 ? "disabled" : ""}>Add</button><button class="btn primary" type="submit">Save list</button><button class="btn" type="button" data-action="cancel">Cancel</button></div>
      </form>`;
    }
    return html + `</section>`;
  }

  function sectionBlock(u, sec, t) {
    const fields = sec.fields.map(([k]) => C.FIELDS[k]).filter(f => !IN_CARDS.has(f.key));
    const live = fields.filter(f => C.applies(u, f.rule));
    const show = S.showNA ? fields : live;
    if (!show.length) return "";
    const filled = live.filter(f => { const x = (u.v || {})[f.key]; return x !== undefined && x !== null && x !== "" && x !== "?"; }).length;
    const open = S.openSecs.has(sec.title) || (S.editing && S.editing.type === "field" && show.some(f => f.key === S.editing.key));
    return `<details class="sec" data-sec="${esc(sec.title)}"${open ? " open" : ""}>
      <summary><span class="grow"><h3>${esc(sec.short)}</h3><span class="fill">${filled} of ${live.length}</span></span></summary>
      ${show.map(f => `<div class="f-row${C.applies(u, f.rule) ? "" : " na"}">${fieldCell(u, f, !C.applies(u, f.rule), t)}</div>`).join("")}
    </details>`;
  }

  function fieldCell(u, f, na, t) {
    const raw = (u.v || {})[f.key];
    const unconf = (u.unconfirmed || []).includes(f.key);
    const label = `<div class="f-label">${esc(f.label)}${unconf ? `<span class="flag" title="Not confirmed yet">Check</span>` : ""}${na ? `<span class="muted">· doesn't apply</span>` : ""}</div>`;
    if (S.editing && S.editing.type === "field" && S.editing.key === f.key) return label + fieldEditor(u, f, raw, unconf);
    let shown = C.displayValue(f, raw);
    if (f.key === "owner") shown = C.personName(raw);
    let extra = "";
    if (f.type === "expiry" && raw) {
      const e = C.expiryStatus(raw, t || today());
      if (e && e.st !== "ok") extra = `<span class="pill ${e.st}">${e.st === "over" ? "Expired" : "Due soon"}</span>`;
    }
    const cls = `f-val${f.type === "pn" ? " pn" : ""}${shown ? "" : " empty"}`;
    if (S.readOnly) return label + `<div class="${cls} ro">${esc(shown || "—")}${extra}</div>`;
    return label + `<button class="${cls}" data-action="edit" data-key="${f.key}" aria-label="${esc(f.label)}: ${esc(shown || "empty")}. Edit">${esc(shown || "Add")}${extra}</button>`;
  }

  function fieldEditor(u, f, raw, unconf) {
    const id = "ed-" + f.key;
    let val = raw === undefined || raw === null ? "" : String(raw);
    if (f.key === "owner") val = C.personName(val);
    let input;
    if (f.type.startsWith("sel:")) {
      const opts = C.LISTS[f.type.slice(4)] || [];
      const all = val && !opts.includes(val) ? [val].concat(opts) : opts;
      input = `<select id="${id}" name="val"><option value="">—</option>${all.map(o => `<option${o === val ? " selected" : ""}>${esc(o)}</option>`).join("")}</select>`;
    } else if (f.type.startsWith("list:")) {
      const opts = C.LISTS[f.type.slice(5)] || [];
      input = `<input id="${id}" name="val" type="text" autocomplete="off" list="dl-${id}" value="${esc(val)}"><datalist id="dl-${id}">${opts.map(o => `<option value="${esc(o)}"></option>`).join("")}</datalist>`;
    } else if (f.type === "date" || f.type === "expiry") {
      const d = C.parseDate(val);
      input = `<input id="${id}" name="val" type="date" value="${d ? C.isoDate(d) : ""}">`;
    } else if (f.type === "num" || f.type === "money") {
      input = `<input id="${id}" name="val" type="text" inputmode="decimal" autocomplete="off" value="${esc(val)}">`;
    } else if (LONG_TEXT.has(f.key)) {
      input = `<textarea id="${id}" name="val" rows="3">${esc(val)}</textarea>`;
    } else {
      input = `<input id="${id}" name="val" type="text" autocomplete="off" value="${esc(val === "?" ? "" : val)}"${f.type === "pn" ? ' autocapitalize="characters" spellcheck="false"' : ""}>`;
    }
    return `<form class="editor" data-form="field" data-key="${f.key}">
      ${input}
      <p class="warn" id="fieldWarn" hidden></p>
      <div class="row-actions"><button class="btn primary" type="submit">Save</button><button class="btn" type="button" data-action="cancel">Cancel</button>
        ${unconf && val && val !== "?" ? `<button class="btn quiet" type="button" data-action="confirm" data-key="${f.key}">${esc(val)} is right</button>` : ""}</div>
    </form>`;
  }

  // ---------------------------------------------------------------- saving
  function toast(msg) {
    const el = $("#toast");
    el.textContent = msg;
    el.classList.add("show");
    clearTimeout(toast._t);
    toast._t = setTimeout(() => el.classList.remove("show"), 3800);
  }
  function plain(v, type) {
    if (v === null || v === undefined) return "";
    if (Array.isArray(v)) return v.join(", ");
    if (type === "date" || type === "expiry") { const d = C.parseDate(String(v)); return d ? C.usDate(d) : String(v); }
    return String(v);
  }
  function setFormBusy(form, busy) { if (form) form.querySelectorAll("button").forEach(b => { b.disabled = busy; }); }
  const canWrite = () => { if (S.readOnly) { toast("This copy can look but can't save changes."); return false; } return true; };
  const offlineNote = () => (isOffline() ? " No signal right now, so it's saved on this phone and will send on its own." : "");
  const crewNote = () => (S.me.isOwner ? "" : " It's waiting for approval.");

  function commit(u, patch, changes, msg) {
    if (!canWrite()) return false;
    const unitName = (patch.v && patch.v.name) || nameOf(u);
    const log = changes.map(ch => ({
      cid: newId("C"), key: ch.key, p: ch.p || (ch.key.startsWith("svc.") || ch.key === "att" ? ch.key : "v." + ch.key),
      label: ch.label, section: ch.section, from: plain(ch.from, ch.type), to: plain(ch.to, ch.type), kind: ch.kind || ""
    }));
    queueOp({ t: "unit", unit: u.id, unitName, patch, log });
    endEdit();
    render();
    if (!S.me.isOwner) msg = (msg || "Saved.") + " It's waiting for approval.";
    toast((msg || "Saved. Approve it under Changes when you want it in the master sheet.") + offlineNote());
    return true;
  }

  function same(a, b) { return String(a === null || a === undefined ? "" : a) === String(b === null || b === undefined ? "" : b); }
  function showWarn(form, id, text) { const w = form.querySelector("#" + id); if (w) { w.textContent = text; w.hidden = !text; } }

  function saveValue(u, f, val, msg) {
    const old = (u.v || {})[f.key];
    if (same(old, val)) { endEdit(); renderDetail(); return; }
    const patch = { v: { [f.key]: val } };
    const unc = u.unconfirmed || [];
    if (unc.includes(f.key)) patch.unconfirmed = unc.filter(k => k !== f.key);
    commit(u, patch, [{ key: f.key, label: f.label, section: f.section, from: old, to: val, type: f.type }], msg);
  }

  function saveField(form) {
    const u = S.units.get(S.openId); if (!u) return;
    const f = C.FIELDS[form.dataset.key];
    let val = form.elements.val.value.trim();
    if ((f.type === "num" || f.type === "money") && val !== "") {
      const n = C.num(val.replace(/^\$/, ""));
      if (n === null) return showWarn(form, "fieldWarn", "Enter a number, like 3000.");
      val = n;
    }
    if (f.key === "name" && val === "") return showWarn(form, "fieldWarn", "Every unit needs a name.");
    saveValue(u, f, val, null);
  }

  function saveLocation(form) {
    const u = S.units.get(S.openId); if (!u) return;
    const val = form.elements.val.value.trim().replace(/\s+/g, " ");
    if (!val) return showWarn(form, "locWarn", "Type where it is, or tap Shop.");
    const shop = /\bshop\b/i.test(val);
    saveValue(u, C.FIELDS.loc, val, shop ? `${nameOf(u)} is at the shop.` : `Moved ${nameOf(u)} to ${val}.`);
  }

  function confirmField(key) {
    const u = S.units.get(S.openId); if (!u) return;
    const f = C.FIELDS[key];
    const val = (u.v || {})[key];
    const patch = { unconfirmed: (u.unconfirmed || []).filter(k => k !== key) };
    commit(u, patch, [{ key, p: "unconfirmed", label: f.label, section: f.section, from: val, to: val, type: f.type, kind: "confirm" }],
      `Marked ${f.label.toLowerCase()} as confirmed.`);
  }

  function saveHours(form) {
    const u = S.units.get(S.openId); if (!u) return;
    const word = C.unitWord(u);
    const n = C.num(form.elements.hrs.value);
    if (n === null || n < 0) return showWarn(form, "hoursWarn", "Enter the reading as a number, like 3000.");
    const date = form.elements.date.value || C.isoDate(today());
    const old = C.num((u.v || {}).cur);
    if (old !== null && n < old && form.dataset.lower !== "1") {
      form.dataset.lower = "1";
      return showWarn(form, "hoursWarn", `That's lower than the last reading (${C.fmtNum(old)} ${word}). Tap Save again to keep it.`);
    }
    const patch = { v: {} }, changes = [];
    if (old !== n) { patch.v.cur = n; changes.push({ key: "cur", label: C.FIELDS.cur.label, section: "HOURS", from: old, to: n, type: "num" }); }
    if (!same((u.v || {}).read, date)) { patch.v.read = date; changes.push({ key: "read", label: C.FIELDS.read.label, section: "HOURS", from: (u.v || {}).read, to: date, type: "date" }); }
    if (!changes.length) { endEdit(); renderDetail(); return; }
    commit(u, patch, changes, `Saved ${C.fmtNum(n)} ${word} for ${nameOf(u)}.`);
  }

  function saveSvc(form) {
    const u = S.units.get(S.openId); if (!u) return;
    const key = form.dataset.svc, s = C.SVC[key];
    const cur = (u.svc || {})[key] || {};
    const next = {};
    for (const sub of ["ih", "im", "lh"]) {
      if (!form.elements[sub]) continue;
      const raw = form.elements[sub].value.trim();
      if (raw === "") { next[sub] = ""; continue; }
      const n = C.num(raw);
      if (n === null || n < 0) return showWarn(form, "svcWarn", "Intervals and readings need to be numbers, like 500.");
      next[sub] = n;
    }
    next.ld = form.elements.ld.value || "";
    const patch = { svc: { [key]: {} } }, changes = [];
    Object.keys(next).forEach(sub => {
      if (same(cur[sub], next[sub])) return;
      patch.svc[key][sub] = next[sub];
      changes.push({ key: "svc." + key + "." + sub, label: C.SVC_SUB[sub].label, section: s.title, from: cur[sub], to: next[sub], type: sub === "ld" ? "date" : "num" });
    });
    if (!changes.length) { endEdit(); renderDetail(); return; }
    commit(u, patch, changes, `Saved ${s.short.toLowerCase()} for ${nameOf(u)}.`);
  }

  function svcDone(key) {
    const u = S.units.get(S.openId); if (!u) return;
    const s = C.SVC[key], d = (u.svc || {})[key] || {};
    const todayIso = C.isoDate(today());
    const cur = C.usesMeter(u) ? C.num((u.v || {}).cur) : null;
    const patch = { svc: { [key]: { ld: todayIso } } };
    const changes = [{ key: "svc." + key + ".ld", label: C.SVC_SUB.ld.label, section: s.title, from: d.ld, to: todayIso, type: "date" }];
    if (cur !== null) { patch.svc[key].lh = cur; changes.push({ key: "svc." + key + ".lh", label: C.SVC_SUB.lh.label, section: s.title, from: d.lh, to: cur, type: "num" }); }
    const word = C.unitWord(u);
    commit(u, patch, changes, `Logged ${s.short.toLowerCase()} as done today${cur !== null ? " at " + C.fmtNum(cur) + " " + word : ""}.`);
  }

  function saveAtt(form) {
    const u = S.units.get(S.openId); if (!u) return;
    const extra = form.elements.add && form.elements.add.value.trim();
    if (extra && S.attDraft.length < 6) S.attDraft.push(extra);
    const old = u.att || [];
    if (old.join("\u0001") === S.attDraft.join("\u0001")) { endEdit(); renderDetail(); return; }
    commit(u, { att: S.attDraft.slice() }, [{ key: "att", label: "Bucket / Attachment 1–6", section: "BUCKETS & ATTACHMENTS", from: old, to: S.attDraft.slice(), type: "list" }],
      `Saved the attachment list for ${nameOf(u)}.`);
  }

  // State inspection: saves the month it was done and the Inspection Expires date (end of that month next year),
  // which goes under Changes for the master sheet like any other detail.
  function saveInsp(form) {
    const u = S.units.get(S.openId); if (!u) return;
    const m = Number(form.elements.m.value), y = Number(form.elements.y.value);
    if (!(m >= 1 && m <= 12) || !(y >= 2000 && y <= 2100)) return showWarn(form, "inspWarn", "Pick the month and year it was inspected.");
    const done = y + "-" + String(m).padStart(2, "0");
    const exp = C.isoDate(new Date(y + 1, m, 0));
    const v = u.v || {};
    if (v.inspdone === done && same(v.insp, exp)) { endEdit(); renderDetail(); return; }
    const f = C.FIELDS.insp;
    commit(u, { v: { inspdone: done, insp: exp } }, [{ key: "insp", label: f.label, section: f.section, from: v.insp, to: exp, type: "expiry" }],
      `Saved. ${nameOf(u)} was inspected ${C.MONTHS[m - 1]} ${y} and is good through ${C.MONTHS[m - 1]} ${y + 1}.`);
  }

  // What's with a machine changes all the time, like fuel, so it stays in the app and skips the Changes list.
  function saveAttWith(form) {
    const u = S.units.get(S.openId); if (!u || !canWrite()) return;
    const picked = new Set([...form.querySelectorAll('input[name="w"]:checked')].map(i => i.value));
    const keep = (u.att || []).filter(a => picked.has(a));
    const old = attWithList(u);
    if (old !== null && old.join("\u0001") === keep.join("\u0001")) { endEdit(); renderDetail(); return; }
    queueOp({ t: "unit", unit: u.id, unitName: nameOf(u), log: [],
      patch: { v: { attwith: keep, attwithat: new Date().toISOString(), attwithby: S.me.name } } });
    endEdit();
    render();
    toast((keep.length ? `With ${nameOf(u)}: ${keep.join(", ")}.` : `Marked ${nameOf(u)} as having none of its attachments.`) + offlineNote());
  }

  // Problems and fuel flags are day-to-day field notes: they live in the app and skip the Changes list.
  function saveProblem(form) {
    const u = S.units.get(S.openId); if (!u || !canWrite()) return;
    const text = form.elements.text.value.trim();
    if (!text) return showWarn(form, "probWarn", "Describe the problem so the next person knows what to look at.");
    queueOp({ t: "prob", pid: newId("P"), unit: u.id, unitName: nameOf(u), text });
    endEdit();
    render();
    toast(`Problem reported. ${nameOf(u)} shows orange in the list until it's marked fixed.` + crewNote() + offlineNote());
  }

  function markFixed(pid) {
    if (!canWrite()) return;
    queueOp({ t: "fix", pid });
    render();
    toast("Marked fixed." + crewNote() + offlineNote());
  }

  function toggleFuel() {
    const u = S.units.get(S.openId); if (!u || !canWrite()) return;
    const on = !needsFuel(u);
    queueOp({ t: "fuel", unit: u.id, needs: on });
    render();
    toast((on ? `Flagged ${nameOf(u)} as needing fuel.` : `Marked ${nameOf(u)} as fueled.`) + crewNote() + offlineNote());
  }

  function setApproval(ids, approved) {
    if (!S.me.isOwner || !ids.length) return false;
    queueOp({ t: "approve", cids: ids, val: approved ? "Approved" : "" });
    render();
    return true;
  }

  function approveAll() {
    const ids = S.changes.filter(c => changeState(c) === "waiting").map(c => c.id);
    if (!ids.length) return;
    setApproval(ids, true);
    toast(`Approved ${plural(ids.length, "change")}. They're on the Approved tab, ready to send to the master sheet.`);
  }

  // Declining a change that was sent in by mistake: it never goes to the master sheet, and if it's still the
  // newest change to that field, the field goes back to what it was before.
  const findChange = id => S.changes.find(c => c.id === id) || null;
  function fieldNow(u, key) {
    if (key === "att") return (u.att || []).join(", ");
    if (key.startsWith("svc.")) { const p = key.split("."); return plain(((u.svc || {})[p[1]] || {})[p[2]], p[2] === "ld" ? "date" : "num"); }
    const f = C.FIELDS[key];
    return plain((u.v || {})[key], f ? f.type : "text");
  }
  // The patch that puts a field back to a value as the Changes list shows it (dates as MM/DD/YYYY, lists joined).
  function fieldPatch(key, val) {
    val = val === null || val === undefined ? "" : String(val);
    const day = s => { const d = C.parseDate(s); return d ? C.isoDate(d) : s; };
    const number = s => { const x = C.num(s.replace(/^\$/, "")); return x === null ? s : x; };
    if (key === "att") return { att: val ? val.split(", ").map(s => s.trim()).filter(Boolean) : [] };
    if (key.startsWith("svc.")) {
      const p = key.split(".");
      if (!C.SVC[p[1]] || !C.SVC_SUB[p[2]]) return null;
      return { svc: { [p[1]]: { [p[2]]: val === "" ? "" : p[2] === "ld" ? day(val) : number(val) } } };
    }
    const f = C.FIELDS[key];
    if (!f) return null;
    let x = val;
    if (val !== "" && (f.type === "num" || f.type === "money")) x = number(val);
    else if (val !== "" && (f.type === "date" || f.type === "expiry")) x = day(val);
    const patch = { v: { [key]: x } };
    if (key === "insp") { const d = C.parseDate(val); patch.v.inspdone = d ? (d.getFullYear() - 1) + "-" + String(d.getMonth() + 1).padStart(2, "0") : ""; }
    return patch;
  }
  // Set the field to `val` if it still shows `expect` and no newer change to it is standing.
  function fieldBack(c, val, expect) {
    if (!c || c.note === "Confirmed" || !c.key) return null;
    const u = S.units.get(c.unit);
    if (!u) return null;
    const newer = S.changes.some(x => x.id !== c.id && x.unit === c.unit && x.key === c.key && String(x.at) > String(c.at) && !["stale", "declined"].includes(changeState(x)));
    if (newer || fieldNow(u, c.key) !== String(expect === null || expect === undefined ? "" : expect)) return null;
    const patch = fieldPatch(c.key, val);
    return patch ? { t: "unit", unit: u.id, unitName: nameOf(u), patch, log: [] } : null;
  }

  // A coworker's fuel flag or problem: declining it undoes it (the flag goes back, the problem report comes off,
  // a problem they marked fixed opens again); undoing the decline puts it back.
  function crewUndo(c, undo) {
    const key = String(c.key || "");
    const u = S.units.get(c.unit);
    if (key === "fuel") {
      const newer = S.changes.some(x => x.id !== c.id && x.unit === c.unit && x.key === "fuel" && String(x.at) > String(c.at) && !["stale", "declined"].includes(changeState(x)));
      const want = (undo ? c.from : c.to) === "Yes";
      if (!u || newer || needsFuel(u) !== want) return null;
      return { t: "fuel", unit: u.id, needs: !want };
    }
    const pid = key.slice(key.indexOf(":") + 1);
    const p = S.problems.find(x => x.id === pid);
    if (!p) return null;
    if (key.startsWith("prob:")) return undo ? (p.status === "declined" ? { t: "probx", pid, val: "Open" } : null) : (p.status !== "declined" ? { t: "probx", pid, val: "Declined" } : null);
    if (key.startsWith("fix:")) return undo ? (p.status === "open" ? { t: "fix", pid } : null) : (p.status === "fixed" ? { t: "probx", pid, val: "Open" } : null);
    return null;
  }
  function declineChange(id) {
    const c = findChange(id);
    if (!S.me.isOwner || !c || !["waiting", "approved"].includes(changeState(c))) return;
    const crewItem = !isMasterChange(c);
    const back = crewItem ? crewUndo(c, false) : fieldBack(c, c.from, c.to);
    queueOp({ t: "approve", cids: [id], val: "Declined" });
    if (back) queueOp(back);
    render();
    const u = S.units.get(c.unit), shown = fmtChangeVal(c, c.from), name = u ? nameOf(u) : c.unit;
    if (crewItem) {
      const what = c.key === "fuel" ? (c.to === "Yes" ? `The fuel flag on ${name} is off.` : `${name} is flagged as needing fuel again.`)
        : c.key.startsWith("prob:") ? `That problem report is off ${name}.` : `That problem on ${name} is open again.`;
      toast("Declined. " + (back ? what : "Nothing else to undo."));
      return;
    }
    toast(back ? `Declined. ${c.label || "That field"} on ${name} is back to ${shown || "empty"}.` : "Declined. It won't go to the master sheet.");
  }
  function undoDecline(id) {
    const c = findChange(id);
    if (!S.me.isOwner || !c || changeState(c) !== "declined") return;
    queueOp({ t: "approve", cids: [id], val: "" });
    const again = isMasterChange(c) ? fieldBack(c, c.to, c.from) : crewUndo(c, true);   // decline had undone it: put it back
    if (again) queueOp(again);
    render();
    toast("Back to waiting for approval.");
  }
  function undoApproval(ids) {
    if (!setApproval(ids, false)) return;
    toast(ids.length === 1 ? "Moved back to Waiting under Changes." : `Moved ${ids.length} changes back to Waiting under Changes.`);
  }

  // ---------------------------------------------------------------- sending approved changes to the master sheet
  // The master sheet has its own small link (its own Apps Script); the app sends it each approved field's newest
  // value, then tells your sheet which changes went in.
  function masterName(v) {
    const ini = (D.config && D.config.initials) || {};
    const keys = Object.keys(ini).filter(k => ini[k] === v);
    return keys.find(k => k.includes(" – ")) || keys[0] || v;
  }
  function masterItem(g) {
    const c = g.latest, key = c.key || "", f = C.FIELDS[key];
    let type = "text", value = c.to === null || c.to === undefined ? "" : String(c.to);
    if (key === "att") { type = "list"; value = value ? value.split(", ").map(s => s.trim()).filter(Boolean) : []; }
    else if (key.startsWith("svc.")) type = key.split(".")[2] === "ld" ? "date" : "num";
    else if (f && (f.type === "num" || f.type === "money")) type = "num";
    else if (f && (f.type === "date" || f.type === "expiry")) type = "date";
    if (type === "num" && value !== "") { const x = C.num(value.replace(/^\$/, "")); if (x !== null) value = x; }
    if (type === "date" && value !== "") { const d = C.parseDate(value); if (d) value = C.isoDate(d); }
    if (key === "owner") value = masterName(value);
    const at = new Date(c.at);
    return { ids: g.items.map(x => x.id), unit: c.unit, key, section: c.section, label: c.label, type, value,
      by: c.by || S.me.name, at: c.at, day: isNaN(at) ? "" : C.isoDate(at), confirm: c.note === "Confirmed" };
  }

  async function sendToMaster() {
    const cfg = D.config || {};
    if (S.sendState === "busy") return;
    if (!cfg.masterUrl || !cfg.masterKey) { toast("The master sheet isn't linked to the app yet."); return; }
    if (isOffline()) { toast("No signal right now. Sending to the master sheet needs service."); return; }
    const groups = approvedGroups();
    if (!groups.length) return;
    clearTimeout(S.sendTimer);
    if (S.sendState !== "confirm") {
      S.sendState = "confirm";
      renderApproved();
      S.sendTimer = setTimeout(() => { if (S.sendState === "confirm") { S.sendState = null; if (S.tab === "approved") renderApproved(); } }, 8000);
      return;
    }
    S.sendState = "busy";
    renderApproved();
    let res = null, fail = "";
    try { res = await M.post(cfg.masterUrl, { key: cfg.masterKey, by: S.me.name, app: VERSION, changes: groups.map(masterItem) }, 150000); }
    catch (e) { fail = e && e.server ? "The master sheet had a problem: " + e.message : "Couldn't reach the master sheet. Check your signal and try again."; }
    S.sendState = null;
    if (!fail && (!res || res.ok !== true)) {
      fail = res && res.error === "bad_key" ? "The master sheet's code doesn't match the one on your sheet's Settings tab."
        : res && res.error === "busy" ? "The master sheet is busy. Try again in a minute."
        : "The master sheet had a problem" + (res && res.message ? ": " + res.message : "") + ". Nothing was marked as sent.";
    }
    if (fail) { render(); toast(fail); return; }
    const copied = (Array.isArray(res.copied) ? res.copied : []).filter(id => typeof id === "string" && findChange(id));
    const skips = {};
    (Array.isArray(res.skipped) ? res.skipped : []).forEach(s => (s && Array.isArray(s.ids) ? s.ids : []).forEach(id => { skips[id] = String(s.why || "It couldn't go in."); }));
    S.sendSkips = skips;
    lsSet("skips", skips);
    if (copied.length) queueOp({ t: "copied", cids: copied });
    render();
    const left = Object.keys(skips).length;
    toast(copied.length
      ? `Done. ${plural(copied.length, "change")} went into the master sheet.` + (left ? ` ${left} couldn't; the reason is on each one.` : "")
      : left ? "None of them could go in. The reason is on each one." : "Nothing was sent.");
  }

  // ---------------------------------------------------------------- the phone's Back button
  // Back steps back through what you did in the app, like any phone app: it closes an open editor, then goes
  // from a unit back to the list, then back through the tabs you were on. On the main list it does nothing,
  // so Back never takes you out of the app; the home button does.
  // Each screen is a step in the browser's history. Phones only let a web app hold the Back button with a step
  // that was added right after a tap (one step per tap), so the step under the main list is put back after your
  // next tap, and only when that tap didn't already add a step of its own.
  const NAV = { on: false, atBase: true, pushed: false, ignore: 0, rootW: null };
  const TABS = ["fleet", "due", "changes", "approved", "me"];
  const screenNow = extra => Object.assign({ ml: 1, tab: S.tab, openId: S.openId || null }, extra || {});

  function navStart() {
    if (NAV.on) return;
    NAV.on = true;
    try { history.scrollRestoration = "manual"; } catch (e) { /* older browsers */ }
    try { history.replaceState({ ml: 1, base: 1, tab: "fleet", openId: null }, ""); } catch (e) { /* fine */ }
    NAV.atBase = true;
    const tapped = () => { NAV.pushed = false; setTimeout(navArm, 0); };
    document.addEventListener("click", tapped, true);
    document.addEventListener("keydown", tapped, true);
    window.addEventListener("popstate", onBack);
    rootWatch();
  }
  // On the bottom step after a tap that didn't move anywhere: add a step for this screen, so Back has one to take.
  function navArm() {
    if (!NAV.on || !NAV.atBase || NAV.pushed || S.phase !== "app") return;
    try { history.pushState(screenNow(S.editing ? { ed: 1 } : null), ""); NAV.atBase = false; } catch (e) { /* fine */ }
  }
  // Moving to a new screen: remember how far down the old one was scrolled, then add a step for the new one.
  // Leaving an open editor reuses its step, so Back doesn't stop on a screen that looks the same.
  function navPush(extra) {
    if (!NAV.on) return;
    NAV.pushed = true;
    try {
      const cur = history.state;
      if (cur && cur.ml && cur.ed && !(extra && extra.ed)) { history.replaceState(screenNow(extra), ""); return; }
      if (cur && cur.ml) history.replaceState(Object.assign({}, cur, { y: window.scrollY }), "");
      history.pushState(screenNow(extra), "");
      NAV.atBase = false;
    } catch (e) { /* fine */ }
  }
  // What the Back button does, for the on-screen back buttons too.
  function goBackOne() {
    const st = history.state;
    if (!NAV.on || !st || !st.ml || st.base) return false;
    if (S.editing) { S.editing = null; S.attDraft = null; }
    history.go(st.ed ? -2 : -1);
    return true;
  }
  function onBack(e) {
    if (NAV.ignore > 0) { NAV.ignore--; return; }   // our own step back after an editor closed
    const st = e.state && e.state.ml ? e.state : null;
    if (!st) return;
    NAV.atBase = !!st.base;   // on the bottom step, the next tap adds a step back on top of it
    const hadEditor = !!S.editing;
    if (S.editing && !st.ed) { S.editing = null; S.attDraft = null; }   // Back closes an editor without saving, like Cancel
    const tab = TABS.includes(st.tab) && !(st.tab === "approved" && !S.me.isOwner) ? st.tab : "fleet";
    const id = st.openId && S.units.has(st.openId) ? st.openId : null;
    const moved = tab !== S.tab || id !== (S.openId || null);
    if (!moved) { if (hadEditor) renderDetail(); rootWatch(); return; }
    S.tab = tab; lsSet("tab", tab);
    S.openId = id;
    S.confirmReset = false;
    render();
    window.scrollTo(0, typeof st.y === "number" ? st.y : 0);
    const pl = document.querySelector(".pane-list"); if (pl && !id) pl.scrollTop = 0;
    rootWatch();
  }
  // Closing an editor with Save or Cancel takes its step back off, so the next Back goes to the list.
  function endEdit() {
    S.editing = null; S.attDraft = null;
    if (NAV.on && history.state && history.state.ml && history.state.ed) { NAV.ignore++; history.back(); }
  }
  // On the main list, Chrome on Android also lets the app swallow a Back press outright.
  function rootWatch() {
    const atRoot = NAV.on && S.phase === "app" && S.tab === "fleet" && !S.openId && !S.editing;
    if (atRoot && !NAV.rootW && typeof window.CloseWatcher === "function") {
      try {
        const w = new window.CloseWatcher();
        w.addEventListener("cancel", ev => { if (ev.cancelable) ev.preventDefault(); });
        w.addEventListener("close", () => { if (NAV.rootW === w) NAV.rootW = null; setTimeout(rootWatch, 0); });
        NAV.rootW = w;
      } catch (err) { NAV.rootW = null; }
    } else if (!atRoot && NAV.rootW) {
      const w = NAV.rootW;
      NAV.rootW = null;
      try { w.destroy(); } catch (err) { /* already gone */ }
    }
  }

  // ---------------------------------------------------------------- navigation
  function setTab(t) {
    if (!TABS.includes(t) || (t === "approved" && !S.me.isOwner)) t = "fleet";
    if (t === S.tab && (!S.openId || window.innerWidth >= 980)) { window.scrollTo(0, 0); return; }   // already there
    S.editing = null; S.attDraft = null;
    S.tab = t; lsSet("tab", t);
    S.confirmReset = false;
    if (S.sendState === "confirm") S.sendState = null;
    if (window.innerWidth < 980 && S.openId) closeUnit(true);
    navPush();
    render();
    window.scrollTo(0, 0);
    const pl = document.querySelector(".pane-list"); if (pl) pl.scrollTop = 0;
    rootWatch();
  }
  function openUnit(id) {
    if (!S.units.has(id) || id === S.openId) return;
    if (!S.openId) S.listScroll = window.scrollY;
    S.editing = null; S.attDraft = null;
    S.openId = id;
    navPush();
    render();
    if (window.innerWidth < 980) window.scrollTo(0, 0);
    else { const d = $("#detail"); if (d) d.scrollTop = 0; }
    rootWatch();
  }
  function closeUnit(silent) {
    S.openId = null; S.editing = null; S.attDraft = null;
    if (silent) return;
    render();
    window.scrollTo(0, S.listScroll || 0);
    rootWatch();
  }
  function startEdit(obj) {
    if (S.readOnly) return;
    const fresh = !S.editing;
    S.editing = Object.assign({ focus: true }, obj);
    if (fresh) navPush({ ed: 1 });
    renderDetail();
    rootWatch();
  }

  // ---------------------------------------------------------------- events
  document.addEventListener("click", e => {
    if (L.open) {
      const p = e.target.closest("[data-pin],[data-pin-act]");
      if (!p) return;
      if (p.dataset.pin) return pinKey(p.dataset.pin);
      const a = p.dataset.pinAct;
      if (a === "forgot") { L.mode = "forgot"; return renderLock(); }
      if (a === "back") { L.mode = "unlock"; L.msg = ""; L.bad = false; return renderLock(); }
      if (a === "skip") { closeLock(); toast("No PIN on this phone. You can set one under the person button."); return; }
      if (a === "cancel") { if (L.pin && L.mode !== "unlock") { closeLock(); return; } closeLock(); return; }
      return;
    }
    const t = e.target.closest("[data-tab],[data-open],[data-cat],[data-st],[data-chf],[data-action]");
    if (!t) return;
    if (t.dataset.tab) {
      // The person button opens and closes the You screen; closing it goes back where you were.
      if (t.dataset.tab === "me" && S.tab === "me") { if (!goBackOne()) setTab("fleet"); return; }
      return setTab(t.dataset.tab);
    }
    if (t.dataset.open) return openUnit(t.dataset.open);
    if (t.dataset.cat) { S.cat = t.dataset.cat; lsSet("cat", S.cat); return renderFleet(); }
    if (t.dataset.st) { S.st = S.st === t.dataset.st ? "all" : t.dataset.st; return renderFleet(); }
    if (t.dataset.chf) { S.chFilter = t.dataset.chf; return renderChanges(); }
    const a = t.dataset.action;
    if (a === "close") {   // "All units" works like Back
      const st = history.state;
      if (NAV.on && st && st.ml && !st.base && st.openId === S.openId && goBackOne()) return;
      return closeUnit();
    }
    if (a === "clear-filters") { S.q = ""; S.cat = "all"; S.st = "all"; $("#q").value = ""; lsSet("cat", "all"); return renderFleet(); }
    if (a === "edit") return startEdit({ type: "field", key: t.dataset.key });
    if (a === "hours") return startEdit({ type: "hours" });
    if (a === "loc") return startEdit({ type: "loc" });
    if (a === "attwith") return startEdit({ type: "attwith", focus: false });
    if (a === "insp") return startEdit({ type: "insp", focus: false });
    if (a === "loc-pick") { const inp = $("#ed-loc"); if (inp) { inp.value = t.dataset.val; inp.focus(); } return; }
    if (a === "problem") return startEdit({ type: "problem" });
    if (a === "prob-fixed") return markFixed(t.dataset.id);
    if (a === "fuel") return toggleFuel();
    if (a === "svc-edit") return startEdit({ type: "svc", svc: t.dataset.svc });
    if (a === "svc-done") return svcDone(t.dataset.svc);
    if (a === "att-edit") { const u = S.units.get(S.openId); S.attDraft = (u && u.att ? u.att.slice() : []); return startEdit({ type: "att" }); }
    if (a === "att-remove") { S.attDraft.splice(Number(t.dataset.i), 1); S.editing.focus = false; return renderDetail(); }
    if (a === "att-add") {
      const inp = $("#ed-att"); const val = inp && inp.value.trim();
      if (val && S.attDraft.length < 6) S.attDraft.push(val);
      S.editing.focus = true; renderDetail(); return;
    }
    if (a === "confirm") return confirmField(t.dataset.key);
    if (a === "cancel") { endEdit(); renderDetail(); if (S.detailStale) render(); rootWatch(); return; }
    if (a === "approve") { if (setApproval([t.dataset.id], true)) toast("Approved. It's on the Approved tab, ready to send to the master sheet."); return; }
    if (a === "unapprove") return undoApproval([t.dataset.id]);
    if (a === "approve-all") return approveAll();
    if (a === "decline") return declineChange(t.dataset.id);
    if (a === "undecline") return undoDecline(t.dataset.id);
    if (a === "ap-undo") return undoApproval(String(t.dataset.ids || "").split(" ").filter(Boolean));
    if (a === "send-master") return sendToMaster();
    if (a === "sync-now") { if (navigator.onLine === false) { toast("No signal right now. Everything's saved on this phone and will send by itself."); return; } toast("Syncing…"); return sync({ full: true, user: true }); }
    if (a === "lock-now") return openLock("unlock");
    if (a === "pin-change") return openLock("change");
    if (a === "pin-set") return openLock("new");
    if (a === "backup") return downloadBackup();
    if (a === "reset") return resetPhone();
    if (a === "check-update") { toast("Checking for an app update…"); return checkForUpdate(true); }
    if (a === "reload-app") return location.reload();
    if (a === "install") {
      const ev = S.installEvt;
      if (!ev) return;
      S.installEvt = null;
      ev.prompt();
      if (ev.userChoice) ev.userChoice.then(() => render()).catch(() => { /* closed */ });
      return;
    }
    if (a === "tip-close") { S.tipClosed = true; lsSet("tipDone", true); return renderFleet(); }
  });
  document.addEventListener("submit", e => {
    e.preventDefault();
    const f = e.target;
    if (f.dataset.form === "setup") return doSetup(f);
    if (f.dataset.form === "forgot") return forgotPin(f);
    if (f.dataset.form === "newkey") return saveNewKey(f);
    if (L.open) return;
    if (f.dataset.form === "field") return saveField(f);
    if (f.dataset.form === "hours") return saveHours(f);
    if (f.dataset.form === "loc") return saveLocation(f);
    if (f.dataset.form === "problem") return saveProblem(f);
    if (f.dataset.form === "svc") return saveSvc(f);
    if (f.dataset.form === "att") return saveAtt(f);
    if (f.dataset.form === "attwith") return saveAttWith(f);
    if (f.dataset.form === "insp") return saveInsp(f);
  });
  document.addEventListener("change", e => {
    if (e.target.id === "showNA") { S.showNA = e.target.checked; lsSet("showNA", S.showNA); renderDetail(); }
    if (e.target.id === "lockAfter" && L.pin) {
      L.pin = Object.assign({}, L.pin, { after: Number(e.target.value) });
      M.set("pin", L.pin).catch(() => { /* try again next change */ });
      lsSet("seenAt", Date.now());
      toast(L.pin.after < 0 ? "The app won't ask for your PIN." : L.pin.after === 0 ? "The app asks for your PIN every time you open it." : "Saved.");
      renderMe();
    }
  });
  // Setup codes: capitals and dashes as you type.
  document.addEventListener("input", e => {
    const i = e.target;
    if (!i.classList || !i.classList.contains("code-input")) return;
    const raw = normKey(i.value).slice(0, 12);
    const pretty = raw.replace(/(.{4})(?=.)/g, "$1-");
    if (i.value !== pretty) i.value = pretty;
  });
  document.addEventListener("keydown", e => {
    if (L.open && L.mode !== "forgot") {
      if (/^[0-9]$/.test(e.key)) { e.preventDefault(); pinKey(e.key); }
      else if (e.key === "Backspace") { e.preventDefault(); pinKey("del"); }
      return;
    }
    if (e.key === "Escape" && S.editing) { endEdit(); renderDetail(); }
    if (e.key === "Enter" && e.target.id === "ed-att") { e.preventDefault(); const val = e.target.value.trim(); if (val && S.attDraft.length < 6) { S.attDraft.push(val); S.editing.focus = true; renderDetail(); } }
  });
  document.addEventListener("toggle", e => {
    const d = e.target;
    if (!(d instanceof HTMLDetailsElement) || !d.dataset.sec) return;
    if (d.open) S.openSecs.add(d.dataset.sec); else S.openSecs.delete(d.dataset.sec);
    lsSet("openSecs", [...S.openSecs]);
  }, true);
  $("#q").addEventListener("input", e => { S.q = e.target.value; renderFleet(); });

  // for the local test harness only
  window.__ML = { S, D, L, NAV, sync, reloadFromDb, approvedGroups, changeState };
  init();
})();
