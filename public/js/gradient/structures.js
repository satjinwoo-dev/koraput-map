// @ts-check
/* ============================================================================
   MapUnite gradient — bridges and tunnels along a route (OpenStreetMap)
   ==============================================================================
   createStructures({ fetch, caches }).along(path) → { ways, source }
     ways: [{ id, kind: "bridge"|"tunnel", name, coords: [[lat, lng], …] }]
     source: "network" | "cache" | "stale" | "none"

     - One Overpass query per route: highway ways tagged bridge=* or tunnel=*
       (or covered=yes) within ~25 m of the route line. The line is simplified
       (Douglas–Peucker, 8 m; more if the route is very long) so the query stays
       small but still follows the road closely enough for a 25 m buffer.
     - Cached in Cache Storage ("mu-gradient-v1") for 30 days, keyed by the route's
       rounded shape: bridges don't move, and the same ride works offline.
     - Offline with nothing cached: source "none". The gradient still runs; only
       the DEM spike detector looks for structures then, and the chart says so.
     - Only the route's coordinates are sent; no identifiers, no cookies.
   CSP: https://overpass-api.de is already in connect-src (Step 8 pitstops).
   ============================================================================ */
(function (root, factory) {
    if (typeof module === "object" && module.exports) module.exports = factory();
    else { const ns = /** @type {any} */ (root).MUGradient || (/** @type {any} */ (root).MUGradient = {}); ns.structures = factory(); }
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
    "use strict";

    const ENDPOINT = "https://overpass-api.de/api/interpreter";
    const CACHE_NAME = "mu-gradient-v1";              // not "mapunite-*": sw.js deletes those on update
    const MAX_AGE = 30 * 86400000;
    const MAX_POINTS = 1200;
    const R = 6371008.8, RAD = Math.PI / 180;

    /**
     * Douglas–Peucker in metres (iterative). Tolerance grows until ≤ maxPoints remain.
     * @param {ArrayLike<ArrayLike<number>>} path [[lat, lng], …] @param {number} [tol] m @param {number} [maxPoints]
     * @returns {{ pts: number[][], tol: number }}
     */
    function simplify(path, tol = 8, maxPoints = MAX_POINTS) {
        const P = [];
        for (let i = 0; i < (path ? path.length : 0); i++) { const p = path[i]; if (p && Number.isFinite(Number(p[0])) && Number.isFinite(Number(p[1]))) P.push([Number(p[0]), Number(p[1])]); }
        if (P.length <= 2) return { pts: P, tol };
        const lat0 = P.reduce((a, p) => a + p[0], 0) / P.length;
        const kx = Math.cos(lat0 * RAD) * R * RAD, ky = R * RAD;
        const X = P.map((p) => p[1] * kx), Y = P.map((p) => p[0] * ky);
        const run = (t) => {
            const keep = new Uint8Array(P.length); keep[0] = keep[P.length - 1] = 1;
            const stack = [[0, P.length - 1]];
            while (stack.length) {
                const [a, b] = /** @type {number[]} */ (stack.pop());
                let best = -1, idx = -1;
                const dx = X[b] - X[a], dy = Y[b] - Y[a], L2 = dx * dx + dy * dy;
                for (let i = a + 1; i < b; i++) {
                    const tt = L2 > 0 ? Math.max(0, Math.min(1, ((X[i] - X[a]) * dx + (Y[i] - Y[a]) * dy) / L2)) : 0;
                    const d = Math.hypot(X[a] + dx * tt - X[i], Y[a] + dy * tt - Y[i]);
                    if (d > best) { best = d; idx = i; }
                }
                if (best > t && idx > 0) { keep[idx] = 1; stack.push([a, idx], [idx, b]); }
            }
            return P.filter((_, i) => keep[i]);
        };
        let t = tol, pts = run(t);
        while (pts.length > maxPoints && t < 200) { t *= 1.5; pts = run(t); }
        return { pts, tol: t };
    }

    /** The Overpass QL. @param {number[][]} pts @param {number} radius m */
    function query(pts, radius) {
        const line = pts.map(([a, b]) => `${a.toFixed(5)},${b.toFixed(5)}`).join(",");
        const r = Math.round(radius);
        return `[out:json][timeout:30];(way["highway"]["bridge"]["bridge"!="no"](around:${r},${line});way["highway"]["tunnel"]["tunnel"!="no"](around:${r},${line});way["highway"]["covered"="yes"](around:${r},${line}););out tags geom 3000;`;
    }

    /**
     * Overpass JSON → ways.
     * @param {any} json
     * @returns {Array<{ id: string, kind: "bridge"|"tunnel", name: string, coords: number[][] }>}
     */
    function parse(json) {
        const out = [];
        for (const el of (json && Array.isArray(json.elements) ? json.elements : [])) {
            if (el.type !== "way" || !Array.isArray(el.geometry) || el.geometry.length < 2) continue;
            const t = el.tags || {};
            const isTunnel = (t.tunnel && t.tunnel !== "no") || t.covered === "yes";
            const isBridge = t.bridge && t.bridge !== "no";
            if (!isTunnel && !isBridge) continue;
            const kind = isBridge && !isTunnel ? "bridge" : "tunnel";
            const coords = el.geometry.map((g) => [Number(g.lat), Number(g.lon)]).filter((c) => Number.isFinite(c[0]) && Number.isFinite(c[1]));
            if (coords.length < 2) continue;
            const name = String(t["bridge:name"] || t["tunnel:name"] || t.name || t.ref || "").slice(0, 80);
            out.push({ id: `way/${el.id}`, kind, name, coords });
        }
        return /** @type {any} */ (out);
    }

    /** Cache key: the route's simplified shape at ~1 km resolution. @param {number[][]} pts */
    function routeKey(pts) {
        let hsh = 2166136261;
        const str = pts.map(([a, b]) => `${a.toFixed(2)},${b.toFixed(2)}`).join(";") + `|${pts.length > 1 ? `${pts[0][0].toFixed(4)},${pts[pts.length - 1][1].toFixed(4)}` : ""}`;
        for (let i = 0; i < str.length; i++) { hsh ^= str.charCodeAt(i); hsh = Math.imul(hsh, 16777619); }
        return `/__mu/gradient/${(hsh >>> 0).toString(16)}.json`;
    }

    /**
     * @param {{ fetch?: typeof fetch|null, caches?: CacheStorage|null, endpoint?: string, timeoutMs?: number, now?: () => number, online?: () => boolean }} [o]
     */
    function createStructures(o = {}) {
        const doFetch = o.fetch !== undefined ? o.fetch : (typeof fetch === "function" ? fetch.bind(globalThis) : null);
        const cs = o.caches !== undefined ? o.caches : (typeof caches !== "undefined" ? caches : null);
        const endpoint = o.endpoint || ENDPOINT, timeoutMs = o.timeoutMs || 25000, now = o.now || Date.now;
        const online = o.online || (() => !(typeof navigator !== "undefined" && navigator.onLine === false));

        /**
         * @param {ArrayLike<ArrayLike<number>>} path
         * @returns {Promise<{ ways: any[], source: "network"|"cache"|"stale"|"none" }>}
         */
        async function along(path) {
            const { pts, tol } = simplify(path);
            if (pts.length < 2) return { ways: [], source: "none" };
            const key = routeKey(pts);
            let cached = null;
            try { if (cs) { const c = await cs.open(CACHE_NAME); const r = await c.match(key); if (r) cached = await r.json(); } } catch { cached = null; }
            if (cached && cached.v === 1 && now() - cached.at < MAX_AGE) return { ways: cached.ways, source: "cache" };
            if (doFetch && online()) {
                const ctl = typeof AbortController !== "undefined" ? new AbortController() : null;
                const t = ctl ? setTimeout(() => ctl.abort(), timeoutMs) : null;
                try {
                    const res = await doFetch(endpoint, { method: "POST", credentials: "omit", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: `data=${encodeURIComponent(query(pts, tol + 17))}`, signal: ctl ? ctl.signal : undefined });
                    if (res.ok) {
                        const ways = parse(await res.json());
                        if (cs) { try { const c = await cs.open(CACHE_NAME); await c.put(key, new Response(JSON.stringify({ v: 1, at: now(), ways }), { headers: { "Content-Type": "application/json" } })); } catch { /* quota */ } }
                        return { ways, source: "network" };
                    }
                } catch { /* offline / timeout */ } finally { if (t) clearTimeout(t); }
            }
            if (cached && cached.v === 1) return { ways: cached.ways, source: "stale" };
            return { ways: [], source: "none" };
        }
        return { along };
    }

    return { ENDPOINT, CACHE_NAME, MAX_AGE, simplify, query, parse, routeKey, createStructures };
});
