// @ts-check
"use strict";

/* ============================================================================
   MapUnite physics — js/physics/cruise.js
   ==============================================================================
   Cruise-band tables: what steady riding costs at every speed, precomputed
   once per bike and conditions (one table is a few hundred operating points;
   the budget is 5 ms on a mid-range phone — see the timing test).

     cruiseTable(vehicle, env)          speeds, gear, engine speed, cost per metre, feasibility,
                                        and the ECO BAND: the speeds whose cost is within
                                        `ecoTolerance` (default 5 %) of the cheapest
     cruiseTableWithUncertainty(params, env)   the same with ±1σ on every row and on the band
     evRange(vehicle, conditions)       steady-speed range from the usable battery energy

   Cost per metre: ICE m³ of fuel per m (× 1e5 = L/100 km); EV J per m of
   battery energy (÷ 3.6 = Wh/km).
   ============================================================================ */

(function (root, factory) {
    if (typeof module === "object" && module && module.exports) {
        module.exports = factory(require("./core.js"), require("./profile.js"), require("./drive.js"), require("./uncertainty.js"));
    } else { const ns = /** @type {any} */ (root).MUPhysics; ns.cruise = factory(ns.core, ns.profile, ns.drive, ns.uncertainty); }
})(typeof globalThis !== "undefined" ? globalThis : self, function (/** @type {any} */ core, /** @type {any} */ profile, /** @type {any} */ drive, /** @type {any} */ uncertainty) {
    const { PhysicsError, positive, inRange } = core;

    const DEFAULT_V_MIN = 10 / 3.6;
    const DEFAULT_STEP = 0.5;
    const DEFAULT_ECO_TOLERANCE = 0.05;
    const SPEED_CAP = 60;

    /**
     * @typedef {{ rho: number, grade?: number, headwind?: number, auxPower?: number, reserve?: number }} Env
     * @typedef {{ vMin?: number, vMax?: number, step?: number, ecoTolerance?: number }} TableOpts
     * @typedef {object} CruiseTable
     * @property {string} powertrain
     * @property {"m3/m" | "J/m"} unit
     * @property {Float64Array} speeds        m/s
     * @property {Int8Array} gear             1-based; 0 = no gear (CVT, EV)
     * @property {Float64Array} engineSpeed   rad/s
     * @property {Float64Array} perDistance   fuel m³/m or battery J/m
     * @property {Uint8Array} feasible        1 = the bike can hold this speed here
     * @property {{ lo: number, hi: number, best: number } | null} eco   null if nothing is feasible
     */

    /**
     * Highest speed worth tabulating: top gear at redline, the CVT's top ratio at
     * the limiter, an EV's power-limited speed on the level (when it publishes no
     * top speed) — and never above a published top speed.
     * @param {any} vehicle @param {{ rho: number }} env
     */
    function maxSpeed(vehicle, env) {
        const r = vehicle.rollingRadius;
        let v = SPEED_CAP;
        if (vehicle.overallRatios) v = (vehicle.engine.redline * r) / vehicle.overallRatios[vehicle.overallRatios.length - 1];
        else if (vehicle.cvt) v = (vehicle.engine.limiter * r) / (vehicle.cvt.final * vehicle.cvt.ratioMin);
        const top = vehicle.params.topSpeed;
        if (top !== null) v = Math.min(v, top);
        else if (vehicle.ev) {
            // bisection: level-road wheel power = the motor's peak at the wheel
            let lo = 0, hi = SPEED_CAP;
            for (let k = 0; k < 50; k++) {
                const mid = (lo + hi) / 2;
                if (drive.demand(vehicle, { speed: mid, rho: env.rho }).power <= vehicle.ev.maxWheelPower) lo = mid; else hi = mid;
            }
            v = lo;
        }
        return Math.min(v, SPEED_CAP);
    }

    /**
     * @param {any} vehicle @param {Env} env @param {TableOpts} [opts]
     * @returns {CruiseTable}
     */
    function cruiseTable(vehicle, env, opts = {}) {
        const step = opts.step === undefined ? DEFAULT_STEP : inRange(opts.step, 0.05, 5, "step");
        const vMin = opts.vMin === undefined ? DEFAULT_V_MIN : positive(opts.vMin, "vMin");
        const vMax = opts.vMax === undefined ? maxSpeed(vehicle, env) : positive(opts.vMax, "vMax");
        const tol = opts.ecoTolerance === undefined ? DEFAULT_ECO_TOLERANCE : inRange(opts.ecoTolerance, 0, 1, "ecoTolerance");
        if (!(vMax > vMin)) throw new PhysicsError(`vMax (${vMax}) must exceed vMin (${vMin})`);
        const n = Math.floor((vMax - vMin) / step + 1e-9) + 1;
        const t = {
            powertrain: vehicle.params.powertrain,
            unit: /** @type {"m3/m" | "J/m"} */ (vehicle.params.powertrain === "ev" ? "J/m" : "m3/m"),
            speeds: new Float64Array(n), gear: new Int8Array(n), engineSpeed: new Float64Array(n),
            perDistance: new Float64Array(n), feasible: new Uint8Array(n), eco: /** @type {CruiseTable["eco"]} */ (null)
        };
        const isEv = t.unit === "J/m";
        const c = { speed: 0, rho: env.rho, grade: env.grade, headwind: env.headwind, auxPower: env.auxPower, reserve: env.reserve };
        for (let i = 0; i < n; i++) {
            const v = vMin + i * step;
            c.speed = v;
            const p = drive.operatingPoint(vehicle, c);
            t.speeds[i] = v;
            t.gear[i] = p.gear || 0;
            t.engineSpeed[i] = p.engineSpeed;
            t.perDistance[i] = (isEv ? p.batteryPower : p.fuelRate) / v;
            t.feasible[i] = p.feasible ? 1 : 0;
        }
        t.eco = ecoBand(t, tol);
        return t;
    }

    /**
     * The contiguous run of feasible speeds around the cheapest one whose cost
     * per metre is within `tol` of it.
     * @param {CruiseTable} t @param {number} tol
     */
    function ecoBand(t, tol) {
        let iBest = -1;
        for (let i = 0; i < t.speeds.length; i++) if (t.feasible[i] && (iBest < 0 || t.perDistance[i] < t.perDistance[iBest])) iBest = i;
        if (iBest < 0) return null;
        const limit = t.perDistance[iBest] >= 0 ? t.perDistance[iBest] * (1 + tol) : t.perDistance[iBest] * (1 - tol);
        let lo = iBest, hi = iBest;
        while (lo > 0 && t.feasible[lo - 1] && t.perDistance[lo - 1] <= limit) lo--;
        while (hi < t.speeds.length - 1 && t.feasible[hi + 1] && t.perDistance[hi + 1] <= limit) hi++;
        return { lo: t.speeds[lo], hi: t.speeds[hi], best: t.speeds[iBest] };
    }

    /**
     * The cruise table with ±1σ on every row's cost and on the eco band's edges.
     * The speed grid is fixed from the nominal bike, so every perturbed table
     * lines up row by row.
     * @param {any} params @param {Env} env @param {TableOpts} [opts]
     * @returns {{ table: CruiseTable, perDistanceSigma: Float64Array, perDistanceLow: Float64Array, perDistanceHigh: Float64Array,
     *             eco: { lo: number, hi: number, best: number, loSigma: number, hiSigma: number, bestSigma: number } | null,
     *             contributions: Array<{ key: string, origin: string, sigma: number }> }}
     */
    function cruiseTableWithUncertainty(params, env, opts = {}) {
        const nominal = profile.compileVehicle(params);
        const grid = { ...opts, vMin: opts.vMin ?? DEFAULT_V_MIN, vMax: opts.vMax ?? maxSpeed(nominal, env) };
        const table = cruiseTable(nominal, env, grid);
        const n = table.perDistance.length;
        /** Cost per metre on every row, then the eco band's lo / hi / best. */
        const pack = (/** @type {CruiseTable} */ t) => {
            const out = new Float64Array(n + 3);
            out.set(t.perDistance);
            const e = t.eco || table.eco || { lo: 0, hi: 0, best: 0 };
            out[n] = e.lo; out[n + 1] = e.hi; out[n + 2] = e.best;
            return out;
        };
        const r = uncertainty.propagate(params, (/** @type {any} */ v) => pack(cruiseTable(v, env, grid)));
        const sig = /** @type {Float64Array} */ (r.sigma);
        return {
            table,
            perDistanceSigma: sig.slice(0, n),
            perDistanceLow: Float64Array.from(table.perDistance, (x, i) => Math.max(0, x - sig[i])),
            perDistanceHigh: Float64Array.from(table.perDistance, (x, i) => x + sig[i]),
            eco: table.eco ? { ...table.eco, loSigma: sig[n], hiSigma: sig[n + 1], bestSigma: sig[n + 2] } : null,
            contributions: r.contributions
        };
    }

    /**
     * Steady-speed range of an EV from its usable energy, m.
     * @param {any} vehicle @param {{ speed: number, rho: number, grade?: number, headwind?: number, auxPower?: number }} c
     */
    function evRange(vehicle, c) {
        if (!vehicle.ev) throw new PhysicsError("evRange needs an electric vehicle");
        const p = drive.evPoint(vehicle, c);
        const perMetre = p.batteryPower / positive(c.speed, "speed");
        return perMetre > 0 ? vehicle.ev.usableEnergy / perMetre : Infinity;
    }

    return Object.freeze({ cruiseTable, cruiseTableWithUncertainty, ecoBand, evRange, maxSpeed, DEFAULT_ECO_TOLERANCE });
});
