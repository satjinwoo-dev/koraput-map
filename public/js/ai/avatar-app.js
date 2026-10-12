/*
  avatar-app.js : the Master AI's face on the map screen
  ==========================================================================
  Puts the particle core (ai-particle-core.js, unchanged) on the app:

    corner view   a small floating window on the map (default). Drag it to the
                  other side or up and down; tap it (or the Master AI button in
                  the map tools) for the full screen.
    full screen   the map is hidden and the Master's face and body take the whole
                  screen, with the mountain range behind (avatar-ridges.js), the
                  line being spoken as a caption, a Talk button, and while a
                  drive is on, the next turn and the speed.

  The face follows the app (avatar-state.js decides; this file only listens):
    js/voice.js       "mu:voice-state"   a line starts / ends → speaking (level moves the brain)
                      "mu:mic-state"     the mic opens for an answer or a command → listening
    the Master bus    master.delegated / master.task-done → thinking
                      master.decision (critical / warning delivered) → alert + a pulse
                      "mu:master-say"    → the caption (English on screen, like the island)

  No DOM ids of the app are touched; everything here lives under #mu-avatar.
  Settings stay on the phone (localStorage "mu.avatar.v1": corner view on/off, side, height).
  window.MUAvatar.live gives the console a handle: .core, .open(), .close(), .state.snapshot().
*/

import { createAIMasterCore } from "./ai-particle-core.js";
import { createRidgeLayer } from "./avatar-ridges.js";

const W = window;
const doc = document;
const $ = (id) => doc.getElementById(id);
const KEY = "mu.avatar.v1";
const LABEL = { idle: "Online", listening: "Listening…", thinking: "Thinking…", speaking: "Speaking", alert: "Alert" };

function loadPrefs() {
  const d = { pip: true, side: "left", y: null };
  try { const v = JSON.parse(localStorage.getItem(KEY) || "null"); if (v && typeof v === "object") return { ...d, ...v }; } catch (e) { /* private mode */ }
  return d;
}
const prefs = loadPrefs();
const savePrefs = () => { try { localStorage.setItem(KEY, JSON.stringify(prefs)); } catch (e) { /* storage full / private mode */ } };

function webglOk() {
  try { const c = doc.createElement("canvas"); return Boolean(c.getContext("webgl2") || c.getContext("webgl")); } catch (e) { return false; }
}

function boot() {
  const root = $("mu-avatar"), canvas = $("ai-master-core"), S = W.MUAvatar && W.MUAvatar.state;
  if (!root || !canvas || !S) return;
  // #mu-avatar and its button start hidden in index.html: they appear only once the face really runs
  // (no WebGL, or Three.js not loaded: this module never gets here, and nothing covers the map)
  const openBtn = $("avatar-open-btn");
  if (!webglOk()) { console.warn("[avatar] WebGL unavailable: the Master AI's face is off"); return; }

  // ---- the core: as many particles as the full screen would get on this phone (the demo's rule) ----
  const small = Math.min(W.innerWidth, W.innerHeight) < 600;
  let core;
  try {
    core = createAIMasterCore(canvas, {
      count: small ? 16000 : 30000,
      onReady: () => root.classList.add("is-ready")
    });
  } catch (e) {
    console.warn("[avatar] the particle core failed to start:", e);
    return;
  }
  const ridges = createRidgeLayer();
  ridges.setVisible(false);
  core.addLayer(ridges);

  // ---- state → core ----
  const st = S.createAvatarState();
  let shown = "";
  let timer = 0;
  const stateEl = $("mu-avatar-state");
  function apply() {
    const now = Date.now();
    const m = st.mode(now);
    if (m !== shown) {
      shown = m;
      core.setMode(m);
      root.dataset.mode = m;
      if (stateEl) stateEl.textContent = LABEL[m] || m;
    }
    clearTimeout(timer);
    const next = st.nextChange(now);
    if (Number.isFinite(next)) timer = setTimeout(apply, Math.max(30, next - now + 5));
    levelLoop();
  }
  function feed(ev) {
    const r = st.handle(ev, Date.now());
    if (r.pulse) core.pulse(r.pulse);
    apply();
  }

  // the voice level: a speech rhythm while a line plays (see speechLevel), and the
  // premium voice's route (still fetching → thinking, then speaking)
  let levelTick = 0, lineStart = 0, lastRoute = "";
  function levelLoop() {
    const live = st.snapshot().speaking;
    if (live && !levelTick) {
      lineStart = performance.now();
      levelTick = setInterval(() => {
        const cur = W.VoiceAssistant && W.VoiceAssistant.current;
        const route = cur && cur.handle && typeof cur.handle.route === "string" ? cur.handle.route : "";
        if (route && route !== lastRoute) { lastRoute = route; feed({ type: "voice", phase: "route", route }); }
        if (st.speaking) core.setLevel(S.speechLevel(performance.now() - lineStart));
      }, 90);
    } else if (!live && levelTick) { clearInterval(levelTick); levelTick = 0; lastRoute = ""; core.setLevel(0); }
  }

  doc.addEventListener("mu:voice-state", (e) => {
    const d = e.detail || {};
    if (d.phase === "start") { lastRoute = d.route || ""; lineStart = performance.now(); }
    feed({ type: "voice", phase: d.phase, priority: d.priority, route: d.route });
  });
  doc.addEventListener("mu:mic-state", (e) => { const d = e.detail || {}; feed({ type: "mic", on: Boolean(d.on), mode: d.mode }); });

  // the Master's bus (master-app.js has run: classic scripts finish before this module)
  let busWired = false;
  function wireBus() {
    const live = W.MUMaster && W.MUMaster.live;
    if (busWired || !live || !live.bus) return;
    busWired = true;
    const own = { owner: "avatar" };
    live.bus.subscribe("master.delegated", (d) => feed({ type: "task", phase: "start", task: d && d.task }), own);
    live.bus.subscribe("master.task-done", (d) => feed({ type: "task", phase: "end", task: d && d.task }), own);
    live.bus.subscribe("master.decision", (d) => feed({ type: "decision", severity: d && d.severity, kind: d && d.kind, action: d && d.action }), own);
  }
  wireBus();
  doc.addEventListener("mu:master-ready", wireBus);

  // ---- caption (full screen): the Master's latest line, English as on the island ----
  const caption = $("mu-avatar-caption");
  let captionTimer = 0;
  doc.addEventListener("mu:master-say", (e) => {
    const d = e.detail || {};
    if (!caption || d.severity === "info") return;
    const disp = d.display || {};
    const text = [disp.title, disp.sub].filter(Boolean).join(" · ") || "";
    if (!text) return;
    caption.textContent = text;
    caption.dataset.severity = d.severity || "advice";
    caption.hidden = false;
    clearTimeout(captionTimer);
    captionTimer = setTimeout(() => { caption.hidden = true; }, 12000);
  });

  // ---- corner view ↔ full screen ----
  const pipBtn = $("mu-avatar-pip-btn"), closeBtn = $("mu-avatar-close"), talkBtn = $("mu-avatar-talk"), pipToggle = $("mu-avatar-pip-toggle");
  let full = false;
  function syncVisibility() {
    root.hidden = !full && !prefs.pip;
    if (root.hidden) core.pause(); else core.resume();
    if (pipToggle) pipToggle.setAttribute("aria-pressed", String(Boolean(prefs.pip)));
  }
  function open() {
    if (full) return;
    full = true;
    root.classList.remove("is-pip");
    root.classList.add("is-full");
    root.setAttribute("role", "dialog");
    root.setAttribute("aria-modal", "true");
    root.setAttribute("aria-label", "Master AI");
    doc.body.classList.add("mu-avatar-full");
    ridges.setVisible(true);
    syncVisibility();
    navMirror(true);
    try { if (!(history.state && history.state.muAvatar)) history.pushState({ muAvatar: 1 }, ""); } catch (e) { /* sandboxed */ }
    (closeBtn || root).focus({ preventScroll: true });
  }
  function close(fromHistory = false) {
    if (!full) return;
    full = false;
    root.classList.remove("is-full");
    root.classList.add("is-pip");
    root.removeAttribute("role");
    root.removeAttribute("aria-modal");
    root.removeAttribute("aria-label");
    doc.body.classList.remove("mu-avatar-full");
    ridges.setVisible(false);
    navMirror(false);
    syncVisibility();
    if (!fromHistory) { try { if (history.state && history.state.muAvatar) history.back(); } catch (e) { /* sandboxed */ } }
    if (openBtn && root.hidden) openBtn.focus({ preventScroll: true });
  }
  W.addEventListener("popstate", () => { if (full) close(true); });
  doc.addEventListener("keydown", (e) => { if (full && e.key === "Escape") { e.preventDefault(); close(); } });
  if (closeBtn) closeBtn.addEventListener("click", () => close());
  if (openBtn) openBtn.addEventListener("click", () => open());
  if (talkBtn) talkBtn.addEventListener("click", () => {
    const VA = W.VoiceAssistant;
    if (VA && typeof VA.togglePushToTalk === "function") VA.togglePushToTalk();
  });
  if (pipToggle) pipToggle.addEventListener("click", () => { prefs.pip = !prefs.pip; savePrefs(); syncVisibility(); });

  // ---- drag the corner view (snaps to the nearer side; a tap opens the full screen) ----
  function placePip() {
    root.dataset.side = prefs.side === "right" ? "right" : "left";
    if (Number.isFinite(prefs.y)) root.style.setProperty("--mu-avatar-y", `${Math.round(prefs.y * 1000) / 10}%`);
    else root.style.removeProperty("--mu-avatar-y");
  }
  placePip();
  if (pipBtn) {
    let drag = null, suppressClick = false;
    pipBtn.addEventListener("pointerdown", (e) => {
      if (full || e.button > 0) return;
      const r = root.getBoundingClientRect();
      drag = { id: e.pointerId, x0: e.clientX, y0: e.clientY, dx: e.clientX - r.left, dy: e.clientY - r.top, moved: false };
      try { pipBtn.setPointerCapture(e.pointerId); } catch (err) { /* old WebView */ }
    });
    pipBtn.addEventListener("pointermove", (e) => {
      if (!drag || e.pointerId !== drag.id) return;
      if (!drag.moved && Math.hypot(e.clientX - drag.x0, e.clientY - drag.y0) < 8) return;
      drag.moved = true;
      root.classList.add("is-dragging");
      root.style.left = `${e.clientX - drag.dx}px`;
      root.style.top = `${e.clientY - drag.dy}px`;
      root.style.right = "auto";
    });
    const end = (e) => {
      if (!drag || e.pointerId !== drag.id) return;
      const wasDrag = drag.moved;
      drag = null;
      if (!wasDrag) return;
      const r = root.getBoundingClientRect();
      prefs.side = r.left + r.width / 2 > W.innerWidth / 2 ? "right" : "left";
      prefs.y = Math.min(1, Math.max(0, r.top / W.innerHeight));
      savePrefs();
      root.classList.remove("is-dragging");
      root.style.left = root.style.top = root.style.right = "";
      placePip();
      suppressClick = true;
      setTimeout(() => { suppressClick = false; }, 0);
    };
    pipBtn.addEventListener("pointerup", end);
    pipBtn.addEventListener("pointercancel", end);
    pipBtn.addEventListener("click", () => { if (!suppressClick && !full) open(); });
  }

  // ---- full screen during a drive: the next turn and the speed stay in view ----
  const navBox = $("mu-avatar-nav");
  let navTimer = 0;
  function navMirror(on) {
    clearInterval(navTimer);
    if (!navBox) return;
    if (!on) { navBox.hidden = true; return; }
    const tick = () => {
      const ui = $("premium-nav-ui");
      const driving = Boolean(ui && getComputedStyle(ui).display !== "none");
      navBox.hidden = !driving;
      if (!driving) return;
      const txt = (id) => { const el = $(id); return el ? el.textContent.trim() : ""; };
      const turn = $("mu-avatar-nav-turn"), speed = $("mu-avatar-nav-speed");
      if (turn) turn.textContent = [txt("turn-dist"), txt("turn-name")].filter(Boolean).join(" · ");
      if (speed) speed.textContent = txt("speed-n") || "0";
    };
    tick();
    navTimer = setInterval(tick, 500);
  }

  syncVisibility();
  if (openBtn) openBtn.hidden = false;
  apply();
  W.MUAvatar.live = { core, ridges, state: st, open, close: () => close(), get full() { return full; } };
  doc.dispatchEvent(new CustomEvent("mu:avatar-ready"));
}

if (doc.readyState === "loading") doc.addEventListener("DOMContentLoaded", boot); else boot();
