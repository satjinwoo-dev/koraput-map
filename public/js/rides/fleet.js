// @ts-check
/* ============================================================================
   MapUnite fleet — anonymous tank telemetry, client + shared contract
   (roadmap step 10). The contract is FLEET.md (v1); this file implements it.
   ==============================================================================
     MUFleet.contract   validateTank / validateEnvelope / coarsen: the SAME rules
                        run on the phone and in the reference server (lib/fleet.js)
     MUFleet.createFleetClient({ storage, fetch, base, crypto, now, appVersion })
                        consent, the contributor secret, the upload queue,
                        opt-out with server-side deletion

   Nothing is sent unless the rider opted in. What is sent is exactly
   preview() — the consent screen shows that very payload.
   ============================================================================ */
(function (root, factory) {
    if (typeof module === "object" && module.exports) module.exports = factory();
    else /** @type {any} */ (root).MUFleet = factory();
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
    "use strict";

    const SCHEMA = "mapunite-fleet/1";
    const CONSENT_VERSION = "2026-10-04";
    const MAX_TANKS = 20;
    const KEY = "mu.fleet.v1";
    const ASK_AGAIN_MS = 60 * 86400000;
    const LIMITS = Object.freeze({
        distance: [5000, 2e6],          // m
        fuel: [1e-4, 6e-2],             // m³ (0.1 L – 60 L)
        coverage: [0.6, 1.25],
        idleTime: [0, 48 * 3600],       // s
        trips: [1, 500],
        economy: [2e6, 9e7]             // m / m³  (2–90 km/L)
    });

    const isNum = (x) => typeof x === "number" && Number.isFinite(x);
    const pad2 = (n) => String(n).padStart(2, "0");
    /** @param {number} ts @returns {string} local YYYY-MM */
    const monthOf = (ts) => { const d = new Date(ts); return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}`; };

    /**
     * @typedef {{ id: string, month: string, distance: number, fuel: number, odoDistance: number|null, coverage: number|null, bandShare: number[], idleTime: number, trips: number }} Tank
     */

    /**
     * Learner interval (FuelCurve.intervals()) → a coarsened tank without its id (FLEET.md §4).
     * @param {{ fromTs: number, toTs: number, litres: number, bandKm: number[], idleH: number, km: number, odoKm: number|null, coverage: number|null, trips: number }} iv
     * @returns {Omit<Tank, "id">}
     */
    function coarsen(iv) {
        const bk = (iv.bandKm || []).map((x) => Math.max(0, Number(x) || 0));
        const sum = bk.reduce((a, x) => a + x, 0);
        return {
            month: monthOf(iv.toTs),
            distance: Math.round((iv.km * 1000) / 100) * 100,
            fuel: Math.round(iv.litres * 1000) / 1e6,
            odoDistance: iv.odoKm ? Math.round(iv.odoKm * 10) * 100 : null,
            coverage: iv.coverage === null || iv.coverage === undefined ? null : Math.round(iv.coverage * 100) / 100,
            bandShare: [0, 1, 2, 3].map((j) => (sum > 0 ? Math.round(((bk[j] || 0) / sum) * 100) / 100 : 0)),
            idleTime: Math.round((Math.max(0, iv.idleH || 0) * 3600) / 60) * 60,
            trips: Math.max(0, Math.round(iv.trips || 0))
        };
    }

    /**
     * FLEET.md §3 rules for one tank. null = valid, else a short reason.
     * @param {any} t @param {number} [now] ms
     * @returns {string|null}
     */
    function validateTank(t, now = Date.now()) {
        if (!t || typeof t !== "object") return "not an object";
        if (typeof t.id !== "string" || !/^[0-9a-f]{16}$/.test(t.id)) return "id must be 16 hex digits";
        if (typeof t.month !== "string" || !/^\d{4}-(0[1-9]|1[0-2])$/.test(t.month)) return "month must be YYYY-MM";
        const d = new Date(now + 14 * 3600000);                         // the earliest time zone's month
        const latest = `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}`;
        if (t.month < "2024-01" || t.month > latest) return "month out of range";
        /** @param {any} x @param {ReadonlyArray<number>} r */
        const inR = (x, r) => isNum(x) && x >= r[0] && x <= r[1];
        if (!inR(t.distance, LIMITS.distance)) return "distance out of range";
        if (!inR(t.fuel, LIMITS.fuel)) return "fuel out of range";
        if (t.odoDistance !== null && t.odoDistance !== undefined && !inR(t.odoDistance, LIMITS.distance)) return "odoDistance out of range";
        if (t.coverage !== null && t.coverage !== undefined && !inR(t.coverage, LIMITS.coverage)) return "coverage out of range";
        if (!Array.isArray(t.bandShare) || t.bandShare.length !== 4 || !t.bandShare.every((x) => inR(x, [0, 1]))) return "bandShare must be 4 shares";
        const s = t.bandShare.reduce((a, x) => a + x, 0);
        if (s < 0.98 || s > 1.02) return "bandShare must add up to 1";
        if (!inR(t.idleTime, LIMITS.idleTime)) return "idleTime out of range";
        if (!Number.isInteger(t.trips) || !inR(t.trips, LIMITS.trips)) return "trips out of range";
        const econ = t.distance / (t.fuel * Math.min(1, t.coverage ?? 1));
        if (!inR(econ, LIMITS.economy)) return "economy not plausible";
        const extra = Object.keys(t).filter((k) => !["id", "month", "distance", "fuel", "odoDistance", "coverage", "bandShare", "idleTime", "trips"].includes(k));
        if (extra.length) return `unknown field ${extra[0]}`;
        return null;
    }

    /** The request around the tanks. null = valid. @param {any} b */
    function validateEnvelope(b) {
        if (!b || typeof b !== "object") return "body must be an object";
        if (b.schema !== SCHEMA) return `schema must be ${SCHEMA}`;
        if (typeof b.consent !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(b.consent)) return "consent must be a date";
        if (typeof b.app !== "string" || b.app.length > 40) return "app must be a short string";
        const k = b.bike;
        if (!k || typeof k !== "object") return "bike missing";
        if (k.id !== null && (typeof k.id !== "string" || !/^[a-z0-9-]{3,80}$/.test(k.id))) return "bike.id must be a catalogue id or null";
        if (typeof k.classKey !== "string" || !/^[a-z_]+\.[a-z_]+$/.test(k.classKey)) return "bike.classKey must be powertrain.segment";
        if (k.powertrain !== "ice") return "only ice bikes have tanks";
        if (!Array.isArray(b.tanks) || b.tanks.length < 1) return "tanks missing";
        if (b.tanks.length > MAX_TANKS) return "too many tanks";
        return null;
    }

    /** @param {Uint8Array} bytes */
    function b64url(bytes) {
        let s = "";
        for (const x of bytes) s += String.fromCharCode(x);
        return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");          // btoa: browsers and Node ≥ 16
    }
    /** @param {any} cr  Web Crypto @param {string} text */
    async function sha256Hex(cr, text) {
        const buf = await cr.subtle.digest("SHA-256", new TextEncoder().encode(text));
        return [...new Uint8Array(buf)].map((x) => x.toString(16).padStart(2, "0")).join("");
    }

    /**
     * @param {{ storage?: Storage|null, fetch?: typeof fetch|null, base?: string, crypto?: any, now?: () => number, appVersion?: string, online?: () => boolean }} [o]
     */
    function createFleetClient(o = {}) {
        const storage = o.storage !== undefined ? o.storage : (typeof localStorage !== "undefined" ? localStorage : null);
        const doFetch = o.fetch !== undefined ? o.fetch : (typeof fetch === "function" ? fetch.bind(globalThis) : null);
        const base = String(o.base ?? "").replace(/\/+$/, "");
        const cr = o.crypto || globalThis.crypto;
        const now = o.now || Date.now;
        const appVersion = o.appVersion || "mu";
        const online = o.online || (() => !(typeof navigator !== "undefined" && navigator.onLine === false));

        /** @type {{ consent: { version: string, choice: "yes"|"no", at: number }|null, contributor: string|null, sent: string[], queue: Tank[], pendingDelete: string|null, nextTryAt: number, failures: number, lastSentAt: number|null, lastError: string|null, askedAt: number|null, sentTotal: number }} */
        let st = read();
        function read() {
            const d = { consent: null, contributor: null, sent: [], queue: [], pendingDelete: null, nextTryAt: 0, failures: 0, lastSentAt: null, lastError: null, askedAt: null, sentTotal: 0 };
            try { const x = JSON.parse((storage && storage.getItem(KEY)) || "null"); if (x && typeof x === "object") return { ...d, ...x, sent: Array.isArray(x.sent) ? x.sent : [], queue: Array.isArray(x.queue) ? x.queue : [] }; } catch { /* fresh */ }
            return d;
        }
        function write() { try { if (storage) storage.setItem(KEY, JSON.stringify(st)); } catch { /* storage blocked: in memory only */ } }

        const optedIn = () => Boolean(st.consent && st.consent.choice === "yes" && st.consent.version === CONSENT_VERSION && st.contributor);
        const auth = (c) => ({ Authorization: `Fleet ${c}` });

        /** Usable learner intervals → tanks with ids (async: the id is a salted hash). */
        async function tanksFor(intervals, contributor) {
            const out = [];
            for (const iv of intervals || []) {
                if (!iv || !iv.usable) continue;
                const t = coarsen(iv);
                const id = (await sha256Hex(cr, `${contributor}:${iv.fromTs}:${iv.toTs}`)).slice(0, 16);
                out.push({ id, ...t });
            }
            return out;
        }
        /** @param {any} bike */
        function bikeOf(bike) {
            return { id: bike && typeof bike.id === "string" && /^[a-z0-9-]{3,80}$/.test(bike.id) ? bike.id : null, classKey: (bike && bike.classKey) || "ice_manual.commuter", powertrain: bike && bike.powertrain === "ev" ? "ev" : "ice" };
        }
        function envelope(bike, tanks) { return { schema: SCHEMA, consent: CONSENT_VERSION, app: appVersion, bike: bikeOf(bike), tanks }; }

        /**
         * The exact payload sharing would send next (contributor shown as "•••").
         * @param {any[]} intervals FuelCurve.intervals() @param {any} bike
         */
        async function preview(intervals, bike) {
            const tanks = await tanksFor(intervals, st.contributor || "preview");
            return { request: `POST ${base || ""}/api/fleet/v1/tanks`, authorization: "Fleet •••", body: envelope(bike, tanks.filter((t) => !validateTank(t, now())).slice(0, MAX_TANKS)) };
        }

        async function post(body, contributor) {
            if (!doFetch) throw new Error("no network");
            const res = await doFetch(`${base}/api/fleet/v1/tanks`, { method: "POST", credentials: "omit", headers: { "Content-Type": "application/json", ...auth(contributor) }, body: JSON.stringify(body) });
            let j = null; try { j = await res.json(); } catch { j = null; }
            return { status: res.status, json: j || {} };
        }

        /**
         * Queue new usable tanks and upload what's due.
         * @param {any[]} intervals @param {any} bike
         * @returns {Promise<{ sent: number, queued: number, error: string|null, skipped?: string }>}
         */
        async function sync(intervals, bike) {
            await retryPendingDelete();
            if (!optedIn()) return { sent: 0, queued: 0, error: null, skipped: "not opted in" };
            if (bikeOf(bike).powertrain !== "ice") return { sent: 0, queued: 0, error: null, skipped: "no tanks on an EV" };
            const contributor = /** @type {string} */ (st.contributor);
            const fresh = (await tanksFor(intervals, contributor)).filter((t) => !st.sent.includes(t.id) && !st.queue.some((q) => q.id === t.id));
            for (const t of fresh) { const err = validateTank(t, now()); if (!err) st.queue.push(t); }
            write();
            if (!st.queue.length || now() < st.nextTryAt || !online()) return { sent: 0, queued: st.queue.length, error: null };
            let sent = 0;
            while (st.queue.length) {
                const batch = st.queue.slice(0, MAX_TANKS);
                let r;
                try { r = await post(envelope(bike, batch), contributor); } catch (e) { r = { status: 0, json: { error: /** @type {Error} */ (e).message } }; }
                if (r.status === 200 && r.json.ok) {
                    const rejected = new Set((r.json.rejected || []).map((x) => x.id));
                    st.sent = [...st.sent, ...batch.map((t) => t.id)].slice(-500);
                    st.queue = st.queue.slice(batch.length);
                    sent += batch.length - rejected.size;
                    st.sentTotal += batch.length - rejected.size;
                    st.failures = 0; st.nextTryAt = 0; st.lastSentAt = now(); st.lastError = rejected.size ? `${rejected.size} tank(s) refused by the server` : null;
                    write();
                    continue;
                }
                if (r.status === 400 || r.status === 413) {               // the server won't take these: don't retry them forever
                    st.queue = st.queue.slice(batch.length);
                    st.lastError = r.json.error || `refused (${r.status})`;
                    write();
                    continue;
                }
                // 401 / 429 / 5xx / offline: back off and keep the queue
                st.failures += 1;
                st.nextTryAt = now() + Math.min(6 * 3600000, 2 * 60000 * 2 ** (st.failures - 1));
                st.lastError = r.status === 0 ? "offline" : r.status === 429 ? "server busy" : `server error ${r.status}`;
                write();
                break;
            }
            return { sent, queued: st.queue.length, error: st.lastError };
        }

        /**
         * Say yes. A fresh contributor secret each time sharing is switched on.
         * @param {any[]} [intervals] @param {any} [bike]
         */
        async function optIn(intervals, bike) {
            const bytes = new Uint8Array(16);
            cr.getRandomValues(bytes);
            st.contributor = b64url(bytes);
            st.consent = { version: CONSENT_VERSION, choice: "yes", at: now() };
            st.sent = []; st.queue = []; st.failures = 0; st.nextTryAt = 0; st.lastError = null;
            write();
            return intervals ? sync(intervals, bike) : { sent: 0, queued: 0, error: null };
        }

        /** "Not now": don't ask again for 60 days. */
        function decline() {
            st.consent = { version: CONSENT_VERSION, choice: "no", at: now() };
            st.askedAt = now();
            write();
        }

        /**
         * Stop sharing and delete everything sent under this ID (FLEET.md §5).
         * @returns {Promise<{ ok: boolean, deleted: number|null, pending: boolean }>}
         */
        async function optOut() {
            const c = st.contributor;
            st.consent = { version: CONSENT_VERSION, choice: "no", at: now() };
            st.contributor = null; st.queue = []; st.sent = []; st.failures = 0; st.nextTryAt = 0; st.lastError = null;
            if (c) st.pendingDelete = c;
            write();
            if (!c) return { ok: true, deleted: 0, pending: false };
            return retryPendingDelete();
        }

        /** @returns {Promise<{ ok: boolean, deleted: number|null, pending: boolean }>} */
        async function retryPendingDelete() {
            const c = st.pendingDelete;
            if (!c) return { ok: true, deleted: null, pending: false };
            if (!doFetch || !online()) return { ok: false, deleted: null, pending: true };
            try {
                const res = await doFetch(`${base}/api/fleet/v1/contributor`, { method: "DELETE", credentials: "omit", headers: auth(c) });
                let j = null; try { j = await res.json(); } catch { j = null; }
                if (res.status === 200 || res.status === 404) {
                    st.pendingDelete = null; write();
                    return { ok: true, deleted: j && isNum(j.deleted) ? j.deleted : null, pending: false };
                }
            } catch { /* retry later */ }
            return { ok: false, deleted: null, pending: true };
        }

        /**
         * Ask now? Only after a usable tank, never twice within 60 days of "Not now",
         * never again once decided for this consent version.
         * @param {number} usableTanks
         */
        function shouldAsk(usableTanks) {
            if (usableTanks < 1) return false;
            if (st.consent && st.consent.version === CONSENT_VERSION && st.consent.choice === "yes") return false;
            if (st.consent && st.consent.version === CONSENT_VERSION && st.consent.choice === "no") return now() - (st.askedAt ?? st.consent.at) > ASK_AGAIN_MS;
            return true;
        }

        return {
            preview, sync, optIn, optOut, decline, shouldAsk, retryPendingDelete,
            markAsked() { st.askedAt = now(); write(); },
            optedIn,
            /** For the UI: plain facts, no secrets. */
            status() {
                return { optedIn: optedIn(), decided: Boolean(st.consent && st.consent.version === CONSENT_VERSION), choice: st.consent ? st.consent.choice : null, since: st.consent ? st.consent.at : null, sentTotal: st.sentTotal, queued: st.queue.length, lastSentAt: st.lastSentAt, lastError: st.lastError, pendingDelete: Boolean(st.pendingDelete), version: CONSENT_VERSION };
            },
            /** Forget everything local (after a server delete, or when there was nothing to delete). Keeps a pending delete. */
            wipeLocal() { const pd = st.pendingDelete; st = { ...read(), consent: null, contributor: null, sent: [], queue: [], nextTryAt: 0, failures: 0, lastSentAt: null, lastError: null, askedAt: null, sentTotal: 0, pendingDelete: pd }; write(); }
        };
    }

    return {
        SCHEMA, CONSENT_VERSION, MAX_TANKS, KEY, LIMITS,
        contract: { SCHEMA, CONSENT_VERSION, MAX_TANKS, LIMITS, coarsen, validateTank, validateEnvelope, monthOf },
        sha256Hex, b64url, createFleetClient
    };
});
