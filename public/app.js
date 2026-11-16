(function () {
  "use strict";
  var $ = function (s, r) { return (r || document).querySelector(s); };
  var $$ = function (s, r) { return Array.prototype.slice.call((r || document).querySelectorAll(s)); };
  var app = $("#app");

  // Filled from names and tags already used on the website once signed in
  var SPEAKERS = [];
  var TAGS = [];
  var MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
  var COLL_SLUG = { Sunday: "sunday-messages", Hebron: "hebron-messages", Charis: "charis-messages" };
  var MAX_PPS = 300, TILE_W = 114;
  var GENERIC = "Something went wrong. Check your connection and try again.";

  var S = {
    view: "upload", file: null, url: null, demo: false, dur: 0, notes: [],
    segs: null, inPt: null, outPt: null, sel: null, undo: [], redo: [], fit: true,
    skip: false, theme: "system", thumbs: [], d: null,
    render: { pct: 0, done: false, timer: null }, rSegs: null,
    sentBack: "", published: false,
    // real-service state
    user: null, msg: null, list: [], fps: 30, src: null, noteFiles: {},
    up: { active: false, sent: 0, total: 0, paused: false, error: "" }
  };
  function FRAME() { return 1 / (S.fps || 30); }

  function lsGet(k, f) { try { var v = localStorage.getItem("md." + k); return v == null ? f : JSON.parse(v); } catch (e) { return f; } }
  function lsSet(k, v) { try { localStorage.setItem("md." + k, JSON.stringify(v)); } catch (e) {} }
  function esc(s) { return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]; }); }
  function pad(n) { return String(n).padStart(2, "0"); }
  function fmt(t, dec) {
    t = Math.max(0, t || 0); dec = dec || 0;
    var h = Math.floor(t / 3600), m = Math.floor((t % 3600) / 60), s = t - h * 3600 - m * 60;
    var f = Math.pow(10, dec), sv = Math.floor(s * f + 1e-6) / f;
    var ss = dec ? sv.toFixed(dec).padStart(3 + dec, "0") : pad(Math.floor(s));
    return h ? h + ":" + pad(m) + ":" + ss : m + ":" + ss;
  }
  function parseTc(str) {
    str = String(str).trim().replace(/[^0-9:.]/g, "");
    if (!str) return null;
    var parts = str.split(":"), t = 0;
    for (var i = 0; i < parts.length; i++) { var n = parseFloat(parts[i] || "0"); if (isNaN(n)) return null; t = t * 60 + n; }
    return t;
  }
  function ordinal(n) { var v = n % 100; if (v >= 11 && v <= 13) return n + "th"; return n + ({ 1: "st", 2: "nd", 3: "rd" }[n % 10] || "th"); }

  /* ---------- Server ---------- */
  function api(method, path, body) {
    return fetch("/api" + path, {
      method: method, credentials: "same-origin",
      headers: body ? { "Content-Type": "application/json" } : {},
      body: body ? JSON.stringify(body) : undefined
    }).then(function (r) {
      return r.json().catch(function () { return {}; }).then(function (j) {
        if (r.status === 401 && j.signin) { showSignin(); }
        if (!r.ok) { var e = new Error(j.error || GENERIC); e.user = true; e.status = r.status; throw e; }
        return j;
      });
    }, function () { var e = new Error(GENERIC); e.user = true; throw e; });
  }
  function msgOf(e) { return e && e.user ? e.message : GENERIC; }

  /* ---------- Theme ---------- */
  function applyTheme(t) {
    S.theme = t; lsSet("theme", t);
    app.classList.add("no-motion");
    app.classList.toggle("t-light", t === "light");
    app.classList.toggle("t-dark", t === "dark");
    $$("#themeCtl button").forEach(function (b) { b.setAttribute("aria-pressed", String(b.dataset.themeOpt === t)); });
    requestAnimationFrame(function () { requestAnimationFrame(function () { app.classList.remove("no-motion"); }); });
  }
  $$("#themeCtl button").forEach(function (b) { b.addEventListener("click", function () { applyTheme(b.dataset.themeOpt); }); });
  applyTheme(lsGet("theme", "light")); // white by default; people can still choose System or Dark in the side panel

  /* ---------- Section model ---------- */
  function keptDur(segs) {
    segs = segs === undefined ? S.segs : segs;
    if (!segs) return S.dur;
    return segs.reduce(function (a, s) { return a + (s.t === "keep" ? s.b - s.a : 0); }, 0);
  }
  function removedAt(t, segs) {
    if (!segs) return null;
    for (var i = 0; i < segs.length; i++) { var s = segs[i]; if (s.t === "remove" && t >= s.a && t < s.b - 0.01) return s; }
    return null;
  }
  function removedBefore(t, segs) {
    if (!segs) return 0;
    return segs.reduce(function (a, s) { return s.t !== "remove" ? a : a + Math.max(0, Math.min(t, s.b) - s.a); }, 0);
  }
  function snapshot() { return JSON.stringify({ segs: S.segs, inPt: S.inPt, outPt: S.outPt }); }
  function restore(x) {
    var v = JSON.parse(x);
    if (Array.isArray(v) || v === null) v = { segs: v, inPt: null, outPt: null }; // older entries
    S.segs = v.segs; S.inPt = v.inPt; S.outPt = v.outPt; S.sel = null; drawTL();
  }
  function pushUndo() { S.undo.push(snapshot()); if (S.undo.length > 200) S.undo.shift(); S.redo = []; }
  function undo() {
    if (isLocked()) { nudgeLock(); return; }
    if (!S.undo.length) return;
    S.redo.push(snapshot());
    restore(S.undo.pop());
  }
  function redo() {
    if (isLocked()) { nudgeLock(); return; }
    if (!S.redo.length) return;
    S.undo.push(snapshot());
    restore(S.redo.pop());
  }
  function updateHistoryUi() { $("#undoBtn").disabled = !S.undo.length || isLocked(); $("#redoBtn").disabled = !S.redo.length || isLocked(); }
  // After Save & review the cuts are locked, so nothing changes by accident
  function isLocked() { return !S.demo && !!S.msg && (S.msg.status === "finished" || S.msg.status === "published") && !S.unlocked; }
  function drawLock() {
    var on = isLocked(), v = $("#lockVeil");
    $("#tl").classList.toggle("locked", on);
    v.hidden = !on;
    ["#inBtn", "#outBtn", "#splitBtn", "#clearBtn"].forEach(function (id) { $(id).disabled = on; });
    if (on) { v.style.top = tScroll.offsetTop + "px"; v.style.height = tScroll.offsetHeight + "px"; }
  }
  function nudgeLock() {
    var b = $("#unlockBtn"); b.animate && b.animate([{ transform: "scale(1)" }, { transform: "scale(1.06)" }, { transform: "scale(1)" }], { duration: 260, easing: "ease-out" });
  }
  function paint(a, b, t) {
    if (b - a < 0.01) return;
    pushUndo();
    if (!S.segs) S.segs = [{ a: 0, b: S.dur, t: t === "remove" ? "keep" : "remove" }];
    var out = [];
    S.segs.forEach(function (s) {
      if (s.b <= a || s.a >= b) { out.push(s); return; }
      if (s.a < a) out.push({ a: s.a, b: a, t: s.t, s: s.s });
      if (s.b > b) out.push({ a: b, b: s.b, t: s.t });
    });
    out.push({ a: a, b: b, t: t });
    out.sort(function (x, y) { return x.a - y.a; });
    var m = [];
    out.forEach(function (s) {
      if (s.b - s.a < 0.005) return;
      var l = m[m.length - 1];
      // A split point stays, even between two parts of the same kind
      if (l && l.t === s.t && Math.abs(l.b - s.a) < 0.005 && !s.s) l.b = s.b;
      else { var n = { a: s.a, b: s.b, t: s.t }; if (s.s && l) n.s = true; m.push(n); }
    });
    S.segs = (m.length === 1 && m[0].t === "keep") ? null : m;
  }
  // In and out points sit exactly on frame boundaries of the recording
  function frameAt(t) { return Math.floor(t * S.fps + 1e-3); }
  function snap(t) { return Math.min(S.dur, Math.max(0, frameAt(t) / S.fps)); }

  /* ---------- Player ---------- */
  function Player(video, onTick, onUi, segsFn) {
    var self = this;
    this.v = video; this.onTick = onTick; this.onUi = onUi; this.segsFn = segsFn;
    this.clock = 0; this.playing = false; this.last = 0; this.raf = 0; this.pi = 0; this.switching = false;
    video.addEventListener("play", function () { if (!S.demo) { self.playing = true; self.loop(); self.onUi(true); } });
    video.addEventListener("pause", function () { if (!S.demo && !self.switching) { self.playing = false; self.onUi(false); self.onTick(self.getT()); } });
    video.addEventListener("ended", function () {
      // Several recordings: carry straight on into the next one
      var ps = self.parts();
      if (ps && self.pi < ps.length - 1) { self.load(self.pi + 1, 0, true); return; }
      self.playing = false; self.onUi(false);
    });
    video.addEventListener("seeked", function () { if (!self.playing) self.onTick(self.getT()); });
  }
  // Several recordings play as one timeline: each is its own file, one after another
  // A part is a whole file, or (for an already-joined preview) a stretch of one file starting at `from`
  Player.prototype.parts = function () { return S.parts && (S.parts.length > 1 || S.parts[0].from) ? S.parts : null; };
  function partStart(j) { var o = 0; for (var i = 0; i < j; i++) o += S.parts[i].dur; return o; }
  function partAt(x) { var o = 0; for (var i = 0; i < S.parts.length; i++) { if (x < o + S.parts[i].dur || i === S.parts.length - 1) return i; o += S.parts[i].dur; } return 0; }
  Player.prototype.getT = function () {
    if (S.demo) return this.clock;
    var ps = this.parts();
    if (!ps) return this.v.currentTime || 0;
    var j = Math.min(this.pi, ps.length - 1);
    return partStart(j) + Math.max(0, (this.v.currentTime || 0) - (ps[j].from || 0));
  };
  Player.prototype.load = function (j, local, play) {
    var self = this, v = this.v, ps = this.parts();
    if (!ps || !ps[j]) return;
    var resume = play != null ? play : this.playing, at = (ps[j].from || 0) + Math.max(0, local);
    this.pi = j;
    if (v.getAttribute("src") === ps[j].url && v.readyState > 0) {
      try { v.currentTime = at; } catch (e) {}
      if (resume && v.paused) { var pp = v.play(); if (pp && pp.catch) pp.catch(function () {}); }
      this.onTick(this.getT()); return;
    }
    this.switching = true;
    var done = function () {
      v.removeEventListener("loadedmetadata", done);
      try { v.currentTime = at; } catch (e) {}
      self.switching = false;
      if (resume) { var p = v.play(); if (p && p.catch) p.catch(function () {}); }
      self.onTick(self.getT());
    };
    v.addEventListener("loadedmetadata", done);
    v.src = ps[j].url;
  };
  Player.prototype.setT = function (x) {
    x = Math.min(Math.max(0, x), S.dur || 0);
    var ps = this.parts();
    if (S.demo) this.clock = x;
    else if (ps) {
      var j = partAt(x), local = Math.min(x - partStart(j), ps[j].dur - 0.001);
      if (j !== this.pi || this.v.getAttribute("src") !== ps[j].url) this.load(j, local);
      else { try { this.v.currentTime = (ps[j].from || 0) + local; } catch (e) {} }
    } else { try { this.v.currentTime = x; } catch (e) {} }
    this.onTick(x);
  };
  Player.prototype.play = function () {
    if (!S.dur) return;
    if (this.getT() >= S.dur - 0.05) this.setT(0);
    var r = removedAt(this.getT(), this.segsFn()); if (r) this.setT(r.b);
    if (S.demo) { this.playing = true; this.last = performance.now(); this.loop(); this.onUi(true); }
    else { var p = this.v.play(); if (p && p.catch) p.catch(function () {}); }
  };
  Player.prototype.pause = function () { if (S.demo) { this.playing = false; this.onUi(false); } else this.v.pause(); };
  Player.prototype.toggle = function () { if (this.playing) this.pause(); else this.play(); };
  Player.prototype.loop = function () {
    var self = this; cancelAnimationFrame(this.raf);
    var step = function (ts) {
      if (!self.playing) return;
      if (S.demo) {
        var dt = Math.min(0.25, (ts - self.last) / 1000); self.last = ts;
        self.clock = Math.min(S.dur, self.clock + dt);
        if (self.clock >= S.dur) { self.playing = false; self.onUi(false); }
      }
      // Stretches of one file: move on when this one's time is up
      var ps = !S.demo && !self.switching ? self.parts() : null;
      if (ps) {
        var cp = ps[Math.min(self.pi, ps.length - 1)];
        if ((self.v.currentTime || 0) >= (cp.from || 0) + cp.dur - 0.02) {
          if (self.pi < ps.length - 1) self.load(self.pi + 1, 0, true);
          else { self.pause(); self.setT(S.dur); return; }
        }
      }
      var t = self.getT(), r = removedAt(t, self.segsFn());
      if (r) { if (r.b >= S.dur - 0.01) { self.setT(S.dur); self.pause(); return; } self.setT(r.b); t = r.b; }
      self.onTick(t);
      self.raf = requestAnimationFrame(step);
    };
    this.raf = requestAnimationFrame(step);
  };

  var vid = $("#vid"), rvid = $("#rvid");
  var FS_ENTER = '<svg class="i" viewBox="0 0 16 16" aria-hidden="true"><path d="M2.5 6V2.5H6M10 2.5h3.5V6M13.5 10v3.5H10M6 13.5H2.5V10"></path></svg>';
  var FS_EXIT = '<svg class="i" viewBox="0 0 16 16" aria-hidden="true"><path d="M6 2.5V6H2.5M13.5 6H10V2.5M10 13.5V10h3.5M2.5 10H6v3.5"></path></svg>';
  var inner = $("#tInner"), tScroll = $("#tScroll"), ph = $("#ph");

  var edP = new Player(vid, function (t) {
    if (!S.dur) return;
    ph.style.left = (t / S.dur * 100) + "%";
    if ($("#tcIn").hidden) $("#tcNow").textContent = fmt(t, 2);
    if (S.demo) $("#demoTc").textContent = fmt(t, 2);
    if (edP && edP.playing) keepVisible(t);
    trFollow(t);
  }, function (on) {
    $("#playBtn").classList.toggle("on", on);
    $("#playBtn").setAttribute("aria-label", on ? "Pause" : "Play");
  }, function () { return S.skip ? S.segs : null; });

  var rvP = new Player(rvid, function (t) {
    if (!S.dur) return;
    var bar = $("#rBar .ph"); if (bar) bar.style.left = (t / S.dur * 100) + "%";
    var edited = t - removedBefore(t, S.rSegs);
    $("#rNow").textContent = fmt(edited);
    if (S.demo) $("#rDemoTc").textContent = fmt(edited);
  }, function (on) {
    $("#rPlay").classList.toggle("on", on);
    $("#rPlay").setAttribute("aria-label", on ? "Pause final edit" : "Play final edit");
  }, function () { return S.rSegs; });

  // Learns the recording's frame rate from playback until the preview job reports the exact one
  function estimateFps() {
    if (S.msg && S.msg.fps) return;
    if (!("requestVideoFrameCallback" in HTMLVideoElement.prototype)) return;
    var last = null, deltas = [];
    var cb = function (now, meta) {
      if (S.msg && S.msg.fps) return;
      if (last != null) { var d = meta.mediaTime - last; if (d > 0.004 && d < 0.2) deltas.push(d); }
      last = meta.mediaTime;
      if (deltas.length < 60) { vid.requestVideoFrameCallback(cb); return; }
      deltas.sort(function (a, b) { return a - b; });
      var f = 1 / deltas[deltas.length >> 1];
      var std = [24000 / 1001, 24, 25, 30000 / 1001, 30, 48, 50, 60000 / 1001, 60];
      S.fps = std.reduce(function (a, b) { return Math.abs(b - f) < Math.abs(a - f) ? b : a; });
      scheduleSave();
    };
    vid.requestVideoFrameCallback(cb);
  }
  vid.addEventListener("play", function () { if (!S.demo) estimateFps(); });

  /* ---------- Views ---------- */
  var POST_VIEWS = { edit: 1, details: 1, review: 1 };
  function setAddress(v) {
    var want = S.msg && !S.demo && POST_VIEWS[v] ? "#/post/" + S.msg.id + "/" + v : "";
    if (location.hash !== want) { try { history.replaceState(null, "", location.pathname + location.search + want); } catch (e) {} }
  }
  function readAddress() {
    var m = /^#\/post\/([\w-]{10,})\/(edit|details|review)$/.exec(location.hash);
    return m ? { id: m[1], view: m[2] } : null;
  }
  function show(v) {
    S.view = v;
    if (v !== "signin") setAddress(v);
    $$(".view").forEach(function (el) { el.hidden = el.id !== "v-" + v; });
    if (v !== "edit") { edP.pause(); $("#pop").hidden = true; }
    if (v !== "review") rvP.pause();
    if (v === "upload") { renderUpload(); refreshList(); }
    if (v === "edit") { renderEditHeader(); requestAnimationFrame(function () { if (S.fit) inner.style.width = "100%"; renderVisible(); drawTL(); edP.onTick(edP.getT()); updateZoomUi(); }); }
    if (v === "details") renderDetails(); else closeFramePick();
    if (v === "review") renderReview();
    poll(); presenceSoon();
  }

  /* ---------- Who else is on this post ---------- */
  var TAB_ID = (function () {
    try { var t = sessionStorage.getItem("md.tab"); if (!t) { t = Math.random().toString(36).slice(2, 12) + Date.now().toString(36).slice(-4); sessionStorage.setItem("md.tab", t); } return t; }
    catch (e) { return Math.random().toString(36).slice(2, 14); }
  })();
  var pres = { timer: 0, id: null, others: [] };
  function presenceHere() { return !S.demo && S.user && S.msg && POST_VIEWS[S.view] && document.visibilityState === "visible" ? S.msg.id : null; }
  function presenceLeave(id) {
    var body = JSON.stringify({ device: TAB_ID, leaving: true });
    try { if (navigator.sendBeacon && navigator.sendBeacon("/api/messages/" + id + "/presence", new Blob([body], { type: "application/json" }))) return; } catch (e) {}
    fetch("/api/messages/" + id + "/presence", { method: "POST", credentials: "same-origin", keepalive: true, headers: { "Content-Type": "application/json" }, body: body }).catch(function () {});
  }
  function presenceSoon() { clearTimeout(pres.timer); pres.timer = setTimeout(presenceTick, 300); }
  function presenceTick() {
    clearTimeout(pres.timer);
    var id = presenceHere();
    if (pres.id && pres.id !== id) { presenceLeave(pres.id); pres.others = []; drawPresence(); }
    pres.id = id;
    if (!id) return;
    api("POST", "/messages/" + id + "/presence", { device: TAB_ID, view: S.view }).then(function (r) {
      if (pres.id !== id) return;
      pres.others = (r && r.others) || []; drawPresence();
    }, function () {}).then(function () { if (pres.id === id) { clearTimeout(pres.timer); pres.timer = setTimeout(presenceTick, 20000); } });
  }
  document.addEventListener("visibilitychange", presenceSoon);
  window.addEventListener("pagehide", function () { if (pres.id) presenceLeave(pres.id); });
  var FACE_COLORS = ["#2f5bea", "#0f9d74", "#c2410c", "#7c3aed", "#be185d", "#0e7490", "#a16207"];
  function drawPresence() {
    var o = pres.others, where = { edit: "editing", details: "on details", review: "reviewing" };
    var h = "";
    if (o.length) {
      var faces = o.slice(0, 3).map(function (p) {
        var nm = p.you ? (S.user && S.user.name) || p.name || p.email : p.name || p.email, ini = String(nm || "?").trim().charAt(0).toUpperCase();
        var c = 0, key = (p.email || "") + (p.name || "");
        for (var i = 0; i < key.length; i++) c = (c * 31 + key.charCodeAt(i)) >>> 0;
        var label = (p.you ? "You, in another window" : nm) + " · " + (where[p.view] || "here");
        return '<span class="face" style="background:' + FACE_COLORS[c % FACE_COLORS.length] + '" title="' + esc(label) + '">' + esc(ini) + "</span>";
      }).join("");
      var one = o[0], first = String(one.name || one.email || "").split(/[\s@]/)[0];
      var text = o.length > 1 ? o.length + " others here" : one.you ? "Also open in another window" : first + " is " + (where[one.view] || "here");
      h = '<span class="faces">' + faces + '</span><span class="who">' + esc(text) + "</span>";
    }
    $$("[data-presence]").forEach(function (el) { el.innerHTML = h; el.hidden = !h; });
  }

  /* ---------- Sign in ---------- */
  var CLIENT_ID = "", gRendered = false;
  function showSignin(err) {
    S.user = null;
    if (!gRendered && CLIENT_ID) renderGoogleButton(CLIENT_ID);
    $$(".view").forEach(function (el) { el.hidden = el.id !== "v-signin"; });
    S.view = "signin";
    $("#signinErr").hidden = !err; $("#signinErr").textContent = err || "";
  }
  function standalone() { return navigator.standalone === true || matchMedia("(display-mode: standalone)").matches; }
  function renderGoogleButton(clientId) {
    gRendered = true;
    if (standalone() && clientId) {
      var a = $("#gbtnApp"); a.hidden = false; a.href = "/api/auth/start?back=" + encodeURIComponent(location.hash || "");
      return;
    }
    if (!clientId) { $("#signinSub").textContent = "Message Desk isn't set up yet. Ask the tech lead to finish setup."; return; }
    var s = document.createElement("script");
    s.src = "https://accounts.google.com/gsi/client"; s.async = true;
    s.onload = function () {
      google.accounts.id.initialize({ client_id: clientId, callback: onGoogle, ux_mode: "popup", auto_select: false });
      var dark = app.classList.contains("t-dark") || (!app.classList.contains("t-light") && matchMedia("(prefers-color-scheme: dark)").matches);
      google.accounts.id.renderButton($("#gbtn"), { theme: dark ? "filled_black" : "outline", size: "large", shape: "pill", text: "signin_with", width: 260 });
    };
    s.onerror = function () { $("#signinErr").hidden = false; $("#signinErr").textContent = "Couldn't reach Google. Check your connection and reload."; };
    document.head.appendChild(s);
  }
  function onGoogle(resp) {
    api("POST", "/auth/google", { credential: resp.credential }).then(function (j) { S.user = j.user; afterSignin(); }, function (e) { showSignin(msgOf(e)); });
  }
  function afterSignin() {
    var where = readAddress();
    show("upload");
    if (where) openMessage(where.id, null, [], where.view);
    api("GET", "/options").then(function (o) {
      SPEAKERS.length = 0; TAGS.length = 0;
      (o.speakers || []).forEach(function (x) { SPEAKERS.push(x); });
      (o.tags || []).forEach(function (x) { TAGS.push(x); });
    }, function () {});
  }
  $("#signOut").addEventListener("click", function () {
    if (S.up.active && !confirm("An upload is still running. Sign out anyway?")) return;
    api("POST", "/auth/signout").then(function () { location.reload(); }, function () { location.reload(); });
  });

  /* ---------- Upload ---------- */
  var drop = $("#drop"), fileIn = $("#fileIn");
  function isVideo(f) { return /^video\//.test(f.type) || /\.(mov|mp4|m4v|mkv|webm)$/i.test(f.name); }
  function fileKey(f) { return f.name + "|" + f.size + "|" + f.lastModified; }
  function handleFiles(list) {
    var files = Array.prototype.slice.call(list || []);
    var v = files.filter(isVideo), notes = files.filter(function (f) { return !isVideo(f); });
    $("#dropErr").hidden = true;
    if (!v.length) {
      if (notes.length && S.dur && !S.published) { addNoteFiles(notes); renderUpload(); return; }
      $("#dropErr").textContent = "That doesn't look like a video. Drop an MP4 or MOV recording."; $("#dropErr").hidden = false; return;
    }
    if (S.up.active && S.msg && fileKey(v[0]) !== S.up.key) { $("#dropErr").textContent = "Another recording is still uploading. Let it finish first."; $("#dropErr").hidden = false; return; }
    // The same recording dropped again: pick up where it left off
    var known = lsGet("files", {})[fileKey(v[0])];
    var match = S.list.filter(function (m) { return m.id === known || (m.file && m.file.name === v[0].name && m.file.size === v[0].size); })[0];
    if (match) { openMessage(match.id, v[0], notes); return; }
    // Several recordings at once: in name order, the first starts the post and the rest follow it
    v.sort(function (a, b) { return a.name.localeCompare(b.name, undefined, { numeric: true }); });
    loadVideo(v[0], notes);
    if (v.length > 1) S.pendingClips = v.slice(1);
  }
  function resetEdit() {
    edP.pause(); rvP.pause();
    if (S.url) { try { URL.revokeObjectURL(S.url); } catch (e) {} }
    clearInterval(S.render.timer);
    S.file = null; S.url = null; S.dur = 0; S.segs = null; S.inPt = S.outPt = null; S.sel = null; S.undo = []; S.redo = []; S.fit = true;
    S.thumbs = []; S.render = { pct: 0, done: false, timer: null }; S.rSegs = null; S.sentBack = ""; S.published = false;
    S.msg = null; S.fps = 30; S.src = null; S.noteFiles = {}; lastSaved = ""; S.waitMsg = ""; S.wave = null; S.waveId = null;
    S.tr = null; S.trNorm = null; S.trId = null; $("#trQ").value = ""; resetTranscript();
    S.parts = null; S.clipFiles = {}; S.pendingClips = null; S.clipAsk = null;
    S.unlocked = false; S.spriteId = null; S.sharp = null; closeFramePick();
    edP.clock = 0; rvP.clock = 0;
    inner.style.width = "100%";
    vid.removeAttribute("src"); rvid.removeAttribute("src");
    $("#waitScreen").hidden = true;
  }
  function setSource(src) {
    S.src = src; S.waitMsg = "";
    vid.hidden = false; $("#demoScreen").hidden = true; rvid.hidden = false; $("#rDemo").hidden = true;
    $("#waitScreen").hidden = true;
    vid.src = src; rvid.src = src; edP.pi = 0; rvP.pi = 0;
  }
  function setWaiting(text) {
    S.waitMsg = text;
    vid.hidden = true; $("#demoScreen").hidden = true;
    $("#waitScreen").hidden = !text; $("#waitMsg").textContent = text || "";
  }
  function loadVideo(file, notes) {
    resetEdit();
    S.demo = false; S.file = file; S.notes = (notes || []).map(function (f) { return { name: f.name, size: f.size, type: f.type }; });
    S.url = URL.createObjectURL(file);
    $("#dropTitle").textContent = "Opening " + file.name + "…";
    var started = false;
    vid.onloadedmetadata = function () {
      if (started) return; started = true;
      S.dur = vid.duration;
      if (!isFinite(S.dur) || S.dur <= 0) { S.dur = 0; noLocalPlayback(file, notes); return; }
      initDetails(); $("#dropTitle").textContent = "Drop the recording here";
      show("edit"); makeThumbs();
      createOnServer(file, notes);
    };
    vid.onerror = function () { if (started) return; started = true; noLocalPlayback(file, notes); };
    setSource(S.url);
  }
  // The browser can't play this file (for example ProRes). Upload it anyway and edit with the preview copy.
  function noLocalPlayback(file, notes) {
    vid.removeAttribute("src"); rvid.removeAttribute("src");
    try { URL.revokeObjectURL(S.url); } catch (e) {}
    S.url = null; S.dur = 0;
    $("#dropTitle").textContent = "Drop the recording here";
    initDetails();
    setWaiting("This recording can't play in the browser, so a preview copy is being made. It will appear here a few minutes after the upload finishes.");
    show("edit");
    createOnServer(file, notes);
  }
  function loadDemo() {
    resetEdit();
    S.demo = true; S.dur = 6734; S.notes = []; S.fps = 30;
    vid.removeAttribute("src"); rvid.removeAttribute("src");
    vid.hidden = true; $("#demoScreen").hidden = false; rvid.hidden = true; $("#rDemo").hidden = false;
    initDetails(); show("edit"); makeThumbs();
  }
  ["dragenter", "dragover"].forEach(function (ev) { drop.addEventListener(ev, function (e) { e.preventDefault(); drop.classList.add("over"); }); });
  ["dragleave", "drop"].forEach(function (ev) { drop.addEventListener(ev, function (e) { e.preventDefault(); drop.classList.remove("over"); }); });
  drop.addEventListener("drop", function (e) { e.stopPropagation(); handleFiles(e.dataTransfer && e.dataTransfer.files); });
  window.addEventListener("dragover", function (e) { e.preventDefault(); });
  window.addEventListener("drop", function (e) {
    e.preventDefault();
    var files = e.dataTransfer && e.dataTransfer.files;
    if (S.view === "upload") handleFiles(files);
    // Dropping the recording on the editor resumes a paused upload
    else if (S.view === "edit" && S.msg && !S.msg.original.uploaded && files && files[0] && isVideo(files[0]) && !(S.msg.clips || []).length) openMessage(S.msg.id, files[0], []);
    else if (S.view === "edit" && files && files.length) { var vs = Array.prototype.slice.call(files).filter(isVideo); if (vs.length) addClipFiles(vs); }
  });
  $("#chooseBtn").addEventListener("click", function () { fileIn.click(); });
  fileIn.addEventListener("change", function () { handleFiles(fileIn.files); fileIn.value = ""; });
  $("#demoBtn").addEventListener("click", loadDemo);

  function cardSub(m, cur) {
    var bits = [];
    var name = m.file ? m.file.name : "";
    bits.push(name);
    if (m.duration) bits.push(fmt(m.duration));
    var n = (m.notes || []).length;
    if (n) bits.push(n + " notes file" + (n > 1 ? "s" : ""));
    if (m.source === "zoom" && !m.original.uploaded) bits.push(m.importing && m.importing.failed ? "Couldn't copy from Zoom" : "Copying from Zoom" + (m.importing && m.importing.pct ? " " + m.importing.pct + "%" : ""));
    else if (cur && S.up.active) bits.push("Uploading " + upPct() + "%");
    else if (!allClipsUp(m)) bits.push("Upload paused");
    else if (m.source === "zoom" && m.status === "editing" && !(m.preview && m.preview.proxyId)) bits.push("Getting the preview ready");
    else if (m.status === "finished") bits.push(m.render && m.render.done ? "Waiting for approval" : "Preparing");
    else if (m.render && !m.render.done && !m.render.failed) bits.push("Rendering");
    return bits.join(" · ");
  }
  function renderUpload() {
    var el = $("#continueList"), h = "", seen = {};
    if (S.demo && S.dur > 0 && !S.published) {
      h += card("demo", title(), "Sample recording · " + fmt(S.dur), false);
    }
    if (S.msg && !S.published) { seen[S.msg.id] = 1; h += card(S.msg.id, title(), cardSub(S.msg, true), S.msg.source === "zoom"); }
    S.list.forEach(function (m) {
      if (seen[m.id] || m.status === "published") return;
      h += card(m.id, titleOf(m.d), cardSub(m, false), m.source === "zoom");
    });
    el.innerHTML = h;
    $$("[data-discard]", el).forEach(function (b) { b.addEventListener("click", function () { confirmDiscard(b.dataset.discard); }); });
    $$("[data-cont]", el).forEach(function (b) {
      b.addEventListener("click", function () {
        var id = b.dataset.cont;
        if (id === "demo" || (S.msg && S.msg.id === id)) { show("edit"); return; }
        if (S.up.active) { $("#dropErr").textContent = "Another recording is still uploading. Let it finish first."; $("#dropErr").hidden = false; return; }
        openMessage(id, null, []);
      });
    });
  }
  function card(id, t, sub, zoom) {
    var ico = zoom
      ? '<span class="cont-ico" aria-hidden="true" title="From Zoom"><svg class="lg" style="width: 20px; height: 20px;"><use href="#lg-zoom"></use></svg></span>'
      : '<span class="cont-ico" aria-hidden="true"><svg class="i" viewBox="0 0 16 16"><rect x="1.75" y="3.5" width="9" height="9" rx="2"></rect><path d="m10.75 7 3.5-2v6l-3.5-2"></path></svg></span>';
    return '<div class="card continue" data-card="' + esc(id) + '"><div style="display: flex; align-items: center; gap: 12px; min-width: 0;">' + ico + '<div style="min-width: 0;"><div>' + esc(t) + '</div><div class="muted" style="font-size: 13px;">' + esc(sub) + '</div></div></div><div style="display: flex; align-items: center; gap: 14px;"><button class="link" style="color: var(--muted); font-size: 13px;" data-discard="' + esc(id) + '">Discard</button><button class="btn primary" data-cont="' + esc(id) + '">Continue</button></div></div>';
  }
  // New Zoom drafts can arrive at any time, so the list refreshes itself while it's on screen
  var listTimer = 0;
  // Discard: asks first, right in the card
  function confirmDiscard(id) {
    var c = $('[data-card="' + id + '"]'); if (!c) return;
    var cur = S.msg && S.msg.id === id;
    if (cur && S.up.active) { $("#dropErr").textContent = "Wait for the upload to finish, or close the page to stop it, before discarding."; $("#dropErr").hidden = false; return; }
    c.innerHTML = '<div style="min-width: 0; flex: 1 1 280px;"><div>Discard this post?</div><div class="muted" style="font-size: 13px;">' +
      (id === "demo" ? "The sample edit will be cleared." : "Its recording, final video, audio and notes go to the Drive trash for 30 days, its Vimeo video is deleted and its website draft is removed.") +
      '</div></div><div style="display: flex; gap: 8px;"><button class="btn" data-no>Cancel</button><button class="btn danger" data-yes>Discard</button></div>';
    $("[data-no]", c).onclick = function () { renderUpload(); };
    $("[data-yes]", c).onclick = function () {
      if (id === "demo") { resetEdit(); S.d = null; S.demo = false; renderUpload(); return; }
      $("[data-yes]", c).disabled = true; $("[data-yes]", c).textContent = "Discarding…"; $("[data-no]", c).disabled = true;
      api("DELETE", "/messages/" + id).then(function (r) {
        if (cur) { resetEdit(); S.d = null; S.notes = []; }
        S.list = S.list.filter(function (m) { return m.id !== id; });
        renderUpload();
        if (r && r.vimeoLeft) { $("#dropErr").textContent = "Discarded. Its Vimeo video couldn't be removed automatically, so delete it in Vimeo."; $("#dropErr").hidden = false; }
      }, function (e) { renderUpload(); $("#dropErr").textContent = msgOf(e); $("#dropErr").hidden = false; });
    };
  }

  // Vimeo storage and upload allowance
  var quotaWarn = "";
  function size(b) { return b >= 1e12 ? (b / 1e12).toFixed(b >= 1e13 ? 0 : 1) + " TB" : b >= 1e9 ? (b / 1e9).toFixed(b >= 1e10 ? 0 : 1) + " GB" : Math.round(b / 1e6) + " MB"; }
  function loadQuota() {
    api("GET", "/vimeo-quota").then(function (q) {
      var el = $("#vimeoQuota"), rows = [];
      var row = function (label, x, resets) {
        var pct = Math.min(100, Math.round(x.used / x.max * 100)), low = x.free < 3e9;
        return '<div class="quota-row"><div style="display: flex; justify-content: space-between; gap: 10px;"><span>' + label + '</span><span class="muted num">' + size(x.used) + " of " + size(x.max) + " used" + (resets ? " · resets " + new Date(resets).toLocaleDateString(undefined, { month: "short", day: "numeric" }) : "") + '</span></div><div class="quota-bar' + (low ? " low" : "") + '"><i style="width:' + pct + '%"></i></div></div>';
      };
      if (q.storage) rows.push(row("Storage", q.storage));
      if (q.periodic) rows.push(row("Uploads this week", q.periodic, q.periodic.resets));
      var low = (q.storage && q.storage.free < 3e9) || (q.periodic && q.periodic.free < 3e9);
      quotaWarn = low ? "Vimeo is almost out of " + (q.periodic && q.periodic.free < 3e9 ? "this week's upload allowance" : "space") + ", so the render may not finish. Free up space in Vimeo or wait for the allowance to reset." : "";
      el.hidden = !rows.length;
      el.innerHTML = '<span class="card-h" style="font-size: 13px;"><svg class="lg lg-vimeo" aria-hidden="true"><use href="#lg-vimeo"></use></svg>Vimeo</span>' + rows.join("");
    }, function () {});
  }

  // Notifications: a one-time switch per device
  var notifyOn = null;
  function isApple() { return /iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1); }
  function canPush() { return "serviceWorker" in navigator && "PushManager" in window && "Notification" in window; }
  function b64ToBytes(s) { s = s.replace(/-/g, "+").replace(/_/g, "/"); var r = atob(s + "===".slice((s.length + 3) % 4)); var a = new Uint8Array(r.length); for (var i = 0; i < r.length; i++) a[i] = r.charCodeAt(i); return a; }
  function currentSub() {
    if (!canPush()) return Promise.resolve(null);
    return serviceWorker().then(function () { return navigator.serviceWorker.ready; }).then(function (reg) { return reg.pushManager.getSubscription(); }).catch(function () { return null; });
  }
  function drawNotify(msg) {
    var el = $("#notifyCard");
    var head = '<span class="card-h" style="font-size: 13px;"><svg class="i" viewBox="0 0 16 16" aria-hidden="true"><path d="M4 11.5V7a4 4 0 0 1 8 0v4.5l1 1.5H3z"></path><path d="M6.5 14a1.6 1.6 0 0 0 3 0"></path></svg>Notifications</span>';
    var body;
    if (isApple() && !standalone()) {
      body = '<p class="muted" style="font-size: 13px;">To get a notification on this iPhone when a video is ready, add Message Desk to your Home Screen: tap <b style="font-weight: 600;">Share</b>, then <b style="font-weight: 600;">Add to Home Screen</b>. Then open Message Desk from the new icon and turn notifications on there.</p>';
    } else if (!canPush()) {
      body = '<p class="muted" style="font-size: 13px;">This browser can\'t show notifications. Try Safari or Chrome.</p>';
    } else if (Notification.permission === "denied") {
      body = '<p class="muted" style="font-size: 13px;">Notifications are turned off for Message Desk on this device. Turn them on in Settings, then come back here.</p>';
    } else if (notifyOn) {
      body = '<div style="display: flex; align-items: center; gap: 12px; flex-wrap: wrap;"><span class="muted" style="font-size: 13px; flex: 1 1 200px;">On for this device. You\'ll get a notification when a video is ready to publish.</span><button class="btn" data-ntest>Send a test</button><button class="link" style="color: var(--muted); font-size: 13px;" data-noff>Turn off</button></div>';
    } else {
      body = '<div style="display: flex; align-items: center; gap: 12px; flex-wrap: wrap;"><span class="muted" style="font-size: 13px; flex: 1 1 200px;">Get a notification on this device when a video is ready to publish, so you don\'t have to wait at the computer.</span><button class="btn primary" data-non>Turn on</button></div>';
    }
    el.innerHTML = head + body + (msg ? '<p class="fine">' + esc(msg) + "</p>" : "");
    el.hidden = false;
    var on = $("[data-non]", el), off = $("[data-noff]", el), t = $("[data-ntest]", el);
    if (on) on.onclick = function () { on.disabled = true; turnOnNotify().then(function () { drawNotify(); }, function (e) { drawNotify(e && e.user ? e.message : "Notifications couldn't be turned on. Try again."); }); };
    if (off) off.onclick = function () { turnOffNotify().then(function () { drawNotify(); }); };
    if (t) t.onclick = function () { t.disabled = true; api("POST", "/notify/test").then(function (r) { drawNotify(r.sent ? "Test sent. It should arrive in a few seconds." : "The test didn't go through. Turn notifications off and on again."); }, function (e) { drawNotify(msgOf(e)); }); };
  }
  function turnOnNotify() {
    return Notification.requestPermission().then(function (perm) {
      if (perm !== "granted") throw { user: true, message: "Notifications weren't allowed on this device." };
      return Promise.all([api("GET", "/notify/key"), serviceWorker().then(function () { return navigator.serviceWorker.ready; })]);
    }).then(function (x) {
      return x[1].pushManager.getSubscription().then(function (old) {
        return old || x[1].pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64ToBytes(x[0].publicKey) });
      });
    }).then(function (sub) {
      return api("POST", "/notify/subscribe", { subscription: sub.toJSON() });
    }).then(function () { notifyOn = true; });
  }
  function turnOffNotify() {
    return currentSub().then(function (sub) {
      if (!sub) return;
      return api("POST", "/notify/unsubscribe", { endpoint: sub.endpoint }).catch(function () {}).then(function () { return sub.unsubscribe(); });
    }).then(function () { notifyOn = false; });
  }
  function loadNotify() {
    if (S.demo) return;
    currentSub().then(function (sub) {
      if (!sub) { notifyOn = false; drawNotify(); return; }
      api("POST", "/notify/status", { endpoint: sub.endpoint }).then(function (r) { notifyOn = !!r.on; drawNotify(); }, function () { notifyOn = false; drawNotify(); });
    });
  }

  function refreshList() {
    clearTimeout(listTimer);
    if (!S.user) return;
    api("GET", "/messages").then(function (j) { S.list = j.messages || []; if (S.view === "upload") renderUpload(); }, function () {});
    $("#pubCard").hidden = S.demo && !S.user;
    if ($("#pubToggle").getAttribute("aria-expanded") === "true") loadPublished();
    loadQuota();
    if (notifyOn === null) loadNotify();
    listTimer = setTimeout(function () { if (S.view === "upload" && !document.hidden) refreshList(); else listTimer = 0; }, 30000);
  }
  document.addEventListener("visibilitychange", function () { if (!document.hidden && S.view === "upload" && !listTimer) refreshList(); });

  /* ---------- Published list, with a guarded Unpublish ---------- */
  var pub = { posts: null, loading: false, menu: null, target: null };
  $("#pubToggle").addEventListener("click", function () {
    var open = $("#pubToggle").getAttribute("aria-expanded") !== "true";
    $("#pubToggle").setAttribute("aria-expanded", String(open)); $("#pubList").hidden = !open;
    if (open) loadPublished();
  });
  function loadPublished() {
    if (pub.loading) return;
    pub.loading = true;
    if (!pub.posts) $("#pubList").innerHTML = '<p class="fine" style="padding: 4px 8px 8px;">Loading…</p>';
    api("GET", "/messages/published").then(function (j) { pub.posts = j.posts || []; pub.loading = false; drawPublished(); },
      function (e) { pub.loading = false; $("#pubList").innerHTML = '<p class="err" style="padding: 4px 8px 8px;">' + esc(msgOf(e)) + "</p>"; });
  }
  function shortDate(iso) { var d = new Date(iso); return isNaN(d) ? "" : MONTHS[d.getMonth()].slice(0, 3) + " " + d.getDate() + ", " + d.getFullYear(); }
  function drawPublished() {
    var el = $("#pubList");
    if (!pub.posts.length) { el.innerHTML = '<p class="fine" style="padding: 4px 8px 8px;">Nothing published from Message Desk yet.</p>'; return; }
    el.innerHTML = pub.posts.map(function (p) {
      var where = p.onSite ? "On the website" : "Vimeo only";
      return '<div class="pub-row" data-pub="' + esc(p.id) + '"><div class="grow"><div>' + esc(p.title) + '</div><div class="muted" style="font-size: 13px;">' + esc(where + (p.publishedAt ? " · published " + shortDate(p.publishedAt) : "")) + "</div></div>" +
        (p.liveUrl ? '<a class="link" style="font-size: 13px;" href="' + esc(p.liveUrl) + '" target="_blank" rel="noopener">View</a>' : p.vimeoLink ? '<a class="link" style="font-size: 13px;" href="' + esc(p.vimeoLink) + '" target="_blank" rel="noopener">Vimeo</a>' : "") +
        '<button type="button" class="icon-btn" data-more="' + esc(p.id) + '" aria-label="More options" aria-haspopup="menu" aria-expanded="false"><svg class="i" viewBox="0 0 16 16" aria-hidden="true"><circle cx="3.5" cy="8" r="1" fill="currentColor"></circle><circle cx="8" cy="8" r="1" fill="currentColor"></circle><circle cx="12.5" cy="8" r="1" fill="currentColor"></circle></svg></button></div>';
    }).join("");
    $$("[data-more]", el).forEach(function (b) { b.addEventListener("click", function (e) { e.stopPropagation(); openPubMenu(b); }); });
  }
  function closePubMenu() { if (pub.menu) { pub.menu.remove(); pub.menu = null; $$("[data-more]").forEach(function (b) { b.setAttribute("aria-expanded", "false"); }); } }
  function openPubMenu(btn) {
    var was = pub.menu && pub.menu.dataset.for === btn.dataset.more;
    closePubMenu(); if (was) return;
    var p = pub.posts.filter(function (x) { return x.id === btn.dataset.more; })[0]; if (!p) return;
    var m = document.createElement("div"); m.className = "pub-menu"; m.setAttribute("role", "menu"); m.dataset.for = p.id;
    m.innerHTML = p.onSite
      ? '<button type="button" role="menuitem" class="danger-text" data-unpub>Unpublish from website…</button>'
      : '<button type="button" role="menuitem" disabled>Not on the website (Vimeo only)</button>';
    btn.closest(".pub-row").appendChild(m); pub.menu = m; btn.setAttribute("aria-expanded", "true");
    var u = $("[data-unpub]", m); if (u) u.addEventListener("click", function () { closePubMenu(); askUnpublish(p); });
  }
  document.addEventListener("click", function (e) { if (pub.menu && !pub.menu.contains(e.target)) closePubMenu(); });
  document.addEventListener("keydown", function (e) { if (e.key === "Escape") closePubMenu(); });
  function askUnpublish(p) {
    pub.target = p;
    $("#unpubText").textContent = "“" + p.title + "” comes off sentlifecenter.com right away. It moves back to Continue so it can be fixed and published again. The Vimeo video and the files in Drive stay.";
    $("#unpubIn").value = ""; $("#unpubYes").disabled = true; $("#unpubYes").textContent = "Unpublish"; $("#unpubErr").hidden = true;
    var d = $("#unpubDlg"); if (d.showModal) d.showModal(); else d.setAttribute("open", "");
    setTimeout(function () { $("#unpubIn").focus(); }, 30);
  }
  function unpubTyped() { return $("#unpubIn").value.trim().toLowerCase() === "unpublish"; }
  $("#unpubIn").addEventListener("input", function () { $("#unpubYes").disabled = !unpubTyped(); });
  $("#unpubNo").addEventListener("click", function () { $("#unpubDlg").close(); });
  $("#unpubForm").addEventListener("submit", function (e) {
    e.preventDefault();
    if (!unpubTyped() || !pub.target) return;
    var p = pub.target, yes = $("#unpubYes");
    yes.disabled = true; yes.textContent = "Unpublishing…"; $("#unpubErr").hidden = true;
    api("POST", "/messages/" + p.id + "/unpublish", { confirm: $("#unpubIn").value }).then(function () {
      $("#unpubDlg").close();
      pub.posts = pub.posts.filter(function (x) { return x.id !== p.id; }); drawPublished();
      refreshList();
      $("#pubNote").textContent = "“" + p.title + "” is off the website. It's back under Continue."; $("#pubNote").hidden = false;
    }, function (er) { yes.disabled = false; yes.textContent = "Unpublish"; $("#unpubErr").textContent = msgOf(er); $("#unpubErr").hidden = false; });
  });

  /* ---------- Real uploads straight to Google Drive ---------- */
  function createOnServer(file, notes) {
    var body = {
      file: { name: file.name, size: file.size, type: file.type, lastModified: file.lastModified },
      notes: (notes || []).map(function (f) { return { name: f.name, size: f.size, type: f.type }; }),
      d: S.d, duration: S.dur || 0
    };
    banner("");
    api("POST", "/messages", body).then(function (m) {
      S.msg = m;
      setAddress(S.view);
      var map = lsGet("files", {}); map[fileKey(file)] = m.id; lsSet("files", map);
      (notes || []).forEach(function (f, i) { S.noteFiles[i] = f; });
      startUploads(file);
      if (S.pendingClips) { var pc = S.pendingClips; S.pendingClips = null; addClipFiles(pc); }
    }, function (e) {
      banner(msgOf(e), "Try again", function () { createOnServer(file, notes); });
    });
  }
  function upPct() { return S.up.total ? Math.min(100, Math.floor(S.up.sent / S.up.total * 100)) : 0; }
  function startUploads(file) {
    var m = S.msg; if (!m) return;
    var jobs = [];
    m.notes.forEach(function (n, i) { if (!n.uploaded && S.noteFiles[i]) jobs.push({ kind: "notes", idx: i, file: S.noteFiles[i], url: n.sessionUrl }); });
    if (!m.original.uploaded && file) jobs.push({ kind: "original", idx: 0, file: file, url: m.original.sessionUrl });
    (m.clips || []).forEach(function (c, i) { if (!c.uploaded && S.clipFiles[i]) jobs.push({ kind: "clip", idx: i, file: S.clipFiles[i], url: c.sessionUrl }); });
    if (!jobs.length) { updateUpPill(); return; }
    S.up = { active: true, sent: 0, total: jobs.reduce(function (a, j) { return a + j.file.size; }, 0), base: 0, error: "", key: file ? fileKey(file) : S.up.key, id: m.id, jobs: jobs };
    updateUpPill();
    var run = function (i) {
      if (i >= jobs.length) { S.up.active = false; updateUpPill(); updateRender(); refreshList(); renderNotes(); poll(); return; }
      var job = jobs[i];
      uploadOne(m.id, job, function (done) { S.up.sent = S.up.base + done; updateUpPill(); }).then(function (view) {
        if (S.msg && S.msg.id === view.id) mergeView(view);
        S.up.base += job.file.size; S.up.sent = S.up.base;
        run(i + 1);
      }, function (e) {
        S.up.active = false; S.up.error = msgOf(e); updateUpPill();
        banner("The upload stopped. " + msgOf(e), "Resume", function () { banner(""); startUploads(file); });
      });
    };
    run(0);
  }
  var CHUNK = 32 * 1024 * 1024; // multiple of 256 KB, as Google requires
  function putChunk(url, blob, start, total, onp) {
    return new Promise(function (res) {
      var x = new XMLHttpRequest();
      x.open("PUT", url);
      x.setRequestHeader("Content-Range", "bytes " + start + "-" + (start + blob.size - 1) + "/" + total);
      x.upload.onprogress = function (e) { onp(start + e.loaded); };
      x.onload = function () {
        var end = null, json = null;
        try { var r = x.getResponseHeader("Range"); var mm = r && /bytes=0-(\d+)/.exec(r); if (mm) end = +mm[1]; } catch (e) {}
        try { json = JSON.parse(x.responseText); } catch (e) {}
        res({ status: x.status, end: end, json: json });
      };
      x.onerror = function () { res({ status: 0 }); };
      x.ontimeout = function () { res({ status: 0 }); };
      x.send(blob);
    });
  }
  function uploadOne(id, job, onp) {
    var size = job.file.size, tries = 0;
    var ask = function () { return api("POST", "/messages/" + id + "/upload-offset", { kind: job.kind, idx: job.idx }); };
    var finish = function (fileId) { return api("POST", "/messages/" + id + "/uploaded", { kind: job.kind, idx: job.idx, fileId: fileId }); };
    var loop = function (offset) {
      if (offset >= size) return ask().then(function (st) { if (st.done) return api("GET", "/messages/" + id); return loop(st.offset); });
      var end = Math.min(size, offset + CHUNK);
      return putChunk(job.url, job.file.slice(offset, end), offset, size, onp).then(function (r) {
        if (r.status === 200 || r.status === 201) return finish(r.json && r.json.id);
        if (r.status === 308) { tries = 0; return loop(r.end != null ? r.end + 1 : end); }
        if (++tries > 8) throw new Error("upload");
        var wait = Math.min(30000, 1000 * Math.pow(2, tries));
        return new Promise(function (ok) { setTimeout(ok, wait); }).then(ask).then(function (st) {
          if (st.sessionUrl) job.url = st.sessionUrl;
          if (st.done) return api("GET", "/messages/" + id);
          return loop(st.offset);
        });
      });
    };
    return ask().then(function (st) {
      if (st.sessionUrl) job.url = st.sessionUrl;
      if (st.done) return api("GET", "/messages/" + id);
      onp(st.offset);
      return loop(st.offset);
    });
  }
  // Adds an upload to the one running, or starts one
  function queueUpload(job) {
    if (S.up.active && S.up.jobs && S.up.id === (S.msg && S.msg.id)) { S.up.jobs.push(job); S.up.total += job.file.size; updateUpPill(); }
    else startUploads(null);
  }
  function allClipsUp(m) { return !!m && m.original.uploaded && (m.clips || []).every(function (c) { return c.uploaded; }); }
  function updateUpPill() {
    var pill = $("#upPill");
    if (S.demo || !S.msg) { pill.hidden = true; return; }
    if (S.up.active) {
      pill.hidden = false; pill.className = "pill";
      $(".bar", pill).hidden = false; $(".bar i", pill).style.width = upPct() + "%";
      $(".lbl", pill).textContent = "Uploading · " + upPct() + "%";
    } else if (!allClipsUp(S.msg)) {
      pill.hidden = false; pill.className = "pill warn"; $(".bar", pill).hidden = true;
      $(".lbl", pill).textContent = "Upload paused";
    } else if (S.up.total) {
      pill.hidden = false; pill.className = "pill ok"; $(".bar", pill).hidden = true;
      $(".lbl", pill).textContent = "Saved to Drive";
    } else pill.hidden = true;
    if (S.view === "upload") renderUpload();
    if (S.view === "edit") drawClips();
  }
  window.addEventListener("beforeunload", function (e) {
    if (S.up.active || saveTimer) { e.preventDefault(); e.returnValue = ""; flushSave(); }
  });
  function banner(text, action, fn) {
    var sb = $("#sentBack");
    if (!text) { sb.hidden = true; return; }
    sb.hidden = false;
    sb.innerHTML = "<span>" + esc(text) + "</span>" + (action ? '<button class="link" id="sbAct">' + esc(action) + "</button>" : "");
    if (action) $("#sbAct").onclick = fn;
  }

  /* ---------- Opening a saved post (any computer) ---------- */
  function mergeView(v) {
    S.msg = v;
    if (v.fps) S.fps = v.fps;
    S.notes = v.notes;
  }
  function openMessage(id, localFile, extraNotes, view) {
    $("#dropErr").hidden = true;
    $("#dropTitle").textContent = "Opening…";
    api("GET", "/messages/" + id).then(function (v) {
      $("#dropTitle").textContent = "Drop the recording here";
      resetEdit();
      S.demo = false;
      mergeView(v);
      S.d = v.d; S.segs = v.segs; S.rSegs = v.renderSegs;
      S.dur = v.duration || 0;
      var map = lsGet("files", {});
      if (localFile) { map[fileKey(localFile)] = v.id; lsSet("files", map); }
      var go = function () {
        // Review needs Finish first; anything else opens where it was asked for
        var want = view === "review" && v.status !== "finished" && v.status !== "published" ? "details" : view;
        show(want || "edit");
        if (localFile && !v.original.uploaded) startUploads(localFile);
        if (extraNotes && extraNotes.length) addNoteFiles(extraNotes);
        updateUpPill();
      };
      if (localFile && (v.clips || []).length) { S.file = localFile; usePreview(v); go(); }
      else if (localFile) {
        S.file = localFile; S.url = URL.createObjectURL(localFile);
        var started = false;
        vid.onloadedmetadata = function () { if (started) return; started = true; if (isFinite(vid.duration) && vid.duration > 0) S.dur = vid.duration; makeThumbs(); loadWave(v.preview); loadTranscript(v.preview && v.preview.transcript); go(); };
        vid.onerror = function () { if (started) return; started = true; S.url = null; usePreview(v); go(); };
        setSource(S.url);
      } else { usePreview(v); go(); }
    }, function (e) { $("#dropTitle").textContent = "Drop the recording here"; $("#dropErr").textContent = msgOf(e); $("#dropErr").hidden = false; });
  }
  var swReady = null;
  function serviceWorker() {
    if (swReady) return swReady;
    swReady = new Promise(function (res, rej) {
      if (!("serviceWorker" in navigator)) { rej(new Error("no sw")); return; }
      navigator.serviceWorker.register("/sw.js").then(function () { return navigator.serviceWorker.ready; }).then(function (reg) {
        if (navigator.serviceWorker.controller) { res(); return; }
        navigator.serviceWorker.addEventListener("controllerchange", function () { res(); }, { once: true });
        // A hard refresh (or a first visit) leaves the page without the helper: ask it to take over now
        try { reg.active && reg.active.postMessage({ claim: true }); } catch (e) {}
        setTimeout(function () {
          if (navigator.serviceWorker.controller) { res(); return; }
          // Still not in charge: one quiet reload fixes it
          var tried = false; try { tried = sessionStorage.getItem("md.swReload") === "1"; sessionStorage.setItem("md.swReload", "1"); } catch (e) { tried = true; }
          if (!tried) { location.reload(); return; }
          rej(new Error("sw"));
        }, 2500);
      }, rej);
    });
    return swReady;
  }
  window.addEventListener("load", function () { setTimeout(function () { try { if (navigator.serviceWorker && navigator.serviceWorker.controller) sessionStorage.removeItem("md.swReload"); } catch (e) {} }, 3000); });
  function usePreview(v) {
    var p = v.preview || {};
    if (!p.proxyId) {
      if (p.joining && allClipsUp(v)) { setWaiting("The recordings are being joined into one preview. It appears here a few minutes after the uploads finish."); return; }
      if (v.source === "zoom" && !v.original.uploaded) setWaiting(v.importing && v.importing.failed ? "This recording couldn't be copied from Zoom. Ask the tech team to look at it." : "Copying the recording from Zoom. It will be ready to edit in a few minutes.");
      else if (!v.original.uploaded) setWaiting(S.up.active ? "The preview will appear here a few minutes after the upload finishes." : "The upload isn't finished. Open Message Desk on the computer that has the recording and drop it again to finish.");
      else setWaiting(p.status === "error" ? "The preview couldn't be made. Ask the tech team to look at this post." : "Getting the preview ready. This takes a few minutes after an upload.");
      return;
    }
    serviceWorker().then(function () {
      setSource("/media/" + p.proxyId + "?size=" + (p.proxySize || 0) + "&type=video%2Fmp4");
      S.parts = null; S.awaitJoin = false;
      vid.onloadedmetadata = function () {
        vid.onloadedmetadata = null;
        if (isFinite(vid.duration) && vid.duration > 0 && !S.dur) { S.dur = vid.duration; }
        if (S.view === "edit") show("edit");
      };
      loadSprite(p);
      loadWave(p);
      loadTranscript(p.transcript);
      if (S.view === "edit") show("edit");
    }, function () { setWaiting("The preview couldn't load in this window. Refresh the page to try again."); });
  }
  // Transcript: the whole thing with times, click any word to jump there, search, copy
  function norm(w) { return String(w).toLowerCase().replace(/[^a-z0-9']+/g, ""); }
  function resetTranscript() {
    $("#trBody").innerHTML = ""; $("#trCount").textContent = "";
    $("#trPrev").hidden = $("#trNext").hidden = true;
    S.trSpans = null; S.trHits = []; S.trCur = -1; S.trNowI = -1; S.trParas = null;
    $("#trCopy").disabled = true;
  }
  function loadTranscript(t) {
    drawTrNote();
    if (!t || !t.id || S.trId === t.id) return;
    S.trId = t.id;
    serviceWorker().then(function () { return fetch("/media/" + t.id + "?type=application%2Fjson"); })
      .then(function (r) { if (!r.ok) throw new Error("tr"); return r.json(); })
      .then(function (j) { S.tr = j.words || []; S.trNorm = S.tr.map(function (w) { return norm(w[2]); }); buildTranscript(); drawTrNote(); searchTr(true); }, function () { S.trId = null; });
  }
  // Paragraphs break at pauses, or at the end of a sentence once one gets long
  function paragraphs(words) {
    var out = [], cur = null;
    for (var i = 0; i < words.length; i++) {
      var w = words[i], prev = words[i - 1];
      var gap = prev ? w[0] - prev[1] : 0, n = cur ? i - cur.a : 0;
      var endSentence = prev && /[.?!]["')\]]?$/.test(prev[2]);
      if (!cur || gap > 1.6 || (n >= 45 && endSentence) || n >= 110) { cur = { a: i, b: i }; out.push(cur); }
      cur.b = i;
    }
    return out;
  }
  function buildTranscript() {
    var body = $("#trBody");
    if (!S.tr || !S.tr.length) { body.innerHTML = ""; return; }
    S.trParas = paragraphs(S.tr);
    var h = "";
    S.trParas.forEach(function (pg) {
      h += '<div class="tr-p"><button type="button" class="tt" data-w="' + pg.a + '" title="Jump to ' + fmt(S.tr[pg.a][0]) + '">' + fmt(S.tr[pg.a][0]) + "</button><p>";
      for (var i = pg.a; i <= pg.b; i++) h += '<span data-w="' + i + '">' + esc(S.tr[i][2]) + "</span> ";
      h += "</p></div>";
    });
    body.innerHTML = h;
    var spans = body.querySelectorAll("p span"); S.trSpans = new Array(S.tr.length);
    for (var k = 0; k < spans.length; k++) S.trSpans[+spans[k].dataset.w] = spans[k];
    S.trNowI = -1; S.trRemovedKey = null;
    markRemovedWords(); trFollow(edP.getT());
    $("#trCopy").disabled = false;
  }
  $("#trBody").addEventListener("click", function (e) {
    var el = e.target.closest("[data-w]"); if (!el || !S.tr) return;
    var t = S.tr[+el.dataset.w][0];
    edP.pause(); edP.setT(Math.max(0, t - 0.05)); revealTime(t);
  });
  // Words in removed parts are crossed out
  var removedTimer = 0;
  function markRemovedSoon() { clearTimeout(removedTimer); removedTimer = setTimeout(markRemovedWords, 250); }
  function markRemovedWords() {
    if (!S.trSpans) return;
    var key = JSON.stringify(S.segs || null);
    if (key === S.trRemovedKey) return;
    S.trRemovedKey = key;
    for (var i = 0; i < S.tr.length; i++) {
      var sp = S.trSpans[i]; if (!sp) continue;
      var x = !!S.segs && removedAt((S.tr[i][0] + S.tr[i][1]) / 2, S.segs);
      if (sp.classList.contains("x") !== x) sp.classList.toggle("x", x);
    }
  }
  // The word being spoken at the playhead (the list doesn't scroll by itself)
  function wordAt(t) {
    var lo = 0, hi = S.tr.length - 1, ans = -1;
    while (lo <= hi) { var mid = (lo + hi) >> 1; if (S.tr[mid][0] <= t + 0.02) { ans = mid; lo = mid + 1; } else hi = mid - 1; }
    if (ans >= 0 && t > S.tr[ans][1] + 1.2) return -1;
    return ans;
  }
  function trFollow(t) {
    if (!S.trSpans || !S.tr.length) return;
    var i = wordAt(t);
    if (i === S.trNowI) return;
    if (S.trNowI >= 0 && S.trSpans[S.trNowI]) S.trSpans[S.trNowI].classList.remove("now");
    S.trNowI = i;
    if (i >= 0 && S.trSpans[i]) S.trSpans[i].classList.add("now");
  }
  function drawTrNote() {
    var t = S.msg && S.msg.preview && S.msg.preview.transcript, q = $("#trQ"), note = $("#trNote");
    var ready = !!(S.tr && S.tr.length);
    q.disabled = !ready;
    if (S.demo) { note.textContent = "There's no transcript for the sample recording."; return; }
    if (ready) { note.textContent = ""; return; }
    if (t && t.status === "error") { note.textContent = "The transcript couldn't be made for this recording."; return; }
    if (t && t.status === "done" && S.tr && !S.tr.length) { note.textContent = "No speech was found in this recording."; return; }
    var pct = !t ? 0 : t.status === "done" ? 100 : Math.floor(t.pct || 0);
    var label = !t || t.status === "done" ? "Loading the transcript" : "Writing the transcript";
    note.innerHTML = '<span style="display: flex; justify-content: space-between; gap: 8px; margin-bottom: 6px;"><span>' + label + '</span><span class="num">' + (t ? pct + "%" : "") + '</span></span>' +
      '<span class="quota-bar" style="display: block;"><i style="width:' + pct + '%"></i></span>' +
      '<span style="display: block; margin-top: 6px;">You can keep editing. It appears here when it\'s ready.</span>';
  }
  function searchTr(quiet) {
    var q = $("#trQ").value.trim();
    (S.trHits || []).forEach(function (h) { for (var k = h; k < h + S.trHitLen; k++) if (S.trSpans && S.trSpans[k]) S.trSpans[k].classList.remove("hit", "cur"); });
    S.trHits = []; S.trCur = -1;
    var terms = q.split(/\s+/).map(norm).filter(Boolean), n = terms.length;
    if (!S.tr || !n) { $("#trCount").textContent = ""; $("#trPrev").hidden = $("#trNext").hidden = true; return; }
    for (var i = 0; i + n <= S.trNorm.length; i++) {
      var ok = true;
      for (var k = 0; k < n && ok; k++) ok = k === n - 1 ? S.trNorm[i + k].indexOf(terms[k]) === 0 : S.trNorm[i + k] === terms[k];
      if (ok) S.trHits.push(i);
    }
    S.trHitLen = n;
    S.trHits.forEach(function (h) { for (var k = h; k < h + n; k++) if (S.trSpans[k]) S.trSpans[k].classList.add("hit"); });
    $("#trPrev").hidden = $("#trNext").hidden = S.trHits.length < 2;
    if (!S.trHits.length) { $("#trCount").textContent = "None"; return; }
    // Start from the first match after the playhead
    var now = edP.getT(), first = 0;
    for (var j = 0; j < S.trHits.length; j++) if (S.tr[S.trHits[j]][0] >= now - 0.5) { first = j; break; }
    goHit(first, false);
  }
  function goHit(i, seek) {
    if (!S.trHits.length) return;
    i = (i + S.trHits.length) % S.trHits.length;
    if (S.trCur >= 0) { var o = S.trHits[S.trCur]; for (var k = o; k < o + S.trHitLen; k++) if (S.trSpans[k]) S.trSpans[k].classList.remove("cur"); }
    S.trCur = i;
    var h = S.trHits[i];
    for (var k2 = h; k2 < h + S.trHitLen; k2++) if (S.trSpans[k2]) S.trSpans[k2].classList.add("cur");
    $("#trCount").textContent = (i + 1) + " of " + S.trHits.length;
    var el = S.trSpans[h], body = $("#trBody");
    if (el) { var r = el.getBoundingClientRect(), br = body.getBoundingClientRect(); if (r.top < br.top + 20 || r.bottom > br.bottom - 20) body.scrollTop += r.top - br.top - br.height / 3; }
    if (seek) { var t = S.tr[h][0]; edP.pause(); edP.setT(Math.max(0, t - 0.05)); revealTime(t); }
  }
  var trTimer = 0;
  $("#trQ").addEventListener("input", function () { clearTimeout(trTimer); trTimer = setTimeout(function () { searchTr(true); }, 150); });
  $("#trQ").addEventListener("keydown", function (e) {
    // First Enter jumps to the highlighted match; after that Enter moves on (Shift goes back)
    if (e.key === "Enter") { e.preventDefault(); if (S.trHits.length) goHit(S.trJumped ? S.trCur + (e.shiftKey ? -1 : 1) : S.trCur, true); S.trJumped = true; }
    if (e.key === "Escape") { $("#trQ").blur(); }
  });
  $("#trQ").addEventListener("input", function () { S.trJumped = false; });
  $("#trPrev").addEventListener("click", function () { goHit(S.trCur - 1, true); S.trJumped = true; });
  $("#trNext").addEventListener("click", function () { goHit(S.trCur + 1, true); S.trJumped = true; });
  $("#trCopy").addEventListener("click", function () {
    if (!S.tr || !S.trParas) return;
    var text = title() + "\n\n" + S.trParas.map(function (pg) {
      var w = []; for (var i = pg.a; i <= pg.b; i++) w.push(S.tr[i][2]);
      return "[" + fmt(S.tr[pg.a][0]) + "] " + w.join(" ");
    }).join("\n\n") + "\n";
    var done = function (ok) {
      $("#trCopyLbl").textContent = ok ? "Copied" : "Couldn't copy";
      clearTimeout(S.copyTimer); S.copyTimer = setTimeout(function () { $("#trCopyLbl").textContent = "Copy"; }, 1800);
    };
    if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(text).then(function () { done(true); }, function () { done(fallbackCopy(text)); });
    else done(fallbackCopy(text));
  });
  function fallbackCopy(text) {
    var ta = document.createElement("textarea"); ta.value = text; ta.style.position = "fixed"; ta.style.opacity = "0"; document.body.appendChild(ta); ta.select();
    var ok = false; try { ok = document.execCommand("copy"); } catch (e) {} ta.remove(); return ok;
  }

  // Side panel: open unless someone closed it, with Transcript and Editing tabs
  function setTab(tab) {
    $$(".ptabs [data-tab]").forEach(function (b) { b.setAttribute("aria-selected", String(b.dataset.tab === tab)); });
    $("#paneTr").hidden = tab !== "tr"; $("#paneEd").hidden = tab !== "ed";
    lsSet("tab", tab);
  }
  $$(".ptabs [data-tab]").forEach(function (b) { b.addEventListener("click", function () { setTab(b.dataset.tab); }); });
  setTab(lsGet("tab", "tr") === "ed" ? "ed" : "tr");
  (function () { var open = lsGet("panel", true) !== false; $("#panel").hidden = !open; $("#panelBtn").setAttribute("aria-pressed", String(open)); })();

  function loadWave(p) {
    if (!p || !p.waveId || S.waveId === p.waveId) return;
    S.waveId = p.waveId;
    serviceWorker().then(function () { return fetch("/media/" + p.waveId + "?type=application%2Foctet-stream"); })
      .then(function (r) { if (!r.ok) throw new Error("wave"); return r.arrayBuffer(); })
      .then(function (b) { S.wave = new Uint8Array(b); S.waveRate = p.waveRate || 50; scheduleVisible(); }, function () { S.waveId = null; });
  }
  function drawWave(w, pps) {
    var c = $("#wave"), vw = viewW(), dpr = window.devicePixelRatio || 1, H = 26;
    c.style.left = tScroll.scrollLeft + "px"; c.style.width = vw + "px"; c.style.height = H + "px";
    if (c.width !== Math.round(vw * dpr) || c.height !== H * dpr) { c.width = Math.round(vw * dpr); c.height = H * dpr; }
    var g = c.getContext("2d"); g.setTransform(dpr, 0, 0, dpr, 0, 0); g.clearRect(0, 0, vw, H);
    if (!S.wave || !S.dur) return;
    var rate = S.waveRate, n = S.wave.length, left = tScroll.scrollLeft;
    g.fillStyle = "rgba(214, 220, 232, .78)";
    for (var x = 0; x < vw && left + x < w; x++) {
      var i0 = Math.floor((left + x) / pps * rate), i1 = Math.max(i0 + 1, Math.ceil((left + x + 1) / pps * rate)), m = 0;
      for (var i = i0; i < i1 && i < n; i++) if (S.wave[i] > m) m = S.wave[i];
      var h = Math.max(1, m / 255 * (H - 4));
      g.fillRect(x, (H - h) / 2, 1, h);
    }
  }
  function loadSprite(p) {
    if (!p || !p.thumbsId || !p.thumbs || S.spriteId === p.thumbsId + ":" + p.thumbs.n) return;
    S.spriteId = p.thumbsId + ":" + p.thumbs.n;
    var t = p.thumbs, img = new Image();
    img.onerror = function () { S.spriteId = null; };
    img.onload = function () {
      var c = document.createElement("canvas"); c.width = 192; c.height = 108; var g = c.getContext("2d");
      var out = [];
      for (var i = 0; i < t.n; i++) {
        g.drawImage(img, (i % t.cols) * t.w, Math.floor(i / t.cols) * t.h, t.w, t.h, 0, 0, 192, 108);
        try { out.push(c.toDataURL("image/jpeg", 0.7)); } catch (e) { out.push(null); }
      }
      S.thumbs = out; scheduleVisible();
    };
    img.src = "/media/" + p.thumbsId + "?type=image%2Fjpeg";
  }

  /* ---------- Thumbnails ---------- */
  var N_THUMBS = 48;
  function nThumbs() { return S.thumbs.length || N_THUMBS; }
  function once(el, ev, ms) {
    return new Promise(function (res) {
      var done = false; var f = function () { if (done) return; done = true; el.removeEventListener(ev, f); res(); };
      el.addEventListener(ev, f); setTimeout(f, ms);
    });
  }
  function demoThumb(i) {
    var c = document.createElement("canvas"); c.width = 192; c.height = 108; var g = c.getContext("2d");
    var wide = i % 5 === 4;
    g.fillStyle = wide ? "#262b34" : "#1c2027"; g.fillRect(0, 0, 192, 108);
    g.fillStyle = "#151920"; g.fillRect(0, 78, 192, 30);
    g.fillStyle = "#3d4451";
    var r = wide ? 8 : 15, cy = wide ? 42 : 36;
    g.beginPath(); g.arc(96 + (i % 3 - 1) * 4, cy, r, 0, Math.PI * 2); g.fill();
    g.beginPath(); g.ellipse(96 + (i % 3 - 1) * 4, 108, wide ? 22 : 40, wide ? 36 : 48, 0, Math.PI, 0); g.fill();
    if (wide) { g.fillStyle = "#2d333d"; g.fillRect(82, 70, 28, 38); }
    return c.toDataURL("image/jpeg", 0.7);
  }
  function makeThumbs() {
    S.thumbs = new Array(N_THUMBS).fill(null); renderVisible();
    if (S.demo) { for (var i = 0; i < N_THUMBS; i++) S.thumbs[i] = demoThumb(i); renderVisible(); return; }
    var parts = S.parts && S.parts.length > 1 ? S.parts.slice() : [{ url: S.url || S.src, dur: S.dur }];
    var token = S.thumbToken = {};
    var c = document.createElement("canvas"); c.width = 192; c.height = 108; var g = c.getContext("2d");
    (async function () {
      var cur = -1, tv = null, off = 0;
      for (var i = 0; i < N_THUMBS; i++) {
        if (S.thumbToken !== token) return;
        var T = (i + 0.5) / N_THUMBS * S.dur, j = 0, o = 0;
        while (j < parts.length - 1 && T >= o + parts[j].dur) { o += parts[j].dur; j++; }
        if (j !== cur) {
          if (tv) { tv.removeAttribute("src"); try { tv.load(); } catch (e) {} }
          tv = document.createElement("video"); tv.muted = true; tv.preload = "auto"; tv.playsInline = true; tv.src = parts[j].url;
          cur = j; off = o;
          await once(tv, "loadeddata", 10000);
        }
        try { tv.currentTime = (parts[j].from || 0) + Math.max(0, T - off); } catch (e) {}
        await once(tv, "seeked", 8000);
        try {
          var vw = tv.videoWidth || 16, vh = tv.videoHeight || 9, sr = vw / vh, tr = 192 / 108, sx = 0, sy = 0, sw = vw, sh = vh;
          if (sr > tr) { sw = vh * tr; sx = (vw - sw) / 2; } else { sh = vw / tr; sy = (vh - sh) / 2; }
          g.drawImage(tv, sx, sy, sw, sh, 0, 0, 192, 108);
          S.thumbs[i] = c.toDataURL("image/jpeg", 0.65);
          if (i % 4 === 3 || i === N_THUMBS - 1) scheduleVisible();
        } catch (e) {}
      }
      scheduleVisible();
      if (tv) { tv.removeAttribute("src"); try { tv.load(); } catch (e) {} }
    })();
  }

  /* ---------- Several recordings, back to back ---------- */
  // Where each recording starts on the timeline
  function clipDurs() {
    if (S.parts && S.parts.length > 1) return S.parts.map(function (p) { return p.dur; });
    var d = S.msg && S.msg.preview && S.msg.preview.clipDurs;
    return d && d.length > 1 ? d : [S.dur];
  }
  function clipStarts() { var o = 0; return clipDurs().map(function (d) { var s = o; o += d; return s; }); }
  // Recordings in the order they play: { sid: position as stored (0 = first upload), name, up: upload details }
  function playClips() {
    if (!S.msg) return S.file ? [{ sid: 0, name: S.file.name, up: null }] : [];
    var stored = [{ sid: 0, name: S.msg.file.name, up: S.msg.original }].concat((S.msg.clips || []).map(function (c, i) { return { sid: i + 1, name: c.name, up: c }; }));
    var order = S.parts && S.parts.length > 1 ? S.parts.map(function (p) { return p.sid; }) : S.msg.order || stored.map(function (x) { return x.sid; });
    return order.map(function (i) { return stored[i]; }).filter(Boolean);
  }
  function clipNames() { return playClips().map(function (c) { return c.name; }); }
  // A gentle colour per recording, which stays with it when the order changes
  var CLIP_COLORS = ["#4f7cff", "#f59e0b", "#14b8a6", "#a855f7", "#f43f5e", "#22c55e", "#0ea5e9", "#eab308", "#ec4899", "#64748b"];
  function clipColor(sid) { return CLIP_COLORS[sid % CLIP_COLORS.length]; }
  // Clips as separate parts on this screen, so they can be moved or removed (a joined preview is split by time)
  function ensureParts() {
    if (S.parts) return;
    var pc = playClips(), durs = clipDurs();
    if (durs.length > 1 && durs.length === pc.length) {
      var o = 0;
      S.parts = durs.map(function (d, i) { var p = { url: S.src, from: o, dur: d, name: pc[i].name, sid: pc[i].sid }; o += d; return p; });
    } else S.parts = [{ url: S.url || S.src, from: 0, dur: S.dur, name: (pc[0] || {}).name, sid: 0 }];
  }
  function localDuration(file) {
    return new Promise(function (res) {
      var u = URL.createObjectURL(file), t = document.createElement("video"); t.preload = "metadata"; t.muted = true;
      var done = function (d) { res({ url: u, dur: d }); };
      t.onloadedmetadata = function () { done(isFinite(t.duration) ? t.duration : 0); };
      t.onerror = function () { done(0); };
      t.src = u;
    });
  }
  function clipErr(text) { $("#hint").textContent = text; }
  function addClipFiles(files) {
    if (S.demo) { clipErr("Clips can't be added to the sample recording."); return; }
    if (!S.msg) { S.pendingClips = (S.pendingClips || []).concat(files); return; }
    if (isLocked()) { nudgeLock(); return; }
    if (S.msg.status === "published") return;
    if (!S.src || !S.dur) { clipErr("Wait for the video to load, then add the clip."); return; }
    // The same file dropped again finishes its upload instead of adding it twice
    var fresh = files.filter(function (f) {
      var i = (S.msg.clips || []).findIndex(function (c) { return c.name === f.name && c.size === f.size; });
      if (i < 0) return true;
      if (!S.msg.clips[i].uploaded && !S.clipFiles[i]) { S.clipFiles[i] = f; queueUpload({ kind: "clip", idx: i, file: f, url: S.msg.clips[i].sessionUrl }); }
      return false;
    });
    var chain = Promise.resolve();
    fresh.forEach(function (f) { chain = chain.then(function () { return addClip(f); }); });
  }
  function addClip(file) {
    return localDuration(file).then(function (r) {
      if (!r.dur) { clipErr(file.name + " can't play in this browser, so it can't be added here. Try an MP4."); try { URL.revokeObjectURL(r.url); } catch (e) {} return; }
      var before = S.dur;
      ensureParts();
      return api("POST", "/messages/" + S.msg.id + "/clips", { name: file.name, size: file.size, type: file.type || "video/mp4", duration: r.dur, totalDuration: before + r.dur }).then(function (j) {
        mergeView(j.message);
        S.parts.push({ url: r.url, from: 0, dur: r.dur, name: file.name, sid: j.idx + 1 });
        S.clipFiles[j.idx] = file;
        if (!S.url) S.awaitJoin = true;
        S.dur = before + r.dur;
        // Everything in the new clip is kept; earlier undo steps no longer fit the longer timeline
        if (S.segs) { var last = S.segs[S.segs.length - 1]; if (last.t === "keep") last.b = S.dur; else S.segs.push({ a: before, b: S.dur, t: "keep", s: true }); }
        S.undo = []; S.redo = [];
        drawTL(); renderEditHeader(); updateZoomUi(); makeThumbs(); flushSave();
        queueUpload({ kind: "clip", idx: j.idx, file: file, url: j.message.clips[j.idx].sessionUrl });
        renderVisible();
      });
    }).catch(function (e) { clipErr(msgOf(e)); });
  }
  // Removing a clip takes its part of the timeline (and any cuts in it) out
  function removeClip(j) {
    ensureParts();
    if (!S.parts || !S.parts[j] || S.parts[j].sid === 0 || !S.msg) return;
    var sid = S.parts[j].sid, a = clipStarts()[j], len = S.parts[j].dur, b = a + len;
    var segs = S.segs ? [] : null;
    if (S.segs) S.segs.forEach(function (s) {
      var parts = [];
      if (s.a < a) parts.push({ a: s.a, b: Math.min(s.b, a), t: s.t, s: s.s });
      if (s.b > b) parts.push({ a: Math.max(s.a, b) - len, b: s.b - len, t: s.t, s: s.a >= b ? s.s : true });
      parts.forEach(function (x) { if (x.b - x.a > 0.005) segs.push(x); });
    });
    if (segs && segs.length && segs[0]) delete segs[0].s;
    if (segs && (!segs.length || (segs.length === 1 && segs[0].t === "keep"))) segs = null;
    edP.pause(); rvP.pause();
    if (S.parts[j].url.indexOf("blob:") === 0) { try { URL.revokeObjectURL(S.parts[j].url); } catch (e) {} }
    S.parts.splice(j, 1);
    // Stored positions after this one move down by one
    S.parts.forEach(function (p) { if (p.sid > sid) p.sid--; });
    var files = {}; Object.keys(S.clipFiles).forEach(function (k) { k = +k; if (k < sid - 1) files[k] = S.clipFiles[k]; else if (k > sid - 1) files[k - 1] = S.clipFiles[k]; });
    S.clipFiles = files;
    if (!S.url) S.awaitJoin = true;
    S.dur -= len; S.segs = segs; S.sel = null; S.inPt = S.outPt = null; S.undo = []; S.redo = [];
    if (S.parts.length === 1 && !S.parts[0].from) S.parts = null;
    // The sound wave and transcript are remade for the new set of recordings
    S.wave = null; S.waveId = null; S.tr = null; S.trId = null; resetTranscript();
    edP.setT(Math.min(edP.getT(), S.dur));
    drawTL(); renderEditHeader(); updateZoomUi(); makeThumbs(); drawTrNote();
    api("DELETE", "/messages/" + S.msg.id + "/clips/" + (sid - 1), { totalDuration: S.dur }).then(function (v) { mergeView(v); lastSaved = ""; flushSave(); drawClips(); poll(); }, function (e) { clipErr(msgOf(e)); });
  }
  // Move a recording earlier or later. Its cuts travel with it.
  function moveClip(j, dir) {
    if (isLocked()) { nudgeLock(); return; }
    ensureParts();
    var k = j + dir;
    if (!S.parts || !S.parts[j] || !S.parts[k] || S.up.active) return;
    var starts = clipStarts();
    // Cuts, clip by clip, measured from each clip's own start
    var per = S.parts.map(function () { return []; });
    if (S.segs) S.segs.forEach(function (s) {
      S.parts.forEach(function (p, i) {
        var a = Math.max(s.a, starts[i]), b = Math.min(s.b, starts[i] + p.dur);
        if (b - a > 0.0005) per[i].push({ a: a - starts[i], b: b - starts[i], t: s.t, s: s.s && a === s.a });
      });
    });
    var order = S.parts.map(function (_, i) { return i; });
    order[j] = k; order[k] = j;
    var parts = order.map(function (i) { return S.parts[i]; }), segs = S.segs ? [] : null, o = 0;
    order.forEach(function (i, pos) {
      per[i].forEach(function (s) { var x = { a: s.a + o, b: s.b + o, t: s.t }; if (s.s) x.s = true; segs.push(x); });
      o += S.parts[i].dur;
    });
    if (segs) {
      // Same kind on both sides of the new join merges back into one section
      var merged = [];
      // (a split you made yourself stays)
      segs.forEach(function (s) { var l = merged[merged.length - 1]; if (l && l.t === s.t && Math.abs(l.b - s.a) < 0.005 && !s.s) { l.b = s.b; } else merged.push(s); });
      if (merged.length) delete merged[0].s;
      segs = merged.length === 1 && merged[0].t === "keep" ? null : merged;
    }
    edP.pause(); rvP.pause();
    var moved = S.parts[j];
    S.parts = parts; S.segs = segs; S.sel = null; S.inPt = S.outPt = null; S.undo = []; S.redo = [];
    if (!S.url) S.awaitJoin = true;
    // The sound wave and transcript follow once the recordings are joined in the new order
    S.wave = null; S.waveId = null; S.tr = null; S.trId = null; resetTranscript();
    edP.pi = -1; rvP.pi = -1;
    edP.setT(clipStarts()[k] + 1e-4);
    drawTL(); renderVisible(); makeThumbs(); drawTrNote();
    if (S.msg) api("POST", "/messages/" + S.msg.id + "/clip-order", { order: S.parts.map(function (p) { return p.sid; }), segs: S.segs })
      .then(function (v) { mergeView(v); lastSaved = payload(); drawClips(); poll(); }, function (e) { clipErr(msgOf(e)); });
    $("#hint").textContent = moved.name + " now plays " + (k === 0 ? "first" : k === S.parts.length - 1 ? "last" : "as clip " + (k + 1)) + ".";
  }
  function drawClips() {
    var el = $("#clipList"); if (!el) return;
    var pc = playClips(), m = S.msg, durs = clipDurs();
    var many = pc.length > 1 && durs.length === pc.length;
    var canEdit = !S.demo && m && m.status !== "published" && !isLocked() && !S.up.active && !!S.src;
    var canRemove = canEdit && many;
    var UP = '<svg class="i" viewBox="0 0 16 16" aria-hidden="true"><path d="m4.5 10 3.5-3.5 3.5 3.5"></path></svg>', DOWN = '<svg class="i" viewBox="0 0 16 16" aria-hidden="true"><path d="m4.5 6.5 3.5 3.5 3.5-3.5"></path></svg>';
    el.innerHTML = pc.map(function (c, i) {
      var n = c.name, up = c.up;
      var st = up && !up.uploaded ? (S.up.active ? "Uploading" : "Not uploaded") : fmt(durs[i] || 0);
      if (S.clipAsk === i) return '<div class="clip-confirm"><span>Remove clip ' + (i + 1) + "? Its part of the timeline and any cuts in it go too.</span>" +
        '<span style="display: flex; gap: 8px;"><button class="btn" data-clip-no>Cancel</button><button class="btn danger" data-clip-yes="' + i + '">Remove</button></span></div>';
      var x = canRemove && c.sid !== 0 ? '<button class="icon-btn sm" data-clip-x="' + i + '" aria-label="Remove clip ' + (i + 1) + '" title="Remove"><svg class="i" viewBox="0 0 16 16" aria-hidden="true"><path d="m4.5 4.5 7 7M11.5 4.5l-7 7"></path></svg></button>' : "";
      var mv = canEdit && many ? '<span class="mv"><button class="icon-btn sm" data-clip-mv="' + i + ':-1" aria-label="Move clip ' + (i + 1) + ' earlier" title="Play earlier"' + (i === 0 ? " disabled" : "") + ">" + UP + '</button><button class="icon-btn sm" data-clip-mv="' + i + ':1" aria-label="Move clip ' + (i + 1) + ' later" title="Play later"' + (i === pc.length - 1 ? " disabled" : "") + ">" + DOWN + "</button></span>" : "";
      return '<div class="clip-item"><span class="n"' + (many ? ' style="--c:' + clipColor(c.sid) + '"' : ' style="--c:var(--ink-2)"') + ">" + (i + 1) + '</span><span class="nm" title="' + esc(n) + '">' + esc(n) + '</span><span class="st">' + esc(st) + "</span>" + mv + x + "</div>";
    }).join("");
    $$("[data-clip-mv]", el).forEach(function (b) { b.addEventListener("click", function () { var v = b.dataset.clipMv.split(":"); moveClip(+v[0], +v[1]); }); });
    $$("[data-clip-x]", el).forEach(function (b) { b.addEventListener("click", function () { S.clipAsk = +b.dataset.clipX; drawClips(); }); });
    var no = $("[data-clip-no]", el); if (no) no.addEventListener("click", function () { S.clipAsk = null; drawClips(); });
    var yes = $("[data-clip-yes]", el); if (yes) yes.addEventListener("click", function () { var j = +yes.dataset.clipYes; S.clipAsk = null; removeClip(j); });
    var add = !S.demo && m && m.status !== "published";
    $("#addClipBtn").hidden = !add; $("#addClipBtn2").hidden = !add;
    $("#addClipBtn").disabled = $("#addClipBtn2").disabled = isLocked();
  }
  $("#addClipBtn").addEventListener("click", noFocus(function () { if (isLocked()) { nudgeLock(); return; } $("#clipIn").click(); }));
  $("#addClipBtn2").addEventListener("click", function () { if (isLocked()) { nudgeLock(); return; } $("#clipIn").click(); });
  $("#clipIn").addEventListener("change", function () { var f = Array.prototype.slice.call($("#clipIn").files || []).filter(isVideo); $("#clipIn").value = ""; if (f.length) addClipFiles(f); });

  /* ---------- Timeline: zoom, ruler, film ---------- */
  function viewW() { return tScroll.clientWidth || 1; }
  function minPps() { return viewW() / S.dur; }
  function curPps() { return (inner.clientWidth || viewW()) / S.dur; }
  function setPps(p, clientX, anchorT) {
    if (!S.dur) return;
    var minP = minPps(), maxP = Math.max(minP, MAX_PPS);
    p = Math.min(maxP, Math.max(minP, p));
    var sr = tScroll.getBoundingClientRect(), cur = curPps();
    if (clientX == null) {
      var tp = edP.getT(), xp = tp * cur - tScroll.scrollLeft;
      if (xp >= 0 && xp <= viewW()) { clientX = sr.left + xp; anchorT = tp; } else { clientX = sr.left + viewW() / 2; }
    }
    var offset = clientX - sr.left;
    if (anchorT == null) anchorT = (tScroll.scrollLeft + offset) / cur;
    S.fit = p <= minP * 1.001;
    inner.style.width = S.fit ? "100%" : (S.dur * p) + "px";
    tScroll.scrollLeft = S.fit ? 0 : anchorT * p - offset;
    renderVisible(); positionPop(); updateZoomUi();
  }
  function zoomBy(f, clientX) { setPps(curPps() * f, clientX); }
  function updateZoomUi() {
    if (!S.dur) return;
    var p = curPps(), minP = minPps();
    $("#zOut").disabled = S.fit;
    $("#zIn").disabled = p >= MAX_PPS - 0.01;
    var z = p / minP;
    $("#zFit").textContent = S.fit ? "Fit" : (z < 10 ? z.toFixed(1) : Math.round(z)) + "×";
  }
  var visRaf = 0;
  function scheduleVisible() { if (visRaf) return; visRaf = requestAnimationFrame(function () { visRaf = 0; renderVisible(); positionPop(); }); }
  function renderVisible() {
    if (!S.dur) { $("#ruler").innerHTML = ""; $("#film").innerHTML = ""; return; }
    var w = inner.clientWidth || viewW(), pps = w / S.dur;
    var x0 = Math.max(0, tScroll.scrollLeft - 300), x1 = Math.min(w, tScroll.scrollLeft + viewW() + 300);
    // ruler
    var steps = [0.1, 0.2, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 900, 1800, 3600];
    var step = 3600; for (var i = 0; i < steps.length; i++) { if (steps[i] * pps >= 96) { step = steps[i]; break; } }
    var minor = step / 5, dec = step < 1 ? 1 : 0, h = "";
    var tStart = Math.floor((x0 / pps) / minor) * minor;
    for (var t = tStart; t <= x1 / pps + 0.0001; t += minor) {
      var tt = Math.round(t * 1000) / 1000, isMaj = Math.abs(tt / step - Math.round(tt / step)) < 0.001;
      if (tt > S.dur) break;
      if (isMaj) h += '<span class="maj" style="left:' + (tt * pps) + 'px">' + fmt(tt, dec) + "</span>";
      else if (minor * pps >= 10) h += '<span class="min" style="left:' + (tt * pps) + 'px"></span>';
    }
    $("#ruler").innerHTML = h;
    // film tiles
    var f = "", i0 = Math.floor(x0 / TILE_W), i1 = Math.ceil(x1 / TILE_W), N = nThumbs();
    for (var k = i0; k < i1; k++) {
      var left = k * TILE_W; if (left >= w) break;
      var tw = Math.min(TILE_W, w - left);
      var midT = (left + tw / 2) / pps;
      var idx = Math.min(N - 1, Math.max(0, Math.floor(midT / S.dur * N)));
      var img = S.thumbs[idx];
      f += '<div class="tile" style="left:' + left + "px;width:" + tw + "px" + (img ? ";background-image:url(" + img + ")" : "") + '"></div>';
    }
    $("#film").innerHTML = f;
    drawWave(w, pps);
  }

  /* ---------- Editor ---------- */
  function renderEditHeader() {
    $("#editTitle").textContent = title();
    $("#editSub").textContent = S.demo ? "Sample recording" : (S.file ? S.file.name : (S.msg && S.msg.file ? (S.msg.source === "zoom" ? "From Zoom · " : "") + S.msg.file.name : ""));
    $("#tcDur").textContent = fmt(S.dur);
    $("#pushBtn").disabled = !S.demo && !S.dur;
    if (S.waitMsg) setWaiting(S.waitMsg);
    updateUpPill();
    drawTrNote();
  }
  function P(x) { return (x / S.dur * 100); }
  function popRange() {
    if (S.inPt != null && S.outPt != null) return { a: S.inPt, b: S.outPt, pending: true };
    if (S.sel) return { a: S.sel.a, b: S.sel.b, pending: false };
    return null;
  }
  function drawTL() {
    if (!S.dur) { $("#ovl").innerHTML = ""; $("#hint").textContent = ""; updateHistoryUi(); return; }
    var h = "";
    if (S.segs) {
      S.segs.forEach(function (s) {
        var sel = S.sel && S.inPt == null && Math.abs(S.sel.a - s.a) < 0.001 && Math.abs(S.sel.b - s.b) < 0.001;
        h += '<div class="seg ' + s.t + (sel ? " sel" : "") + '" style="left:' + P(s.a) + "%;width:" + P(s.b - s.a) + '%"><span class="tag">' + (s.t === "keep" ? "Keep" : "Remove") + "</span></div>";
      });
    }
    if (S.inPt != null && S.outPt != null) h += '<div class="pending" style="left:' + P(S.inPt) + "%;width:" + P(S.outPt - S.inPt) + '%"></div>';
    var cs = clipStarts(), cd = clipDurs(), pcs = playClips();
    if (cs.length > 1) {
      var tint = "";
      cs.forEach(function (c, i) { var col = clipColor(pcs[i] ? pcs[i].sid : i); tint += '<div class="cliptint" style="left:' + P(c) + "%;width:" + P(cd[i]) + "%;--c:" + col + '"></div>'; });
      h += tint;
      cs.forEach(function (c, i) { if (i > 0 && c < S.dur) h += '<div class="clipmark" style="left:' + P(c) + "%;--c:" + clipColor(pcs[i] ? pcs[i].sid : i) + '"><span>Clip ' + (i + 1) + "</span></div>"; });
    }
    if (S.inPt != null) h += '<div class="mark in" style="left:' + P(S.inPt) + '%"><span>IN</span></div>';
    if (S.outPt != null) h += '<div class="mark out" style="left:' + P(S.outPt) + '%"><span>OUT</span></div>';
    $("#ovl").innerHTML = h;
    updateHistoryUi();
    $("#inoutTxt").textContent = (S.inPt != null ? "In " + fmt(S.inPt, 2) : "") + (S.outPt != null ? "  ·  Out " + fmt(S.outPt, 2) : "");
    $("#legend").hidden = !S.segs;
    var hint = "";
    if (S.inPt != null && S.outPt == null) hint = "In point set. Move the playhead and press O for the out point.";
    else if (!popRange()) hint = S.segs ? "Click a section to switch it between Remove and Keep, or mark another range." : "Everything is kept. Press I and O to mark a range, then choose Remove or Keep.";
    $("#hint").textContent = hint;
    drawPop(); drawCutList(); drawLock(); markRemovedSoon(); drawClips();
    scheduleSave();
  }
  function drawPop() {
    var r = popRange(), pop = $("#pop");
    if (!r || S.view !== "edit") { pop.hidden = true; return; }
    pop.hidden = false;
    $("#popRange").textContent = fmt(r.a, 2) + " – " + fmt(r.b, 2);
    var cur = null;
    if (!r.pending && S.segs) { var s = S.segs.find(function (x) { return Math.abs(x.a - r.a) < 0.001; }); cur = s ? s.t : null; }
    $("#popRemove").classList.toggle("on", cur === "remove");
    $("#popKeep").classList.toggle("on", cur === "keep");
    $("#popClear").hidden = !r.pending;
    positionPop(r);
  }
  function positionPop(r) {
    r = r || popRange(); var pop = $("#pop");
    if (!r || pop.hidden) return;
    var tl = $("#tl"), pw = pop.offsetWidth;
    pop.style.left = Math.max(8, (tl.clientWidth - pw) / 2) + "px";
    pop.style.top = (tScroll.offsetTop + tScroll.offsetHeight + 6) + "px";
  }
  function drawCutList() {
    var el = $("#cutList");
    if (!S.segs) { el.innerHTML = '<p class="fine" style="font-size:13px">No cuts yet. Everything is kept.</p>'; return; }
    el.innerHTML = S.segs.map(function (s, i) {
      return '<button class="cut-item" data-i="' + i + '"><span class="dot ' + s.t + '"></span><span style="flex:1">' + (s.t === "keep" ? "Keep" : "Remove") + '</span><span class="muted num" style="font-size:12px">' + fmt(s.a) + " – " + fmt(s.b) + "</span></button>";
    }).join("");
    $$(".cut-item", el).forEach(function (b) {
      b.addEventListener("click", function () { var s = S.segs[+b.dataset.i]; S.inPt = S.outPt = null; S.sel = { a: s.a, b: s.b }; edP.setT(s.a + 1e-4); revealTime(s.a); drawTL(); });
    });
  }
  function apply(t) {
    if (isLocked()) { nudgeLock(); return; }
    var r = popRange(); if (!r) return;
    paint(r.a, r.b, t);
    S.inPt = S.outPt = null;
    var mid = (r.a + r.b) / 2;
    var s = S.segs && S.segs.find(function (x) { return mid >= x.a && mid <= x.b; });
    S.sel = s ? { a: s.a, b: s.b } : null;
    drawTL();
  }
  function markIn() {
    if (!S.dur) return;
    if (isLocked()) { nudgeLock(); return; }
    var t = snap(edP.getT());
    if (S.inPt != null && Math.abs(S.inPt - t) < 0.001) return;
    pushUndo();
    S.sel = null; S.inPt = t;
    if (S.outPt != null && S.outPt <= t + 0.005) S.outPt = null;
    drawTL();
  }
  function markOut() {
    if (!S.dur) return;
    if (isLocked()) { nudgeLock(); return; }
    var t = snap(edP.getT()); S.sel = null;
    if (Math.abs(t - (S.inPt == null ? 0 : S.inPt)) < 0.005) return;
    if (S.outPt != null && Math.abs(S.outPt - t) < 0.001) return;
    pushUndo();
    if (S.inPt == null) S.inPt = 0;
    if (t < S.inPt) { S.outPt = S.inPt; S.inPt = t; } else S.outPt = t;
    drawTL();
  }
  // Split: cut the section under the playhead in two, so either side can be kept or removed
  function split() {
    if (!S.dur) return;
    if (isLocked()) { nudgeLock(); return; }
    var t = snap(edP.getT()), f = FRAME();
    if (t < f || t > S.dur - f) return;
    var segs = S.segs || [{ a: 0, b: S.dur, t: "keep" }];
    var i = -1;
    for (var k = 0; k < segs.length; k++) if (t > segs[k].a + f / 2 && t < segs[k].b - f / 2) { i = k; break; }
    if (i < 0) return; // already a cut here
    pushUndo();
    var s = segs[i], left = { a: s.a, b: t, t: s.t }, right = { a: t, b: s.b, t: s.t, s: true };
    if (s.s) left.s = true;
    S.segs = segs.slice(0, i).concat([left, right], segs.slice(i + 1));
    S.inPt = S.outPt = null; S.sel = null;
    drawTL();
    $("#hint").textContent = "Split at " + fmt(t, 2) + ". Click either side, then choose Remove or Keep.";
  }
  function stepFrames(n) { edP.pause(); edP.setT((frameAt(edP.getT()) + n) / S.fps + 1e-4); revealTime(edP.getT()); }
  function clearMarks() { if (S.inPt != null || S.outPt != null) pushUndo(); S.inPt = S.outPt = null; S.sel = null; drawTL(); }
  function timeAt(cx) { var r = inner.getBoundingClientRect(); return Math.min(Math.max((cx - r.left) / r.width, 0), 1) * S.dur; }
  function revealTime(t) {
    if (S.fit) return;
    var x = t / S.dur * inner.clientWidth;
    if (x < tScroll.scrollLeft || x > tScroll.scrollLeft + viewW()) tScroll.scrollLeft = x - viewW() / 3;
  }
  function keepVisible(t) {
    if (S.fit) return;
    var x = t / S.dur * inner.clientWidth;
    if (x < tScroll.scrollLeft + 20 || x > tScroll.scrollLeft + viewW() - 40) tScroll.scrollLeft = x - viewW() * 0.25;
  }

  // Pointer: scrub (no snapping), click to select a section, two-finger pinch to zoom
  var drag = null, touches = {}, pinch = null;
  function touchCount() { return Object.keys(touches).length; }
  // A cut (where Keep meets Remove) or an In/Out marker under the pointer, if any
  function edgeAt(clientX, touch) {
    if (!S.dur || isLocked()) return null;
    var r = inner.getBoundingClientRect(), pps = r.width / S.dur, x = clientX - r.left, tol = touch ? 12 : 6;
    if (S.inPt != null && Math.abs(S.inPt * pps - x) <= tol) return { kind: "in" };
    if (S.outPt != null && Math.abs(S.outPt * pps - x) <= tol) return { kind: "out" };
    if (S.segs) for (var i = 0; i < S.segs.length - 1; i++) if (Math.abs(S.segs[i].b * pps - x) <= tol) return { kind: "cut", i: i };
    return null;
  }
  function dragEdge(d, clientX) {
    var f = 1 / S.fps, t = snap(timeAt(clientX));
    if (d.kind === "cut") {
      var a = S.segs[d.i], b = S.segs[d.i + 1];
      t = Math.min(b.b - f, Math.max(a.a + f, t));
      if (!d.saved) { pushUndo(); d.saved = true; a = S.segs[d.i]; b = S.segs[d.i + 1]; }
      a.b = t; b.a = t; S.sel = null;
    } else if (d.kind === "in") {
      if (!d.saved) { pushUndo(); d.saved = true; }
      S.inPt = Math.max(0, S.outPt != null ? Math.min(t, S.outPt - f) : t);
    } else {
      if (!d.saved) { pushUndo(); d.saved = true; }
      S.outPt = Math.min(S.dur, Math.max(t, (S.inPt || 0) + f));
    }
    edP.setT(t + 1e-4);
    drawTL();
  }
  inner.addEventListener("pointerdown", function (e) {
    if (!S.dur) return;
    var edge = (e.pointerType !== "touch" || touchCount() === 0) && (e.pointerType === "touch" || e.button === 0) ? edgeAt(e.clientX, e.pointerType === "touch") : null;
    if (edge) {
      if (e.pointerType === "touch") touches[e.pointerId] = e.clientX;
      edP.pause();
      drag = { x: e.clientX, moved: false, edge: edge };
      try { inner.setPointerCapture(e.pointerId); } catch (er) {}
      return;
    }
    if (e.pointerType === "touch") {
      touches[e.pointerId] = e.clientX;
      if (touchCount() === 2) {
        var xs = Object.keys(touches).map(function (k) { return touches[k]; });
        var mid = (xs[0] + xs[1]) / 2;
        pinch = { d0: Math.max(20, Math.abs(xs[0] - xs[1])), p0: curPps(), t0: (tScroll.scrollLeft + mid - tScroll.getBoundingClientRect().left) / curPps() };
        drag = null; return;
      }
    } else if (e.button !== 0) return;
    drag = { x: e.clientX, moved: false };
    try { inner.setPointerCapture(e.pointerId); } catch (er) {}
    edP.setT(timeAt(e.clientX));
  });
  inner.addEventListener("pointermove", function (e) {
    if (e.pointerType === "touch" && touches[e.pointerId] != null) touches[e.pointerId] = e.clientX;
    if (pinch && touchCount() === 2) {
      var xs = Object.keys(touches).map(function (k) { return touches[k]; });
      var d = Math.max(20, Math.abs(xs[0] - xs[1]));
      setPps(pinch.p0 * d / pinch.d0, (xs[0] + xs[1]) / 2, pinch.t0);
      return;
    }
    if (!drag) { if (e.pointerType === "mouse") inner.style.cursor = edgeAt(e.clientX) ? "ew-resize" : ""; return; }
    if (Math.abs(e.clientX - drag.x) > 2) drag.moved = true;
    if (drag.edge) { if (drag.moved) dragEdge(drag.edge, e.clientX); return; }
    if (drag.moved) edP.setT(timeAt(e.clientX));
  });
  function endPointer(e) {
    if (e.pointerType === "touch") { delete touches[e.pointerId]; if (touchCount() < 2) pinch = null; }
    if (!drag) return; var moved = drag.moved, wasEdge = drag.edge; drag = null;
    if (wasEdge) return;
    if (moved || e.type === "pointercancel") return;
    if (S.inPt != null || S.outPt != null) return;
    if (S.segs && !isLocked()) {
      var t = timeAt(e.clientX);
      var s = S.segs.find(function (x) { return t >= x.a && t < x.b; });
      S.sel = s ? { a: s.a, b: s.b } : null; drawTL();
    }
  }
  inner.addEventListener("pointerup", endPointer);

  // Right-click (or Control-click) on the timeline: Remove, Keep, Split here, and moving a recording
  var ctxEl = null;
  function closeCtx() { if (ctxEl) { ctxEl.remove(); ctxEl = null; } }
  // What a right-click points at: the marked range, else the section, else the recording under the pointer
  function ctxTarget(t) {
    if (S.inPt != null && S.outPt != null && t >= S.inPt && t <= S.outPt) return { a: S.inPt, b: S.outPt, label: "Marked range" };
    if (S.segs) { var s = S.segs.find(function (x) { return t >= x.a && t < x.b; }); if (s) return { a: s.a, b: s.b, label: "This section", cur: s.t }; }
    var cs = clipStarts(), cd = clipDurs();
    if (cs.length > 1) for (var i = 0; i < cs.length; i++) if (t >= cs[i] && t < cs[i] + cd[i]) return { a: cs[i], b: cs[i] + cd[i], label: "Clip " + (i + 1), cur: "keep" };
    return null;
  }
  inner.addEventListener("contextmenu", function (e) {
    if (!S.dur || S.view !== "edit") return;
    e.preventDefault();
    closeCtx(); closePubMenu && closePubMenu();
    var t = timeAt(e.clientX), tg = ctxTarget(t), locked = isLocked();
    var cs = clipStarts(), ci = 0; for (var i = 0; i < cs.length; i++) if (t >= cs[i]) ci = i;
    var many = cs.length > 1;
    var h = '<div class="ctx-h">' + esc(tg ? tg.label + " · " + fmt(tg.a) + " – " + fmt(tg.b) : "At " + fmt(t, 2)) + "</div>";
    if (locked) h += '<button type="button" data-cx="unlock">Unlock editing</button><hr>';
    h += '<button type="button" class="rm" data-cx="remove"' + (!tg || locked || tg.cur === "remove" ? " disabled" : "") + ">Remove <kbd>R</kbd></button>";
    h += '<button type="button" data-cx="keep"' + (!tg || locked || tg.cur === "keep" ? " disabled" : "") + ">Keep <kbd>K</kbd></button>";
    h += '<button type="button" data-cx="split"' + (locked ? " disabled" : "") + ">Split here <kbd>S</kbd></button>";
    if (many) {
      h += "<hr>";
      h += '<button type="button" data-cx="earlier"' + (locked || ci === 0 || S.up.active ? " disabled" : "") + ">Move clip " + (ci + 1) + " earlier</button>";
      h += '<button type="button" data-cx="later"' + (locked || ci === cs.length - 1 || S.up.active ? " disabled" : "") + ">Move clip " + (ci + 1) + " later</button>";
    }
    var m = document.createElement("div"); m.className = "ctx"; m.setAttribute("role", "menu"); m.innerHTML = h;
    document.body.appendChild(m); ctxEl = m;
    var w = m.offsetWidth, hh = m.offsetHeight;
    m.style.left = Math.min(e.clientX, innerWidth - w - 8) + "px";
    m.style.top = (e.clientY + hh + 8 > innerHeight ? Math.max(8, e.clientY - hh) : e.clientY) + "px";
    $$("[data-cx]", m).forEach(function (b) {
      b.addEventListener("click", function () {
        var k = b.dataset.cx; closeCtx();
        if (k === "unlock") { S.unlocked = true; drawTL(); return; }
        if (k === "split") { edP.pause(); edP.setT(t); split(); return; }
        if (k === "earlier" || k === "later") { moveClip(ci, k === "earlier" ? -1 : 1); return; }
        if (!tg) return;
        paint(tg.a, tg.b, k);
        S.inPt = S.outPt = null;
        var mid = (tg.a + tg.b) / 2, sec = S.segs && S.segs.find(function (x) { return mid >= x.a && mid <= x.b; });
        S.sel = sec ? { a: sec.a, b: sec.b } : null;
        drawTL();
      });
    });
  });
  document.addEventListener("pointerdown", function (e) { if (ctxEl && !ctxEl.contains(e.target)) closeCtx(); }, true);
  document.addEventListener("keydown", function (e) { if (e.key === "Escape") closeCtx(); });
  window.addEventListener("blur", closeCtx);
  tScroll.addEventListener("scroll", closeCtx);
  inner.addEventListener("pointercancel", endPointer);

  // Wheel: vertical scroll and trackpad pinch zoom; horizontal or Shift-scroll pans
  tScroll.addEventListener("wheel", function (e) {
    if (!S.dur) return;
    var dx = e.deltaX, dy = e.deltaY;
    if (e.deltaMode === 1) { dx *= 16; dy *= 16; }
    if (!e.ctrlKey && !e.metaKey && (e.shiftKey || Math.abs(dx) > Math.abs(dy))) return;
    e.preventDefault();
    var k = e.ctrlKey ? 0.012 : 0.0018;
    zoomBy(Math.exp(-dy * k), e.clientX);
  }, { passive: false });
  // Safari trackpad pinch
  var gBase = null;
  tScroll.addEventListener("gesturestart", function (e) { e.preventDefault(); gBase = curPps(); });
  tScroll.addEventListener("gesturechange", function (e) { e.preventDefault(); if (gBase) setPps(gBase * e.scale, e.clientX); });
  tScroll.addEventListener("gestureend", function (e) { e.preventDefault(); gBase = null; });
  tScroll.addEventListener("scroll", scheduleVisible);
  window.addEventListener("resize", function () {
    if (S.view !== "edit" || !S.dur) return;
    if (S.fit) inner.style.width = "100%"; else if (curPps() < minPps()) setPps(minPps());
    scheduleVisible(); updateZoomUi();
  });

  // Typed timecode
  var tcNow = $("#tcNow"), tcIn = $("#tcIn");
  function openTc() { edP.pause(); tcIn.value = fmt(edP.getT(), 2); tcNow.hidden = true; tcIn.hidden = false; tcIn.focus(); tcIn.select(); }
  function closeTc(apply) {
    if (tcIn.hidden) return;
    if (apply) { var t = parseTc(tcIn.value); if (t != null) { edP.setT(t); revealTime(Math.min(t, S.dur)); } }
    tcIn.hidden = true; tcNow.hidden = false; edP.onTick(edP.getT());
  }
  tcNow.addEventListener("click", openTc);
  tcIn.addEventListener("keydown", function (e) {
    if (e.key === "Enter") { e.preventDefault(); closeTc(true); tcNow.focus(); }
    else if (e.key === "Escape") { e.preventDefault(); closeTc(false); tcNow.focus(); }
  });
  tcIn.addEventListener("blur", function () { closeTc(true); });

  function noFocus(fn) { return function (e) { fn(e); if (e && e.currentTarget && e.detail > 0) e.currentTarget.blur(); }; }
  $("#inBtn").addEventListener("click", noFocus(markIn));
  $("#splitBtn").addEventListener("click", noFocus(split));
  $("#outBtn").addEventListener("click", noFocus(markOut));
  $("#playBtn").addEventListener("click", noFocus(function () { edP.toggle(); }));
  $("#back5").addEventListener("click", noFocus(function () { edP.setT(edP.getT() - 5); revealTime(edP.getT()); }));
  $("#fwd5").addEventListener("click", noFocus(function () { edP.setT(edP.getT() + 5); revealTime(edP.getT()); }));
  $("#zIn").addEventListener("click", noFocus(function () { zoomBy(2); }));
  $("#zOut").addEventListener("click", noFocus(function () { zoomBy(0.5); }));
  $("#zFit").addEventListener("click", noFocus(function () { setPps(0); }));
  $("#popRemove").addEventListener("click", noFocus(function () { apply("remove"); }));
  $("#popKeep").addEventListener("click", noFocus(function () { apply("keep"); }));
  $("#popClear").addEventListener("click", noFocus(clearMarks));
  $("#undoBtn").addEventListener("click", noFocus(undo));
  $("#redoBtn").addEventListener("click", noFocus(redo));
  $("#unlockBtn").addEventListener("click", noFocus(function () { S.unlocked = true; drawTL(); }));
  $("#clearBtn").addEventListener("click", noFocus(function () { if (!S.segs || isLocked()) return; pushUndo(); S.segs = null; S.sel = null; S.inPt = S.outPt = null; drawTL(); }));
  $("#skipChk").addEventListener("change", function () { S.skip = $("#skipChk").checked; });
  $("#panelBtn").addEventListener("click", function () {
    var open = $("#panel").hidden; $("#panel").hidden = !open; $("#panelBtn").setAttribute("aria-pressed", String(open)); lsSet("panel", open);
    requestAnimationFrame(function () { if (!S.fit && curPps() < minPps()) setPps(minPps()); renderVisible(); positionPop(); updateZoomUi(); });
  });
  $("#editBack").addEventListener("click", function () { flushSave(); show("upload"); });
  $("#pushBtn").addEventListener("click", function () {
    S.rSegs = S.segs ? JSON.parse(JSON.stringify(S.segs)) : null;
    S.sentBack = "";
    if (S.demo) { startRender(); show("details"); return; }
    if (!S.msg) return;
    var cur = renderState();
    if (S.msg.renderRequested && !cur.failed && !cur.idle && JSON.stringify(S.segs || null) === JSON.stringify(S.msg.renderSegs || null)) {
      flushSave(); show("details"); return;
    }
    S.renderErr = "";
    S.render = { pct: 0, done: false, timer: null };
    show("details");
    flushSave().then(function () {
      return api("POST", "/messages/" + S.msg.id + "/render", { segs: S.rSegs, d: S.d });
    }).then(function (v) { mergeView(v); updateRender(); poll(); }, function (e) { S.renderErr = msgOf(e); updateRender(); });
  });

  document.addEventListener("keydown", function (e) {
    var tag = (e.target.tagName || "").toLowerCase();
    if (tag === "input" || tag === "textarea" || tag === "select" || e.target.isContentEditable) return;
    var k = e.key.toLowerCase(), mod = e.metaKey || e.ctrlKey;
    if (S.view === "review" && k === " " && tag !== "button") { e.preventDefault(); rvP.toggle(); return; }
    if (S.view === "review" && k === "f" && !e.metaKey && !e.ctrlKey) { e.preventDefault(); fullScreen(); return; }
    if (S.view !== "edit") return;
    if (mod && (k === "=" || k === "+")) { e.preventDefault(); zoomBy(1.6); return; }
    if (mod && (k === "-" || k === "_")) { e.preventDefault(); zoomBy(1 / 1.6); return; }
    if (mod && k === "0") { e.preventDefault(); setPps(0); return; }
    if (mod && k === "f") {
      e.preventDefault();
      if ($("#panel").hidden) $("#panelBtn").click();
      setTab("tr");
      setTimeout(function () { $("#trQ").focus(); $("#trQ").select(); }, 30);
      return;
    }
    if (mod && (k === "z" || k === "y")) {
      e.preventDefault(); e.stopPropagation();
      if (e.repeat) return;
      if (k === "y" || e.shiftKey) redo(); else undo();
      return;
    }
    if (mod || e.altKey) return;
    if (k === " ") { e.preventDefault(); edP.toggle(); }
    else if (k === "i") { e.preventDefault(); markIn(); }
    else if (k === "o") { e.preventDefault(); markOut(); }
    else if (k === "s") { e.preventDefault(); split(); }
    else if (k === "r" || k === "delete" || k === "backspace") { if (popRange()) { e.preventDefault(); apply("remove"); } }
    else if (k === "k") { if (popRange()) { e.preventDefault(); apply("keep"); } }
    else if (k === "arrowleft") { e.preventDefault(); if (e.shiftKey) { edP.pause(); edP.setT(edP.getT() - 1); revealTime(edP.getT()); } else stepFrames(-1); }
    else if (k === "arrowright") { e.preventDefault(); if (e.shiftKey) { edP.pause(); edP.setT(edP.getT() + 1); revealTime(edP.getT()); } else stepFrames(1); }
    else if (k === "escape") { clearMarks(); }
  });

  /* ---------- Saving (cut points and details) ---------- */
  var saveTimer = 0, lastSaved = "", savePromise = Promise.resolve();
  function payload() { return JSON.stringify({ segs: S.segs, d: S.d, fps: S.fps, duration: S.dur }); }
  function scheduleSave() {
    if (S.demo || !S.msg || !S.d) return;
    clearTimeout(saveTimer);
    saveTimer = setTimeout(function () { saveTimer = 0; flushSave(); }, 900);
  }
  function flushSave() {
    clearTimeout(saveTimer); saveTimer = 0;
    if (S.demo || !S.msg || !S.d) return savePromise;
    var p = payload(), id = S.msg.id;
    if (p === lastSaved) return savePromise;
    savePromise = savePromise.then(function () {
      return fetch("/api/messages/" + id, { method: "PUT", credentials: "same-origin", keepalive: p.length < 60000, headers: { "Content-Type": "application/json" }, body: p })
        .then(function (r) { if (r.ok) lastSaved = p; }, function () {});
    });
    return savePromise;
  }

  /* ---------- Render progress ---------- */
  var STAGES = [[35, "Rendering"], [50, "Compressing"], [75, "Uploading to Vimeo"], [90, "Vimeo processing"], [100, "Making audio"]];
  function stageName(p) { for (var i = 0; i < STAGES.length; i++) if (p < STAGES[i][0]) return STAGES[i][1]; return "Ready"; }
  // Simulated progress for the sample recording only
  function startRender() {
    clearInterval(S.render.timer);
    S.render = { pct: 0, done: false, timer: null };
    S.render.timer = setInterval(function () {
      S.render.pct = Math.min(100, S.render.pct + 0.5);
      if (S.render.pct >= 100) { S.render.done = true; clearInterval(S.render.timer); }
      updateRender();
    }, 120);
    updateRender();
  }
  function renderState() {
    if (S.demo) return { pct: S.render.pct, done: S.render.done, label: null };
    var m = S.msg, r = m && m.render;
    if (S.renderErr) return { pct: 0, done: false, failed: true, label: "Render didn't start" };
    if (!m) return { pct: 0, done: false, label: "" };
    if (m.renderRequested && !m.original.uploaded) return { pct: 0, done: false, label: S.up.active ? "Uploading · " + upPct() + "%" : "Waiting for the upload", bar: S.up.active ? upPct() : 0 };
    if (!r) return { pct: 0, done: false, label: m.renderRequested ? "Starting" : "Not rendered yet", idle: !m.renderRequested };
    if (r.failed) return { pct: r.pct, done: false, failed: true, label: "Render stopped" };
    if (r.status === "queued") return { pct: 0, done: false, label: "Starting" };
    return { pct: r.done ? 100 : r.pct, done: r.done, label: null };
  }
  function updateRender() {
    var st = renderState(), p = st.pct, done = st.done, pill = $("#detPill");
    S.render.pct = p; S.render.done = done;
    pill.className = "pill" + (done ? " ok" : st.failed ? " warn" : "");
    $(".bar", pill).hidden = done || st.failed || st.idle;
    $(".bar i", pill).style.width = (st.bar != null ? st.bar : p) + "%";
    $(".lbl", pill).textContent = done ? "Video ready" : (st.label || stageName(p) + " · " + Math.floor(p) + "%");
    var failText = st.failed ? (S.renderErr || "The video didn't finish. Go back to the editor and press Add details again. If it keeps happening, tell the tech team.") : "";
    var warn = failText || (!S.demo && !done ? quotaWarn : "");
    var db = $("#detBanner"); db.hidden = !warn; db.textContent = warn;
    var rb = $("#revBanner"); if (!S.pubErr) { rb.hidden = !failText; rb.textContent = failText; }
    drawProgress();
    if (S.view === "review") renderReviewStatus();
  }
  // One plain progress bar. Tapping it shows the parts being prepared at the same time.
  var progOpen = false;
  function progressHtml(st) {
    var r = S.msg && S.msg.render, mc = r && r.machines;
    var pct = st.done ? 100 : Math.max(0, Math.min(100, Math.floor(st.pct || 0)));
    var label = st.done ? "Video ready" : st.failed ? "Render stopped" : (st.label || stageName(pct));
    var chev = mc ? '<svg class="i chev" viewBox="0 0 16 16" aria-hidden="true"><path d="m4.5 6.5 3.5 3.5 3.5-3.5"></path></svg>' : "";
    var h = '<div class="prog">' + (mc ? '<button type="button" class="prog-h" data-prog aria-expanded="' + progOpen + '">' : '<div class="prog-h">') +
      '<span>' + esc(label) + '</span><span class="muted num" style="display: inline-flex; align-items: center; gap: 6px;">' + (st.failed ? "" : pct + "%") + chev + '</span>' + (mc ? "</button>" : "</div>") +
      '<div class="quota-bar' + (st.failed ? " low" : "") + '"><i style="width:' + pct + '%"></i></div>';
    if (mc && progOpen) {
      var bars = mc.pieces.map(function (p) { return '<span class="mc' + (p >= 100 ? " done" : "") + '"><i style="height:' + p + '%"></i></span>'; }).join("");
      var done = mc.pieces.filter(function (p) { return p >= 100; }).length;
      h += '<div class="machines" style="--n:' + mc.pieces.length + '" aria-hidden="true">' + bars + '<span></span><span class="mc snd' + (mc.sound >= 100 ? " done" : "") + '"><i style="height:' + mc.sound + '%"></i></span></div>' +
        '<p class="fine">Prepared in ' + mc.pieces.length + ' parts at the same time, plus the sound on the right. ' + done + ' of ' + mc.pieces.length + ' parts done.</p>';
    }
    return h + "</div>";
  }
  function drawProgress() {
    var st = renderState(), m = S.msg;
    var active = !S.demo && m && m.renderRequested && !st.idle;
    var running = active && !st.done && !st.failed;
    [["#detMachines", running || (active && st.failed)], ["#rvMachines", active && !st.done]].forEach(function (x) {
      var el = $(x[0]); el.hidden = !x[1];
      if (x[1]) { el.innerHTML = progressHtml(st); var b = $("[data-prog]", el); if (b) b.onclick = function () { progOpen = !progOpen; drawProgress(); }; }
    });
    $("#detCancel").hidden = !running; $("#revCancel").hidden = !running;
  }
  function cancelRender() {
    if (!S.msg || !confirm("Stop making this video? The post goes back to how it was before.")) return;
    api("POST", "/messages/" + S.msg.id + "/cancel-render").then(function (v) { mergeView(v); S.rSegs = v.renderSegs; S.renderErr = ""; updateRender(); if (S.view === "review") renderReview(); }, function (e) { showDetErr(msgOf(e)); });
  }
  $("#detCancel").addEventListener("click", cancelRender);
  $("#revCancel").addEventListener("click", cancelRender);

  // Delete this post: everything it made goes (Drive trash for 30 days, Vimeo video, website draft)
  $$("[data-delrow]").forEach(function (row) {
    var draw = function () {
      row.innerHTML = '<button class="link" style="color: var(--red);" data-delpost>Delete this post</button>';
      $("[data-delpost]", row).onclick = function () {
        if (S.demo) { resetEdit(); S.d = null; S.demo = false; show("upload"); return; }
        row.innerHTML = '<span style="flex: 1 1 260px;">Delete this post? Its recording, final video, audio and notes go to the Drive trash for 30 days, its Vimeo video is deleted and its website draft is removed.</span><button class="btn" data-no>Keep it</button><button class="btn danger" data-yes>Delete</button>';
        $("[data-no]", row).onclick = draw;
        $("[data-yes]", row).onclick = function () {
          var b = $("[data-yes]", row); b.disabled = true; b.textContent = "Deleting…"; $("[data-no]", row).disabled = true;
          var id = S.msg && S.msg.id;
          api("DELETE", "/messages/" + id).then(function (r) {
            resetEdit(); S.d = null; S.notes = [];
            S.list = S.list.filter(function (m) { return m.id !== id; });
            draw(); show("upload");
            if (r && r.vimeoLeft) { $("#dropErr").textContent = "Deleted. Its Vimeo video couldn't be removed automatically, so delete it in Vimeo."; $("#dropErr").hidden = false; }
          }, function (e) { draw(); showDetErr(msgOf(e)); });
        };
      };
    };
    draw();
  });

  // Review sections open and close
  $$(".coll-h").forEach(function (b) {
    b.addEventListener("click", function () {
      var open = b.getAttribute("aria-expanded") !== "true";
      b.setAttribute("aria-expanded", String(open));
      $("#" + b.getAttribute("aria-controls")).hidden = !open;
    });
  });

  var pollTimer = 0;
  function poll() {
    clearTimeout(pollTimer);
    if (S.demo || !S.msg || !S.user) return;
    var m = S.msg;
    var renderBusy = m.renderRequested && !(m.render && (m.render.done || m.render.failed));
    var previewBusy = (m.preview && m.preview.joining) || (m.original.uploaded || (m.source === "zoom" && !(m.importing && m.importing.failed))) && (!(m.preview && (m.preview.proxyId || m.preview.status === "error")) || (m.preview && (m.preview.status === "queued" || m.preview.status === "running")));
    var tr = m.preview && m.preview.transcript;
    var transcriptBusy = m.original.uploaded && !(tr && (tr.status === "done" || tr.status === "error"));
    var watching = (S.view === "details" || S.view === "review") ? renderBusy || (m.render && m.render.done && m.status === "finished" && !m.webflow) : S.view === "edit" ? previewBusy || transcriptBusy : false;
    if (!watching) return;
    pollTimer = setTimeout(function () {
      if (!S.msg || S.msg.id !== m.id) return;
      api("GET", "/messages/" + m.id).then(function (v) {
        if (!S.msg || S.msg.id !== v.id) return;
        var hadProxy = S.msg.preview && S.msg.preview.proxyId;
        if (!v.preview.waveId) S.waveId = null;
        if (!v.preview.thumbsId) S.spriteId = null;
        if (v.preview.transcript && !v.preview.transcript.id) S.trId = null;
        var mixed = !!S.awaitJoin && !S.url;
        mergeView(v);
        if (mixed && v.preview.proxyId && !v.preview.joining) {
          // Swap to the newly joined preview without losing the place (or stopping playback)
          var keepT = edP.getT(), keepPlay = edP.playing;
          vid.addEventListener("loadedmetadata", function () { edP.setT(keepT); if (keepPlay) edP.play(); }, { once: true });
          usePreview(v); drawTL();
        }
        if (mixed) { updateRender(); poll(); return; }
        if (!S.dur && v.duration) S.dur = v.duration;
        if (v.preview.waveId) loadWave(v.preview);
        if (S.view === "edit" && !S.url) loadSprite(v.preview);
        loadTranscript(v.preview.transcript);
        if (!hadProxy && v.preview.proxyId && !S.url) usePreview(v);
        else if (!hadProxy && !S.url && S.view === "edit") usePreview(v);
        updateRender();
        poll();
      }, function () { poll(); });
    }, 4000);
  }

  /* ---------- Details ---------- */
  function initDetails() {
    var dt = S.file ? new Date(S.file.lastModified) : new Date(2026, 10, 7);
    S.d = {
      coll: dt.getDay() === 0 ? "Sunday" : "Hebron",
      date: dt.getFullYear() + "-" + pad(dt.getMonth() + 1) + "-" + pad(dt.getDate()),
      part: "", title: "", titleEdited: false, slug: "", slugEdited: false,
      speakers: [], tags: [], desc: "", res: "", esv: "", esa: "", jav: "", jaa: "",
      featured: false, hide: false, seq: "", adv: false, web: true, thumb: null
    };
  }
  function autoTitleOf(d) {
    if (!d) return "Untitled post";
    var p = (d.date || "").split("-"), ds = "";
    if (p.length === 3) ds = MONTHS[+p[1] - 1] + " " + ordinal(+p[2]) + ", " + p[0];
    return d.coll + " - " + ds + (d.part ? " - Part " + d.part : "");
  }
  function titleOf(d) { if (!d) return "Untitled post"; return (d.title || "").trim() || autoTitleOf(d); }
  function autoTitle() { return autoTitleOf(S.d); }
  function title() { return titleOf(S.d); }
  function slugify(s) { return s.toLowerCase().replace(/[^a-z0-9 -]/g, "").trim().replace(/ /g, "-"); }
  function autoSlug() { return S.d.title.trim() ? slugify(S.d.title.trim() + " " + S.d.date) : slugify(autoTitle()); }
  function slug() { return S.d.slugEdited ? S.d.slug : autoSlug(); }

  // Chip field with a dropdown that opens on focus or click
  function combo(boxId, inputId, menuId, key, options, noun) {
    var box = $(boxId), inp = $(inputId), menu = $(menuId), items = [], active = -1;
    function render() {
      $$(".chip", box).forEach(function (c) { c.remove(); });
      S.d[key].forEach(function (v, i) {
        var c = document.createElement("span"); c.className = "chip";
        c.innerHTML = esc(v) + '<button type="button" aria-label="Remove ' + esc(v) + '"><svg class="i" viewBox="0 0 16 16" style="width:12px;height:12px" aria-hidden="true"><path d="m4.5 4.5 7 7M11.5 4.5l-7 7"></path></svg></button>';
        c.querySelector("button").addEventListener("mousedown", function (e) { e.preventDefault(); });
        c.querySelector("button").addEventListener("click", function () { S.d[key].splice(i, 1); render(); if (!menu.hidden) build(); });
        box.insertBefore(c, inp);
      });
      scheduleSave();
    }
    function build() {
      var q = inp.value.trim(), ql = q.toLowerCase();
      var avail = options.filter(function (o) { return S.d[key].indexOf(o) < 0 && (!ql || o.toLowerCase().indexOf(ql) >= 0); });
      items = avail.map(function (o) { return { value: o, label: o, extra: "" }; });
      var exact = options.some(function (o) { return o.toLowerCase() === ql; }) || S.d[key].some(function (o) { return o.toLowerCase() === ql; });
      if (q && !exact) items.push({ value: q, label: "Add “" + q + "”", extra: "New " + noun });
      if (active >= items.length) active = items.length - 1;
      if (active < 0 && items.length) active = 0;
      menu.innerHTML = items.length ? items.map(function (it, i) {
        return '<button type="button" class="opt' + (i === active ? " active" : "") + '" role="option" aria-selected="' + (i === active) + '" data-i="' + i + '"><span>' + esc(it.label) + "</span>" + (it.extra ? '<span class="hint-r">' + esc(it.extra) + "</span>" : "") + "</button>";
      }).join("") : '<div class="empty">All ' + noun + "s added. Type to add a new one.</div>";
      $$(".opt", menu).forEach(function (b) {
        b.addEventListener("mousedown", function (e) { e.preventDefault(); });
        b.addEventListener("mousemove", function () { if (active !== +b.dataset.i) { active = +b.dataset.i; paintActive(); } });
        b.addEventListener("click", function () { pick(items[+b.dataset.i].value); });
      });
    }
    function paintActive() {
      $$(".opt", menu).forEach(function (b, i) { b.classList.toggle("active", i === active); b.setAttribute("aria-selected", String(i === active)); });
      var a = $$(".opt", menu)[active]; if (a) a.scrollIntoView({ block: "nearest" });
    }
    function open() { active = 0; build(); menu.hidden = false; inp.setAttribute("aria-expanded", "true"); }
    function close() { menu.hidden = true; inp.setAttribute("aria-expanded", "false"); }
    function add(v) { v = v.trim().replace(/,$/, "").trim(); if (!v) return; if (S.d[key].indexOf(v) < 0) S.d[key].push(v); inp.value = ""; render(); }
    function pick(v) { add(v); active = 0; build(); inp.focus(); }
    inp.addEventListener("focus", open);
    inp.addEventListener("click", function () { if (menu.hidden) open(); });
    inp.addEventListener("input", function () { active = 0; build(); if (menu.hidden) { menu.hidden = false; inp.setAttribute("aria-expanded", "true"); } });
    inp.addEventListener("keydown", function (e) {
      if (e.key === "ArrowDown") { e.preventDefault(); if (menu.hidden) open(); else if (items.length) { active = (active + 1) % items.length; paintActive(); } }
      else if (e.key === "ArrowUp") { e.preventDefault(); if (items.length) { active = (active - 1 + items.length) % items.length; paintActive(); } }
      else if (e.key === "Enter") { e.preventDefault(); if (!menu.hidden && items[active]) pick(items[active].value); else if (inp.value.trim()) pick(inp.value); }
      else if (e.key === ",") { e.preventDefault(); if (inp.value.trim()) pick(inp.value); }
      else if (e.key === "Escape") { close(); }
      else if (e.key === "Backspace" && !inp.value && S.d[key].length) { S.d[key].pop(); render(); build(); }
    });
    inp.addEventListener("blur", function () { close(); if (inp.value.trim()) add(inp.value); });
    box.addEventListener("mousedown", function (e) { if (e.target === box) { e.preventDefault(); inp.focus(); } });
    return { render: render, add: add };
  }
  var spk = combo("#spkChips", "#fSpk", "#spkMenu", "speakers", SPEAKERS, "speaker");
  var tags = combo("#tagChips", "#fTag", "#tagMenu", "tags", TAGS, "tag");
  function renderNotes() {
    var el = $("#notesList");
    if (!S.notes.length) { el.innerHTML = '<p class="fine" style="font-size:13px">No notes file. Add one if the session had handouts.</p>'; return; }
    el.innerHTML = S.notes.map(function (f, i) {
      var ext = (f.name.split(".").pop() || "").toUpperCase().slice(0, 4);
      var where = i === 0 ? "Shown as the notes download" : "Shown as an extra resource";
      if (!S.demo && f.uploaded === false) where = (S.up.active ? "Uploading · " : "Waiting to upload · ") + where.charAt(0).toLowerCase() + where.slice(1);
      return '<div class="file-row"><span class="file-ico">' + esc(ext) + '</span><span style="flex:1;min-width:0;overflow-wrap:anywhere;font-size:13px">' + esc(f.name) + '<br><span class="muted" style="font-size:12px">' + where + '</span></span><button class="btn" data-i="' + i + '">Remove</button></div>';
    }).join("");
    $$("button", el).forEach(function (b) { b.addEventListener("click", function () { removeNote(+b.dataset.i); }); });
  }
  function removeNote(i) {
    if (S.demo || !S.msg) { S.notes.splice(i, 1); renderNotes(); return; }
    api("DELETE", "/messages/" + S.msg.id + "/notes/" + i).then(function (v) { mergeView(v); renderNotes(); }, function (e) { showDetErr(msgOf(e)); });
  }
  function addNoteFiles(files) {
    if (S.demo || !S.msg) { S.notes = S.notes.concat(files.map(function (f) { return { name: f.name, size: f.size, type: f.type }; })); renderNotes(); return; }
    api("POST", "/messages/" + S.msg.id + "/notes", { files: files.map(function (f) { return { name: f.name, size: f.size, type: f.type }; }) }).then(function (j) {
      mergeView(j.message);
      j.added.forEach(function (idx, k) { S.noteFiles[idx] = files[k]; queueUpload({ kind: "notes", idx: idx, file: files[k], url: S.msg.notes[idx].sessionUrl }); });
      renderNotes();
    }, function (e) { showDetErr(msgOf(e)); });
  }
  function showDetErr(t) { $("#detErr").textContent = t; $("#detErr").hidden = !t; }
  $("#addNotes").addEventListener("click", function () { $("#notesIn").click(); });
  $("#notesIn").addEventListener("change", function () { addNoteFiles(Array.prototype.slice.call($("#notesIn").files)); $("#notesIn").value = ""; });

  function syncTitle() {
    var t = title();
    $("#titleHelp").textContent = "Shown to viewers on the website and Vimeo. If left empty: " + autoTitle();
    $("#detTitle").textContent = t || "Untitled post";
    if (!S.d.slugEdited) $("#fSlug").value = autoSlug();
    $("#slugPath").textContent = "sentlifecenter.com/" + COLL_SLUG[S.d.coll] + "/" + slug();
    scheduleSave();
  }
  function renderDetails() {
    var d = S.d;
    $$("#collCtl button").forEach(function (b) { b.setAttribute("aria-pressed", String(b.dataset.coll === d.coll)); });
    $("#fDate").value = d.date; $("#fPart").value = d.part;
    $("#fTitle").value = S.d.title;
    $("#fDesc").value = d.desc; $("#descCount").textContent = d.desc.length + " / 200";
    $("#fRes").value = d.res; $("#fEsv").value = d.esv; $("#fEsa").value = d.esa; $("#fJav").value = d.jav; $("#fJaa").value = d.jaa;
    $("#fFeat").checked = d.featured; $("#fHide").checked = d.hide; $("#fSeq").value = d.seq;
    $("#fSlug").value = slug();
    $("#advBtn").setAttribute("aria-expanded", String(d.adv)); $("#advBody").hidden = !d.adv;
    $("#fWeb").checked = d.web !== false;
    $("#sundayOpts").hidden = d.coll !== "Sunday" || d.web === false;
    $("#slugField").hidden = d.web === false;
    $("#detIntro").textContent = d.web === false
      ? "Save & review files this in Google Drive and keeps it on Vimeo only. Nothing goes on the website."
      : "Save & review stages this as a draft on the website. Nothing goes live until someone publishes it.";
    renderThumbs();
    $("#detErr").hidden = true;
    $("#finishBtn").disabled = false;
    spk.render(); tags.render(); renderNotes(); syncTitle(); updateRender();
  }
  $$("#collCtl button").forEach(function (b) { b.addEventListener("click", function () { S.d.coll = b.dataset.coll; renderDetails(); }); });
  $("#fDate").addEventListener("input", function () { S.d.date = $("#fDate").value; syncTitle(); });
  $("#fPart").addEventListener("input", function () { S.d.part = $("#fPart").value.replace(/[^0-9]/g, ""); $("#fPart").value = S.d.part; syncTitle(); });
  $("#fTitle").addEventListener("input", function () { S.d.title = $("#fTitle").value; syncTitle(); });
  $("#fSlug").addEventListener("input", function () { S.d.slug = $("#fSlug").value.toLowerCase().replace(/[^a-z0-9-]/g, "-"); S.d.slugEdited = true; $("#fSlug").value = S.d.slug; syncTitle(); });
  $("#fDesc").addEventListener("input", function () { S.d.desc = $("#fDesc").value; $("#descCount").textContent = S.d.desc.length + " / 200"; scheduleSave(); });
  [["#fRes", "res"], ["#fEsv", "esv"], ["#fEsa", "esa"], ["#fJav", "jav"], ["#fJaa", "jaa"], ["#fSeq", "seq"]].forEach(function (p) {
    $(p[0]).addEventListener("input", function () { S.d[p[1]] = $(p[0]).value; scheduleSave(); });
  });
  $("#fFeat").addEventListener("change", function () { S.d.featured = $("#fFeat").checked; scheduleSave(); });
  $("#fWeb").addEventListener("change", function () { S.d.web = $("#fWeb").checked; renderDetails(); scheduleSave(); });

  // Vimeo thumbnail: one of 16 frames from the kept parts, or an uploaded image
  function thumbChoices() {
    var segs = S.rSegs || S.segs, keeps = segs ? segs.filter(function (x) { return x.t === "keep"; }) : [{ a: 0, b: S.dur }];
    var total = keeps.reduce(function (a, k) { return a + k.b - k.a; }, 0), out = [];
    if (!total || !S.thumbs.length) return out;
    for (var i = 0; i < 16; i++) {
      var want = (i + 0.5) / 16 * total, t = 0;
      for (var j = 0; j < keeps.length; j++) { var len = keeps[j].b - keeps[j].a; if (want <= len) { t = keeps[j].a + want; break; } want -= len; }
      var tt = Math.round(t * 10) / 10;
      out.push({ t: tt, sharp: S.sharp && S.sharp[tt], img: S.thumbs[Math.min(S.thumbs.length - 1, Math.floor(t / S.dur * S.thumbs.length))], at: t - removedBefore(t, segs) });
    }
    return out;
  }
  function renderThumbs() {
    var g = $("#thumbGrid"), th = S.d.thumb, h = "";
    var choices = thumbChoices();
    choices.forEach(function (c, i) {
      var on = th && th.kind === "frame" && Math.abs(th.t - c.t) < 0.6;
      var im = c.sharp || c.img;
      h += '<button type="button" class="thumb-opt' + (on ? " on" : "") + '" data-ti="' + i + '" aria-pressed="' + on + '" aria-label="Use the frame at ' + fmt(c.at) + '"' + (im ? ' style="background-image:url(' + im + ')"' : "") + "><span>" + fmt(c.at) + "</span></button>";
    });
    if (th && th.kind === "frame" && !choices.some(function (c) { return Math.abs(th.t - c.t) < 0.6; })) {
      var segsP = S.rSegs || S.segs, pic = S.thumbPicked && Math.abs(S.thumbPicked.t - th.t) < 0.01 ? S.thumbPicked.img : (S.thumbs.length ? S.thumbs[Math.min(S.thumbs.length - 1, Math.floor(th.t / S.dur * S.thumbs.length))] : null);
      h += '<button type="button" class="thumb-opt on" data-tpick aria-pressed="true" aria-label="Your frame at ' + fmt(th.t - removedBefore(th.t, segsP)) + '"' + (pic ? ' style="background-image:url(' + pic + ')"' : "") + "><span>" + fmt(th.t - removedBefore(th.t, segsP)) + "</span></button>";
    }
    if (th && th.kind === "image") {
      var src = S.thumbLocal || "/media/" + th.fileId + "?type=image%2Fjpeg";
      h += '<button type="button" class="thumb-opt on" data-timg aria-pressed="true" aria-label="Uploaded image" style="background-image:url(' + src + ')"><span>Uploaded</span></button>';
    }
    var keepScroll = g.scrollLeft;
    g.innerHTML = h;
    g.hidden = !h;
    g.scrollLeft = keepScroll;
    railUi(); sharpenThumbs(choices);
    $$("[data-ti]", g).forEach(function (b) {
      b.addEventListener("click", function () {
        var c = choices[+b.dataset.ti], cur = S.d.thumb;
        S.d.thumb = cur && cur.kind === "frame" && Math.abs(cur.t - c.t) < 0.6 ? null : { kind: "frame", t: c.t };
        saveThumb();
      });
    });
    var tp = $("[data-tpick]", g); if (tp) tp.addEventListener("click", function () { S.d.thumb = null; saveThumb(); });
    var ti = $("[data-timg]", g); if (ti) ti.addEventListener("click", function () { S.d.thumb = null; S.thumbLocal = null; saveThumb(); });
    var applied = S.msg && S.msg.render && S.msg.render.thumbApplied;
    $("#thumbNote").textContent = !choices.length && !th ? "Frames to choose from appear once the preview is ready. Until then Vimeo picks one." :
      !th ? "Choose a frame, pick any moment, or upload an image. Otherwise Vimeo picks one." :
      applied ? "Set on Vimeo." : "It will be set on Vimeo once the video is there.";
  }
  // The frame strip: one row, swipe or use the arrows
  function railUi() {
    var g = $("#thumbGrid"), max = g.scrollWidth - g.clientWidth;
    $("#railPrev").disabled = g.hidden || g.scrollLeft <= 4;
    $("#railNext").disabled = g.hidden || g.scrollLeft >= max - 4;
  }
  function railStep(dir) {
    var g = $("#thumbGrid"), tile = $(".thumb-opt", g);
    g.scrollBy({ left: dir * ((tile ? tile.offsetWidth + 12 : 300) * 2), behavior: "smooth" });
  }
  $("#railPrev").addEventListener("click", function () { railStep(-1); });
  $("#railNext").addEventListener("click", function () { railStep(1); });
  $("#thumbGrid").addEventListener("scroll", function () { railUi(); }, { passive: true });
  window.addEventListener("resize", railUi);
  // The filmstrip pictures are small, so the big tiles are swapped for sharp frames from the video itself
  var sharpBusy = false;
  function sharpenThumbs(choices) {
    if (sharpBusy || !S.src || S.demo) return;
    S.sharp = S.sharp || {};
    var todo = choices.filter(function (c) { return !S.sharp[c.t]; });
    if (!todo.length) return;
    sharpBusy = true;
    var src = S.src, tv = document.createElement("video"); tv.muted = true; tv.preload = "auto"; tv.playsInline = true; tv.src = src;
    var c = document.createElement("canvas"); c.width = 640; c.height = 360; var g = c.getContext("2d");
    (async function () {
      await once(tv, "loadeddata", 10000);
      for (var i = 0; i < todo.length; i++) {
        if (S.src !== src || S.view !== "details") break;
        try { tv.currentTime = todo[i].t + 0.01; } catch (e) {}
        await once(tv, "seeked", 8000);
        try {
          var vw = tv.videoWidth || 16, vh = tv.videoHeight || 9, sr = vw / vh, tr = 16 / 9, sx = 0, sy = 0, sw = vw, sh = vh;
          if (sr > tr) { sw = vh * tr; sx = (vw - sw) / 2; } else { sh = vw / tr; sy = (vh - sh) / 2; }
          g.drawImage(tv, sx, sy, sw, sh, 0, 0, 640, 360);
          S.sharp[todo[i].t] = c.toDataURL("image/jpeg", 0.8);
          var b = $('#thumbGrid [data-ti]:nth-child(' + (choices.indexOf(todo[i]) + 1) + ')');
          if (b) b.style.backgroundImage = "url(" + S.sharp[todo[i].t] + ")";
        } catch (e) {}
      }
      tv.removeAttribute("src"); try { tv.load(); } catch (e) {}
      sharpBusy = false;
    })();
  }

  // Pick any moment of the final video for the Vimeo thumbnail
  function fpKeeps() { var segs = S.rSegs || S.segs; return segs ? segs.filter(function (x) { return x.t === "keep"; }) : [{ a: 0, b: S.dur }]; }
  function fpTotal() { return fpKeeps().reduce(function (a, k) { return a + k.b - k.a; }, 0); }
  function fpToOriginal(e) { var keeps = fpKeeps(); for (var j = 0; j < keeps.length; j++) { var len = keeps[j].b - keeps[j].a; if (e <= len) return keeps[j].a + e; e -= len; } return keeps.length ? keeps[keeps.length - 1].b : 0; }
  var fp = { e: 0, timer: 0 };
  function openFramePick() {
    var src = S.src;
    if (!src || !S.dur) { showDetErr("The video isn't ready to pick from yet. Try again once the preview has loaded."); return; }
    var v = $("#fpVid");
    if (v.getAttribute("src") !== src) v.src = src;
    var th = S.d.thumb, segs = S.rSegs || S.segs;
    fp.e = th && th.kind === "frame" ? Math.max(0, th.t - removedBefore(th.t, segs)) : fpTotal() / 3;
    $("#fpRange").value = String(Math.round(fp.e / Math.max(1, fpTotal()) * 1000));
    $("#framePick").hidden = false; $("#framePickBtn").hidden = true;
    fpSeek();
  }
  function closeFramePick() {
    var box = $("#framePick"); if (!box || box.hidden) return;
    box.hidden = true; $("#framePickBtn").hidden = false;
    var v = $("#fpVid"); v.pause(); v.removeAttribute("src"); try { v.load(); } catch (e) {}
  }
  function fpSeek() {
    var total = fpTotal(); fp.e = Math.min(Math.max(0, fp.e), Math.max(0, total - FRAME()));
    $("#fpTime").textContent = fmt(fp.e, 2) + " / " + fmt(total);
    clearTimeout(fp.timer);
    fp.timer = setTimeout(function () { try { $("#fpVid").currentTime = fpToOriginal(fp.e) + 1e-4; } catch (e) {} }, 40);
  }
  $("#framePickBtn").addEventListener("click", openFramePick);
  $("#fpCancel").addEventListener("click", closeFramePick);
  $("#fpRange").addEventListener("input", function () { fp.e = +$("#fpRange").value / 1000 * fpTotal(); fpSeek(); });
  $("#fpBack").addEventListener("click", function () { fp.e -= FRAME(); $("#fpRange").value = String(Math.round(fp.e / Math.max(1, fpTotal()) * 1000)); fpSeek(); });
  $("#fpFwd").addEventListener("click", function () { fp.e += FRAME(); $("#fpRange").value = String(Math.round(fp.e / Math.max(1, fpTotal()) * 1000)); fpSeek(); });
  $("#fpUse").addEventListener("click", function () {
    var t = Math.round(fpToOriginal(fp.e) * 100) / 100, v = $("#fpVid"), img = null;
    try { var c = document.createElement("canvas"); c.width = 192; c.height = 108; c.getContext("2d").drawImage(v, 0, 0, 192, 108); img = c.toDataURL("image/jpeg", 0.75); } catch (e) {}
    S.thumbPicked = { t: t, img: img };
    S.d.thumb = { kind: "frame", t: t };
    closeFramePick(); saveThumb();
  });

  function saveThumb() {
    renderThumbs();
    if (S.demo || !S.msg) return;
    flushSave().then(function () { return api("POST", "/messages/" + S.msg.id + "/thumb", { thumb: S.d.thumb }); })
      .then(function (v) { S.msg.render = v.render; lastSaved = ""; renderThumbs(); }, function (e) { showDetErr(msgOf(e)); });
  }
  $("#thumbUpload").addEventListener("click", function () { $("#thumbIn").click(); });
  $("#thumbIn").addEventListener("change", function () {
    var f = $("#thumbIn").files[0]; $("#thumbIn").value = "";
    if (!f) return;
    if (!/^image\/(jpeg|png)$/.test(f.type)) { showDetErr("Use a JPG or PNG image."); return; }
    S.thumbLocal = URL.createObjectURL(f);
    if (S.demo || !S.msg) { S.d.thumb = { kind: "image", fileId: "local-image-only" }; renderThumbs(); return; }
    $("#thumbNote").textContent = "Uploading the image…";
    api("POST", "/messages/" + S.msg.id + "/thumb-upload", { name: f.name, size: f.size, type: f.type }).then(function (j) {
      return putChunk(j.sessionUrl, f, 0, f.size, function () {});
    }).then(function (r) {
      if (!(r.status === 200 || r.status === 201) || !r.json || !r.json.id) throw new Error("upload");
      S.d.thumb = { kind: "image", fileId: r.json.id };
      saveThumb();
    }).catch(function (e) { S.thumbLocal = null; renderThumbs(); showDetErr(e && e.user ? e.message : "The image didn't upload. Try again."); });
  });
  $("#fHide").addEventListener("change", function () { S.d.hide = $("#fHide").checked; scheduleSave(); });
  $("#advBtn").addEventListener("click", function () { S.d.adv = !S.d.adv; $("#advBtn").setAttribute("aria-expanded", String(S.d.adv)); $("#advBody").hidden = !S.d.adv; });
  $("#detBack").addEventListener("click", function () { flushSave(); show("edit"); });
  $("#finishBtn").addEventListener("click", function () {
    if ($("#fSpk").value.trim()) spk.add($("#fSpk").value);
    if ($("#fTag").value.trim()) tags.add($("#fTag").value);
    var err = !title().trim() ? "Add a title first." : (!S.d.date ? "Add the date of the message." : "");
    if (err) { showDetErr(err); return; }
    if (S.demo) { show("review"); return; }
    var btn = $("#finishBtn"); btn.disabled = true; showDetErr("");
    flushSave().then(function () { return api("POST", "/messages/" + S.msg.id + "/finish", { d: S.d }); }).then(function (v) {
      btn.disabled = false;
      mergeView(v); S.d = v.d;
      show("review");
    }, function (e) { btn.disabled = false; showDetErr(msgOf(e)); });
  });

  /* ---------- Review ---------- */
  function renderReviewStatus() {
    var done = S.render.done, pill = $("#revPill"), p = S.render.pct;
    var st = renderState();
    pill.className = "pill " + (done ? "warn" : st.failed ? "warn" : "");
    pill.textContent = done ? "Waiting for approval" : st.failed ? "Render stopped" : (st.label && !S.demo ? st.label : "Preparing · " + Math.floor(p) + "%");
    $("#publishBtn").disabled = !done || S.publishing;
    var checks = [
      [p >= 50, "Video edited and compressed"],
      [p >= 90, "Video uploaded to Vimeo"],
      [p >= 100, "Audio file saved to Google Drive"],
      [!!title().trim(), "Title and date set"],
      [S.notes.length > 0, S.notes.length ? "Notes attached" : "No notes file (optional)"]
    ];
    $("#rvChecks").innerHTML = checks.map(function (c) { return '<div class="chk' + (c[0] ? " done" : "") + '"><i></i>' + esc(c[1]) + "</div>"; }).join("");
    $("#readySum").textContent = done ? "All set" : st.failed ? "Render stopped" : (st.label && !S.demo ? st.label : stageName(p) + " · " + Math.floor(p) + "%");
  }
  // Drive filing: 01_SLC Media Library > [year] > [collection folder] > ##_[TYPE]_YYYY_MM_DD > Original + Final edit
  var DRIVE_COLL = {
    Sunday: { folder: function (y) { return "01_SLC_Sundays_" + y; }, code: "Sunday" },
    Hebron: { folder: function () { return "03_HEBRON"; }, code: "HEBRON" },
    Charis: { folder: function () { return "04_Charis/X-Elle"; }, code: "CX" }
  };
  var NEXT_2026 = { Sunday: 45, Hebron: 9, Charis: 10 }; // sample recording only
  function drivePlan() {
    if (!S.demo && S.msg && S.msg.filing) {
      var f = S.msg.filing;
      return { path: f.path, folder: f.folder, isNew: f.isNew, original: f.original, final: f.final };
    }
    var d = S.d, p = (d.date || "").split("-"), y = p[0] || "2026";
    var c = DRIVE_COLL[d.coll];
    var n = y === "2026" ? NEXT_2026[d.coll] : 1;
    var folder = pad(n) + "_" + c.code + "_" + p.join("_");
    var base = d.coll + "_" + p.join("_") + (d.part ? "_Part" + d.part : "");
    var ext = S.demo ? "mov" : ((S.file ? S.file.name : (S.msg && S.msg.file ? S.msg.file.name : "x.mov")).split(".").pop() || "mov").toLowerCase();
    return {
      path: ["01_SLC Media Library", y, c.folder(y)],
      folder: folder, isNew: true,
      original: [base + "." + ext].concat(S.notes.map(function (f) { return f.name; })),
      final: [base + ".mp4", base + ".mp3"]
    };
  }
  function renderDrive() {
    var pl = drivePlan();
    var fold = '<svg class="i" viewBox="0 0 16 16" aria-hidden="true"><path d="M2 4.5h4l1.5 1.5H14v6.5H2z"></path></svg>';
    var file = '<svg class="i" viewBox="0 0 16 16" aria-hidden="true"><path d="M4 2h5l3 3v9H4z"></path><path d="M9 2v3h3"></path></svg>';
    var h = '<div class="row">' + fold + "<span>" + pl.path.map(esc).join(" / ") + "</span></div>";
    h += '<div class="row new" style="padding-left:14px">' + fold + "<span>" + esc(pl.folder) + "</span>" + (pl.isNew ? '<span class="badge">New</span>' : "") + "</div>";
    h += '<div class="row new" style="padding-left:28px">' + fold + "<span>Original</span></div>";
    pl.original.forEach(function (f) { h += '<div class="row" style="padding-left:42px">' + file + "<span>" + esc(f) + "</span></div>"; });
    h += '<div class="row new" style="padding-left:28px">' + fold + "<span>Final edit</span></div>";
    pl.final.forEach(function (f) { h += '<div class="row" style="padding-left:42px">' + file + "<span>" + esc(f) + "</span></div>"; });
    h += '<p class="fine" style="margin-top:6px">Drive names follow the meeting date and are set automatically. Once the post is published, the original recording is removed from Drive and only the final edit is kept, so keep the original on your own drive.</p>';
    $("#driveTree").innerHTML = h;
  }
  function renderReview() {
    var d = S.d;
    $("#revTitle").textContent = title();
    var web = d.web !== false;
    $("#rvColl").textContent = web ? d.coll + " Messages" : "Vimeo only";
    $("#rvCollIco use").setAttribute("href", web ? "#lg-webflow" : "#lg-vimeo");
    $("#rvCollIco").setAttribute("class", "lg " + (web ? "lg-webflow" : "lg-vimeo"));
    $("#publishBtn").innerHTML = web ? '<svg class="lg" aria-hidden="true"><use href="#lg-webflow"></use></svg>Publish to Webflow' : '<svg class="lg" aria-hidden="true"><use href="#lg-vimeo"></use></svg>Mark as done';
    $("#rvName").textContent = title();
    var dp = d.date.split("-");
    var rows = [
      ["Date", dp.length === 3 ? MONTHS[+dp[1] - 1] + " " + (+dp[2]) + ", " + dp[0] : ""],
      ["Speaker", d.speakers.join(", ") || "Not set"],
      ["Topic tags", d.tags.join(", ") || "None"],
      ["Length", fmt(keptDur(S.rSegs))],
      ["Notes", S.notes.length ? S.notes.map(function (f) { return f.name; }).join(", ") : "None"],
      web ? ["Page", "/" + COLL_SLUG[d.coll] + "/" + slug()] : ["Website", "Not posted"],
      ["Thumbnail", !d.thumb ? "Chosen by Vimeo" : d.thumb.kind === "image" ? "Uploaded image" : "Frame at " + fmt(d.thumb.t - removedBefore(d.thumb.t, S.rSegs))]
    ];
    if (web && d.coll === "Sunday") rows.push(["Sunday options", [d.featured ? "Featured" : "", d.hide ? "Hidden from Sunday page" : "", d.seq ? "Order " + d.seq : ""].filter(Boolean).join(", ") || "Standard"]);
    $("#rvRows").innerHTML = rows.map(function (r) { return '<div class="kv"><span class="muted">' + esc(r[0]) + "</span><span>" + esc(r[1]) + "</span></div>"; }).join("");
    var rem = S.rSegs ? S.rSegs.filter(function (s) { return s.t === "remove"; }) : [];
    var removed = rem.reduce(function (a, x) { return a + x.b - x.a; }, 0);
    $("#cutSum").textContent = rem.length ? rem.length + (rem.length > 1 ? " cuts · " : " cut · ") + fmt(removed) + " removed" : "Nothing removed";
    $("#driveSum").textContent = "In the " + d.coll + " folder";
    $("#rvCuts").innerHTML = rem.length ? rem.map(function (s) { return '<div class="kv"><span>Removed ' + fmt(s.b - s.a) + '</span><span class="muted">' + fmt(s.a) + " – " + fmt(s.b) + "</span></div>"; }).join("") : '<p class="fine" style="font-size:13px">Nothing removed. The full recording is used.</p>';
    $("#rBar").innerHTML = S.dur ? rem.map(function (s) { return '<div class="rm" style="left:' + P(s.a) + "%;width:" + P(s.b - s.a) + '%"></div>'; }).join("") + '<div class="ph"></div>' : '<div class="ph"></div>';
    $("#rLen").textContent = fmt(keptDur(S.rSegs));
    renderDrive();
    var st = removedAt(rvP.getT(), S.rSegs); if (st) rvP.setT(st.b); else rvP.onTick(rvP.getT());
    S.pubErr = ""; updateRender();
    renderReviewStatus();
  }
  $("#rPlay").addEventListener("click", noFocus(function () { rvP.toggle(); }));
  function fullScreen() {
    var st = $("#rvStage");
    var fsEl = document.fullscreenElement || document.webkitFullscreenElement;
    if (fsEl) { (document.exitFullscreen || document.webkitExitFullscreen).call(document); return; }
    if (st.requestFullscreen) st.requestFullscreen().catch(function () {});
    else if (st.webkitRequestFullscreen) st.webkitRequestFullscreen();
    else if (rvid.webkitEnterFullscreen && !S.demo) rvid.webkitEnterFullscreen(); // iPhone: the phone's own player
  }
  $("#rFull").addEventListener("click", noFocus(fullScreen));
  ["fullscreenchange", "webkitfullscreenchange"].forEach(function (ev) {
    document.addEventListener(ev, function () {
      var on = !!(document.fullscreenElement || document.webkitFullscreenElement);
      $("#rFull").setAttribute("aria-label", on ? "Exit full screen" : "Full screen");
      $("#rFull").innerHTML = on ? FS_EXIT : FS_ENTER;
    });
  });
  $("#rBar").addEventListener("click", function (e) {
    if (!S.dur) return;
    var r = $("#rBar").getBoundingClientRect(), t = (e.clientX - r.left) / r.width * S.dur;
    var s = removedAt(t, S.rSegs); rvP.setT(s ? s.b : t);
  });
  $("#revBack").addEventListener("click", function () { show("details"); });
  $("#openEditor").addEventListener("click", function () { show("edit"); });
  function published(liveUrl) {
    S.published = true;
    if (S.d.web === false) {
      var vl = S.msg && S.msg.render && S.msg.render.vimeoLink;
      $("#doneTitle").textContent = "Saved to Vimeo";
      $("#doneSub").textContent = title() + (vl ? " is on Vimeo at " + vl.replace(/^https?:\/\//, "") : " is on Vimeo") + ". It wasn't posted to the website.";
    } else {
      $("#doneTitle").textContent = "Published to " + S.d.coll + " Messages";
      $("#doneSub").textContent = title() + " is live at " + (liveUrl || ("sentlifecenter.com/" + COLL_SLUG[S.d.coll] + "/" + slug()));
    }
    $("#doneFine").hidden = !S.demo;
    show("done");
  }
  $("#publishBtn").addEventListener("click", function () {
    if (S.demo) { published(); return; }
    S.publishing = true; renderReviewStatus();
    api("POST", "/messages/" + S.msg.id + "/publish").then(function (v) {
      S.publishing = false; mergeView(v); S.d = v.d;
      published(v.webflow && v.webflow.liveUrl);
      refreshList();
    }, function (e) {
      S.publishing = false; renderReviewStatus();
      S.pubErr = msgOf(e); var rb = $("#revBanner"); rb.hidden = false; rb.textContent = S.pubErr;
    });
  });
  $("#newPost").addEventListener("click", function () { resetEdit(); S.d = null; S.notes = []; S.demo = false; show("upload"); });

  /* ---------- Start ---------- */
  api("GET", "/config").then(function (c) {
    CLIENT_ID = c.clientId || "";
    if (c.user) { S.user = c.user; afterSignin(); }
    else { showSignin(); if (!gRendered) renderGoogleButton(CLIENT_ID); }
  }, function () { showSignin("Couldn't reach Message Desk. Check your connection and reload."); });
  // Prepare the preview helper early so reopening a post from another computer is quick
  if ("serviceWorker" in navigator) serviceWorker().catch(function () {});
})();
