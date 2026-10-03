// @ts-check
/* ============================================================================
   MapUnite physics — road load (strict SI: N, W, m/s, kg)
   ==============================================================================
   Tractive force needed at the rear wheel:
       F = F_roll + F_aero + F_grade + F_inertia
       F_roll    = C_rr·m·g·cos θ          (0 at standstill: nothing is rolling)
       F_aero    = ½·ρ·CdA·v_a·|v_a|,      v_a = v + headwind (a tailwind pushes)
       F_grade   = m·g·sin θ
       F_inertia = δ·m·a                    (δ: rotating-mass factor, default 1.05)
   The gradient is a rise/run fraction (0.1 = 10 %). sin θ and cos θ come from
   it algebraically (g/√(1+g²), 1/√(1+g²)), so ANY finite gradient, even a wall,
   gives finite forces.
   Traction limit: the rear tyre can push with at most μ·(rear share)·m·g·cos θ.
   Road speed must be ≥ 0 (the model covers riding forwards).
   ============================================================================ */

(function (root, factory) {
    if (typeof module === "object" && module.exports) module.exports = factory();
    else { const ns = /** @type {any} */ (root).MUPhysics || (/** @type {any} */ (root).MUPhysics = {}); ns.roadload = factory(); }
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
    "use strict";

    const G0 = 9.80665;
    /** Documented assumptions (not bike data). */
    const ROAD_DEFAULTS = Object.freeze({
        rotatingMassFactor: 1.05,  // wheels, tyres and drivetrain inertia: +5 % effective mass
        tyreGrip: 0.8,             // μ, dry asphalt
        rearShare: 0.6             // share of the weight on the driven (rear) wheel when climbing
    });

    /**
     * sin θ and cos θ for a gradient (rise/run), finite for any finite input.
     * @param {number} grade
     * @returns {{ sin: number, cos: number }}
     */
    function slope(grade) {
        if (typeof grade !== "number" || !Number.isFinite(grade)) throw new TypeError(`grade must be a finite number (got ${String(grade)})`);
        if (grade === 0) return { sin: 0, cos: 1 };
        const h = Math.hypot(1, grade);
        return { sin: grade / h, cos: 1 / h };
    }

    /**
     * @typedef {{ mass: number, v: number, grade?: number, cda: number, crr: number, rho: number, wind?: number, accel?: number, rotatingMassFactor?: number }} RoadLoadInput
     * @typedef {{ rolling: number, aero: number, gravity: number, inertia: number, total: number, power: number }} RoadLoad
     */

    /**
     * Road-load forces (N) and the wheel power (W) at speed v.
     * @param {RoadLoadInput} s
     * @returns {RoadLoad}
     */
    function roadLoad(s) {
        const v = s.v;
        if (!(v >= 0) || !Number.isFinite(v)) throw new RangeError(`speed must be a finite number ≥ 0 m/s (got ${String(v)})`);
        if (!(s.mass > 0)) throw new RangeError("mass must be > 0 kg");
        const { sin, cos } = slope(s.grade === undefined ? 0 : s.grade);
        const va = v + (s.wind === undefined ? 0 : s.wind);
        const rolling = v > 0 ? s.crr * s.mass * G0 * cos : 0;
        const aero = 0.5 * s.rho * s.cda * va * Math.abs(va);
        const gravity = s.mass * G0 * sin;
        const inertia = (s.rotatingMassFactor === undefined ? ROAD_DEFAULTS.rotatingMassFactor : s.rotatingMassFactor) * s.mass * (s.accel === undefined ? 0 : s.accel);
        const total = rolling + aero + gravity + inertia;
        return { rolling, aero, gravity, inertia, total, power: total * v };
    }

    /**
     * Same as roadLoad().total without allocating: the hot path of the table precompute.
     * @param {number} mass @param {number} v @param {number} sin @param {number} cos @param {number} cda @param {number} crr
     * @param {number} rho @param {number} wind @param {number} inertiaForce  δ·m·a (N)
     */
    function tractiveForce(mass, v, sin, cos, cda, crr, rho, wind, inertiaForce) {
        const va = v + wind;
        return (v > 0 ? crr * mass * G0 * cos : 0) + 0.5 * rho * cda * va * Math.abs(va) + mass * G0 * sin + inertiaForce;
    }

    /**
     * Largest force the rear tyre can transmit, N.
     * @param {number} mass @param {number} cos  cos θ  @param {number} [grip] @param {number} [rearShare]
     */
    function tractionLimit(mass, cos, grip = ROAD_DEFAULTS.tyreGrip, rearShare = ROAD_DEFAULTS.rearShare) {
        return grip * rearShare * mass * G0 * cos;
    }

    return { G0, ROAD_DEFAULTS, slope, roadLoad, tractiveForce, tractionLimit };
});
