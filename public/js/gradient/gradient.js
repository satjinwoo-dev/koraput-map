// @ts-check
/* ============================================================================
   MapUnite gradient — grades from elevation, with bridges and tunnels fixed
   (roadmap step 9). Pure functions, strict SI (m, rise/run). No DOM, no network.
   ==============================================================================
   Why: a terrain model (Copernicus 90 m DEM) gives the height of the GROUND. On a
   bridge the road is above the valley the DEM sees; in a tunnel it's below the
   hill. Raw, a river bridge becomes a 40 % plunge and climb, a tunnel a mountain.
   So, before smoothing, bridges and tunnels are clamped to a straight grade by the
   ONE pipeline the trip card, the convoy planner and this sheet share (roadmap Step 9,
   js/trip/structures.js inside MUTrip.profile.buildProfile): the spans OpenStreetMap
   knows along the route (a flyover crossing above it isn't "on" it), then the DEM's
   own tell-tale dips and humps. This module adds what the sheet shows:

     analyze()       that profile, with each clamped stretch as an interval ("Bridge",
                     "Tunnel", or "Likely bridge" / "Likely tunnel or cutting" when only
                     the terrain gave it away), how far the DEM was off inside it and the
                     grade it has now; stretches the ±25 % cap still had to cut
     sections()      steep climbs and descents (≥ 6 %, very steep ≥ 10 %): runs less
                     than 200 m apart merge (a short easing doesn't end a climb), then
                     runs shorter than 150 m are dropped
     summarize(), gradeAt()

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
        margin: 45,          // m beyond a structure's ends where the straight line starts (js/trip/structures.js)
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
     * @typedef {{ s0: number, s1: number, kind: string, name: string, source: "osm"|"dem"|"cap", deviation?: number, grade?: number }} Interval
     */

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

    /** js/trip/structures.js, wherever this runs. */
    function structuresModule() {
        const g = /** @type {any} */ (globalThis);
        if (g.MUTrip && g.MUTrip.structures) return g.MUTrip.structures;
        // @ts-ignore — Node (tests): the module next door
        if (typeof module === "object" && module.exports && typeof require === "function") { try { return require("../trip/structures.js"); } catch { return null; } }
        return null;
    }

    /**
     * The whole pipeline. `profileLib` is MUTrip.profile (Step 7).
     * @param {{
     *   sample: { s: ArrayLike<number> },                   // MUTrip.profile.resample() samples
     *   z: ArrayLike<number|null>|null,                     // DEM heights at the samples (NaN = missing)
     *   distance?: number,                                  // the router's length (m)
     *   spans?: Array<{ s0: number, s1: number, kind: string, source: string, name?: string }>|null,
     *   profileLib: any, structuresLib?: any
     * }} a  spans: OSM bridges / tunnels (MUTrip.structures.along()), null = not checked
     * @param {Partial<typeof DEFAULTS>} [o]
     */
    function analyze(a, o = {}) {
        const c = { ...DEFAULTS, ...o };
        const P = a.profileLib, S = a.structuresLib || structuresModule();
        const sIn = a.sample.s, n = sIn.length;
        const L0 = n ? sIn[n - 1] : 0;
        const distance = a.distance && a.distance > 0 ? a.distance : L0;
        const k = L0 > 0 ? distance / L0 : 1;
        const raw = fillGaps(sIn, a.z);
        const checked = Array.isArray(a.spans) ? "osm" : "none";
        if (!raw) {
            const flat = P.buildProfile(sIn, null, { distance, maxGrade: c.maxGrade });
            return { profile: flat, raw: null, sections: [], structures: [], summary: summarize(flat, [], []), structureSource: checked };
        }
        // the shared pipeline: known spans + the DEM's own dips and humps, clamped, then cleaned
        const profile = P.buildProfile(sIn, raw, { distance, maxGrade: c.maxGrade, structures: a.spans || null });
        // what each clamped stretch changed: the DEM against the straight line (in the samples' metres)
        /** @type {Interval[]} */ const intervals = [];
        for (const sp of profile.structures || []) {
            const s0 = sp.s0 / k, s1 = sp.s1 / k;
            let dev = 0, grade;
            if (S) {
                const line = Float64Array.from(raw);
                S.apply(sIn, line, [{ ...sp, s0, s1 }], { margin: c.margin });
                for (let i = 0; i < n; i++) if (sIn[i] >= s0 - c.margin && sIn[i] <= s1 + c.margin) dev = Math.max(dev, Math.abs(raw[i] - line[i]));
                const z0 = interp(sIn, line, s0), z1 = interp(sIn, line, s1);
                grade = s1 > s0 ? (z1 - z0) / (s1 - s0) : 0;
            }
            const kind = sp.source === "dem" ? `likely-${sp.kind}` : sp.kind;
            intervals.push({ s0: sp.s0, s1: sp.s1, kind, name: sp.name || "", source: sp.source === "dem" ? "dem" : "osm", deviation: dev, ...(grade !== undefined ? { grade } : {}) });
        }
        const structures = [...intervals, ...cappedRuns(profile, c)].sort((x, y) => x.s0 - y.s0);
        const rawScaled = { s: Float64Array.from(sIn, (v) => v * k), z: raw };
        const secs = sections(profile, c);
        return { profile, raw: rawScaled, sections: secs, structures, summary: summarize(profile, secs, structures), structureSource: checked };
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

    return { DEFAULTS, KIND_WORDS, routeGeometry, nearestOnRoute, fillGaps, interp, sections, cappedRuns, analyze, summarize, gradeAt };
});
