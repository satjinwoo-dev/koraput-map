// @ts-check
/* ============================================================================
   MapUnite trip — terrain heights for a route (MapUnite's own 30 m terrain model)
   ==============================================================================
   createElevation({ fetch, caches }).lookup(lat[], lng[]) → heights in metres
   (NaN where unknown) and where they came from.

     - The server's POST /api/elevation (lib/elevation/dem-store.js): Copernicus
       GLO-30 (ESA) or NASADEM (NASA), 30 m, self-hosted for the pilot corridors
       (Koraput – Araku, Rourkela). Replaces Open-Meteo's 90 m elevation API,
       whose free plan isn't for commercial use. Up to 500 points per request;
       requests run two at a time with an 8 s timeout each.
     - Outside the corridors the server answers null: the point stays NaN and the
       caller falls back to a flat profile, flagged in the UI ("hills not
       included"). No other source is asked; nothing is made up.
     - Points are rounded to 4 decimals (~11 m) and remembered: in memory, and in
       Cache Storage ("mu-trip-v1", one JSON blob, capped at 20 000 points ≈ 0.5 MB),
       so a daily commute needs no network at all after the first time. The blob
       key changed with the 30 m model, so no 90 m height is ever mixed in.
     - Only coordinates are sent: no identifiers, no cookies (credentials: "omit").
   ============================================================================ */
(function (root, factory) {
    if (typeof module === "object" && module.exports) module.exports = factory();
    else { const ns = /** @type {any} */ (root).MUTrip || (/** @type {any} */ (root).MUTrip = {}); ns.elevation = factory(); }
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
    "use strict";

    // the app's server (the Android app sets window.MU_SERVER_ORIGIN; the web app is same-origin)
    const ORIGIN = (() => {
        const o = typeof globalThis !== "undefined" ? /** @type {any} */ (globalThis).MU_SERVER_ORIGIN : "";
        return typeof o === "string" && /^https?:\/\/[^/\s]+$/.test(o) ? o : "";
    })();
    const ENDPOINT = `${ORIGIN}/api/elevation`;
    const CACHE_NAME = "mu-trip-v1";              // not "mapunite-*": sw.js deletes those on update
    const CACHE_KEY = "/__mu/trip/elevation-30m.json";   // was elevation.json (Open-Meteo 90 m): left behind, never read
    const BATCH = 500;
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
        /** @type {Set<string>} */ const credits = new Set();       // the licence's credit line(s) for the heights we hold
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
                        if (Array.isArray(obj.a)) for (const a of obj.a) if (typeof a === "string") credits.add(a);
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
                    await c.put(CACHE_KEY, new Response(JSON.stringify({ v: 1, k, z, a: [...credits] }), { headers: { "Content-Type": "application/json" } }));
                } catch { /* quota: memory still works */ }
            }, 1500);
        }

        /** @param {string[]} keys @returns {Promise<Array<number|null>|null>} */
        async function request(keys) {
            if (!doFetch) return null;
            const body = JSON.stringify({ lat: keys.map((k) => Number(k.split(",")[0])), lng: keys.map((k) => Number(k.split(",")[1])) });
            const ctl = typeof AbortController !== "undefined" ? new AbortController() : null;
            const t = ctl ? setTimeout(() => ctl.abort(), timeoutMs) : null;
            try {
                const res = await doFetch(endpoint, { method: "POST", headers: { "Content-Type": "application/json" }, body, credentials: "omit", signal: ctl ? ctl.signal : undefined });
                if (!res.ok) return null;
                const j = await res.json();
                if (!j || !Array.isArray(j.elevation) || j.elevation.length !== keys.length) return null;
                if (Array.isArray(j.attribution)) for (const a of j.attribution) if (typeof a === "string" && a && !credits.has(a)) { credits.add(a); dirty = true; }
                return j.elevation;
            } catch { return null; } finally { if (t) clearTimeout(t); }
        }

        /**
         * @param {ArrayLike<number>} lat @param {ArrayLike<number>} lng
         * @param {{ signal?: AbortSignal }} [opts]
         * @returns {Promise<{ z: Float64Array, source: "dem"|"partial"|"none", fetched: number, cached: number, missing: number, credit: string }>}
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
                        // null = outside the corridors: not remembered, so a corridor added later is picked up
                        for (let i = 0; i < b.length; i++) { const v = e[i]; if (typeof v === "number" && Number.isFinite(v)) { remember(b[i], v); fetched++; } }
                    }
                };
                await Promise.all(Array.from({ length: Math.min(concurrency, batches.length) }, worker));
                for (let i = 0; i < n; i++) if (Number.isNaN(z[i])) { const v = mem.get(keys[i]); if (v !== undefined) z[i] = v; }
                scheduleSave();
            }
            let missing = 0;
            for (let i = 0; i < n; i++) if (Number.isNaN(z[i])) missing++;
            return { z, source: missing === 0 ? "dem" : missing === n ? "none" : "partial", fetched, cached, missing, credit: [...credits].join(" · ") };
        }

        return { lookup, get size() { return mem.size; } };
    }

    return { ENDPOINT, CACHE_NAME, BATCH, keyOf, createElevation };
});
