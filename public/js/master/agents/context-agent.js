// @ts-check
/* ============================================================================
   MapUnite Master AI — Context agent ("context"): what the rider is doing in
   the app, and how they're doing
   ==============================================================================
   The Master's situational awareness. Watches the app's own events
   (capability "app-context") and the other agents' reports, and keeps two
   pieces of shared state that every agent and the brain can read:

   state.user = {
     bike: { title, classKey }, group: { inTrip, size, tripName },
     destination: { name, lat, lng, remainingM, etaS }, place,
     recentSearches: [names, ≤ 10], frequentPlaces: [{ name, count }, ≤ 10],
     sharedToday: n (memories shared), lastTrip: { distanceKm }
   }
   state.affect = { at, irritation 0–1, stress 0–1, reasons: [...] }
     irritation  from what the rider SAYS to the app (after its own voice commands
                 ran): "chup", "bas kar", "mat bol", "irritate", "shut up", "stop it",
                 "pareshan", "dimaag mat kha" … +0.4 each, half-life 10 min. A rider
                 who says "nahi" to two tips in a row also adds +0.15.
     stress      from the ride: hard-braking reports +0.3, a jam ahead +0.2, a
                 weather or road WARNING +0.15, riding after dark +0.1, a big group
                 (≥ 6) +0.05; half-life 5 min.
   cognition.js holds advice back while irritation ≥ 0.6 or stress ≥ 0.75; the
   mood agent picks calmer music when stress ≥ 0.6. Safety warnings are never held.

   Everything stays on the phone (store "context": frequent places only).
   task.context-forget wipes it ("Clear my history").
   This is a heuristic reading of words and events, not emotion recognition
   from the voice's sound; that would need an on-device model and the rider's
   explicit opt-in.
   ============================================================================ */
(function (root, factory) {
    const def = factory();
    if (typeof module === "object" && module.exports) module.exports = def;
    else {
        const M = /** @type {any} */ (root).MUMaster || (/** @type {any} */ (root).MUMaster = {});
        if (typeof M.define === "function") M.define(def); else (M._pending || (M._pending = [])).push(def);
    }
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
    "use strict";

    const IRRITATED = [
        /\bchup\b/, /\bbas kar/, /\bmat bol/, /\bband kar\b/, /\bshut up\b/, /\bstop it\b/, /\bstop talking\b/, /\bbe quiet\b/,
        /\birritat/, /\bpareshan\b/, /\bdimaag mat kha/, /\bdimag mat kha/, /\bannoying\b/, /\bpakka mat\b/, /\bfaltu\b/, /\bbakwas\b/, /\benough\b/
    ];

    /** Exponential decay of a 0–1 level. @param {number} v @param {number} dtMs @param {number} halfLifeMs */
    const decay = (v, dtMs, halfLifeMs) => v * Math.pow(0.5, Math.max(0, dtMs) / halfLifeMs);
    /** @param {string} text */
    const irritationIn = (text) => IRRITATED.filter((re) => re.test(String(text || "").toLowerCase())).length;

    return {
        id: "context",
        version: "1.0.0",
        apiVersion: 1,
        description: "What you're doing in the app (bike, group, destination, searches) and how stressful the ride is.",
        requires: ["app-context"],
        defaults: { irritationHalfLifeMs: 600000, stressHalfLifeMs: 300000, publishEveryMs: 5000 },
        irritationIn,

        /** @param {any} ctx */
        start(ctx) {
            const cfg = ctx.config;
            const app = ctx.caps.get("app-context");
            /** @type {Record<string, number>} */ const frequent = ctx.store.get("frequent", {}) || {};
            /** @type {string[]} */ const searches = [];
            let irritation = 0, stress = 0, last = ctx.now(), sharedToday = 0, shareDay = "", declinesInRow = 0;
            /** @type {any} */ let lastTrip = null;
            /** @type {Map<string, number>} */ const reasons = new Map();

            function age() {
                const t = ctx.now(), dt = t - last;
                irritation = decay(irritation, dt, cfg.irritationHalfLifeMs);
                stress = decay(stress, dt, cfg.stressHalfLifeMs);
                for (const [k, at] of reasons) if (t - at > cfg.stressHalfLifeMs * 3) reasons.delete(k);
                last = t;
            }
            function bump(/** @type {"irritation"|"stress"} */ what, /** @type {number} */ by, /** @type {string} */ why) {
                age();
                if (what === "irritation") irritation = Math.min(1, irritation + by); else stress = Math.min(1, stress + by);
                reasons.set(why, ctx.now());
                shareAffect();
            }
            function shareAffect() {
                ctx.setState("affect", { at: ctx.now(), irritation: Math.round(irritation * 100) / 100, stress: Math.round(stress * 100) / 100, reasons: [...reasons.keys()] });
            }
            function shareUser() {
                const s = app.snapshot();
                const top = Object.entries(frequent).sort((a, b) => b[1] - a[1]).slice(0, 10).map(([name, count]) => ({ name, count }));
                ctx.setState("user", { ...s, recentSearches: searches.slice(-10), frequentPlaces: top, sharedToday, lastTrip });
            }

            const offs = [app.onEvent(ctx.wrap((/** @type {any} */ e) => {
                switch (e.type) {
                    case "place-search":
                    case "destination": {
                        const n = e.detail && e.detail.name;
                        if (n) {
                            if (e.type === "place-search") { searches.push(n); if (searches.length > 20) searches.shift(); }
                            frequent[n] = (frequent[n] || 0) + 1;
                            const keys = Object.keys(frequent);
                            if (keys.length > 100) keys.sort((a, b) => frequent[a] - frequent[b]).slice(0, keys.length - 100).forEach((k) => delete frequent[k]);
                            ctx.store.set("frequent", frequent);
                        }
                        break;
                    }
                    case "memories-changed": {
                        const d = new Date().toDateString();
                        if (d !== shareDay) { shareDay = d; sharedToday = 0; }
                        sharedToday++;
                        break;
                    }
                    case "trip-end": lastTrip = e.detail; break;
                    case "voice-heard": {
                        const n = irritationIn(e.detail && e.detail.text);
                        if (n) bump("irritation", Math.min(0.8, 0.4 * n), "rider-words");
                        break;
                    }
                    default: break;
                }
                shareUser();
            }))];
            ctx.onStop(() => offs.forEach((off) => off()));

            // the ride, through the other agents' reports
            ctx.bus.subscribe("report.**", (/** @type {any} */ r) => {
                if (!r || typeof r.kind !== "string") return;
                if (r.kind === "ride.braking-pattern" || r.kind === "ride.hard-brake-check") bump("stress", 0.3, "hard-braking");
                else if (r.kind === "traffic.jam-ahead" || r.kind === "traffic.closure-ahead") bump("stress", 0.2, "traffic");
                else if (r.severity === "warning" && /^(weather|road|terrain|blackspot)\./.test(r.kind)) bump("stress", 0.15, r.kind.split(".")[0]);
            });
            ctx.bus.subscribe("master.decision", (/** @type {any} */ d) => {
                if (!d) return;
                if (d.action === "declined") { if (++declinesInRow >= 2) { bump("irritation", 0.15, "declined-tips"); declinesInRow = 0; } }
                else if (d.action === "spoken" && d.severity === "advice") declinesInRow = 0;
            });
            ctx.bus.subscribe("state.light", (/** @type {any} */ l) => { const r = ctx.bus.last("state.ride"); if (l === "dark" && r && r.active) bump("stress", 0.1, "night"); });

            ctx.bus.handle("task.context-forget", () => { for (const k of Object.keys(frequent)) delete frequent[k]; searches.length = 0; ctx.store.clear(); shareUser(); return { ok: true }; });

            ctx.timers.setInterval(() => {
                age();
                const s = app.snapshot();
                if (s.group && s.group.size >= 6) { const r = ctx.bus.last("state.ride"); if (r && r.active && !reasons.has("big-group")) bump("stress", 0.05, "big-group"); }
                shareAffect();
                shareUser();
            }, cfg.publishEveryMs);
            shareUser();
            shareAffect();
        }
    };
});
