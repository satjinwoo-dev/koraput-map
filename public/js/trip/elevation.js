// @ts-check
/* ============================================================================
   MapUnite trip — terrain heights for a route (Open-Meteo elevation API)
   ==============================================================================
   createElevation({ fetch, caches }).lookup(lat[], lng[]) → heights in metres
   (NaN where unknown) and where they came from.

     - Open-Meteo's /v1/elevation (Copernicus 90 m DEM): free, no key, already in
       the CSP's connect-src. Up to 100 points per request; requests run two at a
       time with an 8 s timeout each.
     - Points are rounded to 4 decimals (~11 m) and remembered: in memory, and in
       Cache Storage ("mu-trip-v1", one JSON blob, capped at 20 000 points ≈ 0.5 MB),
       so a daily commute needs no network at all after the first time.
     - Offline, or the API down: the missing points come back NaN and the caller
       falls back to a flat profile, flagged in the UI ("hills not included").
     - Only coordinates are sent: no identifiers, no cookies (credentials: "omit").
   ============================================================================ */
(function (root, factory) {
    if (typeof module === "object" && module.exports) module.exports = factory();
    else { const ns = /** @type {any} */ (root).MUTrip || (/** @type {any} */ (root).MUTrip = {}); ns.elevation = factory(); }
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
    "use strict";

    const ENDPOINT = "https://api.open-meteo.com/v1/elevation";
    const CACHE_NAME = "mu-trip-v1";              // not "mapunite-*": sw.js deletes those on update
    const CACHE_KEY = "/__mu/trip/elevation.json";
    const BATCH = 100;
    const MAX_MEMORY = 20000;

    /** @param {number} x */
    const r4 = (x) => Math.round(x * 1e4) / 1e4;
    /** @param {number} lat @param {number} lng */
    const keyOf = (lat, lng) => `${r4(lat).toFixed(4)},${r4(lng).toFixed(4)}`;

    /**
     * @param {{ fetch?: typeof fetch|null, caches?: CacheStorage|null, endpoint?: string, timeoutMs?: number, concurrency?: number }} [o]
     */
    function createElevation(o = {}) {
        const doFetch = o.fetch !== undefined ? o.fetch : (typeof fetch === "function" ? fetch.bind(globalThis) : null);
        const cacheStorage = o.caches !== undefined ? o.caches : (typeof caches !== "undefined" ? caches : null);
        const endpoint = o.endpoint || ENDPOINT;
        const timeoutMs = o.timeoutMs || 8000;
        const concurrency = Math.max(1, o.concurrency || 2);
        /** @type {Map<string, number>} */ const mem = new Map();
        let loaded = null, dirty = false, saveTimer = null;

        async function load() {
            if (!loaded) loaded = (async () => {
                if (!cacheStorage) return;
                try {
                    const c = await cacheStorage.open(CACHE_NAME);
                    const r = await c.match(CACHE_KEY);
                    if (!r) return;
                    const obj = await r.json();
                    if (obj && obj.v === 1 && Array.isArray(obj.k) && Array.isArray(obj.z) && obj.k.length === obj.z.length) {
                        for (let i = 0; i < obj.k.length; i++) if (!mem.has(obj.k[i]) && Number.isFinite(obj.z[i])) mem.set(obj.k[i], obj.z[i]);
                    }
                } catch { /* unreadable cache: start empty */ }
            })();
            return loaded;
        }
        function remember(k, z) {
            if (mem.has(k)) mem.delete(k);          // re-insert: Map order = least recently used first
            mem.set(k, z);
            if (mem.size > MAX_MEMORY) { const it = mem.keys(); for (let i = mem.size - MAX_MEMORY; i > 0; i--) mem.delete(it.next().value); }
            dirty = true;
        }
        function scheduleSave() {
            if (!cacheStorage || !dirty || saveTimer) return;
            saveTimer = setTimeout(async () => {
                saveTimer = null;
                if (!dirty) return;
                dirty = false;
                try {
                    const c = await cacheStorage.open(CACHE_NAME);
                    const k = [...mem.keys()], z = k.map((x) => mem.get(x));
                    await c.put(CACHE_KEY, new Response(JSON.stringify({ v: 1, k, z }), { headers: { "Content-Type": "application/json" } }));
                } catch { /* quota: memory still works */ }
            }, 1500);
        }

        /** @param {string[]} keys @returns {Promise<number[]|null>} */
        async function request(keys) {
            if (!doFetch) return null;
            const lats = keys.map((k) => k.split(",")[0]).join(","), lngs = keys.map((k) => k.split(",")[1]).join(",");
            const ctl = typeof AbortController !== "undefined" ? new AbortController() : null;
            const t = ctl ? setTimeout(() => ctl.abort(), timeoutMs) : null;
            try {
                const res = await doFetch(`${endpoint}?latitude=${lats}&longitude=${lngs}`, { credentials: "omit", signal: ctl ? ctl.signal : undefined });
                if (!res.ok) return null;
                const j = await res.json();
                return j && Array.isArray(j.elevation) && j.elevation.length === keys.length ? j.elevation : null;
            } catch { return null; } finally { if (t) clearTimeout(t); }
        }

        /**
         * @param {ArrayLike<number>} lat @param {ArrayLike<number>} lng
         * @param {{ signal?: AbortSignal }} [opts]
         * @returns {Promise<{ z: Float64Array, source: "dem"|"partial"|"none", fetched: number, cached: number, missing: number }>}
         */
        async function lookup(lat, lng, opts = {}) {
            await load();
            const n = lat.length, z = new Float64Array(n).fill(NaN);
            const keys = new Array(n);
            /** @type {string[]} */ const need = [];
            const needSet = new Set();
            let cached = 0;
            for (let i = 0; i < n; i++) {
                const k = keyOf(lat[i], lng[i]);
                keys[i] = k;
                const v = mem.get(k);
                if (v !== undefined) { z[i] = v; cached++; }
                else if (!needSet.has(k)) { needSet.add(k); need.push(k); }
            }
            let fetched = 0;
            if (need.length && !(typeof navigator !== "undefined" && navigator.onLine === false)) {
                const batches = [];
                for (let i = 0; i < need.length; i += BATCH) batches.push(need.slice(i, i + BATCH));
                let next = 0;
                const worker = async () => {
                    while (next < batches.length) {
                        if (opts.signal && opts.signal.aborted) return;
                        const b = batches[next++];
                        const e = await request(b);
                        if (!e) continue;
                        for (let i = 0; i < b.length; i++) if (Number.isFinite(e[i])) { remember(b[i], e[i]); fetched++; }
                    }
                };
                await Promise.all(Array.from({ length: Math.min(concurrency, batches.length) }, worker));
                for (let i = 0; i < n; i++) if (Number.isNaN(z[i])) { const v = mem.get(keys[i]); if (v !== undefined) z[i] = v; }
                scheduleSave();
            }
            let missing = 0;
            for (let i = 0; i < n; i++) if (Number.isNaN(z[i])) missing++;
            return { z, source: missing === 0 ? "dem" : missing === n ? "none" : "partial", fetched, cached, missing };
        }

        return { lookup, get size() { return mem.size; } };
    }

    return { ENDPOINT, CACHE_NAME, BATCH, keyOf, createElevation };
});
