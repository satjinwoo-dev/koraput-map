// @ts-check
/* ============================================================================
   MapUnite rides — the ride summaries kept on this phone (roadmap step 10)
   ==============================================================================
   createRideStore({ indexedDB }) → { put, get, all, remove, clear, count, kind }
     IndexedDB "mu-rides" (v1), object store "rides" keyed by id, newest first.
     Falls back to memory when IndexedDB is missing or blocked (private mode),
     and says so (kind: "memory") so the UI can tell the rider rides won't stay.
   Nothing here talks to the network. Up to MAX_RIDES are kept; the oldest go first.
   ============================================================================ */
(function (root, factory) {
    if (typeof module === "object" && module.exports) module.exports = factory();
    else { const ns = /** @type {any} */ (root).MURides || (/** @type {any} */ (root).MURides = {}); ns.store = factory(); }
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
    "use strict";

    const DB_NAME = "mu-rides", STORE = "rides", VERSION = 1, MAX_RIDES = 1000;

    /** In-memory store with the same surface (tests, private browsing). */
    function createMemoryStore() {
        /** @type {Map<string, any>} */ const m = new Map();
        const sorted = () => [...m.values()].sort((a, b) => b.startedAt - a.startedAt);
        return {
            kind: "memory",
            async put(r) { m.set(r.id, JSON.parse(JSON.stringify(r))); if (m.size > MAX_RIDES) { const old = sorted().slice(MAX_RIDES); for (const x of old) m.delete(x.id); } return r.id; },
            async get(id) { const r = m.get(id); return r ? JSON.parse(JSON.stringify(r)) : null; },
            async all() { return sorted().map((r) => JSON.parse(JSON.stringify(r))); },
            async remove(id) { return m.delete(id); },
            async clear() { const n = m.size; m.clear(); return n; },
            async count() { return m.size; }
        };
    }

    /**
     * @param {{ indexedDB?: IDBFactory|null }} [o]
     */
    function createRideStore(o = {}) {
        const idb = o.indexedDB !== undefined ? o.indexedDB : (typeof indexedDB !== "undefined" ? indexedDB : null);
        if (!idb) return createMemoryStore();
        /** @type {Promise<IDBDatabase|null>|null} */ let opening = null;
        let fallback = null;
        function open() {
            if (!opening) opening = new Promise((resolve) => {
                let req;
                try { req = idb.open(DB_NAME, VERSION); } catch { resolve(null); return; }
                req.onupgradeneeded = () => {
                    const db = req.result;
                    if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE, { keyPath: "id" }).createIndex("startedAt", "startedAt");
                };
                req.onsuccess = () => resolve(req.result);
                req.onerror = () => resolve(null);
                req.onblocked = () => resolve(null);
            });
            return opening;
        }
        /** Run fn on the store, or on the memory fallback when IndexedDB won't open. */
        async function withStore(mode, fn, mem) {
            const db = await open();
            if (!db) { fallback = fallback || createMemoryStore(); api.kind = "memory"; return mem(fallback); }
            return new Promise((resolve, reject) => {
                let out;
                const tx = db.transaction(STORE, mode);
                const st = tx.objectStore(STORE);
                Promise.resolve(fn(st, (v) => { out = v; })).catch(reject);
                tx.oncomplete = () => resolve(out);
                tx.onerror = () => reject(tx.error);
                tx.onabort = () => reject(tx.error);
            });
        }
        const req2p = (r) => new Promise((resolve, reject) => { r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error); });
        const api = {
            kind: "indexeddb",
            /** @param {any} r */
            async put(r) {
                await withStore("readwrite", (st, set) => { st.put(r); set(r.id); }, (m) => m.put(r));
                // keep the newest MAX_RIDES
                const n = await api.count();
                if (n > MAX_RIDES) { const all = await api.all(); for (const x of all.slice(MAX_RIDES)) await api.remove(x.id); }
                return r.id;
            },
            /** @param {string} id */
            async get(id) { return withStore("readonly", async (st, set) => set((await req2p(st.get(id))) || null), (m) => m.get(id)); },
            async all() { return withStore("readonly", async (st, set) => set(((await req2p(st.getAll())) || []).sort((a, b) => b.startedAt - a.startedAt)), (m) => m.all()); },
            /** @param {string} id */
            async remove(id) { return withStore("readwrite", (st, set) => { st.delete(id); set(true); }, (m) => m.remove(id)); },
            async clear() { const n = await api.count(); await withStore("readwrite", (st, set) => { st.clear(); set(n); }, (m) => m.clear()); return n; },
            async count() { return withStore("readonly", async (st, set) => set(await req2p(st.count())), (m) => m.count()); }
        };
        return api;
    }

    return { DB_NAME, STORE, MAX_RIDES, createRideStore, createMemoryStore };
});
