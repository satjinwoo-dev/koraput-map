// @ts-check
"use strict";

/* ============================================================================
   MapUnite physics — js/physics/core.js
   ==============================================================================
   Shared constants and input guards for the physics core (plan step 4).

   Rules every module in js/physics/ follows:
     - Pure functions: no DOM, no I/O, no clock, no randomness. The same inputs
       always give the same outputs, so the phone, the website and the cloud
       calibration worker (Node) compute identical numbers.
     - Strict SI in and out: m, kg, s, rad/s, W, N, N*m, J, Pa, m3. Display
       units (km/h, rpm, L/100 km, km/L) are the UI's job.
     - Bad input throws PhysicsError with the offending name and value; a
       physically impossible state is reported, never papered over with NaN.

   Loading: classic <script> tags, core.js first, then the other modules in any
   order after their dependencies (see index.js); everything hangs off
   window.MUPhysics. In Node: require("public/js/physics/index.js").
   ============================================================================ */

(function (root, factory) {
    const api = factory();
    if (typeof module === "object" && module && module.exports) module.exports = api;
    else { const ns = /** @type {any} */ (root).MUPhysics = /** @type {any} */ (root).MUPhysics || {}; ns.core = api; }
})(typeof globalThis !== "undefined" ? globalThis : self, function () {

    /** Standard gravity, m/s² (CGPM 1901, exact). */
    const G = 9.80665;
    /** Specific gas constant of dry air, J/(kg·K). */
    const R_DRY_AIR = 287.05;
    /** Specific gas constant of water vapour, J/(kg·K). */
    const R_WATER_VAPOUR = 461.5;
    /** ISA sea-level pressure (Pa) and temperature (K), and the tropospheric lapse rate (K/m). */
    const ISA_P0 = 101325;
    const ISA_T0 = 288.15;
    const ISA_LAPSE = 0.0065;
    const TWO_PI = 2 * Math.PI;

    class PhysicsError extends Error {
        /** @param {string} message */
        constructor(message) { super(message); this.name = "PhysicsError"; }
    }

    /**
     * @param {unknown} x @param {string} name
     * @returns {number}
     */
    function finite(x, name) {
        if (typeof x !== "number" || !Number.isFinite(x)) throw new PhysicsError(`${name} must be a finite number (got ${String(x)})`);
        return x;
    }
    /** @param {unknown} x @param {string} name */
    function positive(x, name) {
        const v = finite(x, name);
        if (!(v > 0)) throw new PhysicsError(`${name} must be > 0 (got ${v})`);
        return v;
    }
    /** @param {unknown} x @param {string} name */
    function nonNegative(x, name) {
        const v = finite(x, name);
        if (v < 0) throw new PhysicsError(`${name} must be ≥ 0 (got ${v})`);
        return v;
    }
    /** @param {unknown} x @param {number} lo @param {number} hi @param {string} name */
    function inRange(x, lo, hi, name) {
        const v = finite(x, name);
        if (v < lo || v > hi) throw new PhysicsError(`${name} must be within [${lo}, ${hi}] (got ${v})`);
        return v;
    }
    /** @param {number} x @param {number} lo @param {number} hi */
    const clamp = (x, lo, hi) => (x < lo ? lo : x > hi ? hi : x);

    return Object.freeze({
        G, R_DRY_AIR, R_WATER_VAPOUR, ISA_P0, ISA_T0, ISA_LAPSE, TWO_PI,
        PhysicsError, finite, positive, nonNegative, inRange, clamp
    });
});
