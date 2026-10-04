// @ts-check
/* ============================================================================
   MapUnite trip — fuel / battery energy and cost for a route, from the physics core
   ==============================================================================
   createTripEstimator(physics, model, opts).estimate(profile, speeds, conditions)

   Strict SI in, strict SI out: fuel in m³, battery energy in J, distance in m,
   time in s. The UI converts to L, kWh and km at the edge (garage/units.js), and
   prices are converted to currency per m³ / per J before they reach tripCost().

   How a trip is costed
   1. Cruising. Every profile segment (≈ 90 m – 1.4 km) is ridden at the router's
      own average speed for that stretch, on that segment's grade. The cost per
      metre comes from cruiseTable() — the same precompute the garage chart uses —
      built lazily per 0.5 % grade bucket and interpolated in grade and speed.
      A climb the bike can't take at that speed is ridden at the fastest speed it
      CAN hold (its time grows; flagged "slowed"). Steeper than the bike can climb
      at all: costed at the demanded load and flagged.
   2. Stops. Real roads aren't steady: each stop costs a launch (physics with
      acceleration, 1.0 m/s²), a stop (−1.5 m/s²: overrun fuel cut on injected
      engines, regeneration on EVs) and idling. Stops per km come from the
      segment's speed (≈ 1.5 /km in slow city traffic, none above 55 km/h), times
      the rider's traffic choice. This is the one assumed part, and it says so.
   3. Range (±). The physics' ±1σ per metre (bike-data uncertainty) is summed
      linearly along the route — the same bike's drag error applies on every
      segment, so the errors are fully correlated, not independent. The stop
      and idle terms get ±50 % on top.
   ============================================================================ */
(function (root, factory) {
    if (typeof module === "object" && module.exports) module.exports = factory();
    else { const ns = /** @type {any} */ (root).MUTrip || (/** @type {any} */ (root).MUTrip = {}); ns.energy = factory(); }
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
    "use strict";

    const TRIP_DEFAULTS = Object.freeze({
        gradeStep: 0.01,             // grade bucket width (rise/run); cost is near-linear in grade
        tableStep: 1,                // m/s between cruise-table rows (3.6 km/h), interpolated
        minSpeed: 1,                 // m/s: slowest speed a slowed climb may fall back to
        launchAccel: 1.0,            // m/s²: an unhurried launch (0–40 km/h in ~11 s)
        brakeDecel: 1.5,             // m/s²
        stopsPerKmCity: 1.5,         // at or below cityBelow …
        cityBelow: 15 / 3.6,         // m/s
        noStopsAbove: 55 / 3.6,      // … falling to none at this average speed
        stopUncertainty: 0.5,        // ± share applied to the stop + idle terms
        maxIdleShare: 0.3,           // standing still can't exceed 30 % of the router's trip time (it's inside that time)
        chargeEfficiency: 0.88       // battery energy ÷ energy drawn from the wall
    });
    /** Rider's traffic choice: stop-rate multiplier and idle seconds per stop. */
    const TRAFFIC = Object.freeze({
        light: Object.freeze({ stops: 0.5, idle: 10 }),
        normal: Object.freeze({ stops: 1, idle: 25 }),
        heavy: Object.freeze({ stops: 1.8, idle: 45 })
    });

    /**
     * Base stops per metre at segment average speed v (m/s).
     * @param {number} v
     */
    function stopsPerMetre(v) {
        const D = TRIP_DEFAULTS;
        const t = Math.min(1, Math.max(0, (D.noStopsAbove - v) / (D.noStopsAbove - D.cityBelow)));
        return (D.stopsPerKmCity / 1000) * t;
    }

    /**
     * @typedef {{ mean: number, lo: number, hi: number }} Band
     * @typedef {{
     *   powertrain: string, unit: "m3"|"J", distance: number, duration: number, routeDuration: number,
     *   total: Band, cruise: Band, hills: number, stops: number, idle: number, regen: number,
     *   stopCount: number, idleTime: number,
     *   slowedDistance: number, steepDistance: number, cappedDistance: number,
     *   perMetre: Float64Array, slowed: Uint8Array,
     *   batteryShare: Band|null, usable: number|null,
     *   ascent: number, descent: number, profileSource: string, speedSource: string, flags: string[]
     * }} TripEnergy
     *  total/cruise: m3 (fuel) or J (battery; negative = net recharge).
     *  hills: the part of cruise caused by the gradients (cruise − the same ride on the flat).
     *  regen (EV): energy put back into the battery on the way, J (≥ 0).
     */

    /**
     * @param {any} physics  MUPhysics (cruiseTable, operatingPoint)
     * @param {import("../physics/model.js").BikeModel} model
     * @param {{ altitude?: number, temperature?: number, rho?: number, gradeStep?: number, vMax?: number }} [o]
     *   vMax: highest speed the route asks for (m/s); tables stop just above it (faster precompute)
     */
    function createTripEstimator(physics, model, o = {}) {
        if (!physics || typeof physics.cruiseTable !== "function" || typeof physics.operatingPoint !== "function") throw new Error("createTripEstimator needs the physics core");
        const D = TRIP_DEFAULTS;
        const ev = model.powertrain === "ev";
        const gs = o.gradeStep || D.gradeStep;
        /** @type {Record<string, number>} */ const env0 = {};
        if (o.rho !== undefined) env0.rho = o.rho;
        else { env0.altitude = Number.isFinite(o.altitude) ? Math.min(6000, Math.max(-400, /** @type {number} */ (o.altitude))) : 0; if (o.temperature !== undefined) env0.temperature = o.temperature; }
        /** @type {Map<number, any>} */ const tables = new Map();
        const minRow = Math.ceil(D.minSpeed / D.tableStep - 1e-9);
        /** @type {{ step: number, vMin: number, vMax?: number }} */
        const tableOpts = { step: D.tableStep, vMin: 0 };
        if (Number.isFinite(o.vMax) && /** @type {number} */ (o.vMax) > 0) {
            // never above the bike's own table top (its top speed / redline): faster route speeds are "capped"
            const probe = physics.cruiseTable(model, { ...env0, grade: 0 }, { step: D.tableStep, vMin: 0, sigma: false });
            const top = probe.speed[probe.speed.length - 1];
            tableOpts.vMax = Math.min(top, Math.ceil((/** @type {number} */ (o.vMax) + 2 * D.tableStep) / D.tableStep) * D.tableStep);
        }

        /** Cruise table for grade bucket k (lazy). */
        function table(k) {
            let t = tables.get(k);
            if (!t) { t = physics.cruiseTable(model, { ...env0, grade: k * gs }, tableOpts); tables.set(k, t); }
            return t;
        }

        const pick = { pm: 0, lo: 0, hi: 0, v: 0, status: 0, capped: false };
        /** Cost per metre at speed v in one table → `pick` (status 0 ok, 1 slowed, 2 infeasible). */
        function lookup(t, v) {
            const n = t.speed.length;
            let x = v / t.step;
            pick.capped = x > n - 1;
            if (pick.capped) x = n - 1;
            if (x < minRow) x = minRow;
            const j0 = Math.min(n - 1, Math.floor(x)), j1 = Math.min(n - 1, j0 + 1), w = x - j0;
            if (t.feasible[j0]) {
                if (t.feasible[j1] && j1 !== j0) {
                    pick.pm = t.perMetre[j0] + (t.perMetre[j1] - t.perMetre[j0]) * w;
                    pick.lo = t.perMetreLo[j0] + (t.perMetreLo[j1] - t.perMetreLo[j0]) * w;
                    pick.hi = t.perMetreHi[j0] + (t.perMetreHi[j1] - t.perMetreHi[j0]) * w;
                    pick.v = t.speed[j0] + (t.speed[j1] - t.speed[j0]) * w;
                } else { pick.pm = t.perMetre[j0]; pick.lo = t.perMetreLo[j0]; pick.hi = t.perMetreHi[j0]; pick.v = t.speed[j0]; }
                pick.status = 0;
                return pick;
            }
            for (let r = j0 - 1; r >= minRow; r--) {
                if (!t.feasible[r]) continue;
                pick.pm = t.perMetre[r]; pick.lo = t.perMetreLo[r]; pick.hi = t.perMetreHi[r]; pick.v = t.speed[r]; pick.status = 1;
                return pick;
            }
            pick.pm = t.perMetre[j0]; pick.lo = t.perMetreLo[j0]; pick.hi = t.perMetreHi[j0]; pick.v = Math.max(D.minSpeed, Math.min(v, t.speed[j0])); pick.status = 2;
            return pick;
        }

        const out = { pm: 0, lo: 0, hi: 0, v: 0, status: 0, capped: false };
        /** Interpolated in grade between the two neighbouring buckets → `out`. */
        function costAt(grade, v) {
            const x = grade / gs, k0 = Math.floor(x), w = x - k0;
            const A = lookup(table(k0), v);
            const a = { pm: A.pm, lo: A.lo, hi: A.hi, v: A.v, status: A.status, capped: A.capped };
            if (w < 1e-9) { Object.assign(out, a); return out; }
            const B = lookup(table(k0 + 1), v);
            out.pm = a.pm + (B.pm - a.pm) * w; out.lo = a.lo + (B.lo - a.lo) * w; out.hi = a.hi + (B.hi - a.hi) * w;
            out.v = a.v + (B.v - a.v) * w; out.status = Math.max(a.status, B.status); out.capped = a.capped || B.capped;
            return out;
        }

        // ---- stop-and-go: extra energy of one stop from cruise speed vc, cached on the table grid ----
        /** @type {Map<number, number>} */ const stopMemo = new Map();
        const rate = (v, accel) => {
            const op = physics.operatingPoint(model, v, { ...env0, accel });
            return ev ? /** @type {number} */ (op.batteryPower) : /** @type {number} */ (op.fuelRate);
        };
        function stopCostRow(i) {
            let c = stopMemo.get(i);
            if (c !== undefined) return c;
            const vc = i * D.tableStep;
            if (vc <= 0) { stopMemo.set(i, 0); return 0; }
            const N = 16, dv = vc / N, a = D.launchAccel, b = D.brakeDecel;
            let e = 0;
            for (let k = 0; k < N; k++) {
                const vm = (k + 0.5) * dv;
                e += rate(vm, a) * (dv / a) + rate(vm, -b) * (dv / b);
            }
            const flat = lookup(table(0), vc);
            const cruise = flat.pm * ((vc * vc) / (2 * a) + (vc * vc) / (2 * b));
            c = Math.max(0, e - cruise);   // a stop is never cheaper than not stopping (we don't model the lost time)
            stopMemo.set(i, c);
            return c;
        }
        function stopCost(vc) {
            const x = vc / D.tableStep, i = Math.floor(x), w = x - i;
            return stopCostRow(i) + (stopCostRow(i + 1) - stopCostRow(i)) * w;
        }
        let idleRateMemo = null;
        const idleRate = () => (idleRateMemo === null ? (idleRateMemo = rate(0, 0)) : idleRateMemo);

        const bat = model.battery;
        const usable = bat ? (bat.usable !== null ? bat.usable : bat.gross * (model.params.usableShare ? model.params.usableShare.mean : 0.92)) : null;

        /**
         * @param {{ ds: ArrayLike<number>, grade: ArrayLike<number>, distance: number, source: string, missingShare: number, ascent: number, descent: number }} profile  from MUTrip.profile.buildProfile
         * @param {{ speed: Float64Array, source: string }} speeds  from MUTrip.profile.segmentSpeeds
         * @param {{ traffic?: "light"|"normal"|"heavy", routeDuration?: number }} [c]
         * @returns {TripEnergy}
         */
        function estimate(profile, speeds, c = {}) {
            const tr = TRAFFIC[c.traffic || "normal"] || TRAFFIC.normal;
            const m = profile.ds.length;
            if (speeds.speed.length !== m) throw new Error("speeds must have one entry per profile segment");
            const perMetre = new Float64Array(m), slowed = new Uint8Array(m);
            let cm = 0, cl = 0, ch = 0, flat = 0, regen = 0, time = 0, stops = 0, stopE = 0, idleT = 0;
            let slowedD = 0, steepD = 0, cappedD = 0;
            for (let i = 0; i < m; i++) {
                const ds = profile.ds[i], v = speeds.speed[i];
                if (!(ds > 0)) continue;
                const r = costAt(profile.grade[i], v);
                const e = r.pm * ds;
                cm += e; cl += r.lo * ds; ch += r.hi * ds;
                if (e < 0) regen -= e;
                perMetre[i] = r.pm;
                slowed[i] = r.status;
                time += ds / Math.max(D.minSpeed, r.status ? r.v : v);
                if (r.status === 1) slowedD += ds; else if (r.status === 2) steepD += ds;
                if (r.capped) cappedD += ds;
                const f = lookup(table(0), v);
                flat += f.pm * ds;
                const n = stopsPerMetre(v) * tr.stops * ds;
                if (n > 0) { stops += n; stopE += n * stopCost(Math.min(v, f.v)); idleT += n * tr.idle; }
            }
            // The router's duration already contains the waiting; never assume more standing
            // still than a fair share of it (a slow ghat road is slow from bends, not stops).
            if (c.routeDuration && c.routeDuration > 0 && idleT > D.maxIdleShare * c.routeDuration) idleT = D.maxIdleShare * c.routeDuration;
            const idleE = idleT * idleRate();
            const u = D.stopUncertainty, extra = stopE + idleE;
            const total = { mean: cm + extra, lo: cl + extra * (1 - u), hi: ch + extra * (1 + u) };
            if (!ev) { total.lo = Math.max(0, total.lo); }
            /** @type {string[]} */ const flags = [];
            if (profile.source === "flat") flags.push("hills-unknown");
            else if (profile.missingShare > 0.2) flags.push("hills-partial");
            if (slowedD > 0) flags.push("slowed");
            if (steepD > 0) flags.push("too-steep");
            if (cappedD > 0) flags.push("top-speed");
            if (speeds.source === "assumed") flags.push("speed-assumed");
            const batteryShare = usable && usable > 0 ? { mean: total.mean / usable, lo: total.lo / usable, hi: total.hi / usable } : null;
            return {
                powertrain: model.powertrain, unit: ev ? "J" : "m3",
                distance: profile.distance, duration: time + idleT, routeDuration: c.routeDuration || 0,
                total, cruise: { mean: cm, lo: cl, hi: ch }, hills: cm - flat, stops: stopE, idle: idleE, regen,
                stopCount: stops, idleTime: idleT,
                slowedDistance: slowedD, steepDistance: steepD, cappedDistance: cappedD,
                perMetre, slowed, batteryShare, usable,
                ascent: profile.ascent, descent: profile.descent, profileSource: profile.source, speedSource: speeds.source, flags
            };
        }

        return { estimate, costAt: (g, v) => ({ ...costAt(g, v) }), stopCost, get tablesBuilt() { return tables.size; } };
    }

    /**
     * Money for a trip. Prices arrive already in SI denominators (the UI converts the
     * rider's ₹/L and ₹/kWh): currency per m³ of fuel, currency per J drawn from the wall.
     * EVs pay for battery energy ÷ charging efficiency; a net recharge costs nothing.
     * @param {TripEnergy} r
     * @param {{ fuelPerM3?: number|null, energyPerJ?: number|null, chargeEfficiency?: number }} prices
     * @returns {Band|null}  null when the price for this powertrain isn't known
     */
    function tripCost(r, prices) {
        const ev = r.unit === "J";
        const p = ev ? prices.energyPerJ : prices.fuelPerM3;
        if (!(typeof p === "number" && p >= 0 && Number.isFinite(p))) return null;
        const eff = ev ? (prices.chargeEfficiency || TRIP_DEFAULTS.chargeEfficiency) : 1;
        const f = (q) => (Math.max(0, q) / eff) * p;
        return { mean: f(r.total.mean), lo: f(r.total.lo), hi: f(r.total.hi) };
    }

    return { TRIP_DEFAULTS, TRAFFIC, stopsPerMetre, createTripEstimator, tripCost };
});
