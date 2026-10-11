// @ts-check
/* ============================================================================
   MapUnite Master AI — Traffic agent ("traffic"): jams and closures ahead
   ==============================================================================
   Live flow (/api/master/traffic → TomTom, key on the server) at points 500,
   1000, 1500 and 2000 m along the corridor, re-asked every 60 s while moving
   or when the far end moved ≥ 300 m. Reports the FIRST problem ahead:

     traffic.closure-ahead   road closed                       warning
     traffic.jam-ahead       ≤ 35 % of free-flow speed         warning while navigating within 1 km, advice otherwise
     traffic.slow-ahead      ≤ 60 %                            advice, only within 1 km
     data: distanceM, delayMin (sum of TomTom's extra travel time ahead, ≥ 1)

   One report per episode: a jam that's still there a minute later is the same
   jam. A new report comes only when it clears for 5 min and a new one starts,
   or it turns into a closure. Nothing is said once the rider is already IN
   it (speed < 3 m/s and the jam is < 200 m away): they know.

   Without TOMTOM_API_KEY on the server the agent goes "degraded" and stays
   quiet; everything else runs.
   Shares state.traffic = { at, segments: [{ distanceM, level, speedMs, freeFlowMs }] }.
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
        id: "traffic",
        version: "1.0.0",
        apiVersion: 1,
        description: "Live traffic jams and road closures in the 2 km ahead.",
        requires: ["master-api"],
        optional: ["drive"],
        depends: ["corridor"],
        runWhen: { topic: "state.corridor", test: (/** @type {any} */ c) => Boolean(c && c.active && (c.mode === "route" || c.mode === "heading")) },
        defaults: { aheadM: [500, 1000, 1500, 2000], refreshMs: 60000, requeryM: 300, clearMs: 300000, slowWithinM: 1000, inItSpeedMs: 3, timeoutMs: 7000 },

        /** @param {any} ctx */
        start(ctx) {
            const G = geo();
            const cfg = ctx.config;
            const api = ctx.caps.get("master-api");
            const drive = ctx.caps.get("drive");
            /** @type {any} */ let lastQuery = null;
            let busy = false;
            /** @type {{ level: string, since: number, lastSeen: number }|null} */ let episode = null;

            /** @param {any} c */
            function points(c) {
                const pts = [];
                const cum = G.cumulative(c.line);
                for (const s of cfg.aheadM) {
                    if (s > c.lengthM + 1) break;
                    let i = 0;
                    while (i < cum.length - 2 && cum[i + 1] < s) i++;
                    const seg = cum[i + 1] - cum[i], f = seg > 0 ? (s - cum[i]) / seg : 0;
                    const a = c.line[i], b = c.line[Math.min(i + 1, c.line.length - 1)];
                    pts.push([Number((a[0] + (b[0] - a[0]) * f).toFixed(5)), Number((a[1] + (b[1] - a[1]) * f).toFixed(5)), s]);
                }
                return pts;
            }

            async function query(/** @type {any} */ c) {
                const pts = points(c);
                if (!pts.length) return;
                busy = true;
                try {
                    const r = await api.post("/traffic", { points: pts }, { timeoutMs: cfg.timeoutMs, signal: ctx.signal });
                    lastQuery = { at: ctx.now(), end: c.line[c.line.length - 1] };
                    if (!r.ok) { if (r.reason === "not-configured" || /not-configured/.test(r.reason || "")) ctx.markDegraded("live traffic isn't configured on the server"); return; }
                    ctx.markDegraded("");
                    judge(c, r.data.segments || []);
                } finally { busy = false; }
            }

            /** @param {any} c @param {any[]} segs */
            function judge(c, segs) {
                const t = ctx.now();
                ctx.setState("traffic", { at: t, segments: segs.map((s) => ({ distanceM: s.sAheadM, level: s.level, speedMs: s.speedMs ?? null, freeFlowMs: s.freeFlowMs ?? null })) });
                const bad = segs.find((s) => s.level === "closed" || s.level === "jam" || (s.level === "slow" && s.sAheadM <= cfg.slowWithinM));
                if (!bad) { if (episode && t - episode.lastSeen >= cfg.clearMs) episode = null; return; }
                const inIt = c.ego.speedMs < cfg.inItSpeedMs && bad.sAheadM <= 500;
                const isNew = !episode || (bad.level === "closed" && episode.level !== "closed") || (bad.level === "jam" && episode.level === "slow");
                if (episode) episode.lastSeen = t;
                if (!isNew) return;
                episode = { level: bad.level, since: t, lastSeen: t };
                if (inIt) return;
                const delayS = segs.filter((s) => s.sAheadM >= bad.sAheadM).reduce((a, s) => a + (Number.isFinite(s.delayS) ? s.delayS : 0), 0);
                const nav = Boolean(drive && drive.current().navigating);
                const distanceM = Math.max(100, Math.round(bad.sAheadM / 100) * 100);
                if (bad.level === "closed") ctx.report("traffic.closure-ahead", { severity: "warning", key: "traffic.ahead", category: "traffic", ridingOnly: true, data: { distanceM } });
                else if (bad.level === "jam") ctx.report("traffic.jam-ahead", { severity: nav && bad.sAheadM <= 1000 ? "warning" : "advice", key: "traffic.ahead", category: "traffic", ridingOnly: true, data: { distanceM, delayMin: Math.max(1, Math.round(delayS / 60)) }, cooldownMs: 600000 });
                else ctx.report("traffic.slow-ahead", { severity: "advice", key: "traffic.ahead", category: "traffic", ridingOnly: true, data: { distanceM }, cooldownMs: 900000 });
            }

            ctx.bus.subscribe("state.corridor", (/** @type {any} */ c) => {
                if (!c || !c.active || busy || c.line.length < 2) return;
                const end = c.line[c.line.length - 1];
                if (lastQuery && ctx.now() - lastQuery.at < cfg.refreshMs && G.metres(end[0], end[1], lastQuery.end[0], lastQuery.end[1]) < cfg.requeryM) return;
                if (lastQuery && ctx.now() - lastQuery.at < 15000) return;          // never more than 4 a minute
                query(c);
            }, { replay: true });
        }
    };
});
