// @ts-check
/* ============================================================================
   MapUnite pitstops — fuel pumps and chargers along a route (OpenStreetMap)
   ==============================================================================
   createStations({ fetch, caches }).along(route) → stations projected onto the
   route: { id, name, brand, kinds: ["fuel"] | ["ev"] | both, lat, lng, s (m along
   the route), offRoute (m) }.

     - One Overpass API query per route: amenity=fuel and amenity=charging_station
       within 1.5 km of the route line (the line simplified to ≤ 90 points).
     - Results are cached in Cache Storage ("mu-pitstop-v1") for 7 days, keyed by
       the route's rounded shape, so the same ride again (or offline) needs no
       network.
     - Offline, or the API down: an empty list with source "none"; the planner
       then suggests a stretch of road instead of a named station.
     - Only the route's coordinates are sent; no identifiers.
   CSP: add https://overpass-api.de to connect-src (server.js).
   ============================================================================ */
(function (root, factory) {
    if (typeof module === "object" && module.exports) module.exports = factory();
    else { const ns = /** @type {any} */ (root).MUPitstop || (/** @type {any} */ (root).MUPitstop = {}); ns.stations = factory(); }
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
    "use strict";

    const ENDPOINT = "https://overpass-api.de/api/interpreter";
    const CACHE_NAME = "mu-pitstop-v1";               // not "mapunite-*": sw.js deletes those on update
    const MAX_AGE = 7 * 86400000;
    const RADIUS = 1500;                              // m around the route
    const R = 6371008.8, RAD = Math.PI / 180;

    /**
     * Keep at most `max` points, evenly spread, always the first and last.
     * @param {ArrayLike<number>} lat @param {ArrayLike<number>} lng @param {number} max
     */
    function thin(lat, lng, max) {
        const n = lat.length, out = [];
        if (!n) return out;
        const step = Math.max(1, (n - 1) / Math.max(1, max - 1));
        for (let f = 0; f < n - 1e-9; f += step) out.push([lat[Math.round(f)], lng[Math.round(f)]]);
        const last = out[out.length - 1];
        if (!last || last[0] !== lat[n - 1] || last[1] !== lng[n - 1]) out.push([lat[n - 1], lng[n - 1]]);
        return out;
    }

    /** The Overpass QL for a thinned route line. @param {number[][]} pts @param {number} [radius] */
    function query(pts, radius = RADIUS) {
        const line = pts.map(([a, b]) => `${a.toFixed(5)},${b.toFixed(5)}`).join(",");
        return `[out:json][timeout:25];(node["amenity"="fuel"](around:${radius},${line});way["amenity"="fuel"](around:${radius},${line});node["amenity"="charging_station"](around:${radius},${line}););out center tags 300;`;
    }

    /**
     * Overpass JSON → stations (unprojected). Pumps that also have chargers count as both.
     * @param {any} json
     */
    function parse(json) {
        const out = [];
        for (const el of (json && Array.isArray(json.elements) ? json.elements : [])) {
            const lat = Number(el.lat ?? (el.center && el.center.lat)), lng = Number(el.lon ?? (el.center && el.center.lon));
            if (!Number.isFinite(lat) || !Number.isFinite(lng)) continue;
            const t = el.tags || {};
            const kinds = [];
            if (t.amenity === "fuel") kinds.push("fuel");
            if (t.amenity === "charging_station" || /^(yes|true)$/i.test(t["fuel:electricity"] || "") || Object.keys(t).some((k) => k.startsWith("socket:"))) kinds.push("ev");
            if (!kinds.length) continue;
            const name = String(t.name || t.brand || t.operator || (kinds[0] === "ev" ? "Charging point" : "Fuel station")).slice(0, 80);
            out.push({ id: `${el.type || "node"}/${el.id}`, name, brand: t.brand ? String(t.brand).slice(0, 40) : "", kinds: [...new Set(kinds)], lat, lng, open24: t.opening_hours === "24/7" });
        }
        return out;
    }

    /**
     * Project stations onto the route samples: s along the route and the distance off it.
     * Pumps more than `maxOff` from the route are dropped; duplicates within 60 m merge.
     * @param {any[]} list @param {{ lat: ArrayLike<number>, lng: ArrayLike<number>, s: ArrayLike<number> }} route @param {number} [maxOff]
     */
    function project(list, route, maxOff = RADIUS * 1.2) {
        const n = route.lat.length, out = [];
        for (const st of list) {
            let best = Infinity, bestS = 0;
            const k = Math.cos(st.lat * RAD) * R * RAD;
            for (let i = 0; i < n - 1; i++) {
                const ax = (route.lng[i] - st.lng) * k, ay = (route.lat[i] - st.lat) * R * RAD;
                const bx = (route.lng[i + 1] - st.lng) * k, by = (route.lat[i + 1] - st.lat) * R * RAD;
                const dx = bx - ax, dy = by - ay, L2 = dx * dx + dy * dy;
                const t = L2 > 0 ? Math.min(1, Math.max(0, -(ax * dx + ay * dy) / L2)) : 0;
                const px = ax + dx * t, py = ay + dy * t, d = Math.hypot(px, py);
                if (d < best) { best = d; bestS = route.s[i] + (route.s[i + 1] - route.s[i]) * t; }
            }
            if (best <= maxOff) out.push({ ...st, s: bestS, offRoute: best });
        }
        out.sort((a, b) => a.s - b.s);
        const merged = [];
        for (const st of out) {
            const near = merged.find((x) => Math.abs(x.s - st.s) < 60 && Math.hypot((x.lat - st.lat) * 111e3, (x.lng - st.lng) * 111e3 * Math.cos(st.lat * RAD)) < 60);
            if (near) { near.kinds = [...new Set([...near.kinds, ...st.kinds])]; if (/^(Fuel station|Charging point)$/.test(near.name)) near.name = st.name; }
            else merged.push({ ...st });
        }
        return merged;
    }

    /** Cache key for a route: its thinned shape at ~1 km resolution. @param {number[][]} pts */
    function routeKey(pts) {
        let hsh = 2166136261;
        const str = pts.map(([a, b]) => `${a.toFixed(2)},${b.toFixed(2)}`).join(";");
        for (let i = 0; i < str.length; i++) { hsh ^= str.charCodeAt(i); hsh = Math.imul(hsh, 16777619); }
        return `/__mu/pitstop/${(hsh >>> 0).toString(16)}.json`;
    }

    /**
     * @param {{ fetch?: typeof fetch|null, caches?: CacheStorage|null, endpoint?: string, timeoutMs?: number, now?: () => number }} [o]
     */
    function createStations(o = {}) {
        const doFetch = o.fetch !== undefined ? o.fetch : (typeof fetch === "function" ? fetch.bind(globalThis) : null);
        const cs = o.caches !== undefined ? o.caches : (typeof caches !== "undefined" ? caches : null);
        const endpoint = o.endpoint || ENDPOINT, timeoutMs = o.timeoutMs || 20000, now = o.now || Date.now;

        /**
         * @param {{ lat: ArrayLike<number>, lng: ArrayLike<number>, s: ArrayLike<number> }} route
         * @returns {Promise<{ stations: any[], source: "network"|"cache"|"stale"|"none" }>}
         */
        async function along(route) {
            const pts = thin(route.lat, route.lng, 90);
            if (pts.length < 2) return { stations: [], source: "none" };
            const key = routeKey(pts);
            let cached = null;
            try {
                if (cs) { const c = await cs.open(CACHE_NAME); const r = await c.match(key); if (r) cached = await r.json(); }
            } catch { cached = null; }
            if (cached && cached.v === 1 && now() - cached.at < MAX_AGE) return { stations: project(cached.list, route), source: "cache" };
            const offline = typeof navigator !== "undefined" && navigator.onLine === false;
            if (doFetch && !offline) {
                const ctl = typeof AbortController !== "undefined" ? new AbortController() : null;
                const t = ctl ? setTimeout(() => ctl.abort(), timeoutMs) : null;
                try {
                    const res = await doFetch(endpoint, { method: "POST", credentials: "omit", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: `data=${encodeURIComponent(query(pts))}`, signal: ctl ? ctl.signal : undefined });
                    if (res.ok) {
                        const list = parse(await res.json());
                        if (cs) { try { const c = await cs.open(CACHE_NAME); await c.put(key, new Response(JSON.stringify({ v: 1, at: now(), list }), { headers: { "Content-Type": "application/json" } })); } catch { /* quota */ } }
                        return { stations: project(list, route), source: "network" };
                    }
                } catch { /* offline / timeout: fall through */ } finally { if (t) clearTimeout(t); }
            }
            if (cached && cached.v === 1) return { stations: project(cached.list, route), source: "stale" };
            return { stations: [], source: "none" };
        }
        return { along };
    }

    return { ENDPOINT, CACHE_NAME, RADIUS, thin, query, parse, project, routeKey, createStations };
});
