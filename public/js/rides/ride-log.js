// @ts-check
/* ============================================================================
   MapUnite rides — ride summaries on the phone, and the opt-in fleet share
   (roadmap Step 10)
   ==============================================================================
   Pure logic plus two small stores over a localStorage-like object; strict SI
   (m, s, m/s, m/s², m³). No DOM, no timers. js/rides/rides-app.js wires it to
   SmartDrive and to "Clear my history".

   1. The ride accumulator (createAccumulator / step / finish) — plain data, kept in
      the ride itself (SmartDrive.trip.rideSum), so it survives a restored ride:
        - distance and time per speed band (the fuel learner's bands: under 40,
          40–60, 60–80, over 80 km/h) and per 5 km/h speed bin;
        - moving time, idle time;
        - coasting: moving above 10 km/h and slowing at least as fast as the road
          load alone would slow the bike (air drag + rolling resistance of a typical
          motorcycle and rider) — i.e. the engine isn't pushing. An estimate from GPS
          speed, labelled as one;
        - hard braking: deceleration ≥ 3 m/s² (≈ 0.3 g) for two fixes in a row, counted
          once per event;
        - top speed.
      finish() adds the fill-ups logged during the ride and the fuel estimate.

   2. The ride log (createRideLog): summaries on THIS PHONE only. No coordinates,
      no route, no place names — the day and times, the numbers above, which bike.
      At most 400 rides and 365 days; clear() is what "Clear my history" calls.

   3. The fleet share (createFleetShare): the anonymous full-tank records for the
      cloud calibration (lib/bikedb/fleet.js, FLEET.md), sent ONLY after the rider
      opted in (the consent screen is the app's). A random contributor token is
      made at opt-in and kept here; it's the only way to delete the shared tanks,
      so opting out or clearing history erases them on the server first (retried
      until the server confirms, even after the token is gone from view).
   ============================================================================ */
(function (root, factory) {
    if (typeof module === "object" && module.exports) module.exports = factory();
    else { const ns = /** @type {any} */ (root).MURides || (/** @type {any} */ (root).MURides = {}); ns.core = factory(); }
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
    "use strict";

    /** The fuel learner's bands (js/smartdrive.js FUEL_BANDS), in m/s. */
    const BANDS = Object.freeze([
        { from: 0, to: 40 / 3.6 }, { from: 40 / 3.6, to: 60 / 3.6 }, { from: 60 / 3.6, to: 80 / 3.6 }, { from: 80 / 3.6, to: Infinity }
    ]);
    const BIN = 5 / 3.6, BINS = 40;                        // 5 km/h bins, 0–200 km/h (the last takes anything faster)
    const RIDE = Object.freeze({
        movingSpeed: 3 / 3.6,                              // m/s: below this the bike is stopped (SmartDrive's own threshold)
        coastMinSpeed: 10 / 3.6,                           // m/s
        coastShare: 0.8,                                   // slowing at ≥ 80 % of the road-load deceleration
        brakeDecel: 3.0,                                   // m/s²
        // road load of a typical motorcycle and rider (documented assumption, not a bike's data):
        rho: 1.2, cda: 0.55, crr: 0.015, mass: 200, g: 9.80665
    });

    /** Deceleration the road load alone causes at v (m/s²). @param {number} v @param {Partial<typeof RIDE>} [o] */
    function roadLoadDecel(v, o = {}) {
        const R = { ...RIDE, ...o };
        return (0.5 * R.rho * R.cda * v * v + R.crr * R.mass * R.g) / R.mass;
    }

    /**
     * @typedef {{ v: 1, startedAt: number, lastT: number|null, lastV: number|null, aPrev: number|null, braking: boolean,
     *   bandDist: number[], bandTime: number[], hist: number[], movingTime: number, idleTime: number, distance: number,
     *   coastDist: number, coastTime: number, hardBrakes: number, maxSpeed: number }} Acc
     */
    /** @param {number} startedAt ms @returns {Acc} */
    function createAccumulator(startedAt) {
        return { v: 1, startedAt, lastT: null, lastV: null, aPrev: null, braking: false,
            bandDist: [0, 0, 0, 0], bandTime: [0, 0, 0, 0], hist: new Array(BINS).fill(0),
            movingTime: 0, idleTime: 0, distance: 0, coastDist: 0, coastTime: 0, hardBrakes: 0, maxSpeed: 0 };
    }
    /** @param {number} v */
    const bandOf = (v) => { for (let j = BANDS.length - 1; j >= 0; j--) if (v >= BANDS[j].from) return j; return 0; };

    /**
     * One accepted GPS fix.
     * @param {Acc} a @param {{ t: number, v: number, dt: number, distance: number }} x  t: s; v: m/s; dt: s since the last fix; distance: m
     * @param {Partial<typeof RIDE>} [o]
     */
    function step(a, x, o = {}) {
        const R = { ...RIDE, ...o };
        const v = Math.max(0, Number(x.v) || 0), dt = Math.max(0, Math.min(30, Number(x.dt) || 0)), d = Math.max(0, Number(x.distance) || 0);
        let acc = null;
        if (a.lastT !== null && a.lastV !== null && x.t > a.lastT && x.t - a.lastT <= 5) {
            const raw = (v - a.lastV) / (x.t - a.lastT);
            acc = a.aPrev === null ? raw : 0.5 * (raw + a.aPrev);
            a.aPrev = raw;
        } else a.aPrev = null;
        a.lastT = x.t; a.lastV = v;
        if (v >= R.movingSpeed) {
            const j = bandOf(v);
            a.bandDist[j] += d; a.bandTime[j] += dt;
            a.hist[Math.min(BINS - 1, Math.floor(v / BIN))] += d;
            a.movingTime += dt; a.distance += d;
            if (v > a.maxSpeed) a.maxSpeed = v;
            if (acc !== null && v >= R.coastMinSpeed && -acc >= R.coastShare * roadLoadDecel(v, R)) { a.coastDist += d; a.coastTime += dt; }
        } else a.idleTime += dt;
        const hard = acc !== null && acc <= -R.brakeDecel;
        if (hard && !a.braking) a.hardBrakes++;
        a.braking = hard;
        return acc;
    }

    const r1 = (/** @type {number} */ x) => Math.round(x * 10) / 10;
    const r3 = (/** @type {number} */ x) => Math.round(x * 1000) / 1000;
    /** Local "YYYY-MM-DD". @param {number} ms */
    function localDay(ms) { const d = new Date(ms); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`; }

    /**
     * @typedef {{ v: 1, id: string, day: string, startedAt: number, endedAt: number, duration: number, distance: number,
     *   movingTime: number, idleTime: number, maxSpeed: number,
     *   bands: Array<{ from: number, to: number|null, distance: number, time: number }>, binWidth: number, hist: number[],
     *   coasting: { distance: number, time: number, share: number, estimate: true }, hardBrakes: number,
     *   fuel: { volume: number, idleVolume: number, source: string } | null,
     *   fillups: Array<{ volume: number, full: boolean, at: number }>, bike: string|null, mode: string }} Summary
     *   SI: m, s, m/s, m³ (fuel); `to: null` = no upper edge
     */
    /**
     * The ride's summary.
     * @param {Acc} a
     * @param {{ endedAt: number, id: string, fuelL?: number|null, idleFuelL?: number|null, fuelSource?: string,
     *   fills?: Array<{ ts: number, litres: number, full?: boolean }>, bike?: string|null, mode?: string }} x
     * @returns {Summary}
     */
    function finish(a, x) {
        const fills = (x.fills || []).filter((f) => f && f.ts >= a.startedAt && f.ts <= x.endedAt && f.litres > 0)
            .map((f) => ({ volume: r3(f.litres) / 1000, full: f.full !== false, at: f.ts }));
        return {
            v: 1, id: x.id, day: localDay(a.startedAt), startedAt: a.startedAt, endedAt: x.endedAt,
            duration: Math.max(0, Math.round((x.endedAt - a.startedAt) / 1000)), distance: Math.round(a.distance),
            movingTime: Math.round(a.movingTime), idleTime: Math.round(a.idleTime), maxSpeed: r1(a.maxSpeed),
            bands: BANDS.map((b, j) => ({ from: r3(b.from), to: Number.isFinite(b.to) ? r3(b.to) : null, distance: Math.round(a.bandDist[j]), time: Math.round(a.bandTime[j]) })),
            binWidth: r3(BIN), hist: a.hist.map((h) => Math.round(h)),
            coasting: { distance: Math.round(a.coastDist), time: Math.round(a.coastTime), share: a.distance > 0 ? r3(a.coastDist / a.distance) : 0, estimate: true },
            hardBrakes: a.hardBrakes,
            fuel: Number.isFinite(x.fuelL) ? { volume: r3(/** @type {number} */ (x.fuelL)) / 1000, idleVolume: Number.isFinite(x.idleFuelL) ? r3(/** @type {number} */ (x.idleFuelL)) / 1000 : 0, source: x.fuelSource || "estimate" } : null,
            fillups: fills, bike: x.bike || null, mode: x.mode || "bike"
        };
    }

    // ------------------------------------------------------------------ the ride log
    const LOG_KEY = "mu_ride_summaries_v1";
    /**
     * @param {{ storage: { getItem: (k: string) => string|null, setItem: (k: string, v: string) => void, removeItem: (k: string) => void } | null,
     *   now?: () => number, max?: number, retentionDays?: number, key?: string }} o
     */
    function createRideLog(o) {
        const key = o.key || LOG_KEY, max = o.max || 400, keepMs = (o.retentionDays || 365) * 86400000;
        const now = o.now || Date.now;
        /** @type {Summary[]} memory copy when storage is blocked */
        let mem = [];
        /** @returns {Summary[]} */
        function read() {
            if (!o.storage) return mem;
            try { const x = JSON.parse(o.storage.getItem(key) || "null"); return x && x.v === 1 && Array.isArray(x.rides) ? x.rides : []; } catch { return []; }
        }
        /** @param {Summary[]} rides */
        function write(rides) {
            const cutoff = now() - keepMs;
            let keep = rides.filter((r) => r && r.endedAt >= cutoff).slice(-max);
            if (!o.storage) { mem = keep; return true; }
            for (let tries = 0; tries < 6; tries++) {
                try { o.storage.setItem(key, JSON.stringify({ v: 1, rides: keep })); return true; }
                catch { keep = keep.slice(Math.ceil(keep.length / 4)); }      // storage full: drop the oldest quarter
            }
            return false;
        }
        return {
            /** @param {Summary} s */
            add(s) { const rides = read().filter((r) => r.id !== s.id); rides.push(s); return write(rides); },
            list() { return read().slice(); },
            prune() { return write(read()); },
            clear() { mem = []; if (o.storage) { try { o.storage.removeItem(key); } catch { /* blocked */ } } },
            get size() { return read().length; }
        };
    }

    // ------------------------------------------------------------------ the fleet share
    const CONSENT = "fleet-calibration-v1";
    const SHARE_KEY = "mu_fleet_share_v1";
    /**
     * @param {{ storage: { getItem: (k: string) => string|null, setItem: (k: string, v: string) => void, removeItem: (k: string) => void } | null,
     *   fetch: ((url: string, init?: any) => Promise<any>) | null, apiBase: string|null, now?: () => number,
     *   randomBytes?: (n: number) => Uint8Array }} o
     */
    function createFleetShare(o) {
        const now = o.now || Date.now;
        const rnd = o.randomBytes || ((/** @type {number} */ n) => { const b = new Uint8Array(n); globalThis.crypto.getRandomValues(b); return b; });
        /** @type {any} */ let mem = null;
        const blank = () => ({ v: 1, consent: null, token: null, optedInAt: null, sent: 0, lastSyncAt: null, pendingErase: [] });
        function read() {
            if (!o.storage) return mem || blank();
            try { const x = JSON.parse(o.storage.getItem(SHARE_KEY) || "null"); return x && x.v === 1 ? { ...blank(), ...x } : blank(); } catch { return blank(); }
        }
        function write(/** @type {any} */ s) {
            const empty = !s.consent && !s.token && !s.pendingErase.length;
            if (!o.storage) { mem = empty ? null : s; return; }
            try { if (empty) o.storage.removeItem(SHARE_KEY); else o.storage.setItem(SHARE_KEY, JSON.stringify(s)); } catch { /* blocked: in memory only */ mem = s; }
        }
        const url = (/** @type {string} */ p) => (o.apiBase === null || o.apiBase === undefined ? null : `${o.apiBase.replace(/\/$/, "")}/api/bikes${p}`);
        const hex = (/** @type {Uint8Array} */ b) => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");

        async function call(/** @type {string} */ method, /** @type {string} */ p, /** @type {any} */ body) {
            const u = url(p);
            if (!u || !o.fetch) return { ok: false, status: 0, json: null, offline: true };
            try {
                const res = await o.fetch(u, { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body), credentials: "omit" });
                let json = null;
                try { json = await res.json(); } catch { /* not JSON */ }
                return { ok: res.ok, status: res.status, json, offline: false };
            } catch { return { ok: false, status: 0, json: null, offline: true }; }
        }

        /** Erase every token waiting to be erased; keeps those the server didn't confirm. */
        async function flushErase() {
            const s = read();
            const left = [];
            let deleted = 0;
            for (const token of s.pendingErase) {
                const r = await call("DELETE", "/fillups", { contributor: token });
                if (r.ok) deleted += Number(r.json && r.json.deleted) || 0;
                else if (r.offline || r.status >= 500 || r.status === 429 || r.status === 503) left.push(token);   // try again later
                // 4xx otherwise: the server can't act on it (e.g. a malformed token) — nothing to keep it for
            }
            const s2 = read();
            s2.pendingErase = left.concat(s2.pendingErase.filter((t) => !s.pendingErase.includes(t)));
            write(s2);
            return { deleted, pending: s2.pendingErase.length };
        }

        return {
            CONSENT,
            status() { const s = read(); return { optedIn: s.consent === CONSENT, optedInAt: s.optedInAt, sent: s.sent, lastSyncAt: s.lastSyncAt, pendingErase: s.pendingErase.length, available: url("") !== null }; },
            /** The rider agreed (the app showed the consent screen). */
            optIn() {
                const s = read();
                if (s.consent !== CONSENT || !s.token) { s.consent = CONSENT; s.token = hex(rnd(16)); s.optedInAt = now(); s.sent = 0; }
                write(s);
                return this.status();
            },
            /**
             * Stop sharing. With erase (the default) the tanks already shared are deleted
             * on the server too; the token is forgotten here either way.
             * @param {{ erase?: boolean }} [opts]
             */
            async optOut(opts = {}) {
                const s = read();
                if (s.token && opts.erase !== false && !s.pendingErase.includes(s.token)) s.pendingErase.push(s.token);
                s.consent = null; s.token = null; s.optedInAt = null; s.sent = 0; s.lastSyncAt = null;
                write(s);
                return opts.erase === false ? { deleted: 0, pending: read().pendingErase.length } : flushErase();
            },
            flushErase,
            /**
             * Send the rider's full-tank records (FuelCurve.fleetTanks()). Only when opted in.
             * @param {any[]} tanks
             */
            async sync(tanks) {
                const s = read();
                if (s.pendingErase.length) await flushErase();
                if (s.consent !== CONSENT || !s.token) return { ok: false, reason: "not-opted-in", stored: 0 };
                let stored = 0, duplicates = 0, rejected = 0;
                for (let i = 0; i < tanks.length; i += 20) {
                    const r = await call("POST", "/fillups", { consent: CONSENT, contributor: s.token, tanks: tanks.slice(i, i + 20) });
                    if (r.offline) return { ok: false, reason: "offline", stored };
                    if (!r.ok && r.status !== 400) return { ok: false, reason: (r.json && r.json.reason) || `http-${r.status}`, stored };
                    stored += Number(r.json && r.json.stored) || 0;
                    duplicates += Number(r.json && r.json.duplicates) || 0;
                    rejected += Array.isArray(r.json && r.json.rejected) ? r.json.rejected.length : 0;
                }
                const s2 = read();
                if (s2.token === s.token) { s2.sent += stored; s2.lastSyncAt = now(); write(s2); }
                return { ok: true, stored, duplicates, rejected };
            },
            /** What the server holds for this phone's token. */
            async mine() {
                const s = read();
                if (!s.token) return { ok: true, classes: [] };
                const r = await call("POST", "/fillups/mine", { contributor: s.token });
                return r.ok && r.json ? { ok: true, classes: r.json.classes || [] } : { ok: false, reason: r.offline ? "offline" : `http-${r.status}` };
            }
        };
    }

    return { BANDS, BIN, BINS, RIDE, roadLoadDecel, createAccumulator, step, finish, localDay, createRideLog, createFleetShare, LOG_KEY, SHARE_KEY, CONSENT };
});
