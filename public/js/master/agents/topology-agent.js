// @ts-check
/* ============================================================================
   MapUnite Master AI — Topology agent ("topology"): ghats, hairpins, valley
   edges, bridges, breakers, railway crossings, bad road and mapped hazards ahead
   ==============================================================================
   Needs the ROUTE (corridor mode "route"): road features are only meaningful
   along the road you'll actually take. Two sources, merged into one list of
   features with positions, re-projected onto the corridor on every update:

   1. OpenStreetMap via our server (/api/master/road, cached 24 h there):
        breaker, level-crossing, bad-surface, bridge, hazard (OSM hazard=*), steep (incline ≥ 8 %)
   2. Computed on the phone, so it also works offline:
        ghat      heights every 50 m along the corridor (capability "terrain": the
                  app's DEM cache, js/trip/elevation.js), grade over 200 m windows,
                  a run of |grade| ≥ 6 % lasting ≥ 400 m. Descents ≥ 8 % are warnings
                  (brake fade, the classic ghat crash).
        hairpins  heading change ≥ 100° within 80 m (geo.turnRate) on the route
                  geometry; ≥ 2 within 1 km are reported together.
        valley    a drop beside the road: the same DEM, sampled 90 m and 135 m out on
        edge      both sides of every 50 m station. A side counts when the ground there
                  is ≥ 30 % lower (27 m at 90 m, 40.5 m at 135 m: FAO's "steep" slope
                  class, Guidelines for Soil Description 2006) AND the other side isn't
                  falling too (< half as much): a road cut into a hillside, open on one
                  side. Both sides falling is a bridge, a ridge or an embankment, not an
                  edge. A run of ≥ 200 m is reported, with the side (left/right of travel).
                  Checked against Copernicus GLO-90 + OpenStreetMap roads from
                  Visakhapatnam to Koraput (5 300 km of main roads): ~100 km flagged, all
                  on ghats (the Paderu ghat, Simhachalam, Ananthagiri / Araku), none below
                  150 m altitude. A 90 m DEM smooths cliffs, so it MISSES short sharp drops
                  rather than inventing them; it can't see crash barriers either.

   WHEN each is said (distance ahead, speed-aware; once per feature per 30 min):
     breaker          4–10 s ahead, only at ≥ 8 m/s; at most one a minute (towns have dozens)
     level-crossing   150–600 m                         warning
     hazard (OSM)     150–700 m                         warning
     bad-surface      200–1000 m, ≥ 100 m long          advice
     bridge           300–1200 m, ≥ 250 m long, ONLY when it's wet or windy (state.weather)
     ghat / hairpins  300–1500 m                        warning (descent ≥ 8 %, hairpins) / advice
     valley edge      300–1500 m, ≥ 200 m long          advice; with rain, fog, wind or night it
                                                        becomes one compound warning (cognition.js)
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
    const words = () => PHRASES.WORDS;

    /** Grades and steep runs from heights sampled every stepM. Pure, exported for tests. @param {number[]} z @param {number} stepM */
    function steepRuns(z, stepM, o = { windowM: 200, minGrade: 0.06, minLengthM: 400 }) {
        const w = Math.max(1, Math.round(o.windowM / stepM));
        // fill NaN gaps by carrying the last height (a DEM hole shouldn't invent a cliff)
        const h = [];
        let last = NaN;
        for (const v of z) { if (Number.isFinite(v)) last = v; h.push(last); }
        const grade = [];
        for (let i = 0; i + w < h.length; i++) grade.push(Number.isFinite(h[i]) && Number.isFinite(h[i + w]) ? (h[i + w] - h[i]) / (w * stepM) : 0);
        /** @type {Array<{ s0: number, s1: number, avgGrade: number, maxGrade: number }>} */ const runs = [];
        let start = -1, sign = 0;
        const close = (/** @type {number} */ end) => {
            if (start < 0) return;
            const len = (end - start) * stepM + o.windowM;
            if (len >= o.minLengthM) {
                const g = grade.slice(start, end);
                runs.push({ s0: start * stepM, s1: start * stepM + len, avgGrade: g.reduce((a, x) => a + x, 0) / g.length, maxGrade: g.reduce((a, x) => (Math.abs(x) > Math.abs(a) ? x : a), 0) });
            }
            start = -1; sign = 0;
        };
        for (let i = 0; i < grade.length; i++) {
            const g = grade[i], sg = Math.sign(g);
            if (Math.abs(g) >= o.minGrade && (start < 0 || sg === sign)) { if (start < 0) { start = i; sign = sg; } }
            else close(i);
        }
        close(grade.length);
        return runs;
    }

    /** Cross-section points beside each station: [left 90, left 135, right 90, right 135] m, left/right of travel. @param {any} G @param {ArrayLike<number>[]} pts */
    function crossPoints(G, pts, offsetsM = [90, 135]) {
        /** @type {Array<[number, number]>} */ const out = [];
        for (let i = 0; i < pts.length; i++) {
            const a = pts[Math.max(0, i - 1)], b = pts[Math.min(pts.length - 1, i + 1)];
            const brg = G.bearing(a[0], a[1], b[0], b[1]);
            for (const side of [-90, 90]) for (const d of offsetsM) out.push(G.offset(pts[i][0], pts[i][1], (brg + side + 360) % 360, d));
        }
        return out;
    }

    /**
     * Valley edges from heights. Pure, exported for tests.
     * zRoad[i]: the road at station i; zSide[i] = [left 90, left 135, right 90, right 135] (crossPoints' order).
     * Unknown heights (NaN) never make an edge.
     * @param {number[]} zRoad @param {number[][]} zSide @param {number} stepM
     * @returns {Array<{ s0: number, s1: number, side: "left"|"right", dropM: number }>}
     */
    function valleyEdges(zRoad, zSide, stepM, o = { offsetsM: [90, 135], minSlope: 0.3, otherSideMax: 0.5, minLengthM: 200, gapStations: 1 }) {
        const [d1, d2] = o.offsetsM;
        /** @returns {""|"left"|"right"} */
        const flag = (/** @type {number} */ i) => {
            const z0 = zRoad[i], zs = zSide[i];
            if (!Number.isFinite(z0) || !zs || zs.length < 4 || !zs.every(Number.isFinite)) return "";
            const L = [z0 - zs[0], z0 - zs[1]], R = [z0 - zs[2], z0 - zs[3]];
            const edge = (/** @type {number[]} */ D, /** @type {number[]} */ O) => D[0] >= o.minSlope * d1 && D[1] >= o.minSlope * d2 && O[1] < o.otherSideMax * D[1];
            return edge(L, R) ? "left" : edge(R, L) ? "right" : "";
        };
        /** @type {Array<{ s0: number, s1: number, side: "left"|"right", dropM: number }>} */ const runs = [];
        /** @type {{ side: "left"|"right", first: number, last: number, drop: number }|null} */ let cur = null;
        const close = () => {
            if (cur && (cur.last - cur.first + 1) * stepM >= o.minLengthM) runs.push({ s0: cur.first * stepM, s1: (cur.last + 1) * stepM, side: cur.side, dropM: Math.round(cur.drop) });
            cur = null;
        };
        for (let i = 0; i < zRoad.length; i++) {
            const f = flag(i);
            // a run survives one unflagged station (DEM noise); another side, or a longer gap, ends it
            if (cur && (f ? f !== cur.side : i - cur.last > o.gapStations)) close();
            if (!f) continue;
            const zs = zSide[i], drop = zRoad[i] - (f === "left" ? zs[1] : zs[3]);
            if (!cur) cur = { side: f, first: i, last: i, drop };
            else { cur.last = i; cur.drop = Math.max(cur.drop, drop); }
        }
        close();
        return runs;
    }

    /** Hairpin positions (s, metres along) from a polyline. @param {any} G @param {Array<[number, number]>} line */
    function hairpins(G, line, o = { windowM: 80, minTurnDeg: 100, gapM: 60 }) {
        const out = [];
        let lastS = -Infinity;
        for (const r of G.turnRate(line, o.windowM)) if (r.turnDeg >= o.minTurnDeg && r.s - lastS >= o.gapM) { out.push(r.s); lastS = r.s; }
        return out;
    }

    /** @param {Array<[number, number]>} line @param {number} s */
    function pointAt(/** @type {any} */ G, line, s) {
        const cum = G.cumulative(line);
        let i = 0;
        while (i < cum.length - 2 && cum[i + 1] < s) i++;
        const seg = cum[i + 1] - cum[i], f = seg > 0 ? Math.min(1, (s - cum[i]) / seg) : 0;
        const a = line[i], b = line[Math.min(i + 1, line.length - 1)];
        return [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f];
    }

    return {
        id: "topology",
        version: "1.1.0",
        apiVersion: 1,
        description: "Ghats, hairpins, valley edges, bridges, speed breakers, railway crossings and bad road on the route ahead.",
        requires: ["master-api"],
        optional: ["terrain"],
        depends: ["corridor"],
        runWhen: { topic: "state.corridor", test: (/** @type {any} */ c) => Boolean(c && c.active && c.mode === "route") },
        defaults: { requeryM: 1000, demStepM: 50, repeatMs: 1800000, breakerMinSpeedMs: 8, breakerGapMs: 60000, maxOffM: 45, timeoutMs: 25000 },
        steepRuns, hairpins, valleyEdges, crossPoints,

        /** @param {any} ctx */
        start(ctx) {
            const G = geo(), WD = words();
            const cfg = ctx.config;
            const api = ctx.caps.get("master-api");
            const terrain = ctx.caps.get("terrain");
            /** @type {Map<string, any>} */ const features = new Map();
            /** @type {Map<string, number>} */ const said = new Map();
            /** @type {any} */ let last = null;
            let busy = false, lastBreakerAt = -Infinity;

            async function refresh(/** @type {any} */ c) {
                busy = true;
                const line = c.line.map((/** @type {number[]} */ p) => [Number(p[0].toFixed(5)), Number(p[1].toFixed(5))]);
                last = { at: ctx.now(), end: c.line[c.line.length - 1], routeId: c.routeId };
                try {
                    const jobs = [api.post("/road", { line }, { timeoutMs: cfg.timeoutMs, signal: ctx.signal }).then((/** @type {any} */ r) => {
                        if (!r.ok) return;
                        for (const f of r.data.features || []) features.set(f.id, { ...f, source: "osm" });
                    })];
                    if (terrain) jobs.push(computeTerrain(c));
                    else hairpinsOnly(c);
                    await Promise.all(jobs);
                    // forget features well behind us
                    for (const [id, f] of features) if (G.metres(c.ego.lat, c.ego.lng, f.lat, f.lng) > 6000) features.delete(id);
                } finally { busy = false; }
            }

            function hairpinsOnly(/** @type {any} */ c) {
                const hp = hairpins(G, c.line);
                for (let i = 0; i < hp.length; i++) {
                    const within = hp.filter((s) => s >= hp[i] && s - hp[i] <= 1000);
                    if (within.length < 2) continue;
                    const [lat, lng] = pointAt(G, c.line, hp[i]);
                    const id = `hp:${lat.toFixed(4)},${lng.toFixed(4)}`;
                    if (![...features.values()].some((f) => f.type === "hairpins" && G.metres(f.lat, f.lng, lat, lng) < 300)) features.set(id, { id, type: "hairpins", lat, lng, count: within.length, source: "geometry" });
                    i += within.length - 1;
                }
            }

            async function computeTerrain(/** @type {any} */ c) {
                hairpinsOnly(c);
                const pts = G.resample(c.line, cfg.demStepM).map((/** @type {number[]} */ p) => [p[0], p[1]]);
                if (pts.length < 10) return;
                // one lookup: the road, then four points beside each station (the DEM cache rounds to ~11 m)
                const side = crossPoints(G, pts);
                const all = await terrain.heights(pts.concat(side));
                const z = all.slice(0, pts.length);
                const zSide = pts.map((/** @type {any} */ _p, /** @type {number} */ i) => all.slice(pts.length + i * 4, pts.length + i * 4 + 4));
                for (const e of valleyEdges(z, zSide, cfg.demStepM)) {
                    const [lat, lng] = pointAt(G, c.line, e.s0);
                    if ([...features.values()].some((f) => f.type === "valley-edge" && f.side === e.side && G.metres(f.lat, f.lng, lat, lng) < 300)) continue;
                    const id = `valley:${lat.toFixed(4)},${lng.toFixed(4)}`;
                    features.set(id, { id, type: "valley-edge", lat, lng, side: e.side, lengthM: Math.round(e.s1 - e.s0), dropM: e.dropM, source: "dem" });
                }
                for (const run of steepRuns(z, cfg.demStepM)) {
                    const [lat, lng] = pointAt(G, c.line, run.s0);
                    if ([...features.values()].some((f) => f.type === "ghat" && G.metres(f.lat, f.lng, lat, lng) < 500)) continue;
                    const id = `ghat:${lat.toFixed(4)},${lng.toFixed(4)}`;
                    features.set(id, { id, type: "ghat", lat, lng, lengthM: Math.round(run.s1 - run.s0), grade: run.avgGrade, maxGrade: run.maxGrade, source: "dem" });
                }
            }

            /** @param {any} c */
            function evaluate(c) {
                const t = ctx.now(), v = c.ego.speedMs || 0;
                const wx = ctx.bus.last("state.weather");
                const wet = Boolean(wx && wx.hazards && wx.hazards.some((/** @type {any} */ h) => /rain|drizzle|storm/.test(h.type) && h.distanceM <= 2000));
                const windy = Boolean(wx && wx.hazards && wx.hazards.some((/** @type {any} */ h) => h.type === "wind"));
                const nearest = [];
                for (const f of features.values()) {
                    const p = G.project(f.lat, f.lng, c.line);
                    if (p.d > cfg.maxOffM || p.s < 30) continue;
                    nearest.push({ f, s: p.s });
                }
                nearest.sort((a, b) => a.s - b.s);
                for (const { f, s } of nearest) {
                    if (t - (said.get(f.id) || -Infinity) < cfg.repeatMs) continue;
                    const r = judge(f, s, v, wet, windy, t);
                    if (!r) continue;
                    said.set(f.id, t);
                    ctx.report(r.kind, { ...r, key: `topology.${f.id}`, category: "road", ridingOnly: true, cooldownMs: cfg.repeatMs });
                    return;                                                  // one at a time: the next update says the next one
                }
            }

            /** @returns {any} */
            function judge(/** @type {any} */ f, /** @type {number} */ s, /** @type {number} */ v, /** @type {boolean} */ wet, /** @type {boolean} */ windy, /** @type {number} */ t) {
                const km = (/** @type {number} */ m) => Math.max(100, Math.round(m / 100) * 100);
                switch (f.type) {
                    case "breaker": {
                        if (v < cfg.breakerMinSpeedMs || t - lastBreakerAt < cfg.breakerGapMs) return null;
                        const tt = s / v;
                        if (tt < 4 || tt > 10) return null;
                        lastBreakerAt = t;
                        return { kind: "road.breaker-ahead", severity: "advice", data: { distanceM: Math.round(s / 10) * 10 }, ttlMs: 6000 };
                    }
                    case "level-crossing": return s >= 150 && s <= 600 ? { kind: "road.level-crossing", severity: "warning", data: { distanceM: Math.round(s / 10) * 10 }, ttlMs: 30000 } : null;
                    case "hazard": {
                        if (s < 150 || s > 700) return null;
                        const k = String((f.tags && f.tags.hazard) || "*");
                        const w = WD.osmHazard[k] || WD.osmHazard["*"];
                        return { kind: "road.osm-hazard", severity: "warning", data: { distanceM: Math.round(s / 10) * 10, hazard: w.desi, screen: { hazard: w.plain } }, ttlMs: 30000 };
                    }
                    case "bad-surface": return s >= 200 && s <= 1000 && (f.lengthM || 0) >= 100 ? { kind: "road.bad-surface", severity: "advice", data: { distanceM: km(s), lengthM: Math.max(100, f.lengthM) }, ttlMs: 60000 } : null;
                    case "bridge": {
                        if (s < 300 || s > 1200 || (f.lengthM || 0) < 250 || !(wet || windy)) return null;
                        const why = wet ? WD.bridgeWhy.wet : WD.bridgeWhy.wind;
                        return { kind: "road.bridge-ahead", severity: "advice", data: { distanceM: km(s), why: why.desi, screen: { why: why.plain } }, ttlMs: 60000 };
                    }
                    case "steep": {
                        // OSM's incline sign is relative to the WAY's direction, not ours: say "steep", not up or down
                        if (s < 300 || s > 1500) return null;
                        const pct = Math.round(Math.abs(Number(String((f.tags && f.tags.incline) || "").replace(/[%°]/g, "")) || 8));
                        return { kind: "terrain.ghat-ahead", severity: "advice", data: { distanceM: km(s), gradePct: pct, dir: WD.ghat.steep.desi, screen: { dir: WD.ghat.steep.plain } }, ttlMs: 90000 };
                    }
                    case "ghat": {
                        if (s < 300 || s > 1500) return null;
                        const dir = f.grade < 0 ? WD.ghat.descent : WD.ghat.climb;
                        return { kind: "terrain.ghat-ahead", severity: f.grade <= -0.08 ? "warning" : "advice", data: { distanceM: km(s), gradePct: Math.round(Math.abs(f.grade) * 100), dir: dir.desi, screen: { dir: dir.plain } }, ttlMs: 90000 };
                    }
                    case "valley-edge": {
                        // the drop isn't spoken: a 90 m DEM gives a lower bound, and the number doesn't change what to do
                        if (s < 300 || s > 1500 || (f.lengthM || 0) < 200) return null;
                        const sd = WD.side[f.side] || WD.side.left;
                        return { kind: "terrain.valley-edge", severity: "advice", data: { distanceM: km(s), lengthM: f.lengthM, dropM: f.dropM, side: sd.desi, screen: { side: sd.plain } }, ttlMs: 90000 };
                    }
                    case "hairpins": return s >= 300 && s <= 1500 ? { kind: "terrain.hairpins", severity: "warning", data: { distanceM: km(s), count: f.count }, ttlMs: 90000 } : null;
                    default: return null;
                }
            }

            ctx.bus.subscribe("state.corridor", (/** @type {any} */ c) => {
                if (!c || !c.active || c.mode !== "route" || c.line.length < 2) return;
                const end = c.line[c.line.length - 1];
                if (!busy && (!last || last.routeId !== c.routeId || G.metres(end[0], end[1], last.end[0], last.end[1]) >= cfg.requeryM)) refresh(c);
                evaluate(c);
            }, { replay: true });
        }
    };
});
