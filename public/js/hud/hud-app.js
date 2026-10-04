// @ts-check
/* ============================================================================
   MapUnite HUD — wiring the SmartDrive head-up display into the map app
   ==============================================================================
   Shows #smartdrive-hud while a drive is active (not walking) and feeds it:
     - "mu:fix"         every GPS verdict from SmartDrive.tick (speed, distance)
     - "mu:speed-limit" the posted limit (OpenStreetMap) → eco band clamped to it
     - "mu:route"       the route on screen → grade under you (trip-card profile),
                        distance to go (navState.remainingM)
     - "mu:drive-state" start / stop
     - "mu:trip-end"    the finished trip → "mu:ride-summary" for the share card
     - "mu:advice"      Step 8 road conditions: the eco band is clamped to the advised
                        speed too, the dashboard shows it, quiet ride hides info alerts
     Step 9: when the gradient profile (js/gradient/) for this route is ready, the
     grade under you comes from it (bridges and tunnels fixed) instead of the trip card's.
   The bike and settings come from My bike (a typical bike scaled to your km/L if
   none is chosen), the learned correction from the fuel learner (real ÷ physics
   over your tanks), the starting level from the fuel plan / your last full
   fill-up, prices from the trip card. Pitstop alerts: the convoy plan's next
   stop on this route, else your own range vs the distance to go. Spoken once
   through the app's voice (speak()) when it's available.
   ============================================================================ */
(function (root) {
    "use strict";
    const W = /** @type {any} */ (root);
    if (!W.document) return;
    const $ = (id) => document.getElementById(id);
    const UPDATE_MS = 1000, ALERT_MS = 5000;
    let view = null, est = null, starting = null, active = false, limit = null, route = null, lastRender = 0, lastAlertCheck = 0, alertKey = "", dismissedKey = "", meta = {}, lastSummary = null;
    /** Step 8: { advised m/s|null, text, quiet } from js/advice/ */
    let advice = { advised: null, text: "", quiet: false };

    function g() {
        /** @type {any} */ const o = {};
        // @ts-ignore
        try { o.navState = typeof navState !== "undefined" ? navState : null; } catch { o.navState = null; }
        // @ts-ignore
        try { o.speak = typeof speak === "function" ? speak : null; } catch { o.speak = null; }
        // @ts-ignore
        try { o.SmartDrive = typeof SmartDrive !== "undefined" ? SmartDrive : null; } catch { o.SmartDrive = null; }
        // @ts-ignore
        try { o.FuelCurve = typeof FuelCurve !== "undefined" ? FuelCurve : null; } catch { o.FuelCurve = null; }
        // @ts-ignore
        try { o.fuelShape = typeof fuelShape === "function" ? fuelShape : null; } catch { o.fuelShape = null; }
        o.mode = W.currentTravelMode || "bike";
        // core.js declares `const socket` (a classic-script lexical, not on window): read it by name
        // @ts-ignore
        try { o.socketId = typeof socket !== "undefined" && socket && socket.id ? socket.id : "me"; } catch { o.socketId = "me"; }
        return o;
    }

    function ensureView() {
        if (view) return view;
        const el = $("smartdrive-hud");
        if (!el || !W.MUHud || !W.MUHud.view) return null;
        view = W.MUHud.view.createHud(el, {
            units: W.MUGarage.units,
            onFocusChange: () => place(),
            onDismissAlert: () => { dismissedKey = alertKey; },
            // Step 8: the dashboard's quiet-ride switch; js/advice/ owns the setting
            onQuiet: (on) => document.dispatchEvent(new CustomEvent("mu:advice-set", { detail: { quiet: on } }))
        });
        view.setQuiet(advice.quiet);
        return view;
    }

    /** The learned correction: your real fuel ÷ the physics', over your usable tanks (1 when unknown). */
    async function correctionFor(model) {
        const G = g();
        if (!G.FuelCurve || !G.FuelCurve.fit || !G.FuelCurve.fit.ready || model.powertrain === "ev") return 1;
        try {
            if (!W.MUInsights || !W.MUInsights.fuel) await loadScript("js/insights/fuel-insights.js");
            const I = W.MUInsights.fuel;
            const snap = I.snapshotFromLearner(G.FuelCurve, { fuelShape: G.fuelShape || undefined });
            const cmp = I.compare(snap, I.physicsCurve(W.MUPhysics, model));
            return cmp.overall && Number.isFinite(cmp.overall) ? Math.max(0.6, Math.min(1.6, cmp.overall)) : 1;
        } catch { return 1; }
    }
    function loadScript(src) {
        return new Promise((resolve, reject) => {
            if (document.querySelector(`script[data-mu-src="${src}"]`)) return resolve(undefined);
            const s = document.createElement("script");
            s.src = src; s.async = false; s.dataset.muSrc = src;
            s.onload = () => resolve(undefined); s.onerror = () => reject(new Error(src));
            document.head.append(s);
        });
    }

    async function start() {
        if (active || starting) return starting;
        starting = (async () => {
            const v = ensureView();
            if (!v) return;
            const P = W.MUPhysics, T = W.MUTrip;
            let bike = null;
            try { bike = T && T.app ? await T.app.loadBike() : null; } catch { bike = null; }
            let model, name;
            if (bike) { model = P.createBikeModel(bike.bundle, { classDefault: bike.classDefault, settings: bike.settings }); name = bike.name; }
            else {
                const { index } = await T.app.store.catalog();
                const cls = index.classes.find((c) => c.key === "ice_manual.commuter");
                model = P.createBikeModel(await T.app.store.bundle(cls.bundle)); name = `Typical ${cls.title.toLowerCase()}`;
            }
            const ev = model.powertrain === "ev";
            let correction = await correctionFor(model);
            const fromLearner = !!bike && correction !== 1;
            if (!bike) {                                            // no bike: scale the typical one to the rider's stated km/L
                const G = g();
                const stated = G.SmartDrive && Number.isFinite(G.SmartDrive.baseMileage) ? G.SmartDrive.baseMileage : null;
                const pm50 = P.operatingPoint(model, 50 / 3.6, {}).fuelPerMetre;
                if (stated && pm50 > 0) correction = (1 / (stated * 1e6)) / pm50;
            }
            const prefs = T.card && T.card.loadPrefs ? T.card.loadPrefs((() => { try { return localStorage; } catch { return null; } })()) : { fuelPerLitre: null, energyPerKWh: null };
            const priceRider = ev ? (prefs.energyPerKWh ?? 8) : (prefs.fuelPerLitre ?? 100);
            const price = ev ? priceRider / 3.6e6 : priceRider * 1000;
            const capacity = ev ? (model.battery ? (model.battery.usable !== null ? model.battery.usable : model.battery.gross * 0.92) : null)
                : (bike && bike.bundle.chassis && bike.bundle.chassis.fuelTank ? bike.bundle.chassis.fuelTank.v : 0.012);
            let level = null;
            try { const lv = W.MUPitstop && W.MUPitstop.app && W.MUPitstop.app.levelFor ? W.MUPitstop.app.levelFor(model, capacity) : null; level = lv ? lv.share : null; } catch { level = null; }
            const profile = T.app && T.app.card && T.app.card.profile ? T.app.card.profile : null;
            est = W.MUHud.live.createLiveEstimator(P, model, { price, correction, capacity, level, altitude: profile ? profile.zMean : 0 });
            meta = { name, ev, priceUnit: `₹${W.MUGarage.units.num(priceRider, Number.isInteger(priceRider) ? 0 : 1)}/${ev ? "kWh" : "L"}`, priceExample: ev ? prefs.energyPerKWh === null : prefs.fuelPerLitre === null, correction, fromLearner, bikeName: name };
            active = true;
            alertKey = ""; dismissedKey = "";
            v.show();
            place();
        })().finally(() => { starting = null; });
        return starting;
    }
    function stop() {
        active = false;
        if (view) view.hide();
        const el = $("smartdrive-hud"); if (el) el.hidden = true;
    }

    /** Line the strip up with the speed dial (or the bottom of the screen when there isn't one). */
    function place() {
        const el = $("smartdrive-hud"), dial = $("speed-dial");
        if (!el) return;
        const visible = dial && getComputedStyle(dial).display !== "none" && dial.getBoundingClientRect().height > 0;
        el.classList.toggle("is-solo", !visible);
        if (visible) {
            const r = dial.getBoundingClientRect();
            el.style.setProperty("--hud-bottom", `${Math.max(8, window.innerHeight - r.bottom)}px`);
        } else {
            const sheet = $("nav-bottom-sheet");
            const sv = sheet && getComputedStyle(sheet).display !== "none" ? sheet.getBoundingClientRect() : null;
            el.style.setProperty("--hud-bottom", sv && sv.height > 0 ? `${window.innerHeight - sv.top + 10}px` : "calc(16px + var(--safe-b, 0px))");
        }
    }

    /** Where am I on the route, how far to go, and the grade under me. */
    function whereAmI() {
        const G = g();
        const T = W.MUTrip;
        const GR = W.MUGradient && W.MUGradient.app;
        const profile = (GR && GR.current ? GR.current : null) || (T && T.app && T.app.card ? T.app.card.profile : null);
        const remaining = G.navState && Number.isFinite(G.navState.remainingM) ? G.navState.remainingM : null;
        const total = profile ? profile.distance : route ? route.distanceM : null;
        const progress = total !== null && remaining !== null ? Math.max(0, total - remaining) : null;
        let grade = 0;
        if (profile && progress !== null) {
            const S = profile.s;
            let lo = 0, hi = S.length - 1;
            while (hi - lo > 1) { const m = (lo + hi) >> 1; if (S[m] <= progress) lo = m; else hi = m; }
            grade = profile.grade[Math.min(lo, profile.grade.length - 1)] || 0;
        }
        return { progress, remaining, grade };
    }

    function myStops() {
        const app = W.MUPitstop && W.MUPitstop.app;
        const plan = app && app.panel ? app.panel.plan : null;
        if (!plan) return [];
        const me = g().socketId;
        return plan.stops.map((st) => ({ s: st.s, name: st.station ? st.station.name : `around km ${Math.round(st.s / 1000)}`, mine: st.riders.some((r) => r.id === me || r.id === "me") }));
    }

    function onFix(e) {
        if (!active || !est) return;
        const f = /** @type {CustomEvent} */ (e).detail || {};
        if (g().mode === "walk") { stop(); return; }
        const where = whereAmI();
        const s = est.push({ t: Number.isFinite(f.t) ? f.t : Date.now(), v: Number.isFinite(f.smoothedKmh) ? f.smoothedKmh / 3.6 : null, dist: Number.isFinite(f.distKm) ? f.distKm * 1000 : undefined, accepted: f.accepted !== false, grade: where.grade, limit: effectiveLimit() });
        const now = Date.now();
        if (now - lastRender >= UPDATE_MS) {
            lastRender = now;
            view.update(s, { priceUnit: meta.priceUnit, priceExample: meta.priceExample, remaining: where.remaining, matched: !!meta.fromLearner, advised: advice.advised, adviceText: advice.text, limitPosted: limit });
            place();
        }
        if (now - lastAlertCheck >= ALERT_MS) {
            lastAlertCheck = now;
            const a = W.MUHud.live.pitstopAlert({ progress: where.progress, remaining: where.remaining, range: s && s.tank ? s.tank.range : null, stops: myStops() });
            const key = a ? `${a.kind}:${a.level}:${a.name || ""}` : "";
            if (key !== alertKey) {
                alertKey = key;
                // quiet ride: information-only alerts stay off the screen (warnings still show)
                view.setAlert(a && key !== dismissedKey && !(advice.quiet && a.level === "info") ? a : null);
                const t = a ? W.MUHud.view.alertText(a, W.MUGarage.units, meta.ev) : null;
                const G = g();
                if (t && G.speak && (a.level !== "info")) { try { G.speak(`${t.title}. ${t.sub || ""}`, { priority: a.level === "critical" ? 64 : 42, category: "fuel", key: `hud-${a.kind}-${a.level}`, cooldownMs: 300000 }); } catch { /* voice off */ } }
            }
        }
    }

    /** The eco band's ceiling: the posted limit, or the advised speed when the conditions call for less. */
    function effectiveLimit() {
        if (advice.advised && (!limit || advice.advised < limit)) return advice.advised;
        return limit;
    }

    function onTripEnd(e) {
        const d = /** @type {CustomEvent} */ (e).detail || {};
        const s = est ? est.state : null;
        lastSummary = { trip: d, live: s ? s.trip : null, powertrain: s ? s.powertrain : null, correction: meta.fromLearner ? meta.correction : 1, bike: meta.bikeName || null, priceUnit: meta.priceUnit || null, priceExample: !!meta.priceExample };
        document.dispatchEvent(new CustomEvent("mu:ride-summary", { detail: lastSummary }));
        stop();
    }

    function init() {
        document.addEventListener("mu:fix", onFix);
        document.addEventListener("mu:speed-limit", (e) => { const d = /** @type {CustomEvent} */ (e).detail || {}; limit = Number.isFinite(d.limit) && d.limit > 0 ? d.limit / 3.6 : null; });
        document.addEventListener("mu:route", (e) => { route = /** @type {CustomEvent} */ (e).detail || null; });
        document.addEventListener("mu:route-clear", () => { route = null; });
        document.addEventListener("mu:drive-state", (e) => {
            const d = /** @type {CustomEvent} */ (e).detail || {};
            if ((d.driving || d.navigating) && g().mode !== "walk") start();
            else if (!d.driving && !d.navigating) stop();            // a finished trip already sent mu:trip-end; a cancelled one has nothing to share
        });
        document.addEventListener("mu:trip-end", onTripEnd);
        document.addEventListener("mu:advice", (e) => {
            const d = /** @type {CustomEvent} */ (e).detail || {};
            advice = { advised: Number.isFinite(d.advised) && d.advised > 0 ? d.advised : null, text: d.text || "", quiet: Boolean(d.quiet) };
            if (view) view.setQuiet(advice.quiet);
        });
        window.addEventListener("resize", () => { if (active) place(); });
    }
    if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init); else init();
    W.MUHud = W.MUHud || {};
    W.MUHud.app = { start, stop, get state() { return est ? est.state : null; }, get summary() { return lastSummary; } };
})(typeof globalThis !== "undefined" ? globalThis : this);
