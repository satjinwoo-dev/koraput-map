// @ts-check
/* ============================================================================
   MapUnite Master AI — Destination agent ("destination"): how the ARRIVAL will be
   ==============================================================================
   When a route is set, asks our server (/api/master/destination,
   lib/master/safety.js) for an arrival-risk check at the destination at the
   expected arrival time: daylight, the forecast there, official blackspots
   within 3 km, how far the nearest hospital and police station are, and how
   remote the spot is. It is NOT a crime rating (there's no fair, current data
   for that) and the app never calls a place "unsafe": it says what to plan for.

     destination.good      info: kept in the transcript, said only if asked
     destination.care      advice: the most important reason, in the persona's words
     destination.caution   advice: + "leave earlier, share your live location"
     data: destination (name), reason (Hinglish) / screen.reason (English), score

   And once more, contextually: within 5 km of arriving, if it's getting dark
   and the check wasn't "good", the reason is repeated (key destination.arrival).
   task.destination-safety → the last check, for "destination kaisa hai?".
   ETA: the navigation's own ETA when known, else distance at 11 m/s (≈ 40 km/h,
   a realistic Indian average including towns).
   ============================================================================ */
(function (root, factory) {
    // geo.js and phrases-radar.js load before this file (index.html); in Node they're required
    if (typeof module === "object" && module.exports) module.exports = factory(require("../geo.js"), require("../phrases-radar.js"));
    else {
        const M = /** @type {any} */ (root).MUMaster || (/** @type {any} */ (root).MUMaster = {});
        const def = factory(M.geo, M.phrasesRadar);
        if (typeof M.define === "function") M.define(def); else (M._pending || (M._pending = [])).push(def);
    }
})(typeof globalThis !== "undefined" ? globalThis : this, function (/** @type {any} */ GEO, /** @type {any} */ PHRASES) {
    "use strict";

    const words = () => PHRASES.WORDS;

    /** The factor that matters most → its words. @param {any[]} factors @param {any} WD */
    function reasonOf(factors, WD) {
        const worst = [...(factors || [])].sort((a, b) => a.weight - b.weight)[0];
        if (!worst) return null;
        const id = String(worst.id).startsWith("weather") ? "weather" : worst.id;
        return WD.reason[id] || null;
    }

    return {
        id: "destination",
        version: "1.0.0",
        apiVersion: 1,
        description: "Checks what your arrival will be like: light, weather, blackspots, help nearby.",
        requires: ["master-api", "route"],
        optional: ["app-context"],
        defaults: { avgSpeedMs: 11, recheckMs: 1800000, arrivalRemindM: 5000, timeoutMs: 20000 },
        reasonOf,

        /** @param {any} ctx */
        start(ctx) {
            const WD = words();
            const cfg = ctx.config;
            const api = ctx.caps.get("master-api");
            const route = ctx.caps.get("route");
            const app = ctx.caps.get("app-context");
            /** @type {any} */ let last = null;
            let lastKey = "", reminded = false;

            const destName = () => { const s = app ? app.snapshot() : null; return (s && s.destination && s.destination.name) || ""; };

            async function check(/** @type {any} */ r) {
                if (!r || !Array.isArray(r.path) || r.path.length < 2) return;
                const end = r.path[r.path.length - 1];
                const key = `${Number(end[0]).toFixed(3)},${Number(end[1]).toFixed(3)}`;
                if (key === lastKey && last && ctx.now() - last.at < cfg.recheckMs) return;
                lastKey = key; reminded = false;
                const snap = app ? app.snapshot() : null;
                const etaS = snap && snap.destination && Number.isFinite(snap.destination.etaS) ? snap.destination.etaS : Math.round((r.distanceM || 0) / cfg.avgSpeedMs);
                const res = await api.post("/destination", { lat: Number(end[0]), lng: Number(end[1]), etaS }, { timeoutMs: cfg.timeoutMs, signal: ctx.signal });
                if (!res.ok) return;
                last = { at: ctx.now(), key, lat: end[0], lng: end[1], ...res.data };
                ctx.setState("destination", { at: last.at, level: last.level, score: last.score, factors: last.factors, arriveAt: last.arriveAt, partial: last.partial });
                tell("destination");
            }

            function tell(/** @type {string} */ key) {
                if (!last) return;
                const name = destName() || "wahan";
                const reason = reasonOf(last.factors, WD);
                const data = { destination: name, score: last.score, screen: { destination: destName() || "Your destination" } };
                if (last.level === "good" || !reason) { ctx.report("destination.good", { severity: key === "destination" ? "info" : "advice", key, category: "destination", data }); return; }
                ctx.report(`destination.${last.level}`, { severity: "advice", key, category: "destination", data: { ...data, reason: reason.desi, screen: { ...data.screen, reason: reason.plain } }, ttlMs: 600000 });
            }

            ctx.bus.handle("task.destination-safety", () => (last ? { level: last.level, score: last.score, factors: last.factors, facts: last.facts, arriveAt: last.arriveAt } : null));

            const offs = [route.onChange(ctx.wrap((/** @type {any} */ r) => { if (r) check(r); else { last = null; lastKey = ""; } }))];
            ctx.onStop(() => offs.forEach((off) => off()));
            // near the end, at dusk: say it again, once
            ctx.bus.subscribe("state.corridor", (/** @type {any} */ c) => {
                if (!last || reminded || last.level === "good" || !c || !Number.isFinite(c.routeRemainingM) || c.routeRemainingM > cfg.arrivalRemindM) return;
                const light = ctx.bus.last("state.light");
                if (light !== "dusk" && light !== "dark") return;
                reminded = true;
                tell("destination.arrival");
            });
            const r = route.current();
            if (r) check(r);
        }
    };
});
