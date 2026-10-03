// @ts-check
"use strict";

/* ============================================================================
   MapUnite physics — js/physics/atmosphere.js
   ==============================================================================
   Air density for the aerodynamic drag term.

     ρ = (p − e) / (R_d · T) + e / (R_v · T)

   p from the International Standard Atmosphere (troposphere) unless a measured
   pressure is given; T from the ISA lapse rate unless a measured temperature is
   given; e (water-vapour partial pressure) = relative humidity × saturation
   pressure (Tetens' formula over water). Humid air is LESS dense than dry air
   at the same p and T — at 35 °C and 80 % RH that is about 2 %.
   ============================================================================ */

(function (root, factory) {
    if (typeof module === "object" && module && module.exports) module.exports = factory(require("./core.js"));
    else { const ns = /** @type {any} */ (root).MUPhysics; ns.atmosphere = factory(ns.core); }
})(typeof globalThis !== "undefined" ? globalThis : self, function (/** @type {any} */ core) {
    const { G, R_DRY_AIR, R_WATER_VAPOUR, ISA_P0, ISA_T0, ISA_LAPSE, PhysicsError, finite, inRange } = core;
    const ISA_EXPONENT = G / (R_DRY_AIR * ISA_LAPSE); // ≈ 5.2559

    /** ISA temperature at geometric altitude h (m), K. */
    const isaTemperature = (/** @type {number} */ h) => ISA_T0 - ISA_LAPSE * inRange(h, -500, 11000, "altitude");

    /** ISA pressure at altitude h (m), Pa (troposphere, up to 11 km). */
    const isaPressure = (/** @type {number} */ h) => ISA_P0 * Math.pow(1 - (ISA_LAPSE * inRange(h, -500, 11000, "altitude")) / ISA_T0, ISA_EXPONENT);

    /**
     * Saturation vapour pressure over water, Pa (Tetens 1930; within 0.1 %
     * of the Magnus–Buck fits between 0 and 50 °C).
     * @param {number} T  temperature, K
     */
    function saturationVapourPressure(T) {
        const c = inRange(T, 223.15, 333.15, "temperature") - 273.15;
        return 610.78 * Math.exp((17.27 * c) / (c + 237.3));
    }

    /**
     * Density of (moist) air, kg/m³.
     * @param {{ altitude?: number, temperature?: number, pressure?: number, relativeHumidity?: number }} [conditions]
     *   altitude m (default 0); temperature K (default ISA at altitude); pressure Pa (default ISA at
     *   altitude); relativeHumidity 0–1 (default 0, dry)
     */
    function airDensity(conditions = {}) {
        const h = conditions.altitude === undefined ? 0 : finite(conditions.altitude, "altitude");
        const T = conditions.temperature === undefined ? isaTemperature(h) : inRange(conditions.temperature, 223.15, 333.15, "temperature");
        const p = conditions.pressure === undefined ? isaPressure(h) : inRange(conditions.pressure, 20000, 110000, "pressure");
        const rh = conditions.relativeHumidity === undefined ? 0 : inRange(conditions.relativeHumidity, 0, 1, "relativeHumidity");
        const e = rh * saturationVapourPressure(T);
        if (e >= p) throw new PhysicsError("water-vapour pressure exceeds total pressure");
        return (p - e) / (R_DRY_AIR * T) + e / (R_WATER_VAPOUR * T);
    }

    return Object.freeze({ airDensity, isaPressure, isaTemperature, saturationVapourPressure });
});
