// @ts-check
/* ============================================================================
   MapUnite gradient — grades from elevation, with bridges and tunnels fixed
   (roadmap step 9). Pure functions, strict SI (m, rise/run). No DOM, no network.
   ==============================================================================
   Why: a terrain model (Copernicus 90 m DEM) gives the height of the GROUND. On a
   bridge the road is above the valley the DEM sees; in a tunnel it's below the
   hill. Raw, a river bridge becomes a 40 % plunge and climb, a tunnel a mountain.
   So, before smoothing:

     1. structureIntervals()  OpenStreetMap bridge/tunnel ways that run ALONG the
                              route → [s0, s1] intervals (a flyover crossing above
                              the route is not "on" it and is ignored)
     2. detectSpikes()        unmapped ones: the DEM dips (or humps) ≥ 6 m and comes
                              back within 450 m, ≥ 10 % on both sides → "likely bridge"
                              / "likely tunnel or cutting"
     3. applyStructures()     across each interval (± 30 m) the height is a straight
                              line between the road at either end: the road is level
                              or evenly sloped there, which is how bridges and
                              tunnels are built
     4. MUTrip.profile.buildProfile()  the Step 7 cleaning (median, 250 m smoothing,
                              ±25 % cap) on the fixed heights
     5. sections()            steep climbs and descents (≥ 6 %, very steep ≥ 10 %):
                              runs less than 200 m apart merge (a short easing doesn't
                              end a climb), then runs shorter than 150 m are dropped

   Everything that was changed is reported ("clamped sections"), with how much
   the DEM was off, so the chart can show it instead of hiding it.
   ============================================================================ */
(function (root, factory) {
    if (typeof module === "object" && module.exports) module.exports = factory();
    else { const ns = /** @type {any} */ (root).MUGradient || (/** @type {any} */ (root).MUGradient = {}); ns.core = factory(); }
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
    "use strict";

    const R = 6371008.8, RAD = Math.PI / 180;
    const DEFAULTS = Object.freeze({
        steep: 0.06, verySteep: 0.10, minSection: 150, mergeSteepGap: 200,   // sections
        matchM: 25, alongShare: 0.6, minStructure: 25, mergeGap: 40, padM: 30,   // OSM structures
        spikeMaxLen: 450, spikeMinDev: 6, spikeMinGrade: 0.10,   // DEM spikes
        maxGrade: 0.25
    });

    /**
     * The route as metres on a local plane, with cumulative distance (haversine).
     * @param {ArrayLike<ArrayLike<number>>} path [[lat, lng], …]
     */
    function routeGeometry(path) {
        const pts = [];
        for (let i = 0; i < (path ? path.length : 0); i++) {
            const p = path[i]; if (!p) continue;
            const la = Number(p[0]), ln = Number(p[1]);
            if (!Number.isFinite(la) || !Number.isFinite(ln)) continue;
            const q = pts[pts.length - 1];
            if (q && q[0] === la && q[1] === ln) continue;
            pts.push([la, ln]);
        }
        const n = pts.length;
        const lat0 = n ? pts.reduce((a, p) => a + p[0], 0) / n : 0;
        const kx = Math.cos(lat0 * RAD) * R * RAD, ky = R * RAD;
        const x = new Float64Array(n), y = new Float64Array(n), s = new Float64Array(n);
        for (let i = 0; i < n; i++) {
            x[i] = pts[i][1] * kx; y[i] = pts[i][0] * ky;
            if (i) {
                const dLat = (pts[i][0] - pts[i - 1][0]) * RAD, dLng = (pts[i][1] - pts[i - 1][1]) * RAD;
                const a = Math.sin(dLat / 2) ** 2 + Math.cos(pts[i - 1][0] * RAD) * Math.cos(pts[i][0] * RAD) * Math.sin(dLng / 2) ** 2;
                s[i] = s[i - 1] + 2 * R * Math.asin(Math.min(1, Math.sqrt(a)));
            }
        }
        return { n, x, y, s, kx, ky, length: n ? s[n - 1] : 0 };
    }

    /** Nearest point on the route to (px, py): distance along it and off it (m). */
    function nearestOnRoute(G, px, py, pad = Infinity) {
        let best = Infinity, bestS = 0;
        for (let i = 0; i < G.n - 1; i++) {
            const ax = G.x[i], ay = G.y[i], bx = G.x[i + 1], by = G.y[i + 1];
            if (pad < Infinity && (px < Math.min(ax, bx) - pad || px > Math.max(ax, bx) + pad || py < Math.min(ay, by) - pad || py > Math.max(ay, by) + pad)) continue;
            const dx = bx - ax, dy = by - ay, L2 = dx * dx + dy * dy;
            const t = L2 > 0 ? Math.min(1, Math.max(0, ((px - ax) * dx + (py - ay) * dy) / L2)) : 0;
            const d = Math.hypot(ax + dx * t - px, ay + dy * t - py);
            if (d < best) { best = d; bestS = G.s[i] + (G.s[i + 1] - G.s[i]) * t; }
        }
        return { s: bestS, d: best };
    }

    /**
     * @typedef {{ id: string, kind: "bridge"|"tunnel", name: string, coords: number[][] }} Way
     * @typedef {{ s0: number, s1: number, kind: string, name: string, source: "osm"|"dem"|"cap", ids?: string[], deviation?: number, grade?: number }} Interval
     */

    /**
     * OSM bridge / tunnel ways that run along the route → intervals along it (m).
     * A way counts when ≥ 2 of its points are within matchM of the route and the
     * stretch they cover is ≥ minStructure and ≥ alongShare of the way's length
     * (so a flyover CROSSING the route, or a parallel service road's bridge that
     * only touches it, doesn't count).
     * @param {ReturnType<typeof routeGeometry>} G @param {Way[]} ways @param {Partial<typeof DEFAULTS>} [o]
     * @returns {Interval[]}
     */
    function structureIntervals(G, ways, o = {}) {
        const c = { ...DEFAULTS, ...o };
        /** @type {Interval[]} */ const out = [];
        if (!G || G.n < 2) return out;
        for (const w of ways || []) {
            if (!w || !Array.isArray(w.coords) || w.coords.length < 2) continue;
            const ss = [];
            let wayLen = 0;
            for (let i = 0; i < w.coords.length; i++) {
                const px = w.coords[i][1] * G.kx, py = w.coords[i][0] * G.ky;
                if (i) wayLen += Math.hypot(px - w.coords[i - 1][1] * G.kx, py - w.coords[i - 1][0] * G.ky);
                const m = nearestOnRoute(G, px, py, c.matchM);
                if (m.d <= c.matchM) ss.push(m.s);
            }
            if (ss.length < 2) continue;
            const s0 = Math.min(...ss), s1 = Math.max(...ss), span = s1 - s0;
            if (span < c.minStructure || span < c.alongShare * wayLen) continue;
            out.push({ s0, s1, kind: w.kind, name: w.name || "", source: "osm", ids: [w.id] });
        }
        // merge overlapping / nearly touching intervals of the same kind
        out.sort((a, b) => a.s0 - b.s0);
        /** @type {Interval[]} */ const merged = [];
        for (const iv of out) {
            const last = merged[merged.length - 1];
            if (last && last.kind === iv.kind && iv.s0 - last.s1 <= c.mergeGap) {
                last.s1 = Math.max(last.s1, iv.s1);
                last.ids = [...(last.ids || []), ...(iv.ids || [])];
                if (!last.name && iv.name) last.name = iv.name;
            } else merged.push({ ...iv });
        }
        return merged;
    }

    /** Linear gap filling (ends: nearest known). null when < 2 known values. */
    function fillGaps(s, zIn) {
        const n = s.length, z = new Float64Array(n);
        let known = 0;
        for (let i = 0; i < n; i++) { const v = zIn ? zIn[i] : NaN; z[i] = v === null || v === undefined || !Number.isFinite(v) ? NaN : v; if (!Number.isNaN(z[i])) known++; }
        if (known < 2) return null;
        let last = -1;
        for (let i = 0; i < n; i++) {
            if (Number.isNaN(z[i])) continue;
            if (last < 0) for (let j = 0; j < i; j++) z[j] = z[i];
            else for (let j = last + 1; j < i; j++) z[j] = z[last] + ((z[i] - z[last]) * (s[j] - s[last])) / (s[i] - s[last] || 1);
            last = i;
        }
        for (let j = last + 1; j < n; j++) z[j] = z[last];
        return z;
    }

    /** Height at distance x by linear interpolation on (s, z). */
    function interp(s, z, x) {
        const n = s.length;
        if (!n) return NaN;
        if (x <= s[0]) return z[0];
        if (x >= s[n - 1]) return z[n - 1];
        let lo = 0, hi = n - 1;
        while (hi - lo > 1) { const m = (lo + hi) >> 1; if (s[m] <= x) lo = m; else hi = m; }
        const t = (x - s[lo]) / (s[hi] - s[lo] || 1);
        return z[lo] + (z[hi] - z[lo]) * t;
    }

    /**
     * Unmapped structures from the DEM: a dip or hump that comes back within spikeMaxLen.
     * @param {ArrayLike<number>} s @param {ArrayLike<number>} z  gap-filled raw heights
     * @param {Interval[]} [skip]  intervals already handled (OSM)
     * @param {Partial<typeof DEFAULTS>} [o]
     * @returns {Interval[]}
     */
    function detectSpikes(s, z, skip = [], o = {}) {
        const c = { ...DEFAULTS, ...o };
        const n = s.length, cands = [];
        for (let i = 0; i < n - 2; i++) {
            for (let j = i + 2; j < n && s[j] - s[i] <= c.spikeMaxLen; j++) {
                const L = s[j] - s[i];
                if (L <= 0) continue;
                const line = (z[j] - z[i]) / L;
                if (Math.abs(line) >= c.spikeMinGrade) continue;            // a real, steady slope
                let k = -1, dev = 0;
                for (let m = i + 1; m < j; m++) {
                    const d = z[m] - (z[i] + line * (s[m] - s[i]));
                    if (Math.abs(d) > Math.abs(dev)) { dev = d; k = m; }
                }
                if (k < 0 || Math.abs(dev) < c.spikeMinDev) continue;
                // the steepest single step into the dip (or up the hump) and out of it: a dip
                // that spans two samples still has one steep step on each side
                let gIn = 0, gOut = 0;
                for (let m = i; m < k; m++) { const g = (z[m + 1] - z[m]) / (s[m + 1] - s[m] || 1); if (dev < 0 ? g < gIn : g > gIn) gIn = g; }
                for (let m = k; m < j; m++) { const g = (z[m + 1] - z[m]) / (s[m + 1] - s[m] || 1); if (dev < 0 ? g > gOut : g < gOut) gOut = g; }
                if (Math.abs(gIn) < c.spikeMinGrade || Math.abs(gOut) < c.spikeMinGrade) continue;
                cands.push({ s0: s[i], s1: s[j], dev, len: L });
            }
        }
        // strongest first, no overlaps, nothing on top of an OSM structure
        cands.sort((a, b) => Math.abs(b.dev) - Math.abs(a.dev) || a.len - b.len);
        /** @type {Interval[]} */ const out = [];
        const overlaps = (a, b) => a.s0 < b.s1 && b.s0 < a.s1;
        for (const cd of cands) {
            if (skip.some((x) => overlaps(cd, x)) || out.some((x) => overlaps(cd, x))) continue;
            out.push({ s0: cd.s0, s1: cd.s1, kind: cd.dev < 0 ? "likely-bridge" : "likely-tunnel", name: "", source: "dem", deviation: Math.abs(cd.dev) });
        }
        return out.sort((a, b) => a.s0 - b.s0);
    }

    /**
     * Replace the heights across each interval by a straight line between the road at
     * either end. The ends are the nearest SAMPLES at least padM outside the interval
     * (never a value interpolated towards the dip), so the line starts on good ground.
     * Returns the new heights and each interval with how far the DEM was off inside it
     * and the grade it now has.
     * @param {ArrayLike<number>} s @param {Float64Array} z @param {Interval[]} intervals @param {Partial<typeof DEFAULTS>} [o]
     * @returns {{ z: Float64Array, intervals: Interval[] }}
     */
    function applyStructures(s, z, intervals, o = {}) {
        const c = { ...DEFAULTS, ...o };
        const n = s.length, out = Float64Array.from(z), L = n ? s[n - 1] : 0;
        /** @type {Interval[]} */ const done = [];
        for (const iv of [...intervals].sort((a, b) => a.s0 - b.s0)) {
            if (!n) break;
            let ia = -1, ib = -1;
            for (let i = 0; i < n; i++) { if (s[i] <= iv.s0 - c.padM) ia = i; if (ib < 0 && s[i] >= iv.s1 + c.padM) ib = i; }
            if (ia < 0) ia = 0;                                       // the structure starts the route
            if (ib < 0) ib = n - 1;                                   // … or ends it
            if (ib - ia < 1 || L <= 0) continue;
            const a = s[ia], b = s[ib], za = out[ia], zb = out[ib];
            let dev = 0;
            for (let i = ia + 1; i < ib; i++) {
                const v = za + ((zb - za) * (s[i] - a)) / (b - a || 1);
                dev = Math.max(dev, Math.abs(out[i] - v));
                out[i] = v;
            }
            done.push({ ...iv, deviation: Math.max(dev, iv.deviation || 0), grade: (zb - za) / (b - a || 1) });
        }
        return { z: out, intervals: done };
    }

    /**
     * Steep climbs and descents from a profile's (smoothed, capped) grades.
     * @param {{ s: ArrayLike<number>, z: ArrayLike<number>, grade: ArrayLike<number> }} p @param {Partial<typeof DEFAULTS>} [o]
     * @returns {Array<{ kind: "climb"|"descent", level: 1|2, s0: number, s1: number, length: number, rise: number, avgGrade: number, maxGrade: number }>}
     *   level 2 = very steep (some ≥ verySteep stretch of ≥ 100 m); rise is signed (m)
     */
    function sections(p, o = {}) {
        const c = { ...DEFAULTS, ...o };
        const runs = [];
        const m = p.grade.length;
        let i = 0;
        while (i < m) {
            const g = p.grade[i];
            if (Math.abs(g) < c.steep) { i++; continue; }
            const sign = Math.sign(g);
            let j = i, vs = 0, maxG = 0;
            while (j < m && Math.sign(p.grade[j]) === sign && Math.abs(p.grade[j]) >= c.steep) {
                const d = p.s[j + 1] - p.s[j];
                if (Math.abs(p.grade[j]) >= c.verySteep) vs += d;
                if (Math.abs(p.grade[j]) > Math.abs(maxG)) maxG = p.grade[j];
                j++;
            }
            runs.push({ kind: sign > 0 ? "climb" : "descent", i0: i, i1: j, vs, maxG });
            i = j;
        }
        // one climb with a short easing in it is still one climb: merge same-kind runs < mergeSteepGap apart
        const merged = [];
        for (const r of runs) {
            const last = merged[merged.length - 1];
            if (last && last.kind === r.kind && p.s[r.i0] - p.s[last.i1] <= c.mergeSteepGap) {
                last.i1 = r.i1; last.vs += r.vs; if (Math.abs(r.maxG) > Math.abs(last.maxG)) last.maxG = r.maxG;
            } else merged.push({ ...r });
        }
        const out = [];
        for (const r of merged) {
            const s0 = p.s[r.i0], s1 = p.s[r.i1], length = s1 - s0;
            if (length < c.minSection) continue;
            const rise = p.z[r.i1] - p.z[r.i0];
            out.push({ kind: r.kind, level: r.vs >= 100 ? 2 : 1, s0, s1, length, rise, avgGrade: rise / length, maxGrade: r.maxG });
        }
        return /** @type {any} */ (out);
    }

    /** Stretches where the ±maxGrade cap had to cut the grade: the DEM is still not believable there. */
    function cappedRuns(p, o = {}) {
        const c = { ...DEFAULTS, ...o };
        /** @type {Interval[]} */ const out = [];
        for (let i = 0; i < p.grade.length; i++) {
            if (Math.abs(p.grade[i]) < c.maxGrade - 1e-9) continue;
            const last = out[out.length - 1];
            if (last && Math.abs(last.s1 - p.s[i]) < 1e-6) last.s1 = p.s[i + 1];
            else out.push({ s0: p.s[i], s1: p.s[i + 1], kind: "capped", name: "", source: "cap" });
        }
        return out;
    }

    /**
     * The whole pipeline. `profileLib` is MUTrip.profile (Step 7).
     * @param {{
     *   path: ArrayLike<ArrayLike<number>>,                 // the route, [[lat, lng], …]
     *   sample: { s: ArrayLike<number> },                   // MUTrip.profile.resample() samples
     *   z: ArrayLike<number|null>|null,                     // DEM heights at the samples (NaN = missing)
     *   distance?: number,                                  // the router's length (m)
     *   ways?: Way[]|null,                                  // OSM bridges / tunnels, null = not checked
     *   profileLib: any
     * }} a
     * @param {Partial<typeof DEFAULTS>} [o]
     */
    function analyze(a, o = {}) {
        const c = { ...DEFAULTS, ...o };
        const P = a.profileLib;
        const sIn = a.sample.s, n = sIn.length;
        const L0 = n ? sIn[n - 1] : 0;
        const distance = a.distance && a.distance > 0 ? a.distance : L0;
        const k = L0 > 0 ? distance / L0 : 1;
        const raw = fillGaps(sIn, a.z);
        if (!raw) {
            const flat = P.buildProfile(sIn, null, { distance, maxGrade: c.maxGrade });
            return { profile: flat, raw: null, sections: [], structures: [], summary: summarize(flat, [], []), structureSource: a.ways ? "osm" : "none" };
        }
        // OSM structures on the route geometry, mapped onto the sample distances
        const G = routeGeometry(a.path);
        const kr = G.length > 0 ? L0 / G.length : 1;                            // route cumulative → sample positions
        const osm = a.ways ? structureIntervals(G, a.ways, c).map((iv) => ({ ...iv, s0: iv.s0 * kr, s1: iv.s1 * kr })) : [];
        const spikes = detectSpikes(sIn, raw, osm.map((iv) => ({ ...iv, s0: iv.s0 - c.padM, s1: iv.s1 + c.padM })), c);
        const fixed = applyStructures(sIn, raw, [...osm, ...spikes], c);
        const profile = P.buildProfile(sIn, fixed.z, { distance, maxGrade: c.maxGrade });
        const scale = (iv) => ({ ...iv, s0: iv.s0 * k, s1: iv.s1 * k });
        const structures = [...fixed.intervals.map(scale), ...cappedRuns(profile, c)].sort((x, y) => x.s0 - y.s0);
        const rawScaled = { s: Float64Array.from(sIn, (v) => v * k), z: raw };
        const secs = sections(profile, c);
        return { profile, raw: rawScaled, sections: secs, structures, summary: summarize(profile, secs, structures), structureSource: a.ways ? "osm" : "none" };
    }

    /** Totals for the header and the table. */
    function summarize(p, secs, structures) {
        let maxClimb = 0, maxDescent = 0;
        for (let i = 0; i < p.grade.length; i++) { if (p.grade[i] > maxClimb) maxClimb = p.grade[i]; if (p.grade[i] < maxDescent) maxDescent = p.grade[i]; }
        const count = (kind) => structures.filter((x) => x.kind === kind).length;
        return {
            distance: p.distance, ascent: p.ascent, descent: p.descent, zMin: p.zMin, zMax: p.zMax, maxClimb, maxDescent,
            steepClimb: secs.filter((x) => x.kind === "climb").reduce((a, x) => a + x.length, 0),
            steepDescent: secs.filter((x) => x.kind === "descent").reduce((a, x) => a + x.length, 0),
            bridges: count("bridge"), tunnels: count("tunnel"), likely: count("likely-bridge") + count("likely-tunnel"), capped: count("capped"),
            source: p.source, missingShare: p.missingShare
        };
    }

    /** Words for an interval kind (UI and tests share them). */
    const KIND_WORDS = Object.freeze({
        bridge: "Bridge", tunnel: "Tunnel", "likely-bridge": "Likely bridge", "likely-tunnel": "Likely tunnel or cutting", capped: "DEM too steep, capped"
    });

    /** Grade under a distance along the profile (segment lookup). */
    function gradeAt(p, x) {
        const S = p.s; let lo = 0, hi = S.length - 1;
        if (hi < 1) return 0;
        while (hi - lo > 1) { const m = (lo + hi) >> 1; if (S[m] <= x) lo = m; else hi = m; }
        return p.grade[Math.min(lo, p.grade.length - 1)] || 0;
    }

    return { DEFAULTS, KIND_WORDS, routeGeometry, nearestOnRoute, structureIntervals, fillGaps, interp, detectSpikes, applyStructures, sections, cappedRuns, analyze, summarize, gradeAt };
});
