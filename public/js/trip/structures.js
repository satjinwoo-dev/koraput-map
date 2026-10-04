// @ts-check
/* ============================================================================
   MapUnite trip — bridges and tunnels on a route's height profile (roadmap Step 9)
   ==============================================================================
   The terrain model (Copernicus 90 m DEM, js/trip/elevation.js) gives the height of
   the GROUND. On a bridge that's the valley floor under the deck; in a tunnel, the
   hillside above it. Left in, a 300 m bridge over a 30 m gully becomes a 30 m
   descent and a 30 m climb that never happen, and the fuel estimate pays for both.
   The road on a bridge or in a tunnel runs at a steady grade from one end to the
   other, so across each one the profile is CLAMPED: the heights are replaced by a
   straight line between the heights just beyond its two ends.

   Where the bridges and tunnels are, in order of trust:
     1. OpenStreetMap — highway ways tagged bridge=* (not "no") or tunnel=yes /
        avalanche_protector within 25 m of the route, one Overpass query per route
        (the route thinned to ≤ 300 points), cached 30 days in Cache Storage
        ("mu-trip-v1", which "Clear my history" deletes), so the same route again —
        or offline — needs no network. Only the route's coordinates are sent.
     2. The heights themselves (detect) — a stretch ≤ 1.5 km long lying at least 8 m
        below (or above) the surrounding ground line, entered and left by a step
        steeper than 15 % between neighbouring samples, with the ground on either side
        no more than 10 % apart: no public road does that; a DEM does exactly that at
        the edges of a bridge or a tunnel. This
        catches structures OSM misses and works offline from the first ride.

   Spans are in metres along the resampled route (resample().s); buildProfile
   (js/trip/profile.js) applies them before its median and smoothing.
   ============================================================================ */
(function (root, factory) {
    if (typeof module === "object" && module.exports) module.exports = factory();
    else { const ns = /** @type {any} */ (root).MUTrip || (/** @type {any} */ (root).MUTrip = {}); ns.structures = factory(); }
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
    "use strict";

    const ENDPOINT = "https://overpass-api.de/api/interpreter";
    const CACHE_NAME = "mu-trip-v1";
    const CACHE_PREFIX = "/__mu/trip/structures/";
    const MAX_AGE = 30 * 86400000;
    const RADIUS = 25;                    // m around the route line
    const MAX_LINE = 300;                 // points in the query line
    const DETECT = Object.freeze({
        maxLength: 1500,                  // m
        minDepth: 8,                      // m below / above the straight line
        steepGrade: 0.15,                 // the slopes into and out of the dip or hump
        maxChordGrade: 0.10,              // the straight line itself (a bridge deck's grade)
        margin: 45                        // m beyond each end (half the DEM's 90 m cell)
    });
    const RAD = Math.PI / 180;

    /**
     * @typedef {{ s0: number, s1: number, kind: "bridge"|"tunnel", source: "osm"|"dem", name?: string }} Span
     */

    /**
     * Find bridges (dips) and tunnels (humps) in raw DEM heights along a route.
     *   1. the ground line: a running median over ±1.5 km — a structure up to 1.5 km long
     *      is less than half of that window, so it can't drag the median;
     *   2. samples ≥ 8 m below (or above) it, in runs;
     *   3. a run is a bridge (tunnel) only if a step steeper than 15 % leads into it and out
     *      of it within two samples of its ends, and the ground on either side is ≤ 10 % apart:
     *      a DEM's cliff at a bridge or portal, not a real road's valley or crest.
     * @param {ArrayLike<number>} s  positions (m) @param {ArrayLike<number>} z  heights (m), finite
     * @param {Partial<typeof DETECT>} [o]
     * @returns {Span[]}
     */
    function detect(s, z, o = {}) {
        const D = { ...DETECT, ...o };
        const n = s.length;
        if (n < 3) return [];
        // 1. ground line
        const base = new Float64Array(n), buf = [];
        let lo = 0, hi = 0;
        for (let i = 0; i < n; i++) {
            while (s[lo] < s[i] - D.maxLength) lo++;
            if (hi < i) hi = i;
            while (hi + 1 < n && s[hi + 1] <= s[i] + D.maxLength) hi++;
            buf.length = 0;
            for (let k = lo; k <= hi; k++) buf.push(z[k]);
            buf.sort((a, b) => a - b);
            base[i] = buf.length % 2 ? buf[buf.length >> 1] : 0.5 * (buf[(buf.length >> 1) - 1] + buf[buf.length >> 1]);
        }
        // 2. runs off the ground line
        const mark = new Int8Array(n);
        for (let i = 0; i < n; i++) { const d = z[i] - base[i]; mark[i] = d <= -D.minDepth ? 1 : d >= D.minDepth ? -1 : 0; }   // 1 = dip, −1 = hump
        /** @type {Span[]} */ const out = [];
        for (let a = 0; a < n; ) {
            if (!mark[a]) { a++; continue; }
            let b = a;
            while (b + 1 < n && mark[b + 1] === mark[a]) b++;
            const sign = mark[a], i = a - 1, j = b + 1;          // the ground just beyond each end
            const kind = sign === 1 ? "bridge" : "tunnel";
            a = b + 1;
            if (i < 0 || j >= n) continue;                        // runs off the route's end: can't tell
            if (s[j] - s[i] > D.maxLength + 2 * (s[1] - s[0])) continue;
            if (Math.abs(z[j] - z[i]) / (s[j] - s[i]) > D.maxChordGrade) continue;
            // 3. cliffs at both ends (within two samples)
            let into = 0, outOf = 0;
            for (let m = i; m < Math.min(i + 2, b); m++) into = Math.max(into, (sign * (z[m] - z[m + 1])) / (s[m + 1] - s[m]));
            for (let m = Math.max(i, j - 2); m < j; m++) outOf = Math.max(outOf, (sign * (z[m + 1] - z[m])) / (s[m + 1] - s[m]));
            if (into < D.steepGrade || outOf < D.steepGrade) continue;
            out.push({ s0: s[i + 1], s1: s[j - 1], kind, source: "dem" });
        }
        return out;
    }

    /**
     * Clamp heights across spans: a straight line between the heights just beyond each end.
     * Mutates and returns `z`. Spans touching the route's ends are clamped from the one side known.
     * @param {ArrayLike<number>} s @param {Float64Array|number[]} z @param {Span[]} spans @param {{ margin?: number }} [o]
     * @returns {{ z: Float64Array|number[], clamped: number }}  clamped: metres of route changed
     */
    function apply(s, z, spans, o = {}) {
        const margin = o.margin ?? DETECT.margin;
        const n = s.length;
        let clamped = 0;
        for (const sp of spans || []) {
            if (!(sp && sp.s1 > sp.s0)) continue;
            const a = sp.s0 - margin, b = sp.s1 + margin;
            let i0 = -1, i1 = -1;
            for (let i = 0; i < n; i++) { if (s[i] <= a) i0 = i; if (i1 < 0 && s[i] >= b) i1 = i; }
            if (i0 < 0 && i1 < 0) continue;
            if (i0 < 0) i0 = 0;
            if (i1 < 0) i1 = n - 1;
            if (i1 - i0 < 2) continue;                    // nothing between the two ends to fix
            const za = z[i0], zb = z[i1];
            for (let k = i0 + 1; k < i1; k++) z[k] = za + ((zb - za) * (s[k] - s[i0])) / (s[i1] - s[i0] || 1);
            clamped += s[i1] - s[i0];
        }
        return { z, clamped };
    }

    /** Merge overlapping spans of the same kind (OSM splits long bridges into several ways). @param {Span[]} spans */
    function merge(spans) {
        const sorted = spans.slice().sort((a, b) => a.s0 - b.s0);
        /** @type {Span[]} */ const out = [];
        for (const sp of sorted) {
            const last = out[out.length - 1];
            if (last && last.kind === sp.kind && sp.s0 <= last.s1 + 10) { last.s1 = Math.max(last.s1, sp.s1); if (!last.name && sp.name) last.name = sp.name; }
            else out.push({ ...sp });
        }
        return out;
    }

    // ------------------------------------------------------------------ OpenStreetMap
    /** Keep at most `max` evenly spread points (first and last always). @param {ArrayLike<number>} lat @param {ArrayLike<number>} lng @param {number} max */
    function thin(lat, lng, max) {
        const n = lat.length, out = [];
        if (!n) return out;
        const step = Math.max(1, (n - 1) / Math.max(1, max - 1));
        for (let f = 0; f < n - 1e-9; f += step) out.push([lat[Math.round(f)], lng[Math.round(f)]]);
        const last = out[out.length - 1];
        if (last[0] !== lat[n - 1] || last[1] !== lng[n - 1]) out.push([lat[n - 1], lng[n - 1]]);
        return out;
    }
    /** @param {number[][]} pts */
    function query(pts) {
        const line = pts.map(([a, b]) => `${a.toFixed(5)},${b.toFixed(5)}`).join(",");
        return `[out:json][timeout:25];(way["highway"]["bridge"]["bridge"!="no"](around:${RADIUS},${line});way["highway"]["tunnel"~"^(yes|avalanche_protector)$"](around:${RADIUS},${line}););out tags geom 500;`;
    }

    /**
     * Overpass JSON → spans along the route.
     * @param {any} json @param {{ lat: ArrayLike<number>, lng: ArrayLike<number>, s: ArrayLike<number> }} rs  resample() output
     * @returns {Span[]}
     */
    function fromOsm(json, rs) {
        const n = rs.s.length;
        if (n < 2) return [];
        const lat0 = rs.lat[0], kx = 111320 * Math.cos(lat0 * RAD), ky = 110540;
        const X = new Float64Array(n), Y = new Float64Array(n);
        for (let i = 0; i < n; i++) { X[i] = (rs.lng[i] - rs.lng[0]) * kx; Y[i] = (rs.lat[i] - lat0) * ky; }
        /** nearest point on the route: { s, d } */
        const project = (/** @type {number} */ la, /** @type {number} */ ln) => {
            const x = (ln - rs.lng[0]) * kx, y = (la - lat0) * ky;
            let bd = Infinity, bs = 0;
            for (let i = 0; i < n - 1; i++) {
                const dx = X[i + 1] - X[i], dy = Y[i + 1] - Y[i], L2 = dx * dx + dy * dy;
                const t = L2 > 0 ? Math.max(0, Math.min(1, ((x - X[i]) * dx + (y - Y[i]) * dy) / L2)) : 0;
                const d = Math.hypot(X[i] + t * dx - x, Y[i] + t * dy - y);
                if (d < bd) { bd = d; bs = rs.s[i] + t * (rs.s[i + 1] - rs.s[i]); }
            }
            return { s: bs, d: bd };
        };
        /** @type {Span[]} */ const spans = [];
        for (const el of (json && Array.isArray(json.elements) ? json.elements : [])) {
            if (!el || el.type !== "way" || !Array.isArray(el.geometry) || el.geometry.length < 2) continue;
            const t = el.tags || {};
            const kind = t.tunnel && t.tunnel !== "no" ? "tunnel" : t.bridge && t.bridge !== "no" ? "bridge" : null;
            if (!kind) continue;
            let wayLen = 0, smin = Infinity, smax = -Infinity, near = 0;
            for (let k = 0; k < el.geometry.length; k++) {
                const p = el.geometry[k];
                if (!p || !Number.isFinite(p.lat) || !Number.isFinite(p.lon)) continue;
                if (k > 0) { const q = el.geometry[k - 1]; wayLen += Math.hypot((p.lon - q.lon) * kx, (p.lat - q.lat) * ky); }
                const pr = project(p.lat, p.lon);
                if (pr.d <= RADIUS + 15) { near++; smin = Math.min(smin, pr.s); smax = Math.max(smax, pr.s); }
            }
            // on the route along its length (not a bridge crossing over or under it), and plausibly matched
            if (near < 2 || smax - smin < 15 || smax - smin > 1.5 * wayLen + 60) continue;
            spans.push({ s0: smin, s1: smax, kind, source: "osm", ...(typeof t.name === "string" && t.name ? { name: t.name.slice(0, 80) } : {}) });
        }
        return merge(spans);
    }

    /** Small stable hash of the query line (cache key). @param {string} str */
    function fnv(str) { let h = 0x811c9dc5; for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619) >>> 0; } return h.toString(16).padStart(8, "0"); }

    /**
     * @param {{ fetch?: typeof fetch|null, caches?: CacheStorage|null, endpoint?: string, timeoutMs?: number, now?: () => number }} [o]
     */
    function createStructures(o = {}) {
        const doFetch = o.fetch !== undefined ? o.fetch : (typeof fetch === "function" ? fetch.bind(globalThis) : null);
        const cacheStorage = o.caches !== undefined ? o.caches : (typeof caches !== "undefined" ? caches : null);
        const endpoint = o.endpoint || ENDPOINT, timeoutMs = o.timeoutMs || 15000, now = o.now || Date.now;
        /**
         * Bridges and tunnels along a resampled route.
         * @param {{ lat: ArrayLike<number>, lng: ArrayLike<number>, s: ArrayLike<number> }} rs
         * @returns {Promise<{ spans: Span[], source: "osm"|"cache"|"stale"|"none" }>}
         */
        async function along(rs) {
            if (!rs || rs.s.length < 2) return { spans: [], source: "none" };
            const pts = thin(rs.lat, rs.lng, MAX_LINE);
            const q = query(pts);
            const key = `${CACHE_PREFIX}${fnv(q)}.json`;
            /** @type {any} */ let cached = null;
            if (cacheStorage) {
                try { const c = await cacheStorage.open(CACHE_NAME); const r = await c.match(key); if (r) cached = await r.json(); } catch { cached = null; }
            }
            if (cached && cached.v === 1 && now() - cached.at < MAX_AGE) return { spans: fromOsm(cached.json, rs), source: "cache" };
            if (doFetch && !(typeof navigator !== "undefined" && navigator.onLine === false)) {
                const ctl = typeof AbortController !== "undefined" ? new AbortController() : null;
                const timer = ctl ? setTimeout(() => ctl.abort(), timeoutMs) : null;
                try {
                    const res = await doFetch(endpoint, { method: "POST", body: `data=${encodeURIComponent(q)}`, headers: { "Content-Type": "application/x-www-form-urlencoded" }, credentials: "omit", signal: ctl ? ctl.signal : undefined });
                    if (res.ok) {
                        const json = await res.json();
                        if (cacheStorage) {
                            try { const c = await cacheStorage.open(CACHE_NAME); await c.put(key, new Response(JSON.stringify({ v: 1, at: now(), json }), { headers: { "Content-Type": "application/json" } })); } catch { /* quota */ }
                        }
                        return { spans: fromOsm(json, rs), source: "osm" };
                    }
                } catch { /* offline or slow */ } finally { if (timer) clearTimeout(timer); }
            }
            if (cached && cached.v === 1) return { spans: fromOsm(cached.json, rs), source: "stale" };
            return { spans: [], source: "none" };
        }
        return { along };
    }

    return { ENDPOINT, CACHE_NAME, DETECT, detect, apply, merge, thin, query, fromOsm, createStructures };
});
