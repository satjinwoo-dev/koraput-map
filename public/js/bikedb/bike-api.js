// @ts-check
/* ============================================================================
   MapUnite — bike catalogue client (website and Android app)
   ==============================================================================
   One client for both load paths:
     - Website: the page and the API share an origin; URLs stay relative.
     - Android app: pages load from https://localhost (the packaged www/), and
       the API is on MU_SERVER_ORIGIN (set by scripts/build-native.mjs), called
       cross-origin; the server answers with CORS for the app's origin.

   Offline-first:
     - search(): the server's FTS5 search when it answers; otherwise the local
       CatalogIndex over catalog.json (same tokeniser, same ranking, so the
       same bikes in the same order). `source` says which one answered, and
       `catalogStale` says when the server has a newer catalogue than the
       local catalog.json.
     - bundle(): the copy shipped with the page first (public/bikedb/ on the
       website, www/bikedb/ in the app: immutable, works offline), then the
       server (a bike added since the app was packaged).
     - requestBike(): needs the server; it says when a bike is already listed.

   No dependencies. Browser: window.BikeApi. Node: require().
   ============================================================================ */

(function (root, factory) {
    if (typeof module === "object" && module.exports) module.exports = factory();
    else /** @type {any} */ (root).BikeApi = factory();
})(typeof self !== "undefined" ? self : this, function () {
    "use strict";

    const API_PATH = "/api/bikes";
    const HASH_RE = /^[0-9a-f]{16}$/;
    const DEFAULT_TIMEOUT_MS = 6000;

    class BikeApiError extends Error {
        /** @param {string} reason @param {number} status @param {any} [body] */
        constructor(reason, status, body) {
            super(`bike API: ${reason}${status ? ` (HTTP ${status})` : ""}`);
            this.name = "BikeApiError";
            this.reason = reason;
            this.status = status;
            this.body = body;
        }
    }

    /**
     * @typedef {{ search: (q: unknown, o?: { limit?: number }) => any[], matchIds: (q: unknown) => string[], version: string }} LocalIndex
     * @typedef {{ source: "server"|"offline", catalogVersion: string|null, catalogStale: boolean, total: number, results: any[] }} SearchResult
     */

    /**
     * @param {{
     *   origin?: string,
     *   fetch?: typeof fetch,
     *   localIndex?: LocalIndex | (() => LocalIndex | Promise<LocalIndex>) | null,
     *   localBundlePath?: string,
     *   timeoutMs?: number
     * }} [opts]
     *   origin:          the API server ("" = this page's origin). Default: window.MU_SERVER_ORIGIN when set.
     *   localIndex:      a CatalogIndex over catalog.json (or a function that loads it), for offline search
     *   localBundlePath: where the shipped bundles are, relative to the page (default "bikedb/bundles/{hash}.json")
     */
    function createBikeClient(opts = {}) {
        const g = /** @type {any} */ (typeof self !== "undefined" ? self : globalThis);
        const origin = String(opts.origin !== undefined ? opts.origin : typeof g.MU_SERVER_ORIGIN === "string" ? g.MU_SERVER_ORIGIN : "").replace(/\/+$/, "");
        if (origin && !/^https?:\/\/[^/\s]+$/.test(origin)) throw new TypeError(`origin must be scheme://host[:port] (got ${origin})`);
        const doFetch = opts.fetch || (typeof fetch === "function" ? fetch.bind(g) : null);
        if (!doFetch) throw new TypeError("no fetch() available");
        const timeoutMs = opts.timeoutMs || DEFAULT_TIMEOUT_MS;
        const localBundlePath = opts.localBundlePath || "bikedb/bundles/{hash}.json";
        const api = origin + API_PATH;
        /** @type {Promise<LocalIndex|null>|null} */
        let indexPromise = null;
        const localIndex = () => {
            if (!indexPromise) {
                const li = opts.localIndex;
                indexPromise = Promise.resolve(typeof li === "function" ? li() : li || null).catch(() => { indexPromise = null; return null; });
            }
            return indexPromise;
        };

        /** @param {string} url @param {RequestInit} [init] */
        async function request(url, init = {}) {
            const ctl = typeof AbortController === "function" ? new AbortController() : null;
            const timer = ctl ? setTimeout(() => ctl.abort(), timeoutMs) : null;
            try {
                return await doFetch(url, Object.assign({ credentials: "omit", signal: ctl ? ctl.signal : undefined }, init));
            } finally {
                if (timer) clearTimeout(timer);
            }
        }
        /** @param {Response} r */
        const readJson = async (r) => { try { return await r.json(); } catch { return null; } };
        /** Worth falling back to offline data: network down, rate-limited, or a server-side failure. @param {number} status */
        const unavailable = (status) => status === 0 || status === 429 || status >= 500;

        /**
         * @param {unknown} q
         * @param {{ limit?: number }} [o]
         * @returns {Promise<SearchResult>}
         */
        async function search(q, o = {}) {
            const query = typeof q === "string" ? q : "";
            const params = new URLSearchParams({ q: query });
            if (o.limit !== undefined) params.set("limit", String(Math.max(1, Math.floor(o.limit))));
            let status = 0, body = null;
            try {
                const r = await request(`${api}/search?${params}`);
                status = r.status;
                body = await readJson(r);
            } catch { /* offline, timed out, or blocked: fall back below */ }
            if (status === 200 && body && body.ok) {
                const idx = await localIndex();
                return { source: "server", catalogVersion: body.catalogVersion, catalogStale: Boolean(idx && idx.version !== body.catalogVersion), total: body.total, results: body.results };
            }
            if (!unavailable(status)) throw new BikeApiError((body && body.reason) || "search-failed", status, body);
            const idx = await localIndex();
            if (!idx) throw new BikeApiError("offline", status, body);
            return { source: "offline", catalogVersion: idx.version, catalogStale: false, total: idx.matchIds(query).length, results: idx.search(query, { limit: o.limit }) };
        }

        /**
         * A runtime bundle by content hash: the shipped copy, else the server.
         * @param {string} hash
         * @returns {Promise<any>}  the parsed bundle
         */
        async function bundle(hash) {
            if (typeof hash !== "string" || !HASH_RE.test(hash)) throw new TypeError("bundle hash must be 16 hex characters");
            try {
                const r = await request(localBundlePath.replace("{hash}", hash));
                if (r.ok) { const b = await readJson(r); if (b && typeof b === "object") return b; }
            } catch { /* not shipped with this page/app: ask the server */ }
            let r;
            try { r = await request(`${api}/bundles/${hash}`); }
            catch { throw new BikeApiError("offline", 0); }
            const b = await readJson(r);
            if (!r.ok || !b || typeof b !== "object") throw new BikeApiError((b && b.reason) || "bundle-failed", r.status, b);
            const served = r.headers.get("X-Bundle-Hash");
            if (served !== null && served !== hash) throw new BikeApiError("bundle-mismatch", r.status);
            return b;
        }

        /**
         * Ask for a bike that isn't in the catalogue.
         * @param {{ make: string, model: string, variant?: string|null, market?: string, year?: number, powertrain?: string, note?: string, force?: boolean }} input
         * @returns {Promise<{ ok: true, status: "listed", matches: any[] } | { ok: true, status: "queued", created: boolean, newVote: boolean, request: any, similar: any[] }>}
         */
        async function requestBike(input) {
            let r;
            try {
                r = await request(`${api}/requests`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(input) });
            } catch { throw new BikeApiError("offline", 0); }
            const b = await readJson(r);
            if (!r.ok || !b || !b.ok) throw new BikeApiError((b && b.reason) || "request-failed", r.status, b);
            return b;
        }

        return { origin, apiBase: api, search, bundle, requestBike };
    }

    return { API_PATH, BikeApiError, createBikeClient };
});
