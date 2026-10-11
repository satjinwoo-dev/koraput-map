// @ts-check
/* ============================================================================
   MapUnite Master AI — geometry for the agents (pure, SI: metres, degrees)
   ==============================================================================
   Shared by the corridor, weather, traffic, terrain, blackspot and POI agents
   so they all agree on what "1.2 km ahead" means.

     metres(a, b, c, d)            great-circle distance
     bearing(a, b, c, d)           initial bearing, degrees 0–360
     offset(lat, lng, brg, m)      point m metres away on a bearing
     cumulative(path)              [0, d01, d01+d12, …]
     createCursor()                follows the rider along a route without rescanning it
     slice(path, cum, i, t, m)     the route from the rider's projection, m metres ahead
     resample(line, stepM)         points every stepM metres, each with its s (m along)
     project(lat, lng, line, cum)  where a point falls along a line: { s, d }
     turnRate(line, windowM)       heading change per window (hairpins, ghats)
     tileOf / tileCentre           the 0.02° (≈ 2.2 km) tiles the POI cache uses
   Local plane maths (equirectangular) for anything under ~10 km.
   ============================================================================ */
(function (root, factory) {
    if (typeof module === "object" && module.exports) module.exports = factory();
    else { const W = /** @type {any} */ (root); (W.MUMaster || (W.MUMaster = {})).geo = factory(); }
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
    "use strict";

    const R = 6371008.8, RAD = Math.PI / 180;
    const TILE = 0.02;

    /** @param {number} lat1 @param {number} lng1 @param {number} lat2 @param {number} lng2 */
    function metres(lat1, lng1, lat2, lng2) {
        const dLat = (lat2 - lat1) * RAD, dLng = (lng2 - lng1) * RAD;
        const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * RAD) * Math.cos(lat2 * RAD) * Math.sin(dLng / 2) ** 2;
        return 2 * R * Math.asin(Math.min(1, Math.sqrt(a)));
    }
    /** @param {number} lat1 @param {number} lng1 @param {number} lat2 @param {number} lng2 */
    function bearing(lat1, lng1, lat2, lng2) {
        const y = Math.sin((lng2 - lng1) * RAD) * Math.cos(lat2 * RAD);
        const x = Math.cos(lat1 * RAD) * Math.sin(lat2 * RAD) - Math.sin(lat1 * RAD) * Math.cos(lat2 * RAD) * Math.cos((lng2 - lng1) * RAD);
        return (Math.atan2(y, x) / RAD + 360) % 360;
    }
    /** @param {number} lat @param {number} lng @param {number} brgDeg @param {number} m @returns {[number, number]} */
    function offset(lat, lng, brgDeg, m) {
        const d = m / R, b = brgDeg * RAD, p1 = lat * RAD, l1 = lng * RAD;
        const p2 = Math.asin(Math.sin(p1) * Math.cos(d) + Math.cos(p1) * Math.sin(d) * Math.cos(b));
        const l2 = l1 + Math.atan2(Math.sin(b) * Math.sin(d) * Math.cos(p1), Math.cos(d) - Math.sin(p1) * Math.sin(p2));
        return [p2 / RAD, ((l2 / RAD + 540) % 360) - 180];
    }
    /** @param {ArrayLike<ArrayLike<number>>} path @returns {number[]} */
    function cumulative(path) {
        const out = [0];
        for (let i = 1; i < path.length; i++) out.push(out[i - 1] + metres(path[i - 1][0], path[i - 1][1], path[i][0], path[i][1]));
        return out;
    }

    /**
     * Closest point of segment a→b to p (local plane). t in [0,1], d metres.
     * @param {number} lat @param {number} lng @param {ArrayLike<number>} a @param {ArrayLike<number>} b
     */
    function onSegment(lat, lng, a, b) {
        const kx = Math.cos(lat * RAD) * R * RAD, ky = R * RAD;
        const ax = (a[1] - lng) * kx, ay = (a[0] - lat) * ky, bx = (b[1] - lng) * kx, by = (b[0] - lat) * ky;
        const dx = bx - ax, dy = by - ay, len2 = dx * dx + dy * dy;
        const t = len2 > 0 ? Math.max(0, Math.min(1, -(ax * dx + ay * dy) / len2)) : 0;
        return { t, d: Math.hypot(ax + t * dx, ay + t * dy) };
    }

    /**
     * Where a point falls along a line: s = metres from the start, d = metres off it.
     * @param {number} lat @param {number} lng @param {ArrayLike<ArrayLike<number>>} line @param {number[]} [cum]
     */
    function project(lat, lng, line, cum) {
        const c = cum || cumulative(line);
        if (line.length === 1) return { s: 0, d: metres(lat, lng, line[0][0], line[0][1]), i: 0, t: 0 };
        let best = { s: 0, d: Infinity, i: 0, t: 0 };
        for (let i = 0; i < line.length - 1; i++) {
            const r = onSegment(lat, lng, line[i], line[i + 1]);
            if (r.d < best.d) best = { s: c[i] + r.t * (c[i + 1] - c[i]), d: r.d, i, t: r.t };
        }
        return best;
    }

    /**
     * Follows the rider along one route: searches near the last match first, the
     * whole route only when lost. O(window) per fix instead of O(route).
     */
    function createCursor() {
        /** @type {any} */ let ref = null;
        /** @type {number[]} */ let cum = [];
        let idx = 0;
        return {
            /**
             * @param {ArrayLike<ArrayLike<number>>} path @param {number} lat @param {number} lng
             * @returns {{ i: number, t: number, d: number, s: number, cum: number[] }}
             */
            locate(path, lat, lng) {
                if (path !== ref) { ref = path; cum = cumulative(path); idx = 0; }
                const n = path.length;
                let best = { i: idx, t: 0, d: Infinity };
                const scan = (/** @type {number} */ from, /** @type {number} */ to) => {
                    for (let i = Math.max(0, from); i < Math.min(n - 1, to); i++) {
                        const r = onSegment(lat, lng, path[i], path[i + 1]);
                        if (r.d < best.d) best = { i, t: r.t, d: r.d };
                    }
                };
                scan(idx - 15, idx + 300);
                if (best.d > 150) scan(0, n);                               // jumped (tunnel, GPS gap, rejoined later)
                idx = best.i;
                return { ...best, s: n > 1 ? cum[best.i] + best.t * (cum[best.i + 1] - cum[best.i]) : 0, cum };
            },
            reset() { ref = null; cum = []; idx = 0; }
        };
    }

    /**
     * The route ahead of a projection, `lengthM` long, starting at the projected point.
     * @param {ArrayLike<ArrayLike<number>>} path @param {number[]} cum @param {number} i @param {number} t @param {number} lengthM
     * @returns {{ line: Array<[number, number]>, lengthM: number }}
     */
    function slice(path, cum, i, t, lengthM) {
        if (path.length < 2) return { line: path.length ? [[path[0][0], path[0][1]]] : [], lengthM: 0 };
        const a = path[i], b = path[Math.min(i + 1, path.length - 1)];
        /** @type {Array<[number, number]>} */ const line = [[a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]];
        const s0 = cum[i] + t * (cum[Math.min(i + 1, cum.length - 1)] - cum[i]);
        for (let k = i + 1; k < path.length; k++) {
            const sk = cum[k] - s0;
            if (sk >= lengthM) {
                const prev = line[line.length - 1], segLen = cum[k] - Math.max(s0, cum[k - 1]);
                const f = segLen > 0 ? (lengthM - (Math.max(s0, cum[k - 1]) - s0)) / segLen : 0;
                line.push([prev[0] + (path[k][0] - prev[0]) * f, prev[1] + (path[k][1] - prev[1]) * f]);
                return { line, lengthM };
            }
            line.push([path[k][0], path[k][1]]);
        }
        return { line, lengthM: cum[cum.length - 1] - s0 };
    }

    /**
     * Points every stepM metres along a line (first and last included), each [lat, lng, s].
     * @param {ArrayLike<ArrayLike<number>>} line @param {number} stepM
     * @returns {Array<[number, number, number]>}
     */
    function resample(line, stepM) {
        if (!line.length) return [];
        const cum = cumulative(line), total = cum[cum.length - 1];
        /** @type {Array<[number, number, number]>} */ const out = [];
        let k = 0;
        for (let s = 0; s <= total + 1e-6; s += stepM) {
            while (k < line.length - 2 && cum[k + 1] < s) k++;
            const seg = cum[k + 1] - cum[k], f = seg > 0 ? (s - cum[k]) / seg : 0;
            const a = line[k], b = line[Math.min(k + 1, line.length - 1)];
            out.push([a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f, Math.round(s)]);
        }
        if (total - out[out.length - 1][2] > stepM * 0.25) out.push([line[line.length - 1][0], line[line.length - 1][1], Math.round(total)]);
        return out;
    }

    /**
     * Heading change (degrees, absolute sum) inside each window of `windowM`
     * metres, sampled every stepM. Hairpins show up as ≥ 100° within 80 m.
     * @param {ArrayLike<ArrayLike<number>>} line @param {number} windowM @param {number} [stepM]
     * @returns {Array<{ s: number, turnDeg: number }>}
     */
    function turnRate(line, windowM, stepM = 10) {
        const pts = resample(line, stepM);
        if (pts.length < 3) return [];
        const hd = [];
        for (let i = 0; i < pts.length - 1; i++) hd.push(bearing(pts[i][0], pts[i][1], pts[i + 1][0], pts[i + 1][1]));
        const dturn = [0];
        for (let i = 1; i < hd.length; i++) { let d = Math.abs(hd[i] - hd[i - 1]); if (d > 180) d = 360 - d; dturn.push(d); }
        const w = Math.max(1, Math.round(windowM / stepM));
        const out = [];
        let acc = 0;
        for (let i = 0; i < dturn.length; i++) {
            acc += dturn[i];
            if (i >= w) acc -= dturn[i - w];
            if (i >= w - 1) out.push({ s: pts[i][2], turnDeg: Math.round(acc) });
        }
        return out;
    }

    /**
     * Sun elevation in degrees (NOAA general solar position; ±0.5°). Same maths as lib/master/sun.js.
     * @param {number} lat @param {number} lng @param {number} tMs
     */
    function sunElevation(lat, lng, tMs) {
        const d = new Date(tMs);
        const doy = Math.floor((tMs - Date.UTC(d.getUTCFullYear(), 0, 1)) / 86400000);
        const hour = d.getUTCHours() + d.getUTCMinutes() / 60 + d.getUTCSeconds() / 3600;
        const g = (2 * Math.PI / 365) * (doy + (hour - 12) / 24);
        const eq = 229.18 * (0.000075 + 0.001868 * Math.cos(g) - 0.032077 * Math.sin(g) - 0.014615 * Math.cos(2 * g) - 0.040849 * Math.sin(2 * g));
        const decl = 0.006918 - 0.399912 * Math.cos(g) + 0.070257 * Math.sin(g) - 0.006758 * Math.cos(2 * g) + 0.000907 * Math.sin(2 * g) - 0.002697 * Math.cos(3 * g) + 0.00148 * Math.sin(3 * g);
        const ha = ((hour * 60 + eq + 4 * lng) / 4 - 180) * RAD;
        const cz = Math.sin(lat * RAD) * Math.sin(decl) + Math.cos(lat * RAD) * Math.cos(decl) * Math.cos(ha);
        return 90 - Math.acos(Math.max(-1, Math.min(1, cz))) / RAD;
    }
    /** @param {number} lat @param {number} lng @param {number} tMs @returns {"day"|"dusk"|"dark"} */
    const light = (lat, lng, tMs) => { const e = sunElevation(lat, lng, tMs); return e >= 0 ? "day" : e >= -6 ? "dusk" : "dark"; };

    /** @param {number} lat @param {number} lng */
    const tileOf = (lat, lng) => `${Math.floor(lat / TILE)}:${Math.floor(lng / TILE)}`;
    /** @param {string} key @returns {[number, number]} */
    function tileCentre(key) {
        const [i, j] = key.split(":").map(Number);
        return [Math.round(((i + 0.5) * TILE) * 1e5) / 1e5, Math.round(((j + 0.5) * TILE) * 1e5) / 1e5];
    }

    return { R, RAD, TILE, metres, bearing, offset, cumulative, project, createCursor, slice, resample, turnRate, sunElevation, light, tileOf, tileCentre };
});
