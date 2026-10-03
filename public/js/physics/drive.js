// @ts-check
"use strict";

/* ============================================================================
   MapUnite physics — js/physics/drive.js
   ==============================================================================
   From "this speed, this gradient, this acceleration" to an operating point:
   engine speed, whether the bike can do it, and what it costs.

   Manual gearbox (ice_manual)
     engine ω = v · R_g / r,  R_g = primary × gear_g × final
     a gear is FEASIBLE when ω ≤ redline, ω ≥ lugging limit (except first gear
     with the clutch slipping below it), and the full-load wheel force
     T(ω)·R_g·η/r covers the demand with a power RESERVE (default 15 %) so the
     rider can still accelerate gently. Among feasible gears the one burning
     the least fuel wins (ties: the higher gear).
   CVT (ice_cvt) — no gear advice (plan C4). A centrifugal variator holds the
     engine near a load-dependent speed: from CVT_LIGHT_LOAD × ωT at light load
     to ωP at full load, inside what the ratio range allows; below that range
     the centrifugal clutch slips.
   Electric (ev) — no gear advice. Power-limited by the motor's peak power;
     battery power = wheel power / (η_drivetrain · η_motor); braking energy is
     recovered at regenEfficiency.

   All results are finite. A demand the bike can't meet (a 40 % ramp) is
   reported as infeasible with a reason, never as NaN or a throw.
   ============================================================================ */

(function (root, factory) {
    if (typeof module === "object" && module && module.exports) {
        module.exports = factory(require("./core.js"), require("./engine.js"), require("./roadload.js"));
    } else { const ns = /** @type {any} */ (root).MUPhysics; ns.drive = factory(ns.core, ns.engine, ns.roadload); }
})(typeof globalThis !== "undefined" ? globalThis : self, function (/** @type {any} */ core, /** @type {any} */ engine, /** @type {any} */ roadload) {
    const { PhysicsError, G, clamp, inRange } = core;

    const DEFAULT_RESERVE = 0.15;
    /**
     * Tyre–road friction coefficient bounding any drive force: F ≤ μ·m·g·cos θ.
     * 1.0 is an UPPER bound for dry asphalt (wet ≈ 0.5–0.7) applied to the whole
     * weight, so it only ever rejects the truly impossible (a gradient steeper
     * than μ, wheelspin at launch) — a model assumption, not bike data.
     */
    const TRACTION_MU = 1.0;

    /**
     * @typedef {object} Conditions
     * @property {number} speed            m/s
     * @property {number} rho              kg/m³
     * @property {number} [grade]
     * @property {number} [accel]          m/s²
     * @property {number} [headwind]       m/s
     * @property {number} [auxPower]       W, EV auxiliaries; default: the vehicle's auxPower prior
     * @property {number} [reserve]        power reserve required for "feasible" (default 0.15)
     */
    /**
     * @typedef {object} Point
     * @property {number | null} gear      1-based gear (manual); null for CVT, EV and standstill
     * @property {number} engineSpeed      rad/s (0 for EV)
     * @property {number} wheelForce       N demanded at the contact patch
     * @property {number} wheelPower       W demanded (negative: surplus)
     * @property {number} availableForce   N the powertrain can give here
     * @property {boolean} feasible
     * @property {string} [reason]         why not feasible
     * @property {number} fuelRate         m³/s (ICE; 0 for EV)
     * @property {number} batteryPower     W drawn from the battery (EV; negative: charging)
     * @property {boolean} clutchSlip
     */

    /**
     * Force and power demanded at the contact patch, and the most the tyre can transmit.
     * @param {any} vehicle @param {Conditions} c
     */
    function demand(vehicle, c) {
        const rl = roadload.roadLoad({ speed: c.speed, grade: c.grade, accel: c.accel, headwind: c.headwind, rho: c.rho },
            { mass: vehicle.mass, crr: vehicle.crr, cda: vehicle.cda, massFactor: vehicle.massFactor });
        const traction = TRACTION_MU * vehicle.mass * G * Math.cos(Math.atan(c.grade || 0));
        return { force: rl.total, power: rl.total * c.speed, traction };
    }

    /**
     * Engine operating point for a given engine speed and overall ratio.
     * Brake power follows from the wheel force: driving, the drivetrain loses
     * (1 − η); on the overrun the road turns the engine through the same losses.
     * @param {any} vehicle @param {number} F @param {number} omega @param {number} ratio @param {number} reserve
     */
    function enginePoint(vehicle, F, omega, ratio, reserve) {
        const e = vehicle.engine, r = vehicle.rollingRadius, eta = vehicle.drivetrainEfficiency;
        const crankTorque = F > 0 ? (F * r) / (ratio * eta) : (F * r * eta) / ratio;
        const brakePower = crankTorque * omega;
        const availableForce = (e.torque.torque(omega) * ratio * eta) / r;
        const fuelRate = engine.fuelVolumeRate(engine.fuelPower(brakePower, omega, e.fuel), e.lhvVolume);
        return { brakePower, availableForce, fuelRate, feasible: F <= 0 || F * (1 + reserve) <= availableForce };
    }

    /** Below this speed with no drive demanded, the bike is stopped with the engine idling in neutral. */
    const STANDSTILL = 0.1;

    /**
     * Engine idling, clutch out / in neutral: no drive, idle fuel flow.
     * @param {any} vehicle @param {number} F @param {number} P
     * @returns {Point}
     */
    function idlePoint(vehicle, F, P) {
        const e = vehicle.engine;
        return {
            gear: null, engineSpeed: e.fuel.idleSpeed, wheelForce: F, wheelPower: P, availableForce: 0, feasible: true,
            fuelRate: engine.fuelVolumeRate(engine.fuelPower(0, e.fuel.idleSpeed, e.fuel), e.lhvVolume), batteryPower: 0, clutchSlip: false
        };
    }

    /**
     * Every gear of a manual bike at these conditions.
     * @param {any} vehicle @param {Conditions} c
     * @returns {Point[]}
     */
    function gearPoints(vehicle, c) {
        if (!vehicle.overallRatios) throw new PhysicsError("gearPoints needs a manual gearbox");
        const reserve = c.reserve === undefined ? DEFAULT_RESERVE : inRange(c.reserve, 0, 2, "reserve");
        const { force: F, power: P, traction } = demand(vehicle, c);
        const e = vehicle.engine, r = vehicle.rollingRadius;
        return vehicle.overallRatios.map((/** @type {number} */ R, /** @type {number} */ i) => {
            const roadOmega = (c.speed * R) / r;
            // First gear may slip the clutch below the lugging limit (pulling away).
            const clutchSlip = i === 0 && roadOmega < e.lugSpeed;
            const omega = clutchSlip ? e.lugSpeed : roadOmega;
            const pt = enginePoint(vehicle, F, omega, R, reserve);
            const availableForce = Math.min(pt.availableForce, traction);
            /** @type {string | undefined} */
            let reason;
            if (omega > e.redline) reason = "over redline";
            else if (omega < e.lugSpeed) reason = "below the lugging limit";
            else if (F > traction) reason = "beyond tyre grip";
            else if (!pt.feasible) reason = "not enough power";
            return {
                gear: i + 1, engineSpeed: omega, wheelForce: F, wheelPower: P, availableForce,
                feasible: !reason, reason, fuelRate: pt.fuelRate, batteryPower: 0, clutchSlip
            };
        });
    }

    /**
     * The gear that does the job for the least fuel; if none can, the one
     * that comes closest (most force), marked infeasible.
     * @param {any} vehicle @param {Conditions} c
     * @returns {Point}
     */
    function chooseGear(vehicle, c) {
        const d = demand(vehicle, c);
        if (c.speed < STANDSTILL && d.force <= 0) return idlePoint(vehicle, d.force, d.power);
        const pts = gearPoints(vehicle, c);
        let best = null;
        for (const p of pts) {
            if (!p.feasible) continue;
            if (!best || p.fuelRate < best.fuelRate - 1e-15 || (Math.abs(p.fuelRate - best.fuelRate) <= 1e-15 && /** @type {number} */ (p.gear) > /** @type {number} */ (best.gear))) best = p;
        }
        if (best) return best;
        const usable = pts.filter((p) => p.engineSpeed <= vehicle.engine.redline);
        const pool = usable.length ? usable : pts;
        return pool.reduce((a, b) => (b.availableForce > a.availableForce ? b : a));
    }

    /**
     * CVT operating point.
     * @param {any} vehicle @param {Conditions} c
     * @returns {Point}
     */
    function cvtPoint(vehicle, c) {
        const reserve = c.reserve === undefined ? DEFAULT_RESERVE : inRange(c.reserve, 0, 2, "reserve");
        const { force: F, power: P, traction } = demand(vehicle, c);
        const e = vehicle.engine, t = vehicle.cvt, r = vehicle.rollingRadius, eta = vehicle.drivetrainEfficiency;
        const tq = e.torque.map;
        const light = vehicle.cvtLightLoad * tq.peakTorqueSpeed;
        const load = clamp(P > 0 ? P / (eta * tq.peakPower) : 0, 0, 1);
        const hold = Math.max(e.fuel.idleSpeed, light + (tq.peakPowerSpeed - light) * load);
        const lo = (c.speed * t.final * t.ratioMin) / r, hi = (c.speed * t.final * t.ratioMax) / r;
        // No drive demanded: once the road can't keep the engine above the clutch's
        // engagement (~ the light-load speed) the clutch lets go and the engine idles.
        if (F <= 0 && (c.speed < STANDSTILL || lo < light)) return idlePoint(vehicle, F, P);
        const clutchSlip = hi < hold;              // too slow for the variator: the centrifugal clutch slips
        // Driving: held at the load-dependent speed. Overrun: the road drives the engine at the upshifted ratio.
        const omega = F <= 0 ? lo : clutchSlip ? hold : Math.max(hold, lo);
        const ratio = clutchSlip ? t.final * t.ratioMax : (omega * r) / Math.max(c.speed, 1e-9);
        const pt = enginePoint(vehicle, F, omega, ratio, reserve);
        /** @type {string | undefined} */
        const reason = omega > e.limiter ? "over the rev limit" : F > traction ? "beyond tyre grip" : !pt.feasible ? "not enough power" : undefined;
        return {
            gear: null, engineSpeed: omega, wheelForce: F, wheelPower: P, availableForce: Math.min(pt.availableForce, traction),
            feasible: !reason, reason, fuelRate: pt.fuelRate, batteryPower: 0, clutchSlip
        };
    }

    /**
     * Electric operating point.
     * @param {any} vehicle @param {Conditions} c
     * @returns {Point}
     */
    function evPoint(vehicle, c) {
        const reserve = c.reserve === undefined ? DEFAULT_RESERVE : inRange(c.reserve, 0, 2, "reserve");
        const aux = c.auxPower === undefined ? vehicle.ev.auxPower : inRange(c.auxPower, 0, 2000, "auxPower");
        const { force: F, power: P, traction } = demand(vehicle, c);
        const ev = vehicle.ev, eta = vehicle.drivetrainEfficiency;
        const maxP = ev.maxWheelPower;
        const availableForce = c.speed > 0 ? Math.min(maxP / c.speed, traction) : traction;
        let battery;
        if (P >= 0) battery = P / (eta * ev.motorEfficiency);
        else battery = Math.max(P * ev.regenEfficiency, -maxP);   // recovered, never more than the motor can absorb
        /** @type {string | undefined} */
        let reason;
        const top = vehicle.params.topSpeed;
        if (top !== null && c.speed > top * 1.0001) reason = "over the published top speed";
        else if (F > traction) reason = "beyond tyre grip";
        else if (P > 0 && P * (1 + reserve) > maxP) reason = "not enough power";
        return {
            gear: null, engineSpeed: 0, wheelForce: F, wheelPower: P, availableForce,
            feasible: !reason, reason, fuelRate: 0, batteryPower: battery + aux, clutchSlip: false
        };
    }

    /**
     * The operating point for any powertrain (manual: the chosen gear).
     * @param {any} vehicle @param {Conditions} c
     * @returns {Point}
     */
    function operatingPoint(vehicle, c) {
        const pt = vehicle.params.powertrain;
        if (pt === "ev") return evPoint(vehicle, c);
        if (pt === "ice_cvt") return cvtPoint(vehicle, c);
        return chooseGear(vehicle, c);
    }

    /**
     * Upshift speeds for a manual bike, per gear (1st→2nd ...):
     *   performance: the speed from which the next gear gives at least as much
     *     wheel force (full throttle), or the redline speed if it never does;
     *   economy: the lowest speed at which the next gear is above its lugging
     *     limit and can hold a steady speed on the level with the reserve.
     * @param {any} vehicle
     * @param {{ rho: number, step?: number }} env
     * @returns {Array<{ from: number, to: number, performanceSpeed: number, performanceEngineSpeed: number, economySpeed: number | null, economyEngineSpeed: number | null }>}
     */
    function shiftPoints(vehicle, env) {
        if (!vehicle.overallRatios) throw new PhysicsError("shift points apply to manual gearboxes only");
        const R = vehicle.overallRatios, r = vehicle.rollingRadius, e = vehicle.engine, eta = vehicle.drivetrainEfficiency;
        const step = env.step || 0.05;
        const force = (/** @type {number} */ i, /** @type {number} */ v) => (e.torque.torque((v * R[i]) / r) * R[i] * eta) / r;
        const out = [];
        for (let i = 0; i < R.length - 1; i++) {
            const vRed = (e.redline * r) / R[i];
            const vLugNext = (e.lugSpeed * r) / R[i + 1];
            let perf = vRed;
            for (let v = vLugNext; v <= vRed; v += step) if (force(i + 1, v) >= force(i, v)) { perf = v; break; }
            let eco = null;
            for (let v = vLugNext; v <= vRed + step; v += step) {
                const p = gearPoints(vehicle, { speed: v, rho: env.rho })[i + 1];
                if (p.feasible) { eco = v; break; }
            }
            out.push({
                from: i + 1, to: i + 2,
                performanceSpeed: perf, performanceEngineSpeed: (perf * R[i]) / r,
                economySpeed: eco, economyEngineSpeed: eco === null ? null : (eco * R[i]) / r
            });
        }
        return out;
    }

    return Object.freeze({ demand, idlePoint, gearPoints, chooseGear, cvtPoint, evPoint, operatingPoint, shiftPoints, DEFAULT_RESERVE, TRACTION_MU });
});
