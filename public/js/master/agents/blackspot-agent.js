// @ts-check
/* ============================================================================
   MapUnite Master AI — Blackspot agent ("blackspot"): official accident
   blackspots ahead
   ==============================================================================
   Asks our server (/api/master/blackspots, lib/master/blackspots.js: OFFICIAL
   lists only, imported with their source) for spots along the corridor, and
   warns once per spot, early enough to act on:

     lead distance = speed × 30 s, clamped to 300–1200 m
     (40 km/h → 333 m; 80 km/h → 667 m; 120 km/h → 1000 m)

     blackspot.ahead   warning, priority 72 (80 after dark: most blackspot deaths
                       in India happen at night and on highways)
     data: distanceM, fatalities (only when the list gives it; the phrase
           pack has a line without it), road, source

   Nothing is said inside the zone (too late to help) or for a spot more than
   radius + 100 m off the road. Each spot: once per 30 min.
   Shares state.blackspots = { at, ahead: [{ id, distanceM }] , datasetVersion }.
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

    return {
        id: "blackspot",
        version: "1.0.0",
        apiVersion: 1,
        description: "Warns before official accident blackspots on the road ahead.",
        requires: ["master-api"],
        depends: ["corridor"],
        runWhen: { topic: "state.corridor", test: (/** @type {any} */ c) => Boolean(c && c.active && c.lengthM > 0) },
        defaults: { requeryM: 1000, leadS: 30, minLeadM: 300, maxLeadM: 1200, marginM: 100, repeatMs: 1800000, timeoutMs: 8000 },

        /** @param {any} ctx */
        start(ctx) {
            const G = geo();
            const cfg = ctx.config;
            const api = ctx.caps.get("master-api");
            /** @type {Map<string, any>} */ const spots = new Map();
            /** @type {Map<string, number>} */ const said = new Map();
            /** @type {any} */ let last = null;
            let busy = false, version = "";

            async function refresh(/** @type {any} */ c) {
                busy = true;
                last = { end: c.line[c.line.length - 1], routeId: c.routeId, mode: c.mode };
                try {
                    const r = await api.post("/blackspots", { line: c.line.map((/** @type {number[]} */ p) => [Number(p[0].toFixed(5)), Number(p[1].toFixed(5))]), radiusM: cfg.marginM }, { timeoutMs: cfg.timeoutMs, signal: ctx.signal });
                    if (!r.ok) { last = null; return; }                          // retry on the next update
                    version = r.data.datasetVersion || "";
                    if (version === "empty") ctx.markDegraded("no official blackspot list is loaded on the server");
                    else ctx.markDegraded("");
                    for (const s of r.data.spots || []) spots.set(s.id, s);
                    for (const [id, s] of spots) if (G.metres(c.ego.lat, c.ego.lng, s.lat, s.lng) > 8000) spots.delete(id);
                } finally { busy = false; }
            }

            function evaluate(/** @type {any} */ c) {
                const t = ctx.now();
                const v = Math.max(0, c.ego.speedMs || 0);
                const lead = Math.max(cfg.minLeadM, Math.min(cfg.maxLeadM, v * cfg.leadS));
                const ahead = [];
                for (const s of spots.values()) {
                    const p = G.project(s.lat, s.lng, c.line);
                    if (p.d > s.radiusM + cfg.marginM) continue;
                    const toZone = p.s - s.radiusM / 2;                         // the zone starts before its centre point
                    if (toZone <= 0) continue;
                    ahead.push({ s, distanceM: toZone });
                }
                ahead.sort((a, b) => a.distanceM - b.distanceM);
                ctx.setState("blackspots", { at: t, datasetVersion: version, ahead: ahead.map((a) => ({ id: a.s.id, distanceM: Math.round(a.distanceM) })) });
                const next = ahead.find((a) => a.distanceM >= 80 && a.distanceM <= lead && t - (said.get(a.s.id) || -Infinity) >= cfg.repeatMs);
                if (!next) return;
                said.set(next.s.id, t);
                const dark = ctx.bus.last("state.light") === "dark";
                /** @type {any} */ const data = { distanceM: Math.max(100, Math.round(next.distanceM / 100) * 100), road: next.s.road || undefined, source: next.s.source, spotId: next.s.id };
                if (Number.isFinite(next.s.fatalities) && next.s.fatalities > 0) data.fatalities = next.s.fatalities;
                ctx.report("blackspot.ahead", { severity: "warning", priority: dark ? 80 : 72, key: `blackspot.${next.s.id}`, category: "blackspot", ridingOnly: true, data, ttlMs: Math.max(15000, Math.round((next.distanceM / Math.max(v, 5)) * 1000 * 0.6)), cooldownMs: cfg.repeatMs });
            }

            ctx.bus.subscribe("state.corridor", (/** @type {any} */ c) => {
                if (!c || !c.active || c.line.length < 2) return;
                const end = c.line[c.line.length - 1];
                if (!busy && (!last || last.routeId !== c.routeId || last.mode !== c.mode || G.metres(end[0], end[1], last.end[0], last.end[1]) >= cfg.requeryM)) refresh(c);
                if (spots.size) evaluate(c);
            }, { replay: true });
        }
    };
});
