// @ts-check
/* ============================================================================
   MapUnite Master AI — Weather agent ("weather"): storms, rain, heat, dust ahead
   ==============================================================================
   Reads state.corridor (agents/corridor-agent.js), asks our server
   (/api/master/weather → Open-Meteo, keyless; lib/master/weather.js does the
   hazard classification) for points every 400 m along the 2 km ahead, and
   reports what CHANGES for the rider:

     weather.<type>   storm · heavy-rain · freezing → warning
                      rain · drizzle · fog · wind · heat · cold · dust · dry · rain-soon → advice
                      (fog, wind, heat, dust escalate to warning at their thresholds)
     data.distanceM   metres ahead (re-projected onto the corridor NOW, so a late
                      answer never says "2 km" about something 500 m away)
     data.now         set instead when it's already here (≤ 150 m): "abhi" / "Now".
                      Rain, fog, storm, ice and wind that are already HERE are left to the
                      advice module's road-condition voice line (one voice per fact).

   When it asks:  the far end of the corridor moved ≥ requeryM (1 km) since the
                  last answer, or refreshMs (5 min) passed. Model data is 1–11 km
                  resolution: asking more often buys nothing.
   What it says:  each hazard type once while it lasts; again only if it got
                  worse (advice → warning) or went away for ≥ 15 min and came
                  back. At most 2 new hazards per answer, worst first, so a
                  monsoon afternoon isn't a lecture.

   Shares state.weather = { at, here: {…sample at the rider}, hazards: [{ type, level, distanceM }] }.
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

    const geo = () => GEO;
    const SPEAK_ALWAYS = new Set(["storm", "heavy-rain", "freezing"]);    // spoken even when stopped (you're about to ride into it)
    // Weather the rider is already IN is the advice module's job for these (js/advice/advice-ui.js announceCondition,
    // fed by the same road-condition badge): the Master speaks them only AHEAD, so nothing is said twice.
    const HERE_BY_ADVICE = new Set(["rain", "heavy-rain", "drizzle", "fog", "storm", "freezing", "wind"]);
    const RANK = { warning: 2, advice: 1 };

    return {
        id: "weather",
        version: "1.0.0",
        apiVersion: 1,
        description: "Weather and air along the 2 km ahead: storms, rain, fog, wind, heat, dust.",
        requires: ["master-api"],
        depends: ["corridor"],
        runWhen: { topic: "state.corridor", test: (/** @type {any} */ c) => Boolean(c && c.active) },
        defaults: { requeryM: 1000, refreshMs: 300000, stepM: 400, hereM: 150, goneMs: 900000, maxNewPerAnswer: 2, timeoutMs: 9000 },

        /** @param {any} ctx */
        start(ctx) {
            const G = geo();
            const cfg = ctx.config;
            const api = ctx.caps.get("master-api");
            /** @type {any} */ let lastQuery = null;
            let busy = false, failures = 0;
            /** @type {Map<string, { level: string, seenAt: number, saidAt: number }>} */ const known = new Map();
            /** @type {any[]} */ let samples = [];

            function due(/** @type {any} */ c) {
                if (busy) return false;
                if (!lastQuery) return true;
                const end = c.line[c.line.length - 1];
                const backoff = failures ? Math.min(600000, 30000 * 2 ** (failures - 1)) : 0;
                if (ctx.now() - lastQuery.at < backoff) return false;
                return G.metres(end[0], end[1], lastQuery.end[0], lastQuery.end[1]) >= cfg.requeryM || ctx.now() - lastQuery.at >= cfg.refreshMs;
            }

            async function query(/** @type {any} */ c) {
                busy = true;
                const pts = (c.samples || []).filter((/** @type {number[]} */ p, /** @type {number} */ i, /** @type {any[]} */ a) => i === 0 || i === a.length - 1 || p[2] % cfg.stepM === 0).slice(0, 12);
                const end = c.line[c.line.length - 1];
                try {
                    const r = await api.post("/weather", { points: pts.map((/** @type {number[]} */ p) => [Number(p[0].toFixed(5)), Number(p[1].toFixed(5)), p[2]]) }, { timeoutMs: cfg.timeoutMs, signal: ctx.signal });
                    lastQuery = { at: ctx.now(), end };
                    if (!r.ok) { failures++; if (failures === 3) ctx.markDegraded(`weather unavailable (${r.reason || r.status})`); return; }
                    failures = 0;
                    ctx.markDegraded("");
                    samples = r.data.samples.map((/** @type {any} */ s, /** @type {number} */ i) => ({ ...s, lat: pts[i][0], lng: pts[i][1] }));
                    evaluate();
                } finally { busy = false; }
            }

            /** Where each hazard is now, re-projected on the current corridor. */
            function evaluate() {
                const c = ctx.bus.last("state.corridor");
                if (!c || !samples.length) return;
                /** @type {Map<string, { type: string, level: "warning"|"advice", distanceM: number, value: any }>} */ const nearest = new Map();
                for (const s of samples) {
                    const p = c.line.length > 1 ? G.project(s.lat, s.lng, c.line) : { s: G.metres(c.ego.lat, c.ego.lng, s.lat, s.lng), d: 0 };
                    const ahead = p.d > 600 ? null : p.s;               // a sample we've left behind (or off the road now)
                    if (ahead === null) continue;
                    for (const h of s.hazards || []) {
                        const cur = nearest.get(h.type);
                        if (!cur || RANK[/** @type {"warning"|"advice"} */ (h.level)] > RANK[cur.level] || (h.level === cur.level && ahead < cur.distanceM)) nearest.set(h.type, { type: h.type, level: h.level, distanceM: ahead, value: h.value });
                    }
                }
                const t = ctx.now();
                const hazards = [...nearest.values()].sort((a, b) => RANK[b.level] - RANK[a.level] || a.distanceM - b.distanceM);
                const here = samples.reduce((/** @type {any} */ best, /** @type {any} */ s) => (!best || s.sAheadM < best.sAheadM ? s : best), null);
                ctx.setState("weather", { at: t, here: here ? { tempC: here.tempC, feelsC: here.feelsC, rhPct: here.rhPct, precipMmH: here.precipMmH, gustMs: here.gustMs, visibilityM: here.visibilityM, pm10: here.pm10 } : null, hazards: hazards.map((h) => ({ type: h.type, level: h.level, distanceM: Math.round(h.distanceM) })) });

                let told = 0;
                for (const h of hazards) {
                    const k = known.get(h.type);
                    const worse = k && RANK[h.level] > RANK[/** @type {"warning"|"advice"} */ (k.level)];
                    const back = k && t - k.seenAt >= cfg.goneMs;
                    known.set(h.type, { level: worse || !k ? h.level : k.level, seenAt: t, saidAt: k ? k.saidAt : 0 });
                    if (k && !worse && !back) continue;
                    if (told >= cfg.maxNewPerAnswer) continue;
                    if (h.distanceM <= cfg.hereM && HERE_BY_ADVICE.has(h.type)) continue;
                    told++;
                    /** @type {any} */ known.get(h.type).saidAt = t;
                    const isHere = h.distanceM <= cfg.hereM;
                    const data = isHere
                        ? { now: "abhi", type: h.type, value: h.value, screen: { now: "Now" } }
                        : { distanceM: Math.max(200, Math.round(h.distanceM / 100) * 100), type: h.type, value: h.value };
                    ctx.report(`weather.${h.type}`, {
                        severity: h.level, key: `weather.${h.type}`, category: "weather",
                        ridingOnly: !SPEAK_ALWAYS.has(h.type), data,
                        ttlMs: h.level === "warning" ? 90000 : 240000, cooldownMs: h.level === "warning" ? 1200000 : 1800000
                    });
                }
                // hazards that disappeared stay in `known` (seenAt ages) so "came back after 15 min" works
            }

            ctx.bus.subscribe("state.corridor", (/** @type {any} */ c) => {
                if (!c || !c.active) return;
                if (due(c)) query(c);
                else if (samples.length && c.seq % 15 === 0) evaluate();           // keep distances fresh without new requests
            }, { replay: true });
        }
    };
});
