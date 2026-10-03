// @ts-check
/* ============================================================================
   MapUnite rides — wiring ride summaries and the fleet share into the app
   (roadmap Step 10)
   ==============================================================================
   SmartDrive calls onStart(trip), onTick(trip, fix) and onEnd(trip, extra); a
   finished ride's summary goes to the ride log on this phone (js/rides/ride-log.js)
   and fires "mu:ride-summary" for the UI.

   Sharing is OFF until the rider opts in (the consent screen is the app's: call
   optIn() after it). Then, after each ride, when the phone comes back online and
   at start-up (at most every 10 minutes), the rider's full-tank records
   (FuelCurve.fleetTanks(): no times, no places) go to POST /api/bikes/fillups.

   clearAll() is "Clear my history" for everything Steps 7–11 keep: the ride
   summaries, the fuel learner's fill-ups and rides (and the curve learned from
   them), the convoy levels typed in, the cached route heights and bridges
   (mu-trip-v1) and fuel stations (mu-pitstop-v1) — they're route coordinates —
   and, on the server, every tank this phone shared (by its token; retried until
   the server confirms).
   ============================================================================ */
(function (root) {
    "use strict";
    const W = /** @type {any} */ (root);
    if (!W.document) return;
    const SYNC_EVERY = 10 * 60 * 1000;
    const core = () => (W.MURides && W.MURides.core) || null;
    const storage = (() => { try { const s = W.localStorage; s.setItem("mu.t", "1"); s.removeItem("mu.t"); return s; } catch { return null; } })();

    /** classic-script lexicals are read by name */
    function g() {
        /** @type {any} */ const o = {};
        // @ts-ignore
        try { o.FuelCurve = typeof FuelCurve !== "undefined" ? FuelCurve : null; } catch { o.FuelCurve = null; }
        // @ts-ignore
        try { o.BikeFuel = typeof BikeFuel !== "undefined" ? BikeFuel : null; } catch { o.BikeFuel = null; }
        // @ts-ignore
        try { o.mode = typeof currentTravelMode !== "undefined" ? currentTravelMode : "bike"; } catch { o.mode = "bike"; }
        return o;
    }
    function apiBase() {
        try { return W.MUGarage && W.MUGarage.store && W.MUGarage.store.resolveApiBase ? W.MUGarage.store.resolveApiBase(W, W.location) : W.location.origin; } catch { return null; }
    }

    let log = null, share = null, lastSync = 0, syncing = null;
    function ensure() {
        const C = core();
        if (!C) return false;
        if (!log) log = C.createRideLog({ storage });
        if (!share) share = C.createFleetShare({ storage, fetch: typeof W.fetch === "function" ? W.fetch.bind(W) : null, apiBase: apiBase() });
        return true;
    }
    const newId = () => (W.crypto && W.crypto.randomUUID ? W.crypto.randomUUID() : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`);

    // ---------------------------------------------------------------- the ride
    /** @param {any} trip SmartDrive.trip */
    function onStart(trip) {
        const C = core();
        if (!C || !trip) return;
        if (!trip.rideSum || trip.rideSum.v !== 1) trip.rideSum = C.createAccumulator(trip.startTime || Date.now());    // a restored ride keeps its own
    }
    /** @param {any} trip @param {{ accepted: boolean, smoothedKmh: number, dtSec?: number, distKm?: number }} fix */
    function onTick(trip, fix) {
        const C = core();
        if (!C || !trip || !trip.active || !fix || !fix.accepted) return;
        if (!trip.rideSum) onStart(trip);
        C.step(trip.rideSum, { t: Date.now() / 1000, v: (Number(fix.smoothedKmh) || 0) / 3.6, dt: Number.isFinite(fix.dtSec) ? fix.dtSec : 1, distance: (Number(fix.distKm) || 0) * 1000 });
    }
    /**
     * @param {any} trip
     * @param {{ fuelL?: number, idleFuelL?: number, fuelSource?: string }} [extra]
     */
    function onEnd(trip, extra = {}) {
        const C = core();
        if (!C || !trip || !trip.rideSum || !ensure()) return null;
        const G = g();
        const acc = trip.rideSum;
        trip.rideSum = null;
        if (G.mode === "walk" || acc.distance < 50) return null;          // a walk, or barely moved: nothing to summarise
        const electric = G.BikeFuel && G.BikeFuel.status === "ev";
        const s = C.finish(acc, {
            endedAt: Date.now(), id: newId(),
            fuelL: electric ? null : extra.fuelL, idleFuelL: electric ? null : extra.idleFuelL, fuelSource: extra.fuelSource,
            fills: G.FuelCurve && G.FuelCurve.state ? G.FuelCurve.state.fills : [],
            bike: G.BikeFuel && typeof G.BikeFuel.tag === "function" ? G.BikeFuel.tag() : null, mode: G.mode || "bike"
        });
        log.add(s);
        document.dispatchEvent(new CustomEvent("mu:ride-summary", { detail: s }));
        sync(true);
        return s;
    }

    // ---------------------------------------------------------------- the fleet share
    /** @param {boolean} [force] */
    function sync(force = false) {
        if (!ensure()) return Promise.resolve(null);
        const st = share.status();
        if (!st.optedIn && !st.pendingErase) return Promise.resolve(null);
        if (!force && Date.now() - lastSync < SYNC_EVERY) return Promise.resolve(null);
        if (syncing) return syncing;
        lastSync = Date.now();
        const FC = g().FuelCurve;
        syncing = (st.optedIn ? share.sync(FC && typeof FC.fleetTanks === "function" ? FC.fleetTanks() : []) : share.flushErase())
            .catch((/** @type {any} */ e) => ({ ok: false, reason: String(e && e.message || e) }))
            .finally(() => { syncing = null; });
        return syncing;
    }
    function optIn() { if (!ensure()) return null; const s = share.optIn(); sync(true); return s; }
    /** @param {{ erase?: boolean }} [opts] */
    function optOut(opts) { return ensure() ? share.optOut(opts) : Promise.resolve(null); }

    // ---------------------------------------------------------------- "Clear my history"
    async function clearAll() {
        if (!ensure()) return null;
        const rides = log.size;
        log.clear();
        const G = g();
        let fills = 0;
        if (G.FuelCurve && G.FuelCurve.state) { fills = (G.FuelCurve.state.fills || []).length; G.FuelCurve.reset(); }
        try { W.localStorage.removeItem("mu.pitstop.v1"); } catch { /* blocked */ }
        try { if (W.caches) await Promise.all(["mu-trip-v1", "mu-pitstop-v1"].map((n) => W.caches.delete(n))); } catch { /* no Cache API */ }
        const erased = await share.optOut({ erase: true }).catch(() => ({ deleted: 0, pending: 1 }));
        return { rides, fills, sharedDeleted: erased ? erased.deleted : 0, sharedPending: erased ? erased.pending : 0 };
    }

    if (W.addEventListener) W.addEventListener("online", () => sync(true));
    setTimeout(() => sync(), 5000);                                      // start-up: pending erasures, unsent tanks

    W.MURides = W.MURides || {};
    W.MURides.app = {
        onStart, onTick, onEnd, sync, optIn, optOut, clearAll,
        summaries: () => (ensure() ? log.list() : []),
        status: () => (ensure() ? share.status() : null),
        mine: () => (ensure() ? share.mine() : Promise.resolve(null))
    };
})(typeof globalThis !== "undefined" ? globalThis : this);
