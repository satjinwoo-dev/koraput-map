// @ts-check
/* ============================================================================
   MapUnite trip — route geometry, elevation profile and per-segment speeds
   ==============================================================================
   Pure functions, strict SI (metres, m/s, rise/run). No DOM, no network.

     plan(distance)                       sample spacing for a route of this length
     resample(path, spacing)              evenly spaced points along a [lat, lng] polyline
     buildProfile(s, z, opts)             clean DEM heights → smoothed heights, grades,
                                          ascent / descent (or a flagged flat profile)
     segmentSpeeds(edges, steps, opts)    each segment's average speed from the
                                          router's own step distances and durations

   Why the cleaning matters: a 90 m DEM sampled along a road sees the valley floor
   under a flyover and the hillside beside a cutting. Raw, those become 40 % "grades"
   that would cost absurd fuel. So: fill gaps, clamp bridges and tunnels to a straight
   grade (Step 9, js/trip/structures.js: the ones OpenStreetMap knows, then the DEM's
   own tell-tale dips and humps), take a running median (kills single-sample spikes
   and dips), smooth over ~250 m (a bike can't feel shorter wiggles in fuel), and clamp
   what's left to ±25 % (steeper public roads are vanishingly rare).
   ============================================================================ */
(function (root, factory) {
    if (typeof module === "object" && module.exports) module.exports = factory();
    else { const ns = /** @type {any} */ (root).MUTrip || (/** @type {any} */ (root).MUTrip = {}); ns.profile = factory(); }
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
    "use strict";

    const R_EARTH = 6371008.8;          // m, mean Earth radius
    const RAD = Math.PI / 180;

    const PROFILE_DEFAULTS = Object.freeze({
        minSpacing: 90,      // m — the DEM's own resolution; denser sampling adds nothing
        maxPoints: 400,      // 4 elevation requests of 100 points; ~1.4 km spacing at 560 km
        smoothWindow: 250,   // m — centred moving average after the median
        maxGrade: 0.25,      // rise/run clamp
        minSpeed: 2,         // m/s (7 km/h) floor for a segment's average speed
        maxSpeed: 40,        // m/s (144 km/h) ceiling
        fallbackSpeed: 40 / 3.6
    });

    /** Great-circle distance in metres. */
    function haversine(lat1, lng1, lat2, lng2) {
        const dLat = (lat2 - lat1) * RAD, dLng = (lng2 - lng1) * RAD;
        const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * RAD) * Math.cos(lat2 * RAD) * Math.sin(dLng / 2) ** 2;
        return 2 * R_EARTH * Math.asin(Math.min(1, Math.sqrt(a)));
    }

    /**
     * Keep only finite [lat, lng] pairs, dropping exact repeats.
     * @param {ArrayLike<ArrayLike<number>>} path
     * @returns {number[][]}
     */
    function cleanPath(path) {
        /** @type {number[][]} */ const out = [];
        for (let i = 0; i < (path ? path.length : 0); i++) {
            const p = path[i];
            if (!p) continue;
            const lat = Number(p[0]), lng = Number(p[1]);
            if (!Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180) continue;
            const q = out[out.length - 1];
            if (q && q[0] === lat && q[1] === lng) continue;
            out.push([lat, lng]);
        }
        return out;
    }

    /** Cumulative distance along the path (m). @param {number[][]} path */
    function cumulative(path) {
        const s = new Float64Array(path.length);
        for (let i = 1; i < path.length; i++) s[i] = s[i - 1] + haversine(path[i - 1][0], path[i - 1][1], path[i][0], path[i][1]);
        return s;
    }

    /**
     * Sample spacing for a route of this length.
     * @param {number} distance m @param {{ minSpacing?: number, maxPoints?: number }} [o]
     */
    function plan(distance, o = {}) {
        const minS = o.minSpacing ?? PROFILE_DEFAULTS.minSpacing, maxN = o.maxPoints ?? PROFILE_DEFAULTS.maxPoints;
        if (!(distance > 0)) return minS;
        return Math.max(minS, distance / Math.max(1, maxN - 1));
    }

    /**
     * Evenly spaced samples along a polyline, first and last points included.
     * @param {ArrayLike<ArrayLike<number>>} rawPath  [[lat, lng], …]
     * @param {number} spacing m
     * @returns {{ lat: Float64Array, lng: Float64Array, s: Float64Array, length: number }}
     */
    function resample(rawPath, spacing) {
        const path = cleanPath(rawPath);
        if (path.length === 0) return { lat: new Float64Array(0), lng: new Float64Array(0), s: new Float64Array(0), length: 0 };
        const cum = cumulative(path);
        const L = cum[cum.length - 1];
        if (!(spacing > 0)) throw new RangeError("spacing must be > 0");
        const n = L > 0 ? Math.max(2, Math.ceil(L / spacing - 1e-9) + 1) : 1;
        const lat = new Float64Array(n), lng = new Float64Array(n), s = new Float64Array(n);
        let j = 0;
        for (let i = 0; i < n; i++) {
            const target = i === n - 1 ? L : Math.min(L, i * spacing);
            while (j < cum.length - 2 && cum[j + 1] < target) j++;
            const seg = cum[j + 1] - cum[j];
            const t = seg > 0 ? Math.min(1, Math.max(0, (target - cum[j]) / seg)) : 0;
            const a = path[j], b = path[Math.min(j + 1, path.length - 1)];
            lat[i] = a[0] + (b[0] - a[0]) * t;
            lng[i] = a[1] + (b[1] - a[1]) * t;
            s[i] = target;
        }
        return { lat, lng, s, length: L };
    }

    /** Running median over 2h+1 samples; the window shrinks symmetrically at the ends (no edge bias). */
    function runningMedian(z, h) {
        const n = z.length, out = new Float64Array(n), buf = [];
        for (let i = 0; i < n; i++) {
            const k = Math.min(h, i, n - 1 - i);
            buf.length = 0;
            for (let j = i - k; j <= i + k; j++) buf.push(z[j]);
            buf.sort((a, b) => a - b);
            out[i] = buf[buf.length >> 1];
        }
        return out;
    }

    /**
     * Centred moving average over ±half metres (prefix sums). Near the ends the window
     * shrinks symmetrically, so a steady slope stays exact right up to the endpoints.
     * Both window bounds only ever move forward, so this is O(n).
     */
    function movingAverage(s, z, half) {
        const n = z.length, out = new Float64Array(n), pre = new Float64Array(n + 1);
        for (let i = 0; i < n; i++) pre[i + 1] = pre[i] + z[i];
        if (!n) return out;
        const s0 = s[0], s1 = s[n - 1], eps = 1e-9;
        let lo = 0, hi = 0;
        for (let i = 0; i < n; i++) {
            const w = Math.min(half, s[i] - s0, s1 - s[i]);
            while (lo < i && s[lo] < s[i] - w - eps) lo++;
            if (hi < i) hi = i;
            while (hi + 1 < n && s[hi + 1] <= s[i] + w + eps) hi++;
            out[i] = (pre[hi + 1] - pre[lo]) / (hi - lo + 1);
        }
        return out;
    }

    /**
     * @typedef {{
     *   s: Float64Array, z: Float64Array, edges: Float64Array, ds: Float64Array, grade: Float64Array,
     *   ascent: number, descent: number, zMin: number, zMax: number, zMean: number,
     *   distance: number, source: "dem"|"flat", missingShare: number, clampedShare: number,
     *   structures: Array<{ s0: number, s1: number, kind: string, source: string, name?: string }>, structureShare: number
     * }} Profile
     *  s: sample positions (m, scaled to the route distance); z: smoothed heights (m);
     *  edges: segment boundaries = s; ds/grade: per segment (length n − 1).
     *  structures: the bridges and tunnels clamped (positions scaled like s); structureShare: the share of the
     *  distance whose heights they replaced.
     */
    /** js/trip/structures.js, wherever this runs. */
    function structuresModule() {
        const g = /** @type {any} */ (globalThis);
        if (g.MUTrip && g.MUTrip.structures) return g.MUTrip.structures;
        // @ts-ignore — Node (tests): the sibling module
        if (typeof module === "object" && module.exports && typeof require === "function") { try { return require("./structures.js"); } catch { return null; } }
        return null;
    }
    /**
     * Clean heights into a profile. `z` may contain null/NaN for samples the DEM didn't return.
     * @param {ArrayLike<number>} sIn  sample positions along the polyline (m)
     * @param {ArrayLike<number|null>|null} zIn  heights (m) or null for "no elevation data"
     * @param {{ distance?: number, smoothWindow?: number, maxGrade?: number,
     *   structures?: Array<{ s0: number, s1: number, kind: string, source: string, name?: string }>|null, detectStructures?: boolean }} [o]
     *   distance: the router's own length; positions are scaled to it so energy sums match the trip the rider sees;
     *   structures: bridges and tunnels known along the route (positions in sIn's metres, e.g. from
     *   MUTrip.structures.along()); detectStructures (default true): also find them in the heights
     * @returns {Profile}
     */
    function buildProfile(sIn, zIn, o = {}) {
        const n = sIn.length;
        const L0 = n ? sIn[n - 1] : 0;
        const distance = o.distance && o.distance > 0 ? o.distance : L0;
        const k = L0 > 0 ? distance / L0 : 1;
        const s = new Float64Array(n);
        for (let i = 0; i < n; i++) s[i] = sIn[i] * k;

        // 1. gaps → linear interpolation (ends: nearest known value)
        let z = new Float64Array(n), known = 0, structureLen = 0;
        /** @type {Array<{ s0: number, s1: number, kind: string, source: string, name?: string }>} */ let structures = [];
        for (let i = 0; i < n; i++) { const v = zIn ? zIn[i] : null; z[i] = v === null || v === undefined || !Number.isFinite(v) ? NaN : v; if (!Number.isNaN(z[i])) known++; }
        const missingShare = n ? 1 - known / n : 1;
        const source = known >= 2 && missingShare <= 0.5 ? "dem" : "flat";
        if (source === "flat") z.fill(0);
        else {
            let last = -1;
            for (let i = 0; i < n; i++) {
                if (Number.isNaN(z[i])) continue;
                if (last < 0) for (let j = 0; j < i; j++) z[j] = z[i];
                else for (let j = last + 1; j < i; j++) z[j] = z[last] + ((z[i] - z[last]) * (s[j] - s[last])) / (s[i] - s[last] || 1);
                last = i;
            }
            for (let j = last + 1; j < n; j++) z[j] = z[last];
            // 2. bridges and tunnels: a straight grade from end to end (the DEM sees the ground, not the deck)
            const S = structuresModule();
            if (S) {
                const known = (o.structures || []).map((x) => ({ ...x, s0: x.s0 * k, s1: x.s1 * k }));
                if (known.length) structureLen += S.apply(s, z, known).clamped;
                const found = o.detectStructures === false ? [] : S.detect(s, z).filter((/** @type {any} */ d) => !known.some((x) => d.s0 < x.s1 && x.s0 < d.s1));
                if (found.length) structureLen += S.apply(s, z, found).clamped;
                structures = S.merge(known.concat(found));
            }
            // 3. despike (median over ≥ ~270 m), 4. smooth
            const spacing = n > 1 ? distance / (n - 1) : distance;
            const h = spacing <= 150 ? 2 : 1;
            z = runningMedian(z, h);
            const win = Math.max(o.smoothWindow ?? PROFILE_DEFAULTS.smoothWindow, 2 * spacing);
            z = movingAverage(s, z, win / 2);
        }
        // 4. grades, clamped
        const maxG = o.maxGrade ?? PROFILE_DEFAULTS.maxGrade;
        const m = Math.max(0, n - 1);
        const ds = new Float64Array(m), grade = new Float64Array(m);
        let ascent = 0, descent = 0, clamped = 0, zMin = n ? Infinity : 0, zMax = n ? -Infinity : 0, area = 0;
        for (let i = 0; i < m; i++) {
            const d = s[i + 1] - s[i], dz = z[i + 1] - z[i];
            ds[i] = d;
            let g = d > 0 ? dz / d : 0;
            if (g > maxG) { g = maxG; clamped += d; } else if (g < -maxG) { g = -maxG; clamped += d; }
            grade[i] = g;
            if (dz > 0) ascent += dz; else descent -= dz;
            area += 0.5 * (z[i] + z[i + 1]) * d;
        }
        for (let i = 0; i < n; i++) { if (z[i] < zMin) zMin = z[i]; if (z[i] > zMax) zMax = z[i]; }
        return {
            s, z, edges: s, ds, grade, ascent, descent, zMin, zMax,
            zMean: distance > 0 && m ? area / distance : (n ? z[0] : 0),
            distance, source, missingShare, clampedShare: distance > 0 ? clamped / distance : 0,
            structures, structureShare: distance > 0 ? Math.min(1, structureLen / distance) : 0
        };
    }

    /**
     * Average speed of every segment, from the router's steps.
     * Each step's speed = its distance ÷ its duration. Step boundaries are scaled to the
     * profile's distance. When the trip's own duration (e.g. Google's live-traffic figure)
     * differs from the steps' sum, every speed is scaled by the same factor.
     * Without usable steps: one speed, distance ÷ duration (else the fallback).
     * @param {Float64Array} edges  segment boundaries (m), length n
     * @param {Array<{ distance?: number, duration?: number }>|null|undefined} steps
     * @param {{ distance?: number, duration?: number, minSpeed?: number, maxSpeed?: number, fallbackSpeed?: number }} [o]
     * @returns {{ speed: Float64Array, source: "steps"|"average"|"assumed" }}
     */
    function segmentSpeeds(edges, steps, o = {}) {
        const m = Math.max(0, edges.length - 1);
        const vLo = o.minSpeed ?? PROFILE_DEFAULTS.minSpeed, vHi = o.maxSpeed ?? PROFILE_DEFAULTS.maxSpeed;
        const clamp = (v) => Math.min(vHi, Math.max(vLo, v));
        const speed = new Float64Array(m);
        const total = m ? edges[m] : 0;
        const good = (steps || []).filter((x) => x && Number.isFinite(x.distance) && /** @type {number} */ (x.distance) >= 0 && Number.isFinite(x.duration) && /** @type {number} */ (x.duration) >= 0);
        const sumD = good.reduce((a, x) => a + /** @type {number} */ (x.distance), 0);
        const sumT = good.reduce((a, x) => a + /** @type {number} */ (x.duration), 0);
        if (good.length && sumD > 0 && sumT > 0 && total > 0) {
            const kd = total / sumD;
            const kt = o.duration && o.duration > 0 ? sumT / o.duration : 1;       // > 1 when traffic makes the trip slower
            const bounds = [], speeds = [];
            let acc = 0;
            for (const x of good) {
                const d = /** @type {number} */ (x.distance), t = /** @type {number} */ (x.duration);
                if (d <= 0) continue;
                acc += d * kd;
                bounds.push(acc);
                speeds.push(t > 0 ? (d / t) * kt : NaN);
            }
            // steps with no duration take the trip's average
            const avg = (sumD / sumT) * kt;
            let j = 0;
            for (let i = 0; i < m; i++) {
                const mid = 0.5 * (edges[i] + edges[i + 1]);
                while (j < bounds.length - 1 && bounds[j] < mid) j++;
                const v = speeds[j];
                speed[i] = clamp(Number.isFinite(v) ? v : avg);
            }
            return { speed, source: "steps" };
        }
        const dist = o.distance && o.distance > 0 ? o.distance : total;
        const v = o.duration && o.duration > 0 && dist > 0 ? dist / o.duration : NaN;
        speed.fill(clamp(Number.isFinite(v) ? v : (o.fallbackSpeed ?? PROFILE_DEFAULTS.fallbackSpeed)));
        return { speed, source: Number.isFinite(v) ? "average" : "assumed" };
    }

    return { PROFILE_DEFAULTS, R_EARTH, haversine, cleanPath, cumulative, plan, resample, runningMedian, movingAverage, buildProfile, segmentSpeeds };
});
