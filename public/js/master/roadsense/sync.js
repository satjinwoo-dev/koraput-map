// @ts-check
/* ============================================================================
   MapUnite RoadSense Live — opt-in sync with our server, and the offline cache
   ==============================================================================
   OFF until the rider turns on "Community road reports" (Settings). When on:

   SHARE  This phone's own observations (jolts, rough stretches, clean passes;
          rider "self") are queued as they're added to the log, and uploaded to
          /api/master/roadsense/upload in batches:
            - only once they're ≥ 10 minutes old, so nothing is ever live tracking;
            - never within 250 m of where a ride started or ended (home, work:
              "private zones", kept on this phone only), dropped, not delayed;
            - time rounded to 10 s, position to 1e-5° (≈ 1 m: a pothole needs it);
            - under a pseudonym that changes every day (random, made here). The
              server stores only a keyed hash of it, never the IP.
          Turning sharing off empties the queue. "Delete my road reports" sends
          the pseudonyms this phone used, and the server deletes everything
          stored under them.

   RECEIVE  /api/master/roadsense/area returns the evidence of live events in
          ≈ 5.5 km tiles: the tiles along the route when one is set (all of it,
          while there's signal), and around the rider while riding. It goes into
          the SAME log on the phone (localStorage), so warnings work with no
          signal at all. Each observation keeps its id: one this phone uploaded
          comes back as a duplicate and is skipped, and another rider counts as
          one rider however often they passed (roadsense.js).

   Network: every call goes through the "master-api" capability (offline →
   answered at once, no timeouts). Failures back off 1 → 30 min.
   ============================================================================ */
(function (root, factory) {
    if (typeof module === "object" && module.exports) module.exports = factory();
    else { const W = /** @type {any} */ (root); const M = W.MUMaster || (W.MUMaster = {}); (M.roadsenseSync = factory()); }
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
    "use strict";

    const M_PER_DEG = 111320;
    const DEFAULTS = Object.freeze({
        minAgeMs: 10 * 60000,          // uploaded only once this old: never live tracking
        privateRadiusM: 250,           // nothing uploaded this close to where a ride started or ended
        privateZonesMax: 20,
        outboxMax: 2000,               // own observations waiting (oldest dropped first)
        batchMax: 200,                 // per upload (the server's limit)
        tilesPerCall: 24,              // per /area call (the server's limit)
        tileFreshMs: 15 * 60000,       // a tile fetched this recently isn't fetched again
        tilesMax: 200,                 // tiles fetched for one route (≈ 1000 km)
        tileMemory: 500,
        pseudonymsMax: 800,            // days of pseudonyms kept, so "delete" can reach them
        sentMax: 5000,                 // ids of uploaded observations remembered (never re-imported as someone else's)
        backoffMinMs: 60000, backoffMaxMs: 30 * 60000,
        timeoutMs: 15000
    });
    const PHONE_SOURCES = ["imu", "camera", "rider"];

    /** @param {number} lat @param {number} lng @param {number} lat2 @param {number} lng2 */
    function distM(lat, lng, lat2, lng2) {
        const n = (lat2 - lat) * M_PER_DEG, e = (lng2 - lng) * M_PER_DEG * Math.cos(lat * Math.PI / 180);
        return Math.hypot(n, e);
    }

    /** The phone's own calendar day (pseudonyms change with it). @param {number} t */
    function dayOf(t) {
        const d = new Date(t);
        return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
    }

    /**
     * The ≈ 5.5 km tiles covering a polyline [[lat, lng], …], with marginM either side.
     * @param {any} RS the roadsense module (tileOf, TILE_DEG)
     * @param {number[][]} points
     * @param {number} [marginM]
     * @param {number} [max]
     */
    function tilesAlong(RS, points, marginM = 1000, max = Infinity) {
        /** @type {string[]} */ const out = [];
        const seen = new Set();
        const addAround = (/** @type {number} */ lat, /** @type {number} */ lng) => {
            const dLat = marginM / M_PER_DEG, dLng = marginM / (M_PER_DEG * Math.max(0.1, Math.cos(lat * Math.PI / 180)));
            for (const [a, b] of [[0, 0], [dLat, 0], [-dLat, 0], [0, dLng], [0, -dLng], [dLat, dLng], [dLat, -dLng], [-dLat, dLng], [-dLat, -dLng]]) {
                const k = RS.tileOf(lat + a, lng + b);
                if (!seen.has(k) && out.length < max) { seen.add(k); out.push(k); }
            }
        };
        const pts = (Array.isArray(points) ? points : []).filter((p) => Array.isArray(p) && Number.isFinite(p[0]) && Number.isFinite(p[1]));
        for (let i = 0; i < pts.length; i++) {
            addAround(pts[i][0], pts[i][1]);
            const next = pts[i + 1];
            if (!next) break;
            const d = distM(pts[i][0], pts[i][1], next[0], next[1]);
            for (let s = 500; s < d; s += 500) addAround(pts[i][0] + (next[0] - pts[i][0]) * s / d, pts[i][1] + (next[1] - pts[i][1]) * s / d);
        }
        return out;
    }

    /**
     * @param {{
     *   RS: any, log: any, store: { get: (k: string, f?: any) => any, set: (k: string, v: any) => any },
     *   api?: { post: (path: string, body: any, o?: any) => Promise<{ ok: boolean, status: number, data: any, reason?: string }> } | null,
     *   now?: () => number, random?: () => string, settings?: Partial<typeof DEFAULTS>
     * }} o
     */
    function createSync(o) {
        const RS = o.RS, log = o.log, store = o.store;
        const cfg = { ...DEFAULTS, ...(o.settings || {}) };
        const now = o.now || Date.now;
        const api = () => o.api || null;
        const random = o.random || (() => {
            const c = /** @type {any} */ (globalThis).crypto;
            const b = new Uint8Array(16);
            if (c && typeof c.getRandomValues === "function") c.getRandomValues(b); else for (let i = 0; i < b.length; i++) b[i] = Math.floor(Math.random() * 256);
            const A = "0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ-_";
            let s = "";
            for (const v of b) s += A[v & 63];
            return s + A[b[0] >> 2] + A[b[1] >> 2] + A[b[2] >> 2] + A[b[3] >> 2] + A[b[4] >> 2] + A[b[5] >> 2];
        });

        /** @type {{ on: boolean, at: number|null }} */ let consent = store.get("consent", null) || { on: false, at: null };
        /** @type {any[]} */ let outbox = store.get("outbox", []) || [];
        /** @type {{ lat: number, lng: number, t: number }[]} */ let zones = store.get("private", []) || [];
        /** @type {{ day: string, id: string }[]} */ let pseudonyms = store.get("pseudonyms", []) || [];
        /** @type {Record<string, number>} */ let tiles = store.get("tiles", {}) || {};
        /** @type {string[]} */ let sentIds = store.get("sent", []) || [];
        let sentSet = new Set(sentIds);
        const st = { uploaded: 0, privateDropped: 0, received: 0, lastUpload: null, lastFetch: null, backoffUntil: 0, failures: 0, lastError: "" };
        /** @type {Set<(s: any) => void>} */ const watchers = new Set();
        const changed = () => { const s = status(); for (const fn of watchers) { try { fn(s); } catch (e) { /* independent */ } } };

        const saveOutbox = () => store.set("outbox", outbox);
        const inPrivate = (/** @type {any} */ ob) => zones.some((z) => distM(z.lat, z.lng, ob.lat, ob.lng) <= cfg.privateRadiusM);

        /** This phone's pseudonym for a day (made the first time it's needed). @param {string} day */
        function pseudonymFor(day) {
            const have = pseudonyms.find((p) => p.day === day);
            if (have) return have.id;
            const id = random();
            pseudonyms = [...pseudonyms, { day, id }].slice(-cfg.pseudonymsMax);
            store.set("pseudonyms", pseudonyms);
            return id;
        }

        // queue this phone's own observations as the log takes them
        const off = log.onAdd((/** @type {any} */ ob) => {
            if (!consent.on || ob.rider !== RS.SELF || !PHONE_SOURCES.includes(ob.source)) return;
            outbox.push({ id: ob.id, type: ob.type, t: ob.t, lat: ob.lat, lng: ob.lng, source: ob.source, present: ob.present, conf: ob.conf, ...(Number.isFinite(ob.peakMs2) ? { peakMs2: ob.peakMs2 } : {}) });
            if (outbox.length > cfg.outboxMax) outbox.splice(0, outbox.length - cfg.outboxMax);
            saveOutbox();
        });

        function fail(/** @type {string} */ why) {
            st.failures++;
            st.lastError = why;
            st.backoffUntil = now() + Math.min(cfg.backoffMaxMs, cfg.backoffMinMs * 2 ** Math.min(10, st.failures - 1));
        }

        /** Upload what's old enough. Returns how many went up. */
        async function flush() {
            const a = api();
            if (!consent.on || !a || !outbox.length || now() < st.backoffUntil) return 0;
            const t = now();
            // private zones: dropped, never sent
            const before = outbox.length;
            outbox = outbox.filter((ob) => !inPrivate(ob));
            st.privateDropped += before - outbox.length;
            const ready = outbox.filter((ob) => t - ob.t >= cfg.minAgeMs);
            if (before !== outbox.length) saveOutbox();
            if (!ready.length) return 0;
            /** @type {Map<string, any[]>} */ const byDay = new Map();
            for (const ob of ready) { const d = dayOf(ob.t); (byDay.get(d) || byDay.set(d, []).get(d)).push(ob); }
            let sent = 0;
            for (const [day, list] of byDay) {
                for (let i = 0; i < list.length; i += cfg.batchMax) {
                    const batch = list.slice(i, i + cfg.batchMax);
                    const body = {
                        v: 1, rider: pseudonymFor(day),
                        obs: batch.map((ob) => ({ ...ob, t: Math.round(ob.t / 10000) * 10000, lat: Math.round(ob.lat * 1e5) / 1e5, lng: Math.round(ob.lng * 1e5) / 1e5 }))
                    };
                    const r = await a.post("/roadsense/upload", body, { timeoutMs: cfg.timeoutMs });
                    if (r.ok || r.status === 400) {
                        // sent (accepted or already there), or refused as bad data that will never succeed: off the queue
                        const done = new Set(batch.map((ob) => ob.id));
                        outbox = outbox.filter((ob) => !done.has(ob.id));
                        saveOutbox();
                        if (r.ok) {
                            sent += batch.length; st.uploaded += batch.length; st.lastUpload = now(); st.failures = 0; st.backoffUntil = 0;
                            // our own, if they ever come back from the server after the log let them go
                            sentIds = [...sentIds, ...batch.map((ob) => ob.id)].slice(-cfg.sentMax);
                            sentSet = new Set(sentIds);
                            store.set("sent", sentIds);
                        }
                        else st.lastError = "rejected";
                        continue;
                    }
                    fail(r.reason || `http ${r.status}`);
                    changed();
                    return sent;
                }
            }
            changed();
            return sent;
        }

        /**
         * Fetch the live evidence in these tiles into the log (tiles fetched within tileFreshMs are skipped).
         * @param {string[]} want
         * @returns {Promise<{ fetched: number, added: number, skipped: number }>}
         */
        async function fetchTiles(want) {
            const a = api();
            const res = { fetched: 0, added: 0, skipped: 0 };
            if (!consent.on || !a || now() < st.backoffUntil) return res;
            const t = now();
            const todo = [...new Set(want)].filter((k) => !(t - (tiles[k] || 0) < cfg.tileFreshMs));
            res.skipped = want.length - todo.length;
            for (let i = 0; i < todo.length; i += cfg.tilesPerCall) {
                const chunk = todo.slice(i, i + cfg.tilesPerCall);
                const r = await a.post("/roadsense/area", { v: 1, tiles: chunk }, { timeoutMs: cfg.timeoutMs });
                if (!r.ok || !r.data || !Array.isArray(r.data.obs)) { fail(r.reason || `http ${r.status}`); break; }
                // other riders' evidence only: never "self", never an official claim from this route
                const theirs = r.data.obs.filter((/** @type {any} */ ob) => ob && ob.rider !== RS.SELF && PHONE_SOURCES.includes(ob.source) && !sentSet.has(ob.id));
                for (const x of log.addAll(theirs)) if (x.ok && !x.dup && x.obsId) res.added++;
                for (const k of chunk) tiles[k] = t;
                res.fetched += chunk.length;
                st.failures = 0; st.backoffUntil = 0;
            }
            // remember the newest fetches only
            const keys = Object.keys(tiles);
            if (keys.length > cfg.tileMemory) for (const k of keys.sort((x, y) => tiles[x] - tiles[y]).slice(0, keys.length - cfg.tileMemory)) delete tiles[k];
            store.set("tiles", tiles);
            if (res.fetched) { st.received += res.added; st.lastFetch = now(); log.save(); }
            changed();
            return res;
        }

        function status() {
            return {
                consent: consent.on, consentAt: consent.at, queued: outbox.length, pseudonyms: pseudonyms.length, privateZones: zones.length,
                tilesCached: Object.keys(tiles).length, ...st
            };
        }

        return {
            DEFAULTS: cfg,
            /** @param {boolean} on */
            setConsent(on) {
                consent = { on: Boolean(on), at: now() };
                store.set("consent", consent);
                if (!consent.on) { outbox = []; saveOutbox(); }     // nothing waiting goes up after "off"
                changed();
                return status();
            },
            consent: () => consent.on,
            /** A ride started or ended here: nothing within privateRadiusM is ever uploaded. @param {number} lat @param {number} lng */
            markPrivate(lat, lng) {
                if (!Number.isFinite(lat) || !Number.isFinite(lng)) return;
                if (zones.some((z) => distM(z.lat, z.lng, lat, lng) <= cfg.privateRadiusM / 2)) return;
                zones = [...zones, { lat, lng, t: now() }].slice(-cfg.privateZonesMax);
                store.set("private", zones);
                changed();
            },
            flush,
            fetchTiles,
            /** @param {number[][]} points @param {number} [marginM] */
            tilesAlong: (points, marginM = 1000) => tilesAlong(RS, points, marginM, cfg.tilesMax),
            /** Ask the server to delete everything this phone uploaded; then forget the pseudonyms here. */
            async forgetAll() {
                const a = api();
                if (!a) return { ok: false, reason: "no-server", deleted: 0 };
                let deleted = 0;
                for (let i = 0; i < pseudonyms.length; i += 800) {
                    const r = await a.post("/roadsense/forget", { v: 1, riders: pseudonyms.slice(i, i + 800).map((p) => p.id) }, { timeoutMs: cfg.timeoutMs });
                    if (!r.ok) return { ok: false, reason: r.reason || `http ${r.status}`, deleted };
                    deleted += Number(r.data && r.data.deleted) || 0;
                }
                pseudonyms = []; store.set("pseudonyms", pseudonyms);
                outbox = []; saveOutbox();
                changed();
                return { ok: true, deleted };
            },
            status,
            /** @param {(s: any) => void} fn */
            onChange(fn) { watchers.add(fn); return () => watchers.delete(fn); },
            stop() { off(); }
        };
    }

    return { DEFAULTS, createSync, tilesAlong, dayOf };
});
