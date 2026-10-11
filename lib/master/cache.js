// @ts-check
"use strict";
/* ============================================================================
   MapUnite Master AI (server) — TTL cache with single-flight
   ==============================================================================
   Every upstream the Master's server routes call (Open-Meteo, TomTom, Overpass,
   Google Places, Last.fm, the search model) is paid for per request or rate
   limited per IP. Many riders on the same road ask the same question, so
   answers are cached by a key built from ROUNDED coordinates:

     const c = createCache({ max: 2000, ttlMs: 600000 });
     const v = await c.wrap(key, () => fetchSomething(), { ttlMs });

   - wrap() runs the loader once per key even when 50 requests arrive together
     (single-flight): the others await the same promise.
   - A failed load is NOT cached (the next request retries), but a stale value,
     if there is one, is served instead of the error ("stale-if-error"), up to
     staleMs past its expiry. Riders get slightly old weather rather than none.
   - LRU eviction at `max` entries; memory stays bounded whatever the traffic.
   ============================================================================ */

/**
 * @template T
 * @param {{ max?: number, ttlMs?: number, staleMs?: number, now?: () => number }} [o]
 */
function createCache(o = {}) {
    const max = o.max ?? 1000;
    const ttlDefault = o.ttlMs ?? 300000;
    const staleMs = o.staleMs ?? 3600000;
    const now = o.now || (() => Date.now());
    /** @type {Map<string, { v: T, exp: number }>} */ const map = new Map();
    /** @type {Map<string, Promise<T>>} */ const inflight = new Map();
    let hits = 0, misses = 0, staleServed = 0;

    /** @param {string} key @param {T} v @param {number} ttlMs */
    function set(key, v, ttlMs = ttlDefault) {
        map.delete(key);
        map.set(key, { v, exp: now() + ttlMs });
        while (map.size > max) map.delete(/** @type {string} */ (map.keys().next().value));
    }
    /** @param {string} key @returns {T|undefined} fresh value only */
    function get(key) {
        const e = map.get(key);
        if (!e || e.exp <= now()) return undefined;
        map.delete(key); map.set(key, e);                 // LRU touch
        return e.v;
    }
    /**
     * @param {string} key
     * @param {() => Promise<T>} load
     * @param {{ ttlMs?: number, cacheIf?: (v: T) => boolean }} [w]
     * @returns {Promise<T>}
     */
    async function wrap(key, load, w = {}) {
        const fresh = get(key);
        if (fresh !== undefined) { hits++; return fresh; }
        const running = inflight.get(key);
        if (running) { hits++; return running; }
        misses++;
        const p = (async () => {
            try {
                const v = await load();
                if (!w.cacheIf || w.cacheIf(v)) set(key, v, w.ttlMs ?? ttlDefault);
                return v;
            } catch (err) {
                const old = map.get(key);
                if (old && now() - old.exp < staleMs) { staleServed++; return old.v; }
                throw err;
            } finally { inflight.delete(key); }
        })();
        inflight.set(key, p);
        return p;
    }
    return {
        get, set, wrap,
        /** @param {string} key */ delete: (key) => map.delete(key),
        clear: () => { map.clear(); inflight.clear(); },
        stats: () => ({ size: map.size, hits, misses, staleServed, inflight: inflight.size })
    };
}

/** Round a coordinate for a cache key: 2 decimals ≈ 1.1 km, 3 ≈ 110 m. @param {number} v @param {number} d */
const roundCoord = (v, d) => Number(v).toFixed(d);

module.exports = { createCache, roundCoord };
