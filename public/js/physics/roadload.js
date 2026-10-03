// @ts-check
"use strict";

/* ============================================================================
   MapUnite physics — js/physics/roadload.js
   ==============================================================================
   Force needed at the rear contact patch, N:

     F = Crr·m·g·cos θ          rolling (only while moving)
       + m·g·sin θ              gradient (θ = atan(grade); grade = rise / run)
       + ½·ρ·CdA·v_air·|v_air|  aerodynamic, v_air = v + headwind
       + k·m·a                  acceleration; k ≥ 1 adds the rotating parts' inertia

   Negative F means the bike would speed up on its own (a descent or a
   tailwind): the rider brakes, or the engine is driven (engine braking).
   Gradients are accepted up to ±100 % (45°); anything steeper is not a road.
   ============================================================================ */

(function (root, factory) {
    if (typeof module === "object" && module && module.exports) module.exports = factory(require("./core.js"));
    else { const ns = /** @type {any} */ (root).MUPhysics; ns.roadload = factory(ns.core); }
})(typeof globalThis !== "undefined" ? globalThis : self, function (/** @type {any} */ core) {
    const { G, finite, positive, nonNegative, inRange } = core;

    /** Rotating-inertia factor k (model assumption: wheels, drivetrain, engine). */
    const MASS_FACTOR = 1.05;
    const MASS_FACTOR_SIGMA = 0.02;
    const MAX_GRADE = 1;

    /**
     * @typedef {object} RoadState
     * @property {number} speed       m/s, ≥ 0
     * @property {number} [grade]     rise/run, −1…1 (default 0)
     * @property {number} [accel]     m/s² (default 0)
     * @property {number} [headwind]  m/s, positive into the rider's face (default 0)
     * @property {number} rho         air density, kg/m³
     */
    /**
     * @typedef {object} Chassis
     * @property {number} mass        kg — bike + rider + load
     * @property {number} crr
     * @property {number} cda         m²
     * @property {number} [massFactor]
     */

    /**
     * @param {RoadState} s @param {Chassis} c
     * @returns {{ rolling: number, gradient: number, aero: number, inertia: number, total: number }}  N
     */
    function roadLoad(s, c) {
        const v = nonNegative(s.speed, "speed");
        const grade = s.grade === undefined ? 0 : inRange(s.grade, -MAX_GRADE, MAX_GRADE, "grade");
        const a = s.accel === undefined ? 0 : inRange(s.accel, -15, 15, "accel");
        const wind = s.headwind === undefined ? 0 : inRange(s.headwind, -60, 60, "headwind");
        const rho = inRange(s.rho, 0.3, 1.5, "rho");
        const m = positive(c.mass, "mass");
        const k = c.massFactor === undefined ? MASS_FACTOR : inRange(c.massFactor, 1, 1.5, "massFactor");
        const theta = Math.atan(grade);
        const rolling = v > 0 ? finite(c.crr, "crr") * m * G * Math.cos(theta) : 0;
        const gradient = m * G * Math.sin(theta);
        const vAir = v + wind;
        const aero = 0.5 * rho * positive(c.cda, "cda") * vAir * Math.abs(vAir);
        const inertia = k * m * a;
        return { rolling, gradient, aero, inertia, total: rolling + gradient + aero + inertia };
    }

    /** Power needed at the rear contact patch, W (negative: surplus to brake or recover). */
    const wheelPower = (/** @type {RoadState} */ s, /** @type {Chassis} */ c) => roadLoad(s, c).total * s.speed;

    return Object.freeze({ roadLoad, wheelPower, MASS_FACTOR, MASS_FACTOR_SIGMA, MAX_GRADE });
});
