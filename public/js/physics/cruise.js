// @ts-check
/* ============================================================================
   MapUnite physics — operating points, gear choice, shift points, cruise tables, ±1σ
   ==============================================================================
   Everything SI: m/s, rad/s, W, N, m3/s (fuel), m3/m (fuel per metre), J/m.

   operatingPoint(model, v, env)  one steady (or accelerating) state
   chooseGear(model, v, env)      the gear that holds v with reserve at least fuel
   shiftPoints(model, env)        economy and full-throttle up/down-shift speeds
   maxSpeed(model, env)           highest sustainable speed
   cruiseTable(model, env)        THE precompute: one row per speed with the best gear,
                                  engine speed, power, fuel (or battery energy) per
                                  metre with a ±1σ range, feasibility, and the eco
                                  speed band. Allocation-free inner loop; < 5 ms on a
                                  mid-range phone (test/physics/perf.test.mjs)

   Rules that hold everywhere (tests/physics/properties.test.mjs):
     - finite outputs for every finite input, at standstill too (fuel per metre
       at v = 0 is +Infinity: you burn fuel and go nowhere);
     - fuel is never negative;
     - on a fuel-injected engine, overrun (negative wheel power with the engine
       above its fuel-cut speed) burns no fuel at all;
     - any finite gradient is handled; too steep for the engine or the tyre is
       reported as infeasible, never as nonsense.

   ±1σ: one-at-a-time ±σ perturbation of every uncertain parameter (drag area,
   rolling resistance, efficiencies, friction terms, rider mass, tyre
   deflection, EV auxiliary load) at the chosen gear, combined in quadrature:
       σ_f = √Σ ((f(p_k + σ_k) − f(p_k − σ_k)) / 2)²
   The parameters are treated as independent. Fuel ranges are clamped at 0.
   ============================================================================ */

(function (root, factory) {
    if (typeof module === "object" && module.exports) module.exports = factory(require("./atmosphere.js"), require("./roadload.js"), require("./powertrain.js"));
    else { const ns = /** @type {any} */ (root).MUPhysics || (/** @type {any} */ (root).MUPhysics = {}); ns.cruise = factory(ns.atmosphere, ns.roadload, ns.powertrain); }
})(typeof globalThis !== "undefined" ? globalThis : this, function (
    /** @type {typeof import("./atmosphere.js")} */ atmosphere,
    /** @type {typeof import("./roadload.js")} */ roadload,
    /** @type {typeof import("./powertrain.js")} */ powertrain
) {
    "use strict";

    const { torqueAt, frictionPower, motorForceMax, batteryPower } = powertrain;
    const { tractiveForce, tractionLimit, ROAD_DEFAULTS } = roadload;

    const CRUISE_DEFAULTS = Object.freeze({
        reserve: 0.85,        // a gear is advised only if the steady load uses ≤ 85 % of the power available there
        step: 0.5,            // m/s between table rows (1.8 km/h)
        vMaxCap: 50,          // m/s (180 km/h) — table ceiling when no top speed is published
        ecoTolerance: 0.10,   // eco band: within 10 % of the best fuel (or energy) per metre …
        ecoMinSpeed: 30 / 3.6 // … at practical cruising speeds (≥ 30 km/h). Below that the physics
                              // optimum (the slowest speed in top gear) isn't useful riding advice.
    });
    const ICE_SIGMA_PARAMS = ["cda", "crr", "etaDt", "riderMass", "deflection", "etaInd", "fmepA", "fmepB", "fmepC"];
    const EV_SIGMA_PARAMS = ["cda", "crr", "etaDt", "riderMass", "deflection", "etaMotor", "etaRegen", "aux"];
    const V_EPS = 1e-9;

    /**
     * @typedef {{ rho?: number, altitude?: number, temperature?: number, pressure?: number, relativeHumidity?: number, grade?: number, wind?: number, accel?: number }} Env
     * @typedef {{ rho: number, grade: number, sin: number, cos: number, wind: number, accel: number }} ResolvedEnv
     * @typedef {Record<string, number>} Params
     */

    /**
     * Riding conditions: air density (given, or from altitude/temperature/pressure/humidity),
     * gradient (rise/run), headwind (m/s, negative = tailwind), acceleration (m/s²).
     * @param {Env} [env]
     * @returns {ResolvedEnv}
     */
    function resolveEnv(env = {}) {
        let rho;
        if (env.rho !== undefined) {
            rho = atmosphere.finite(env.rho, "rho");
            if (rho <= 0) throw new RangeError("rho must be > 0");
        } else rho = atmosphere.airDensityAt(env);
        const grade = env.grade === undefined ? 0 : env.grade;
        const { sin, cos } = roadload.slope(grade);
        const wind = env.wind === undefined ? 0 : atmosphere.finite(env.wind, "wind");
        const accel = env.accel === undefined ? 0 : atmosphere.finite(env.accel, "accel");
        return { rho, grade, sin, cos, wind, accel };
    }

    /** Mean of every uncertain parameter. @param {import("./model.js").BikeModel} m @returns {Params} */
    function meanParams(m) {
        /** @type {Params} */ const p = {};
        for (const [k, u] of Object.entries(m.params)) p[k] = u.mean;
        return p;
    }

    /** Keep a perturbed parameter physical: efficiencies in (0.05, 0.995], others ≥ 0. */
    function physical(name, x) {
        if (name.startsWith("eta")) return Math.min(0.995, Math.max(0.05, x));
        if (name === "deflection") return Math.min(0.15, Math.max(0, x));
        if (name === "cda" || name === "crr" || name === "riderMass") return Math.max(name === "cda" ? 1e-3 : 0, x);
        return x;
    }

    // ------------------------------------------------------------------
    // The state of one operating point (reused object: no allocation in loops)
    // ------------------------------------------------------------------
    /**
     * @typedef {{ feasible: boolean, reason: string, gear: number, omega: number, slipping: boolean,
     *   force: number, wheelPower: number, enginePower: number, available: number, reserve: number,
     *   fuelRate: number, fuelCut: boolean, overrun: boolean, batteryPower: number, perMetre: number }} State
     */
    /** @returns {State} */
    const newState = () => ({ feasible: false, reason: "", gear: -1, omega: 0, slipping: false, force: 0, wheelPower: 0, enginePower: 0, available: 0, reserve: 0, fuelRate: 0, fuelCut: false, overrun: false, batteryPower: 0, perMetre: 0 });

    /** Engine speed of a CVT scooter at road speed v (rad/s). */
    function cvtOmega(cvt, v, r, idle) {
        if (v <= V_EPS) return idle;                                 // standing: clutch open, engine idles
        const wLow = (v / r) * cvt.ratioMax * cvt.final;
        if (wLow < cvt.omegaEngage) return cvt.omegaEngage;          // clutch slipping
        if (wLow <= cvt.omegaCruise) return wLow;                    // variator still at its launch ratio
        const wHigh = (v / r) * cvt.ratioMin * cvt.final;
        return wHigh >= cvt.omegaCruise ? wHigh : cvt.omegaCruise;  // variator holds cruise speed until top ratio
    }

    /**
     * ICE operating point in a given gear (manual) or the CVT's own ratio.
     * @param {import("./model.js").BikeModel} m  @param {Params} P  @param {ResolvedEnv} E  @param {number} v  @param {number} gear  @param {State} st
     */
    function iceState(m, P, E, v, gear, st) {
        const eng = /** @type {NonNullable<import("./model.js").BikeModel["engine"]>} */ (m.engine);
        const k = eng.curve;
        const mass = m.massFixed + P.riderMass;
        const r = m.unloadedRadius * (1 - P.deflection);
        const F = tractiveForce(mass, v, E.sin, E.cos, P.cda, P.crr, E.rho, E.wind, ROAD_DEFAULTS.rotatingMassFactor * mass * E.accel);
        const Pw = F * v;
        st.gear = gear; st.force = F; st.wheelPower = Pw; st.fuelCut = false; st.slipping = false; st.reason = ""; st.batteryPower = 0; st.overrun = false;
        // engine speed; wOut = speed of the clutch's driven side (gearbox input, or the variator at its launch ratio)
        let w, wOut;
        const cvt = m.drive.cvt;
        if (m.drive.kind === "manual") {
            wOut = (v / r) * m.drive.ratios[gear];
            w = wOut;
            if (w < eng.omegaIdle) { w = eng.omegaIdle; st.slipping = v > V_EPS; }   // clutch slipping (standing: clutch open)
        } else {
            const c = /** @type {NonNullable<typeof cvt>} */ (cvt);
            w = cvtOmega(c, v, r, eng.omegaIdle);
            wOut = (v / r) * c.ratioMax * c.final;
            st.slipping = v > V_EPS && wOut < c.omegaEngage;
        }
        // Brake power at the crank. Through a slipping clutch the torque passes but the
        // speeds differ, so the engine supplies clutch torque × its OWN speed:
        //   T_clutch = P_drive / ω_out = F·r / (ratio·η_dt)  (finite as v → 0)
        let Pb = Pw >= 0 ? Pw / P.etaDt : Pw * P.etaDt;
        if (st.slipping && wOut > V_EPS) Pb *= w / wOut;
        // a loaded CVT lets the engine rev up (towards peak power) when the cruise speed can't carry the load
        if (cvt && !st.slipping && Pb > 0 && v > V_EPS && Pb > torqueAt(k, w) * w) {
            const wTop = Math.min(wOut, eng.omegaMax);
            const target = Math.min(Math.max(k.omegaPower, w), wTop);
            if (target > w) {
                if (torqueAt(k, target) * target >= Pb) {
                    let lo = w, hi = target;                                      // power rises up to ω_P: bisect for the least speed that carries the load
                    for (let i = 0; i < 30; i++) { const mid = 0.5 * (lo + hi); if (torqueAt(k, mid) * mid >= Pb) hi = mid; else lo = mid; }
                    w = hi;
                } else w = target;
            }
        }
        const over = (m.drive.kind === "manual" ? wOut : w) > eng.omegaMax * (1 + 1e-12);
        const avail = over ? 0 : torqueAt(k, w) * w;
        st.omega = w; st.enginePower = Pb; st.available = avail;
        st.reserve = Pb > 0 ? (avail > 0 ? Math.max(-1, 1 - Pb / avail) : -1) : 1;
        const trac = tractionLimit(mass, E.cos);
        if (over) { st.feasible = false; st.reason = "over-rev"; }
        else if (F > trac) { st.feasible = false; st.reason = "traction"; }
        else if (Pb > avail * (1 + 1e-12)) { st.feasible = false; st.reason = "power"; }
        else st.feasible = true;
        // Fuel (Willans line, continuous): indicated power = brake + friction. Only when that
        // is ≤ 0 (gravity beats drag, rolling AND engine braking, so the rider has the throttle
        // shut) is the engine truly overrunning: fuel injection then cuts fuel above its cut-off
        // speed with the clutch engaged. Otherwise the idle circuit is the floor.
        const fuel = /** @type {NonNullable<import("./model.js").BikeModel["fuel"]>} */ (m.fuel);
        const fmep = FMEP_SCRATCH; fmep.A = P.fmepA; fmep.B = P.fmepB; fmep.C = P.fmepC;
        const indicated = Pb + frictionPower(eng.displacement, eng.revsPerCycle, fmep, w);
        st.overrun = indicated <= 0;
        let fuelW;
        if (eng.fuelInjected && !st.slipping && v > V_EPS && w >= eng.omegaCut) {
            fuelW = indicated > 0 ? indicated / P.etaInd : 0;
            st.fuelCut = indicated <= 0;
        } else {
            const idleFeed = frictionPower(eng.displacement, eng.revsPerCycle, fmep, eng.omegaIdle) / P.etaInd;
            fuelW = Math.max(indicated / P.etaInd, idleFeed);
        }
        st.fuelRate = fuelW / fuel.lhv;
        st.perMetre = v > V_EPS ? st.fuelRate / v : Infinity;
        return st;
    }
    const FMEP_SCRATCH = { A: 0, B: 0, C: 0 };

    /**
     * EV operating point.
     * @param {import("./model.js").BikeModel} m  @param {Params} P  @param {ResolvedEnv} E  @param {number} v  @param {State} st
     */
    function evState(m, P, E, v, st) {
        const mot = /** @type {NonNullable<import("./model.js").BikeModel["motor"]>} */ (m.motor);
        const mass = m.massFixed + P.riderMass;
        const r = m.unloadedRadius * (1 - P.deflection);
        const F = tractiveForce(mass, v, E.sin, E.cos, P.cda, P.crr, E.rho, E.wind, ROAD_DEFAULTS.rotatingMassFactor * mass * E.accel);
        const Pw = F * v;
        st.gear = -1; st.force = F; st.wheelPower = Pw; st.fuelCut = false; st.slipping = false; st.reason = ""; st.fuelRate = 0; st.overrun = Pw < 0;
        st.omega = m.drive.evRatio > 0 && v > V_EPS ? (v / r) * m.drive.evRatio : 0;
        const fMax = motorForceMax(mot, v, r, P.etaDt);
        st.available = v > V_EPS ? Math.min(fMax * v, mot.peakPower * P.etaDt) : 0;
        st.reserve = F > 0 ? (fMax > 0 ? Math.max(-1, 1 - F / fMax) : -1) : 1;
        const trac = tractionLimit(mass, E.cos);
        if (mot.speedLimit !== null && v > mot.speedLimit + 1e-9) { st.feasible = false; st.reason = "speed-limit"; }
        else if (F > trac) { st.feasible = false; st.reason = "traction"; }
        else if (F > fMax * (1 + 1e-12) && !(v <= V_EPS && mot.wheelTorque === null)) { st.feasible = false; st.reason = "power"; }
        else st.feasible = true;
        const pb = batteryPower(Pw, { etaDt: P.etaDt, etaMotor: P.etaMotor, etaRegen: P.etaRegen, aux: P.aux, regenLimit: mot.regenLimit });
        st.batteryPower = pb; st.enginePower = pb;
        st.perMetre = v > V_EPS ? pb / v : Infinity;
        return st;
    }

    // ------------------------------------------------------------------
    // Gear choice
    // ------------------------------------------------------------------
    /**
     * Pick the gear for speed v: among gears that hold v with reserve, keep the
     * clutch engaged and the engine at or above its lugging limit, the one that
     * burns least (ties: the higher gear). Downhill this naturally picks the gear
     * whose fuel cut is active, else the one needing the least throttle.
     * Fallbacks: the feasible gear with most reserve; then the least-bad gear.
     * Writes the chosen state into `out` and returns it.
     * @param {import("./model.js").BikeModel} m @param {Params} P @param {ResolvedEnv} E @param {number} v @param {number} reserve @param {State} out @param {State} tmp
     */
    function chooseGearInto(m, P, E, v, reserve, out, tmp) {
        const n = m.drive.ratios.length;
        const eng = /** @type {NonNullable<import("./model.js").BikeModel["engine"]>} */ (m.engine);
        let best = -1, bestKind = 0;   // kind: 3 advisable, 2 feasible, 1 any
        let bestScore = -Infinity;
        for (let g = 0; g < n; g++) {
            iceState(m, P, E, v, g, tmp);
            if (tmp.reason === "over-rev") continue;
            const lugOk = tmp.omega >= eng.omegaLug || g === 0;
            const engagedOk = !(tmp.slipping && g > 0);
            const advisable = tmp.feasible && engagedOk && lugOk && (tmp.enginePower <= 0 || tmp.enginePower <= reserve * tmp.available);
            const kind = advisable ? 3 : tmp.feasible && engagedOk ? 2 : 1;
            const score = kind === 3 ? -tmp.fuelRate + g * 1e-18 : kind === 2 ? tmp.reserve - g * 1e-12 : tmp.available - tmp.enginePower;
            if (kind > bestKind || (kind === bestKind && score > bestScore)) {
                bestKind = kind; bestScore = score; best = g;
            }
        }
        if (best < 0) { iceState(m, P, E, v, n - 1, out); return out; }   // every gear over-revs: report the tallest (reason "over-rev")
        iceState(m, P, E, v, best, out);
        if (bestKind < 3 && out.feasible && out.wheelPower >= 0) out.reason = "low-reserve";
        return out;
    }

    /**
     * State at speed v for any powertrain (gear chosen for manual bikes).
     * @param {import("./model.js").BikeModel} m @param {Params} P @param {ResolvedEnv} E @param {number} v @param {number} reserve @param {State} out @param {State} tmp
     */
    function stateAt(m, P, E, v, reserve, out, tmp) {
        if (m.powertrain === "ev") return evState(m, P, E, v, out);
        if (m.drive.kind === "manual") return chooseGearInto(m, P, E, v, reserve, out, tmp);
        return iceState(m, P, E, v, -1, out);
    }

    /** Same state, gear held fixed (for σ): manual uses `gear`, others ignore it. */
    function stateFixed(m, P, E, v, gear, out) {
        if (m.powertrain === "ev") return evState(m, P, E, v, out);
        return iceState(m, P, E, v, m.drive.kind === "manual" ? gear : -1, out);
    }

    // ------------------------------------------------------------------
    // Public: one operating point
    // ------------------------------------------------------------------
    /**
     * @typedef {{ v: number, feasible: boolean, reason: string|null, gear: number|null, omega: number|null,
     *   wheelForce: number, wheelPower: number, enginePower: number|null, availablePower: number, torqueReserve: number,
     *   fuelRate: number|null, fuelPerMetre: number|null, fuelCut: boolean, overrun: boolean,
     *   batteryPower: number|null, energyPerMetre: number|null, clutchSlipping: boolean }} OperatingPoint
     */
    /**
     * One operating point. torqueReserve = 1 − required ÷ available, in [−1, 1] (−1: can't deliver).
     * @param {import("./model.js").BikeModel} model
     * @param {number} v  road speed, m/s (≥ 0)
     * @param {Env} [env]
     * @param {{ gear?: number, reserve?: number, params?: Params }} [opts]  gear: 1-based, to force one
     * @returns {OperatingPoint}
     */
    function operatingPoint(model, v, env = {}, opts = {}) {
        if (typeof v !== "number" || !Number.isFinite(v) || v < 0) throw new RangeError(`speed must be a finite number ≥ 0 m/s (got ${String(v)})`);
        const E = resolveEnv(env), P = opts.params || meanParams(model);
        const st = newState(), tmp = newState();
        if (opts.gear !== undefined) {
            if (model.drive.kind !== "manual") throw new Error("only manual gearboxes have gears");
            if (!Number.isInteger(opts.gear) || opts.gear < 1 || opts.gear > model.drive.ratios.length) throw new RangeError(`gear must be 1…${model.drive.ratios.length}`);
            iceState(model, P, E, v, opts.gear - 1, st);
        } else stateAt(model, P, E, v, opts.reserve === undefined ? CRUISE_DEFAULTS.reserve : opts.reserve, st, tmp);
        const ice = model.powertrain !== "ev";
        return {
            v, feasible: st.feasible, reason: st.reason || null,
            gear: model.drive.kind === "manual" ? st.gear + 1 : null,
            omega: ice || st.omega > 0 ? st.omega : null,
            wheelForce: st.force, wheelPower: st.wheelPower,
            enginePower: ice ? st.enginePower : null,
            availablePower: st.available, torqueReserve: st.reserve,
            fuelRate: ice ? st.fuelRate : null,
            fuelPerMetre: ice ? (v > V_EPS ? st.perMetre : null) : null,
            fuelCut: st.fuelCut,
            overrun: st.overrun,
            batteryPower: ice ? null : st.batteryPower,
            energyPerMetre: ice ? null : (v > V_EPS ? st.perMetre : null),
            clutchSlipping: st.slipping
        };
    }

    // ------------------------------------------------------------------
    // Shift points (manual gearboxes)
    // ------------------------------------------------------------------
    /**
     * @typedef {{ from: number, to: number, speed: number, omegaFrom: number, omegaTo: number, atRedline: boolean }} Shift
     * @typedef {{ advisory: boolean, ecoUp: Shift[], perfUp: Shift[], ecoDown: Shift[] }} ShiftPoints
     */
    /**
     * Economy upshift: the lowest speed where the next gear is above its lugging
     * limit and carries the load (on the given road) with reserve. Economy downshift:
     * the speed where the current gear falls below its lugging limit. Full-throttle
     * upshift: where the next gear's wheel force overtakes this gear's, else the redline.
     * `advisory` is false when the gearing came from the class default (no gear advice then).
     * @param {import("./model.js").BikeModel} model @param {Env} [env] @param {{ reserve?: number }} [opts]
     * @returns {ShiftPoints|null}  null for CVT scooters and EVs
     */
    function shiftPoints(model, env = {}, opts = {}) {
        if (model.drive.kind !== "manual") return null;
        const eng = /** @type {NonNullable<import("./model.js").BikeModel["engine"]>} */ (model.engine);
        const E = resolveEnv(env), P = meanParams(model);
        const reserve = opts.reserve === undefined ? CRUISE_DEFAULTS.reserve : opts.reserve;
        const r = model.unloadedRadius * (1 - P.deflection);
        const R = model.drive.ratios, n = R.length, k = eng.curve;
        const st = newState();
        /** @type {Shift[]} */ const ecoUp = [], perfUp = [], ecoDown = [];
        const shift = (i, v, atRedline) => ({ from: i + 1, to: i + 2, speed: v, omegaFrom: (v / r) * R[i], omegaTo: (v / r) * R[i + 1], atRedline });
        for (let i = 0; i < n - 1; i++) {
            const vTop = (eng.omegaMax * r) / R[i];                 // redline in gear i
            // economy upshift
            let v = (eng.omegaLug * r) / R[i + 1];
            const dv = Math.max(0.05, vTop / 400);
            while (v < vTop) {
                iceState(model, P, E, v, i + 1, st);
                if (st.feasible && !st.slipping && (st.wheelPower <= 0 || st.enginePower <= reserve * st.available)) break;
                v += dv;
            }
            ecoUp.push(shift(i, Math.min(v, vTop), v >= vTop));        // atRedline: the next gear never carries the load before the redline
            // full-throttle upshift: F_i(v) − F_{i+1}(v) changes sign, else redline
            const force = (g, vv) => (torqueAt(k, (vv / r) * R[g]) * R[g] * P.etaDt) / r;
            const vStart = Math.max((eng.omegaIdle * r) / R[i + 1], (k.omegaTorque * r) / R[i]);
            let vPerf = vTop, crossed = false;
            const N = 200;
            let prev = force(i, vStart) - force(i + 1, vStart);
            for (let j = 1; j <= N; j++) {
                const vv = vStart + ((vTop - vStart) * j) / N;
                const d = force(i, vv) - force(i + 1, vv);
                if (prev > 0 && d <= 0) {
                    let lo = vv - (vTop - vStart) / N, hi = vv;
                    for (let it = 0; it < 40; it++) { const mid = 0.5 * (lo + hi); if (force(i, mid) - force(i + 1, mid) > 0) lo = mid; else hi = mid; }
                    vPerf = hi; crossed = true;
                    break;
                }
                prev = d;
            }
            perfUp.push(shift(i, vPerf, !crossed));
        }
        for (let i = 1; i < n; i++) {
            const v = (eng.omegaLug * r) / R[i];
            ecoDown.push({ from: i + 1, to: i, speed: v, omegaFrom: (v / r) * R[i], omegaTo: (v / r) * R[i - 1], atRedline: false });
        }
        return { advisory: model.gearAdvice, ecoUp, perfUp, ecoDown };
    }

    // ------------------------------------------------------------------
    // Maximum sustainable speed
    // ------------------------------------------------------------------
    /**
     * @param {import("./model.js").BikeModel} model @param {Env} [env]
     * @returns {number} m/s (0 if the bike can't move off on this road)
     */
    function maxSpeed(model, env = {}) {
        const E = resolveEnv(env), P = meanParams(model);
        const st = newState(), tmp = newState();
        const ok = (v) => stateAt(model, P, E, v, 1, st, tmp).feasible;
        const cap = model.motor && model.motor.speedLimit !== null ? model.motor.speedLimit : 120;
        let last = 0;
        for (let v = 0.5; v <= cap + 1e-9; v += 0.5) { if (ok(v)) last = v; else if (last > 0) break; }
        if (last === 0) return ok(0.1) ? 0.1 : 0;
        let lo = last, hi = Math.min(last + 0.5, cap);
        if (ok(hi)) return hi;
        for (let i = 0; i < 40; i++) { const mid = 0.5 * (lo + hi); if (ok(mid)) lo = mid; else hi = mid; }
        return lo;
    }

    // ------------------------------------------------------------------
    // The cruise-band table (the one precompute)
    // ------------------------------------------------------------------
    /**
     * @typedef {{
     *   powertrain: string, units: "SI", env: ResolvedEnv, step: number,
     *   speed: Float64Array, feasible: Uint8Array, gear: Int8Array, omega: Float64Array,
     *   wheelPower: Float64Array, enginePower: Float64Array,
     *   perMetre: Float64Array, perMetreLo: Float64Array, perMetreHi: Float64Array,
     *   fuelRate: Float64Array | null, range: Float64Array | null, rangeLo: Float64Array | null, rangeHi: Float64Array | null,
     *   eco: { speedBest: number, speedLow: number, speedHigh: number, perMetreBest: number } | null,
     *   gearAdvice: boolean
     * }} CruiseTable
     *  perMetre: fuel m3/m (petrol) or battery energy J/m (EV); +Infinity at standstill.
     *  gear: 1-based for manual gearboxes, 0 otherwise.
     */
    /**
     * @param {import("./model.js").BikeModel} model
     * @param {Env} [env]
     * @param {{ vMin?: number, vMax?: number, step?: number, reserve?: number, sigma?: boolean, ecoTolerance?: number, ecoMinSpeed?: number }} [opts]
     * @returns {CruiseTable}
     */
    function cruiseTable(model, env = {}, opts = {}) {
        const E = resolveEnv(env);
        const step = opts.step === undefined ? CRUISE_DEFAULTS.step : opts.step;
        if (!(step > 0)) throw new RangeError("step must be > 0");
        const vMin = opts.vMin === undefined ? 0 : opts.vMin;
        const vMaxDefault = defaultTableTop(model);
        const vMax = opts.vMax === undefined ? vMaxDefault : opts.vMax;
        if (!(vMin >= 0) || !(vMax >= vMin)) throw new RangeError("need 0 ≤ vMin ≤ vMax");
        const reserve = opts.reserve === undefined ? CRUISE_DEFAULTS.reserve : opts.reserve;
        const n = Math.floor((vMax - vMin) / step + 1e-9) + 1;
        const ice = model.powertrain !== "ev";
        const speed = new Float64Array(n), feasible = new Uint8Array(n), gear = new Int8Array(n), omega = new Float64Array(n);
        const wheelPower = new Float64Array(n), enginePower = new Float64Array(n);
        const perMetre = new Float64Array(n), perMetreLo = new Float64Array(n), perMetreHi = new Float64Array(n);
        const fuelRate = ice ? new Float64Array(n) : null;
        const range = ice ? null : new Float64Array(n), rangeLo = ice ? null : new Float64Array(n), rangeHi = ice ? null : new Float64Array(n);

        const P = meanParams(model);
        const names = (ice ? ICE_SIGMA_PARAMS : EV_SIGMA_PARAMS).filter((k) => model.params[k] && model.params[k].sigma > 0);
        const doSigma = opts.sigma !== false;
        // perturbed parameter sets, built once
        const plus = names.map((k) => ({ ...P, [k]: physical(k, P[k] + model.params[k].sigma) }));
        const minus = names.map((k) => ({ ...P, [k]: physical(k, P[k] - model.params[k].sigma) }));
        const st = newState(), tmp = newState(), sp = newState();
        const bat = model.battery;
        const usableMean = bat ? (bat.usable !== null ? bat.usable : bat.gross * P.usableShare) : 0;
        const usableSigma = bat && bat.usable === null && model.params.usableShare ? bat.gross * model.params.usableShare.sigma : 0;

        for (let i = 0; i < n; i++) {
            const v = vMin + i * step;
            speed[i] = v;
            stateAt(model, P, E, v, reserve, st, tmp);
            feasible[i] = st.feasible ? 1 : 0;
            gear[i] = model.drive.kind === "manual" ? st.gear + 1 : 0;
            omega[i] = st.omega;
            wheelPower[i] = st.wheelPower;
            enginePower[i] = st.enginePower;
            const f = st.perMetre;
            perMetre[i] = f;
            if (fuelRate) fuelRate[i] = st.fuelRate;
            let s2 = 0;
            if (doSigma && Number.isFinite(f)) {
                for (let j = 0; j < names.length; j++) {
                    const a = stateFixed(model, plus[j], E, v, st.gear, sp).perMetre;
                    const b = stateFixed(model, minus[j], E, v, st.gear, sp).perMetre;
                    const d = 0.5 * (a - b);
                    s2 += d * d;
                }
            }
            const s = Math.sqrt(s2);
            perMetreLo[i] = Number.isFinite(f) ? (ice ? Math.max(0, f - s) : f - s) : f;
            perMetreHi[i] = Number.isFinite(f) ? f + s : f;
            if (range && rangeLo && rangeHi) {
                // range = usable energy ÷ energy per metre (driving only: a descent gives no "range")
                const rr = (e, eps) => (eps > 0 && Number.isFinite(eps) ? e / eps : Infinity);
                range[i] = rr(usableMean, f);
                const relE = usableMean > 0 ? usableSigma / usableMean : 0;
                const relF = f > 0 && Number.isFinite(f) ? s / f : 0;
                // σ_rel = √((σ_E/E)² + (σ_f/f)²); range ∝ 1/f is asymmetric, so lo = R/(1+σ), hi = R/(1−σ) (σ capped at 0.9)
                const rel = Math.min(0.9, Math.sqrt(relE * relE + relF * relF));
                rangeLo[i] = Number.isFinite(range[i]) ? range[i] / (1 + rel) : range[i];
                rangeHi[i] = Number.isFinite(range[i]) ? range[i] / (1 - rel) : range[i];
            }
        }
        return {
            powertrain: model.powertrain, units: "SI", env: E, step,
            speed, feasible, gear, omega, wheelPower, enginePower, perMetre, perMetreLo, perMetreHi, fuelRate, range, rangeLo, rangeHi,
            eco: ecoBand(speed, perMetre, feasible, opts.ecoTolerance === undefined ? CRUISE_DEFAULTS.ecoTolerance : opts.ecoTolerance, opts.ecoMinSpeed === undefined ? CRUISE_DEFAULTS.ecoMinSpeed : opts.ecoMinSpeed),
            gearAdvice: model.gearAdvice
        };
    }

    /**
     * Highest speed worth tabulating: the EV's speed limit, else the published top
     * speed, else the speed at the redline in the tallest ratio (beyond it every row
     * would be an over-rev), capped at vMaxCap.
     * @param {import("./model.js").BikeModel} m
     */
    function defaultTableTop(m) {
        if (m.motor && m.motor.speedLimit !== null) return m.motor.speedLimit;
        if (m.topSpeed !== null) return Math.min(m.topSpeed, CRUISE_DEFAULTS.vMaxCap);
        if (m.engine) {
            const tallest = m.drive.kind === "manual" ? m.drive.ratios[m.drive.ratios.length - 1] : m.drive.ratios[1];
            const r = m.unloadedRadius * (1 - m.params.deflection.mean);
            return Math.min((m.engine.omegaMax * r) / tallest, CRUISE_DEFAULTS.vMaxCap);
        }
        return CRUISE_DEFAULTS.vMaxCap;
    }

    /**
     * Eco speed band: the contiguous run of feasible speeds (≥ minSpeed) around the
     * cheapest one, within `tol` of its cost per metre.
     * @param {Float64Array} speed @param {Float64Array} cost @param {Uint8Array} feasible @param {number} tol @param {number} minSpeed
     */
    function ecoBand(speed, cost, feasible, tol, minSpeed) {
        let best = -1;
        for (let i = 0; i < speed.length; i++) {
            if (!feasible[i] || speed[i] < minSpeed - 1e-9 || !(cost[i] > 0) || !Number.isFinite(cost[i])) continue;
            if (best < 0 || cost[i] < cost[best]) best = i;
        }
        if (best < 0) return null;
        const limit = cost[best] * (1 + tol);
        const ok = (i) => feasible[i] && speed[i] >= minSpeed - 1e-9 && cost[i] > 0 && cost[i] <= limit;
        let lo = best, hi = best;
        while (lo > 0 && ok(lo - 1)) lo--;
        while (hi < speed.length - 1 && ok(hi + 1)) hi++;
        return { speedBest: speed[best], speedLow: speed[lo], speedHigh: speed[hi], perMetreBest: cost[best] };
    }

    return { CRUISE_DEFAULTS, ICE_SIGMA_PARAMS, EV_SIGMA_PARAMS, resolveEnv, meanParams, operatingPoint, shiftPoints, maxSpeed, cruiseTable, ecoBand, cvtOmega };
});
