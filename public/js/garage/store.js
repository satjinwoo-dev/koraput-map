// @ts-check
/* ============================================================================
   MapUnite garage — data layer (catalogue, bundles, the rider's bike, requests)
   ==============================================================================
   Works offline once the catalogue has been seen:
     - catalog.json: network first (short timeout), cached copy as the fallback.
       In the Android app it ships inside the app, so it's always there.
     - bundles/<hash>.json: cache first. A bundle's name is the start of its
       SHA-256, so a cached copy is valid forever. Every download is checked
       against its name before it's used or cached.
     - The rider's bike and settings live on the phone (localStorage), and
       nothing about them is sent anywhere.
     - "My bike isn't listed" requests wait in an outbox until there is a
       connection and a server to send them to.

   Cache name: "mu-bikedb-v1". It must NOT start with "mapunite-": sw.js deletes
   every "mapunite-*" cache but its own when it updates.
   ============================================================================ */
(function (root, factory) {
    if (typeof module === "object" && module.exports) module.exports = factory();
    else { const ns = /** @type {any} */ (root).MUGarage || (/** @type {any} */ (root).MUGarage = {}); ns.store = factory(); }
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
    "use strict";

    const CACHE_NAME = "mu-bikedb-v1";
    const GARAGE_KEY = "mu.garage.v1";
    const OUTBOX_KEY = "mu.garage.requests.v1";
    const LS_BUNDLE_PREFIX = "mu.garage.bundle.";
    const HASH_RE = /^[0-9a-f]{16}$/;

    /**
     * @typedef {{ riderMass?: number, pillionMass?: number, luggageMass?: number, frontSprocket?: number, rearSprocket?: number, rearTyre?: string, fuelCode?: string }} Settings
     * @typedef {{ v: 1, bikeId: string|null, bundle: string, classKey: string, estimated: boolean, year: number|null, title: string, settings: Settings, savedAt: number }} Garage
     * @typedef {{ id: string, description: string, classKey: string|null, at: number }} BikeRequest
     */

    /**
     * @param {{
     *   search: any, physics: any,
     *   fetch?: typeof fetch, storage?: Storage|null, caches?: CacheStorage|null, subtle?: SubtleCrypto|null,
     *   catalogUrl?: string, staticBase?: string, apiBase?: string|null, timeoutMs?: number, now?: () => number
     * }} o
     */
    function createStore(o) {
        const search = o.search, physics = o.physics;
        if (!search || !physics) throw new Error("createStore needs the catalogue search module and the physics core");
        const doFetch = o.fetch || (typeof fetch === "function" ? fetch.bind(globalThis) : null);
        const storage = o.storage !== undefined ? o.storage : safeLocalStorage();
        const cacheStorage = o.caches !== undefined ? o.caches : (typeof caches !== "undefined" ? caches : null);
        const subtle = o.subtle !== undefined ? o.subtle : (globalThis.crypto && globalThis.crypto.subtle) || null;
        const catalogUrl = o.catalogUrl || "bikedb/catalog.json";
        const staticBase = o.staticBase || "bikedb/";
        const apiBase = o.apiBase ? String(o.apiBase).replace(/\/+$/, "") : null;
        const timeoutMs = o.timeoutMs || 6000;
        const now = o.now || Date.now;

        // ---------------- byte cache: Cache Storage, else localStorage ----------------
        let cachePromise = null;
        const openCache = () => {
            if (!cacheStorage) return Promise.resolve(null);
            if (!cachePromise) cachePromise = cacheStorage.open(CACHE_NAME).catch(() => null);
            return cachePromise;
        };
        /** @param {string} key */
        async function cacheGet(key) {
            const c = await openCache();
            if (c) { const r = await c.match(key); return r ? r.text() : null; }
            return storage ? storage.getItem(LS_BUNDLE_PREFIX + key) : null;
        }
        /** @param {string} key @param {string} text */
        async function cachePut(key, text) {
            const c = await openCache();
            if (c) { await c.put(key, new Response(text, { headers: { "Content-Type": "application/json" } })); return; }
            if (storage) { try { storage.setItem(LS_BUNDLE_PREFIX + key, text); } catch { /* storage full: still works online */ } }
        }

        async function get(url) {
            if (!doFetch) throw new Error("no network access in this environment");
            const ctl = typeof AbortController !== "undefined" ? new AbortController() : null;
            const t = ctl ? setTimeout(() => ctl.abort(), timeoutMs) : null;
            try {
                const res = await doFetch(url, { cache: "no-cache", signal: ctl ? ctl.signal : undefined, headers: { Accept: "application/json" } });
                if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
                return await res.text();
            } finally { if (t) clearTimeout(t); }
        }

        // ---------------- catalogue ----------------
        let catalogPromise = null;
        /** @returns {Promise<{ index: any, source: "network"|"cache" }>} */
        function catalog() {
            if (!catalogPromise) catalogPromise = loadCatalog().catch((e) => { catalogPromise = null; throw e; });
            return catalogPromise;
        }
        async function loadCatalog() {
            let networkError = null;
            try {
                const text = await get(catalogUrl);
                const index = new search.CatalogIndex(JSON.parse(text));     // validates the format before caching
                await cachePut(catalogUrl, text).catch(() => { });
                return { index, source: /** @type {"network"} */ ("network") };
            } catch (e) { networkError = e; }
            const cached = await cacheGet(catalogUrl).catch(() => null);
            if (cached) return { index: new search.CatalogIndex(JSON.parse(cached)), source: /** @type {"cache"} */ ("cache") };
            const err = new Error("The bike list isn't on this phone yet. Connect to the internet once to download it.");
            /** @type {any} */ (err).cause = networkError;
            throw err;
        }

        // ---------------- bundles ----------------
        /** First 16 hex of SHA-256 of the text, or null when WebCrypto isn't available. @param {string} text */
        async function shortSha(text) {
            if (!subtle) return null;
            const digest = await subtle.digest("SHA-256", new TextEncoder().encode(text));
            return Array.from(new Uint8Array(digest).slice(0, 8), (b) => b.toString(16).padStart(2, "0")).join("");
        }

        const bundleMemo = new Map();
        /** @param {string} hash @returns {Promise<any>} the runtime bundle (SI) */
        function bundle(hash) {
            if (typeof hash !== "string" || !HASH_RE.test(hash)) return Promise.reject(new Error(`not a bundle hash: ${String(hash)}`));
            if (!bundleMemo.has(hash)) bundleMemo.set(hash, loadBundle(hash).catch((e) => { bundleMemo.delete(hash); throw e; }));
            return bundleMemo.get(hash);
        }
        async function loadBundle(hash) {
            const key = `${staticBase}bundles/${hash}.json`;
            const cached = await cacheGet(key).catch(() => null);
            if (cached !== null) {
                const h = await shortSha(cached);
                if (h === null || h === hash) return JSON.parse(cached);
            }
            const urls = [...(apiBase ? [`${apiBase}/api/bikes/bundle/${hash}`] : []), key];
            let lastError = null;
            for (const url of urls) {
                try {
                    const text = await get(url);
                    const h = await shortSha(text);
                    if (h !== null && h !== hash) throw new Error(`${url}: content doesn't match its name (${h})`);
                    const b = JSON.parse(text);
                    await cachePut(key, text).catch(() => { });
                    return b;
                } catch (e) { lastError = e; }
            }
            const err = new Error("This bike's data isn't on this phone yet. Connect to the internet once to download it.");
            /** @type {any} */ (err).cause = lastError;
            throw err;
        }

        // ---------------- the rider's bike ----------------
        /** @returns {Garage|null} */
        function garage() {
            if (!storage) return memGarage;
            try {
                const g = JSON.parse(storage.getItem(GARAGE_KEY) || "null");
                return g && g.v === 1 && HASH_RE.test(g.bundle) ? g : null;
            } catch { return null; }
        }
        /** @type {Garage|null} */ let memGarage = null;
        /** @param {Omit<Garage, "v"|"savedAt">} g @returns {Garage} */
        function saveGarage(g) {
            /** @type {Garage} */
            const full = { v: 1, bikeId: g.bikeId, bundle: g.bundle, classKey: g.classKey, estimated: !!g.estimated, year: g.year ?? null, title: g.title, settings: cleanSettings(g.settings || {}), savedAt: now() };
            if (!HASH_RE.test(full.bundle)) throw new Error("garage needs a bundle hash");
            if (storage) storage.setItem(GARAGE_KEY, JSON.stringify(full)); else memGarage = full;
            return full;
        }
        function clearGarage() { if (storage) storage.removeItem(GARAGE_KEY); memGarage = null; }

        /**
         * Garage from a catalogue row (a real bike) or a class (an estimate).
         * @param {any} index CatalogIndex @param {{ bikeId?: string, classKey?: string, year?: number|null, settings?: Settings }} pick
         */
        function garageFromPick(index, pick) {
            if (pick.bikeId) {
                const row = index.get(pick.bikeId);
                if (!row) throw new Error(`no bike ${pick.bikeId} in the catalogue`);
                return { bikeId: row.id, bundle: row.bundle, classKey: row.classKey, estimated: false, year: pick.year ?? null, title: row.title, settings: pick.settings || {} };
            }
            const cls = index.classes.find((c) => c.key === pick.classKey);
            if (!cls) throw new Error(`no class ${pick.classKey}`);
            return { bikeId: null, bundle: cls.bundle, classKey: cls.key, estimated: true, year: pick.year ?? null, title: cls.title, settings: pick.settings || {} };
        }

        /**
         * Follow catalogue updates: if the saved bike's data was corrected (new bundle
         * hash), point the garage at the new bundle. Returns the (possibly updated) garage.
         * @param {any} index
         */
        function refreshGarage(index) {
            const g = garage();
            if (!g) return null;
            const fresh = g.bikeId ? index.get(g.bikeId) : index.classes.find((c) => c.key === g.classKey);
            if (fresh && fresh.bundle !== g.bundle) return saveGarage({ ...g, bundle: fresh.bundle });
            return g;
        }

        /**
         * The physics model for a garage entry (bundle + class default + settings).
         * @param {Garage} g @param {any} index
         */
        async function model(g, index) {
            const b = await bundle(g.bundle);
            let classDefault;
            if (b.kind === "variant") {
                const cls = index.classes.find((c) => c.key === b.classKey);
                if (cls) classDefault = await bundle(cls.bundle).catch(() => undefined);
            }
            return { bundle: b, model: physics.createBikeModel(b, { classDefault, settings: cleanSettings(g.settings || {}) }) };
        }

        // ---------------- missing-bike requests ----------------
        /** @returns {BikeRequest[]} */
        function outbox() {
            if (!storage) return memOutbox;
            try { const a = JSON.parse(storage.getItem(OUTBOX_KEY) || "[]"); return Array.isArray(a) ? a : []; } catch { return []; }
        }
        /** @type {BikeRequest[]} */ let memOutbox = [];
        const writeOutbox = (a) => { if (storage) storage.setItem(OUTBOX_KEY, JSON.stringify(a)); else memOutbox = a; };
        /** @param {string} description @param {string|null} classKey */
        function requestBike(description, classKey) {
            const d = String(description || "").trim().slice(0, 200);
            if (d.length < 2) throw new Error("Describe the bike, e.g. “Bajaj Avenger 220 Street, 2023”.");
            const req = { id: `${now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`, description: d, classKey: classKey || null, at: now() };
            writeOutbox([...outbox(), req].slice(-20));
            return req;
        }
        /** Send queued requests. Returns how many are still waiting. */
        async function flushRequests() {
            const queued = outbox();
            if (!queued.length || !apiBase || !doFetch) return queued.length;
            const left = [];
            for (const r of queued) {
                try {
                    const res = await doFetch(`${apiBase}/api/bikes/request`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ description: r.description, classKey: r.classKey }) });
                    if (!res.ok && res.status >= 500) left.push(r);     // a 4xx means the server won't take it: drop it
                } catch { left.push(r); }
            }
            writeOutbox(left);
            return left.length;
        }

        return { CACHE_NAME, catalog, bundle, garage, saveGarage, clearGarage, garageFromPick, refreshGarage, model, outbox, requestBike, flushRequests };
    }

    /** Only the settings the physics understands, with sane types. @param {any} s */
    function cleanSettings(s) {
        /** @type {Settings} */ const out = {};
        for (const k of ["riderMass", "pillionMass", "luggageMass"]) if (Number.isFinite(s[k]) && s[k] >= 0 && s[k] <= 400) out[k] = s[k];
        if (Number.isInteger(s.frontSprocket) && Number.isInteger(s.rearSprocket) && s.frontSprocket > 0 && s.rearSprocket > 0) { out.frontSprocket = s.frontSprocket; out.rearSprocket = s.rearSprocket; }
        if (typeof s.rearTyre === "string" && s.rearTyre.trim()) out.rearTyre = s.rearTyre.trim().slice(0, 40);
        if (typeof s.fuelCode === "string" && /^E\d{1,3}$/.test(s.fuelCode)) out.fuelCode = s.fuelCode;
        if (out.riderMass === 0) delete out.riderMass;
        return out;
    }

    function safeLocalStorage() {
        try { const s = globalThis.localStorage; s.setItem("mu.t", "1"); s.removeItem("mu.t"); return s; } catch { return null; }
    }

    return { CACHE_NAME, GARAGE_KEY, OUTBOX_KEY, createStore, cleanSettings };
});
