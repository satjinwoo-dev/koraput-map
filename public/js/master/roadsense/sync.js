// @ts-check
/* ============================================================================
   MapUnite RoadSense Live — opt-in sync with our server, and the offline cache
   ==============================================================================
   OFF until the rider turns on "Community road reports" (Settings). When on:

   PUBLISH (RoadPulse, Confirmed Decision 2): nothing this phone detects is
          public until the rider reviews it after the ride (review.js) and taps
          Publish. Then publish({ reports, votes }) queues exactly that:
            reports  hazards the rider confirmed or added: kind, severity,
                     position with its accuracy, heading, the hour;
            votes    "found" / "not found" / "unsure" on hazards it warned about;
          sent to /api/master/roadsense/publish after a random 0–2 h delay (the
          time of a report must not pin the ride), never from a private zone,
          under this phone's CONTRIBUTOR token: random, made here once, stored on
          the server only as a keyed hash (one rider = one vote; badges follow
          accuracy). "Delete my road reports" deletes everything under it and
          makes a new one.
          Smooth passes ("ridden, nothing felt") wait for the same review: only
          the cells of a ride the rider approved (approveCover) go up.

   RAW OBSERVATIONS (shareRawObservations, OFF by default and never turned on
          by the app: kept for research datasets only): every jolt and rough
          stretch as the log takes it, uploaded to /api/master/roadsense/upload:
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
          signal at all. Smooth passes ("ridden, nothing found") go up and come
          down the same way, per ≈ 220 m cell under an unlinkable per-cell token.
          The same call returns the tiles' published HAZARDS with what riders
          said (found / not found / unsure, agreement, status): kept here
          offline (hazards()), for warnings and the Truth Card.
          Official lists and predictions come down with the evidence, each naming
          its source. Each observation keeps its id: one this phone uploaded
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
        coverOutboxMax: 3000,          // smooth passes waiting
        coverBatchMax: 500,            // per /cover upload (the server's limit)
        coverLabelsMax: 5000,          // labels of this phone's own smooth passes (recognised when they come back; sent by "delete")
        backoffMinMs: 60000, backoffMaxMs: 30 * 60000,
        timeoutMs: 15000,
        shareRawObservations: false,   // research datasets only: the app publishes reviewed reports, never raw detections
        publishDelayMaxMs: 2 * 3600000,  // a published report waits a random 0..this before it goes up
        publishOutboxMax: 500,
        publishReportsMax: 50, publishVotesMax: 100,   // per /publish call (the server's limits)
        myReportsMax: 2000,            // ids of hazards this phone reported (no "did you find it?" on its own)
        coverApprovalMaxMs: 7 * 86400000,  // a smooth pass not approved in a review within this is dropped
        hazardsMax: 5000               // published hazards kept offline
    });
    const PHONE_SOURCES = ["imu", "camera", "rider"];

    /** @param {number} lat @param {number} lng @param {number} lat2 @param {number} lng2 */
    function distM(lat, lng, lat2, lng2) {
        const n = (lat2 - lat) * M_PER_DEG, e = (lng2 - lng) * M_PER_DEG * Math.cos(lat * Math.PI / 180);
        return Math.hypot(n, e);
    }

    /** SHA-256 as hex (Web Crypto: the browser, and Node 20+ for the tests). @param {string} text */
    async function sha256hex(text) {
        const c = /** @type {any} */ (globalThis).crypto;
        const d = await c.subtle.digest("SHA-256", new TextEncoder().encode(text));
        return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join("");
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
     *   RS: any, log: any, cover?: any, store: { get: (k: string, f?: any) => any, set: (k: string, v: any) => any },
     *   api?: { post: (path: string, body: any, o?: any) => Promise<{ ok: boolean, status: number, data: any, reason?: string }> } | null,
     *   now?: () => number, random?: () => string, settings?: Partial<typeof DEFAULTS>
     * }} o
     */
    function createSync(o) {
        const RS = o.RS, log = o.log, store = o.store, cover = o.cover || null;
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
        /** @type {{ cell: string, t: number }[]} */ let coverOutbox = store.get("coverOutbox", []) || [];
        /** @type {string[]} */ let coverLabels = store.get("coverLabels", []) || [];
        let coverLabelSet = new Set(coverLabels);
        /** @type {{ from: number, to: number }[]} */ let coverApproved = store.get("coverApproved", []) || [];
        // RoadPulse: what the rider published (waiting), who they are to the server, and the hazards they know
        /** @type {{ kind: "report"|"vote", item: any, notBefore: number }[]} */ let pubOutbox = store.get("pubOutbox", []) || [];
        /** @type {{ contributor: string, device: string }|null} */ let ident = store.get("identity", null);
        /** @type {string[]} */ let myHazards = store.get("myHazards", []) || [];
        /** @type {Record<string, any>} */ let hazardsCache = store.get("hazards", {}) || {};
        const st = { uploaded: 0, coverUploaded: 0, coverReceived: 0, privateDropped: 0, received: 0, lastUpload: null, lastFetch: null, backoffUntil: 0, failures: 0, lastError: "",
            published: 0, publishRejected: 0, hazardsReceived: 0 };
        /** This phone's contributor and device tokens, made the first time they're needed. */
        const identity = () => {
            if (!ident) { ident = { contributor: random(), device: random() }; store.set("identity", ident); }
            return ident;
        };
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

        // research only (shareRawObservations): queue this phone's own observations as the log takes them
        const off = log.onAdd((/** @type {any} */ ob) => {
            if (!cfg.shareRawObservations || !consent.on || ob.rider !== RS.SELF || !PHONE_SOURCES.includes(ob.source)) return;
            outbox.push({ id: ob.id, type: ob.type, t: ob.t, lat: ob.lat, lng: ob.lng, source: ob.source, present: ob.present, conf: ob.conf, ...(Number.isFinite(ob.peakMs2) ? { peakMs2: ob.peakMs2 } : {}) });
            if (outbox.length > cfg.outboxMax) outbox.splice(0, outbox.length - cfg.outboxMax);
            saveOutbox();
        });

        // and its smooth passes: the latest per cell
        const offCover = cover ? cover.onAdd((/** @type {any} */ p) => {
            if (!consent.on || p.rider !== RS.SELF) return;
            coverOutbox = coverOutbox.filter((x) => x.cell !== p.cell);
            coverOutbox.push({ cell: p.cell, t: p.t });
            if (coverOutbox.length > cfg.coverOutboxMax) coverOutbox.splice(0, coverOutbox.length - cfg.coverOutboxMax);
            store.set("coverOutbox", coverOutbox);
        }) : () => {};
        /** the middle of a coverage cell @param {string} cell */
        const cellMiddle = (cell) => { const [y, x] = cell.split(":").map(Number); const d = RS.COVER.cellDeg; return { lat: (y + 0.5) * d, lng: (x + 0.5) * d }; };

        function fail(/** @type {string} */ why) {
            st.failures++;
            st.lastError = why;
            st.backoffUntil = now() + Math.min(cfg.backoffMaxMs, cfg.backoffMinMs * 2 ** Math.min(10, st.failures - 1));
        }

        /** Upload what's due: published reports and votes, (research) observations, approved smooth passes. Returns how many items went up. */
        async function flush() {
            let sent = await flushPublish();
            if (now() >= st.backoffUntil) sent += await flushObs();
            if (now() >= st.backoffUntil) await flushCover();
            return sent;
        }

        const savePub = () => store.set("pubOutbox", pubOutbox);

        /** RoadPulse: the reviewed reports and votes whose random delay has passed. */
        async function flushPublish() {
            const a = api();
            if (!consent.on || !a || !pubOutbox.length || now() < st.backoffUntil) return 0;
            const before = pubOutbox.length;
            pubOutbox = pubOutbox.filter((x) => !(x.kind === "report" && inPrivate(x.item)));
            st.privateDropped += before - pubOutbox.length;
            if (before !== pubOutbox.length) savePub();
            const due = pubOutbox.filter((x) => now() >= x.notBefore);
            if (!due.length) return 0;
            const reports = due.filter((x) => x.kind === "report").slice(0, cfg.publishReportsMax);
            const votes = due.filter((x) => x.kind === "vote").slice(0, cfg.publishVotesMax);
            const id = identity();
            const r = await a.post("/roadsense/publish", { v: 1, contributor: id.contributor, device: id.device, reports: reports.map((x) => x.item), votes: votes.map((x) => x.item) }, { timeoutMs: cfg.timeoutMs });
            if (!(r.ok || r.status === 400)) { fail(r.reason || `http ${r.status}`); changed(); return 0; }
            const done = new Set([...reports, ...votes]);
            pubOutbox = pubOutbox.filter((x) => !done.has(x));
            savePub();
            if (r.ok && r.data) {
                for (const x of r.data.results || []) if (x && typeof x.hazard === "string" && x.id) myHazards.push(x.hazard);
                myHazards = [...new Set(myHazards)].slice(-cfg.myReportsMax);
                store.set("myHazards", myHazards);
                st.published += reports.length + votes.length - ((r.data.rejected || []).length);
                st.publishRejected += (r.data.rejected || []).length;
                st.lastUpload = now(); st.failures = 0; st.backoffUntil = 0;
            } else st.lastError = "rejected";
            changed();
            return reports.length + votes.length;
        }

        async function flushObs() {
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
         * Smooth passes go up as { cell, hour, token }: token = SHA-256(today's pseudonym | cell). The server keeps
         * SHA-256(token) as the label, so it can count distinct riders per cell but can't join one rider's cells
         * into a route, and this phone can recognise its own passes when they come back.
         */
        /** Was the ride at time t approved for smooth passes in its review? @param {number} t */
        function approved(t) { return coverApproved.some((w) => t >= w.from && t <= w.to); }

        async function flushCover() {
            const a = api();
            if (!consent.on || !a || !cover || !coverOutbox.length) return 0;
            const t = now();
            const before = coverOutbox.length;
            // private zones, and passes the rider never approved in a review (after a week): dropped, never sent
            coverOutbox = coverOutbox.filter((x) => !inPrivate(cellMiddle(x.cell)) && (approved(x.t) || t - x.t < cfg.coverApprovalMaxMs));
            st.privateDropped += before - coverOutbox.length;
            const ready = coverOutbox.filter((x) => t - x.t >= cfg.minAgeMs && approved(x.t)).slice(0, cfg.coverBatchMax);
            if (before !== coverOutbox.length) store.set("coverOutbox", coverOutbox);
            if (!ready.length) return 0;
            const items = [];
            /** @type {string[]} */ const labels = [];
            for (const x of ready) {
                const token = await sha256hex(`${pseudonymFor(dayOf(x.t))}|${x.cell}`);
                items.push({ cell: x.cell, t: Math.floor(x.t / 3600000) * 3600000, token });     // the hour only
                labels.push((await sha256hex(token)).slice(0, 16));
            }
            // shuffled: the order mustn't trace the ride
            for (let i = items.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [items[i], items[j]] = [items[j], items[i]]; }
            const r = await a.post("/roadsense/cover", { v: 1, cells: items }, { timeoutMs: cfg.timeoutMs });
            if (!(r.ok || r.status === 400)) { fail(r.reason || `http ${r.status}`); changed(); return 0; }
            const done = new Set(ready.map((x) => `${x.cell}@${x.t}`));
            coverOutbox = coverOutbox.filter((x) => !done.has(`${x.cell}@${x.t}`));
            store.set("coverOutbox", coverOutbox);
            if (r.ok) {
                st.coverUploaded += ready.length;
                coverLabels = [...coverLabels, ...labels].slice(-cfg.coverLabelsMax);
                coverLabelSet = new Set(coverLabels);
                store.set("coverLabels", coverLabels);
            }
            changed();
            return ready.length;
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
                // other riders' evidence, and the server's own feeds (official lists, predictions, each naming its source);
                // never "self", never what this phone sent
                const theirs = r.data.obs.filter((/** @type {any} */ ob) => ob && ob.rider !== RS.SELF && (PHONE_SOURCES.includes(ob.source) || RS.FEED_SOURCES.includes(ob.source)) && !sentSet.has(ob.id));
                for (const x of log.addAll(theirs)) if (x.ok && !x.dup && x.obsId) res.added++;
                // RoadPulse hazards in these tiles: replace what was cached for them
                if (Array.isArray(r.data.hazards)) {
                    const fetchedTiles = new Set(chunk);
                    for (const [hid, h] of Object.entries(hazardsCache)) if (fetchedTiles.has(RS.tileOf(h.lat, h.lng))) delete hazardsCache[hid];
                    for (const h of r.data.hazards) {
                        if (!h || typeof h.id !== "string" || !Number.isFinite(h.lat) || !Number.isFinite(h.lng)) continue;
                        hazardsCache[h.id] = { ...h, mine: myHazards.includes(h.id), fetchedAt: t };
                        st.hazardsReceived++;
                    }
                    const ids = Object.keys(hazardsCache);
                    if (ids.length > cfg.hazardsMax) for (const k of ids.sort((x, y) => hazardsCache[x].fetchedAt - hazardsCache[y].fetchedAt).slice(0, ids.length - cfg.hazardsMax)) delete hazardsCache[k];
                    store.set("hazards", hazardsCache);
                }
                // other riders' smooth passes: [cell, label, hour (s)]; this phone's own come back as its own labels
                if (cover && Array.isArray(r.data.cover)) for (const c of r.data.cover) {
                    if (!Array.isArray(c) || typeof c[1] !== "string" || coverLabelSet.has(c[1]) || !Number.isFinite(c[2])) continue;
                    if (cover.add({ cell: c[0], t: c[2] * 1000, rider: `c${c[1]}` })) st.coverReceived++;
                }
                for (const k of chunk) tiles[k] = t;
                res.fetched += chunk.length;
                st.failures = 0; st.backoffUntil = 0;
            }
            // remember the newest fetches only
            const keys = Object.keys(tiles);
            if (keys.length > cfg.tileMemory) for (const k of keys.sort((x, y) => tiles[x] - tiles[y]).slice(0, keys.length - cfg.tileMemory)) delete tiles[k];
            store.set("tiles", tiles);
            if (res.fetched) { st.received += res.added; st.lastFetch = now(); log.save(); if (cover) cover.save(); }
            changed();
            return res;
        }

        function status() {
            return {
                consent: consent.on, consentAt: consent.at, queued: outbox.length + pubOutbox.length, publishQueued: pubOutbox.length, coverQueued: coverOutbox.length,
                pseudonyms: pseudonyms.length, privateZones: zones.length, hazards: Object.keys(hazardsCache).length,
                tilesCached: Object.keys(tiles).length, ...st
            };
        }

        return {
            DEFAULTS: cfg,
            /** @param {boolean} on */
            setConsent(on) {
                consent = { on: Boolean(on), at: now() };
                store.set("consent", consent);
                if (!consent.on) { outbox = []; saveOutbox(); coverOutbox = []; store.set("coverOutbox", coverOutbox); pubOutbox = []; savePub(); }     // nothing waiting goes up after "off"
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
            /**
             * RoadPulse: what the rider reviewed and chose to publish (review.js). Each item waits a random
             * 0..publishDelayMaxMs, then goes up with the next flush. Nothing is queued while sharing is off.
             * @param {{ reports?: any[], votes?: any[] }} p
             */
            publish(p) {
                if (!consent.on) return { ok: false, reason: "sharing-off", queued: 0 };
                const delay = () => now() + Math.floor(Math.random() * cfg.publishDelayMaxMs);
                let queued = 0;
                for (const item of (p && p.reports) || []) { pubOutbox.push({ kind: "report", item, notBefore: delay() }); queued++; }
                for (const item of (p && p.votes) || []) { pubOutbox.push({ kind: "vote", item, notBefore: delay() }); queued++; }
                if (pubOutbox.length > cfg.publishOutboxMax) pubOutbox.splice(0, pubOutbox.length - cfg.publishOutboxMax);
                savePub();
                changed();
                return { ok: true, queued };
            },
            /** The smooth passes of a ride (its time window) were approved in its review: they may go up. @param {number} from @param {number} to */
            approveCover(from, to) {
                if (!Number.isFinite(from) || !Number.isFinite(to)) return;
                coverApproved = [...coverApproved.filter((w) => now() - w.to < cfg.coverApprovalMaxMs), { from, to }];
                store.set("coverApproved", coverApproved);
            },
            /** The published hazards kept offline (other riders' and this phone's own, mine: true). */
            hazards: () => Object.values(hazardsCache),
            /** @param {string} id */ isMine: (id) => myHazards.includes(id),
            /** @param {number[][]} points @param {number} [marginM] */
            tilesAlong: (points, marginM = 1000) => tilesAlong(RS, points, marginM, cfg.tilesMax),
            /** Ask the server to delete everything this phone uploaded; then forget the pseudonyms here. */
            async forgetAll() {
                const a = api();
                if (!a) return { ok: false, reason: "no-server", deleted: 0 };
                let deleted = 0;
                const rounds = Math.max(1, Math.ceil(pseudonyms.length / 800), Math.ceil(coverLabels.length / 5000));
                for (let i = 0; i < rounds; i++) {
                    const body = { v: 1, riders: pseudonyms.slice(i * 800, (i + 1) * 800).map((p) => p.id), cover: coverLabels.slice(i * 5000, (i + 1) * 5000), ...(i === 0 && ident ? { contributors: [ident.contributor] } : {}) };
                    if (!body.riders.length && !body.cover.length && !body.contributors) continue;
                    const r = await a.post("/roadsense/forget", body, { timeoutMs: cfg.timeoutMs });
                    if (!r.ok) return { ok: false, reason: r.reason || `http ${r.status}`, deleted };
                    deleted += Number(r.data && r.data.deleted) || 0;
                }
                pseudonyms = []; store.set("pseudonyms", pseudonyms);
                coverLabels = []; coverLabelSet = new Set(); store.set("coverLabels", coverLabels);
                outbox = []; saveOutbox(); coverOutbox = []; store.set("coverOutbox", coverOutbox);
                // RoadPulse: a new contributor from now on; nothing waiting goes up; the hazards they reported aren't "mine" any more
                ident = null; store.set("identity", null);
                pubOutbox = []; savePub();
                myHazards = []; store.set("myHazards", myHazards);
                for (const h of Object.values(hazardsCache)) h.mine = false;
                store.set("hazards", hazardsCache);
                changed();
                return { ok: true, deleted };
            },
            status,
            /** @param {(s: any) => void} fn */
            onChange(fn) { watchers.add(fn); return () => watchers.delete(fn); },
            stop() { off(); offCover(); }
        };
    }

    return { DEFAULTS, createSync, tilesAlong, dayOf, sha256hex };
});
