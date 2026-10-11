// @ts-check
/* ============================================================================
   MapUnite advice — wiring the safety gate and speed advice into the app (Step 8)
   ==============================================================================
   Owns:
     - the one live gate (MUAdvice.live.gate). js/voice.js asks it before every
       cue: MUAdvice.live.allowVoice(text, opts) → false = held back;
     - road conditions while riding: Open-Meteo at the start of a ride, then every
       10 min or 8 km; a turn for the worse is spoken once (a "warning", so quiet
       ride shows it without speaking);
     - the speed-advice badge (#advice-overlay) above the limit sign;
     - the settings (#advice-section) and the HUD's quiet switch ("mu:advice-set");
     - "mu:advice" { advised m/s|null, text, quiet, condition } for the HUD.

   Reads (events): "mu:fix" (speed, GPS confidence), "mu:speed-limit",
   "mu:drive-state". Reads (globals, guarded): myCoords, voiceAnnounce,
   islandShow, safeShow. Stored on the phone only: mu.advice.v1.
   ============================================================================ */
(function (root) {
    "use strict";
    const W = /** @type {any} */ (root);
    if (!W.document) return;
    const A = W.MUAdvice;
    if (!A || !A.gate || !A.conditions || !A.overlay) { console.warn("[advice] load js/advice/gate.js, conditions.js and overlay.js before advice-app.js"); return; }
    const C = A.conditions;
    const $ = (id) => document.getElementById(id);
    const KEY = "mu.advice.v1";
    const WEATHER_EVERY_MS = 10 * 60 * 1000, WEATHER_MOVE_M = 8000, RENDER_MS = 1000, OVER_ADVICE_HOLD_MS = 8000;

    /** @returns {{ quiet: boolean, keepNav: boolean, weather: boolean, overlay: boolean, askFirst: boolean }} */
    function loadPrefs() {
        const d = { quiet: false, keepNav: true, weather: true, overlay: true, askFirst: true };
        try { const o = JSON.parse(localStorage.getItem(KEY) || "{}"); for (const k of Object.keys(d)) if (typeof o[k] === "boolean") /** @type {any} */ (d)[k] = o[k]; } catch { /* defaults */ }
        return d;
    }
    const prefs = loadPrefs();
    const save = () => { try { localStorage.setItem(KEY, JSON.stringify(prefs)); } catch { /* storage blocked */ } };

    const gate = A.gate.createGate();
    gate.setQuiet(prefs.quiet); gate.setKeepNav(prefs.keepNav); gate.setAskFirst(prefs.askFirst);
    const tracker = C.createTracker();
    const weather = C.createWeather();

    /** @type {any} */ let condition = null;
    let limit = null, speed = null, conf = 1, driving = false, lastV = null, lastT = null;
    let lastWeatherAt = 0, /** @type {{lat:number,lng:number}|null} */ lastWeatherPos = null, overAdvSince = null, tick = null, lastRender = 0, lastEmit = "", trailing = null;
    /** @type {any} */ let overlay = null;

    // ---------------------------------------------------------------- globals (classic scripts, guarded)
    function g() {
        /** @type {any} */ const o = {};
        // @ts-ignore
        try { o.myCoords = typeof myCoords !== "undefined" ? myCoords : null; } catch { o.myCoords = null; }
        // @ts-ignore
        try { o.voiceAnnounce = typeof voiceAnnounce === "function" ? voiceAnnounce : null; } catch { o.voiceAnnounce = null; }
        // @ts-ignore
        try { o.islandShow = typeof islandShow === "function" ? islandShow : null; } catch { o.islandShow = null; }
        // @ts-ignore
        try { o.safeShow = typeof safeShow === "function" ? safeShow : null; } catch { o.safeShow = null; }
        o.mode = W.currentTravelMode || "bike";
        return o;
    }

    // ---------------------------------------------------------------- the voice hook (js/voice.js)
    /** @param {string} text @param {any} opts @returns {boolean} spoken? */
    function allowVoice(text, opts) {
        const d = gate.decide({ text, ...(opts || {}) }, Date.now());
        if (!d.speak) renderStatus();
        return d.speak;
    }
    /** The full decision, including ask (voice.js asks "Bhai, ek baat bolun?" first). @param {string} text @param {any} opts */
    function decide(text, opts) {
        const d = gate.decide({ text, ...(opts || {}) }, Date.now());
        if (!d.speak) renderStatus();
        return d;
    }
    /** How the rider answered a question. @param {string} category @param {any} answer */
    function noteAnswer(category, answer) {
        const r = gate.noteAnswer(category, answer, Date.now());
        renderStatus();
        return r;
    }

    // ---------------------------------------------------------------- settings
    /** @param {"quiet"|"keepNav"|"weather"|"overlay"|"askFirst"} key @param {boolean} on */
    function set(key, on) {
        if (!(key in prefs) || prefs[key] === Boolean(on)) { syncToggles(); return; }
        prefs[key] = Boolean(on);
        save();
        if (key === "quiet") {
            gate.setQuiet(prefs.quiet);
            const G = g();
            if (G.islandShow) G.islandShow({ id: "quiet-ride", kind: "info", icon: prefs.quiet ? "🔕" : "🔔", title: prefs.quiet ? "Quiet ride on" : "Quiet ride off", sub: prefs.quiet ? "Only safety warnings are spoken" : "Tips and directions are spoken again", ttl: 3500, haptic: false });
        }
        if (key === "keepNav") gate.setKeepNav(prefs.keepNav);
        if (key === "askFirst") gate.setAskFirst(prefs.askFirst);
        if (key === "weather") {
            if (!prefs.weather) { condition = null; gate.setCondition(null); }
            else if (driving) refreshWeather(true);
        }
        syncToggles();
        render(true);
        renderStatus();
    }
    function syncToggles() {
        const map = { "quiet-ride-toggle": "quiet", "quiet-keep-nav-toggle": "keepNav", "weather-alerts-toggle": "weather", "speed-advice-toggle": "overlay", "ask-first-toggle": "askFirst" };
        for (const [id, k] of Object.entries(map)) { const el = /** @type {HTMLInputElement|null} */ ($(id)); if (el) el.checked = /** @type {any} */ (prefs)[k]; }
        const kn = /** @type {HTMLInputElement|null} */ ($("quiet-keep-nav-toggle"));
        if (kn) { kn.disabled = !prefs.quiet; const row = kn.closest(".modal-row"); if (row) row.classList.toggle("is-disabled", !prefs.quiet); }
    }
    function bindSettings() {
        const map = { "quiet-ride-toggle": "quiet", "quiet-keep-nav-toggle": "keepNav", "weather-alerts-toggle": "weather", "speed-advice-toggle": "overlay", "ask-first-toggle": "askFirst" };
        for (const [id, k] of Object.entries(map)) {
            const el = /** @type {HTMLInputElement|null} */ ($(id));
            if (el) el.addEventListener("change", () => set(/** @type {any} */ (k), el.checked));
        }
        syncToggles();
        renderStatus();
    }
    function renderStatus() {
        const st = $("advice-status"), held = $("advice-held");
        const m = gate.mode(Date.now());
        if (st) {
            const road = !prefs.weather ? "Weather alerts are off." : condition && condition.kind !== "unknown" ? `Road: ${condition.label.toLowerCase()} (${condition.detail}).` : "Road conditions are checked when a ride starts.";
            st.textContent = `${m.label}. ${road}`;
            st.dataset.mode = m.key;
        }
        if (held) {
            const t = [A.gate.heldSummary(gate.state.held), A.gate.askSummary ? A.gate.askSummary(gate.state.asks) : ""].filter(Boolean).join(" ");
            held.textContent = t; held.hidden = !t;
        }
    }

    // ---------------------------------------------------------------- weather
    function distanceM(a, b) {
        const R = 6371008.8, rad = Math.PI / 180;
        const dLat = (b.lat - a.lat) * rad, dLng = (b.lng - a.lng) * rad;
        const x = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLng / 2) ** 2;
        return 2 * R * Math.asin(Math.min(1, Math.sqrt(x)));
    }
    /** @param {boolean} [force] */
    async function refreshWeather(force = false) {
        if (!prefs.weather) return;
        const p = g().myCoords;
        if (!p || !Number.isFinite(p.lat) || !Number.isFinite(p.lng)) return;
        const now = Date.now();
        const moved = lastWeatherPos ? distanceM(lastWeatherPos, p) : Infinity;
        if (!force && now - lastWeatherAt < WEATHER_EVERY_MS && moved < WEATHER_MOVE_M) return;
        lastWeatherAt = now; lastWeatherPos = { lat: p.lat, lng: p.lng };
        const r = await weather.get(p.lat, p.lng, now);
        if (!prefs.weather) return;
        const u = tracker.update(r.condition, Date.now());
        condition = u.condition;
        gate.setCondition(condition && condition.kind !== "unknown" ? condition : null);
        if (u.worsened && driving && condition.severity > 0 && condition.kind !== "drying") announceCondition(condition);
        render(true);
        renderStatus();
    }
    const SAY = {
        wet: "Wet roads around you. Ease off and leave more space.",
        heavy: "Heavy rain. Slow down and use your lights.",
        fog: "Fog around you. Lights on, and slow down.",
        storm: "Thunderstorm nearby. Think about a safe place to stop.",
        ice: "Roads may be icy. Ride gently, especially on bridges.",
        wind: "Strong gusts. Slow down and keep a loose grip."
    };
    function announceCondition(c) {
        const G = g();
        const text = /** @type {any} */ (SAY)[c.kind];
        if (!text) return;
        if (G.voiceAnnounce) G.voiceAnnounce(text, { priority: c.severity >= 2 ? 66 : 60, category: "weather", key: `wx-${c.kind}`, cooldownMs: 20 * 60 * 1000, drivingOnly: true, maxAgeMs: 8000 });
        if (G.islandShow) G.islandShow({ id: "weather", kind: "info", icon: c.kind === "fog" ? "🌫️" : c.kind === "wind" ? "💨" : c.kind === "ice" ? "🧊" : "🌧️", title: c.label, sub: c.detail, ttl: 6000, haptic: false });
    }

    // ---------------------------------------------------------------- the badge + the HUD feed
    function anchorRect() {
        for (const id of ["speed-limit-sign", "speed-dial"]) {
            const el = $(id);
            if (!el || el.hidden) continue;
            const cs = getComputedStyle(el);
            if (cs.display === "none" || cs.visibility === "hidden") continue;
            const r = el.getBoundingClientRect();
            if (r.height > 0) return { left: r.left, top: r.top, width: r.width };
        }
        return null;
    }
    function ensureOverlay() {
        if (overlay) return overlay;
        const el = $("advice-overlay");
        if (!el || !W.MUGarage || !W.MUGarage.units) return null;
        overlay = A.overlay.createOverlay(el, {
            units: W.MUGarage.units,
            onToggle: (k, on) => set(k === "quiet" ? "quiet" : "weather", on),
            onOpenSettings: () => {
                const G = g();
                if (G.safeShow) G.safeShow("profile-settings-modal", "flex");
                setTimeout(() => { const s = $("advice-section"); if (s) s.scrollIntoView({ block: "start", behavior: "smooth" }); }, 60);
            }
        });
        return overlay;
    }
    /** @param {boolean} [force] */
    function render(force = false) {
        const now = Date.now();
        if (!force && now - lastRender < RENDER_MS) {
            // throttled: one trailing render so the badge never shows a stale speed
            if (!trailing) trailing = setTimeout(() => { trailing = null; render(true); }, RENDER_MS - (now - lastRender));
            return;
        }
        if (trailing) { clearTimeout(trailing); trailing = null; }
        lastRender = now;
        const cond = prefs.weather ? condition : null;
        const a = C.advise({ limit, condition: cond, speed, confidence: conf });
        const ov = ensureOverlay();
        if (ov) {
            if (!driving || !prefs.overlay) ov.hide();
            else {
                ov.update(C.overlayModel({ limit, condition: cond, speed, confidence: conf, quiet: prefs.quiet }), { quiet: prefs.quiet, weather: prefs.weather, mode: gate.mode(now) });
                ov.place(anchorRect());
            }
        }
        // spoken nudge when clearly over the advised speed for a while (advice level: quiet ride holds it)
        if (driving && a.overAdvised > 0) {
            if (overAdvSince === null) overAdvSince = now;
            else if (now - overAdvSince >= OVER_ADVICE_HOLD_MS && cond) {
                const G = g();
                if (G.voiceAnnounce) G.voiceAnnounce(`${cond.label}. Advised speed ${Math.round(/** @type {number} */ (a.advised) * 3.6)}.`, { priority: 45, category: "weather", key: "wx-advised", cooldownMs: 180000, drivingOnly: true, maxAgeMs: 5000 });
                overAdvSince = now;
            }
        } else overAdvSince = null;
        emit(a, cond);
    }
    function emit(a, cond) {
        const sev = cond && cond.severity > 0 ? cond : null;
        const text = sev ? (a.advised ? `${sev.label} · advised ${Math.round(a.advised * 3.6)} km/h` : `${sev.label} · ease off, leave more space`) : "";
        const detail = { advised: sev ? a.advised : null, text, quiet: prefs.quiet, condition: sev ? { kind: sev.kind, label: sev.label, severity: sev.severity } : null };
        const key = JSON.stringify(detail);
        if (key === lastEmit) return;
        lastEmit = key;
        document.dispatchEvent(new CustomEvent("mu:advice", { detail }));
    }

    // ---------------------------------------------------------------- events
    function onFix(e) {
        const f = /** @type {CustomEvent} */ (e).detail || {};
        const t = Number.isFinite(f.t) ? f.t : Date.now();
        const v = Number.isFinite(f.smoothedKmh) ? f.smoothedKmh / 3.6 : null;
        const c = Number.isFinite(f.confidence) ? f.confidence : 1;
        conf = f.accepted === false ? Math.min(c, 0.59) : c;
        gate.setConfidence(conf);
        if (v !== null && f.accepted !== false) {
            // a hard brake (≤ −3.5 m/s² between two fixes 0.5–3 s apart) opens the busy window
            if (lastV !== null && lastT !== null) { const dt = (t - lastT) / 1000; if (dt >= 0.5 && dt <= 3 && (v - lastV) / dt <= -3.5) gate.noteHarsh(t); }
            lastV = v; lastT = t; speed = v;
        }
        if (driving) render();
    }
    function onDriveState(e) {
        const d = /** @type {CustomEvent} */ (e).detail || {};
        const on = Boolean(d.driving || d.navigating) && g().mode !== "walk";
        if (on === driving) return;
        driving = on;
        if (on) {
            gate.resetRide();
            refreshWeather(true);
            clearInterval(tick);
            tick = setInterval(() => { refreshWeather(false); render(true); renderStatus(); }, 60000);
        } else {
            clearInterval(tick); tick = null;
            overAdvSince = null;
        }
        render(true);
        renderStatus();
    }

    function init() {
        bindSettings();
        document.addEventListener("mu:fix", onFix);
        document.addEventListener("mu:speed-limit", (e) => { const d = /** @type {CustomEvent} */ (e).detail || {}; limit = Number.isFinite(d.limit) && d.limit > 0 ? d.limit / 3.6 : null; render(true); });
        document.addEventListener("mu:drive-state", onDriveState);
        document.addEventListener("mu:advice-set", (e) => { const d = /** @type {CustomEvent} */ (e).detail || {}; if (typeof d.quiet === "boolean") set("quiet", d.quiet); });
        window.addEventListener("resize", () => render(true));
        const sm = $("profile-settings-modal");
        if (sm) new MutationObserver(() => renderStatus()).observe(sm, { attributes: true, attributeFilter: ["style", "class"] });
        // tell the HUD the starting state (quiet ride survives reloads)
        render(true);
    }
    if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init); else init();

    A.live = {
        gate, allowVoice, decide, noteAnswer, set, refreshWeather,
        get prefs() { return { ...prefs }; },
        get condition() { return condition; },
        get driving() { return driving; },
        /** Test hook: feed a weather reading without the network. @param {any} w SI weather */
        _applyWeather(w) { const u = tracker.update(C.classify(w), Date.now()); condition = u.condition; gate.setCondition(condition.kind !== "unknown" ? condition : null); if (u.worsened && driving && condition.severity > 0 && condition.kind !== "drying") announceCondition(condition); render(true); renderStatus(); }
    };
})(typeof globalThis !== "undefined" ? globalThis : this);
