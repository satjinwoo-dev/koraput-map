// @ts-check
/* ============================================================================
   MapUnite physics — air density (strict SI)
   ==============================================================================
   Inputs and outputs are SI: Pa, K, kg/m3, m. Relative humidity is a fraction
   0–1.

   Air is treated as an ideal mixture of dry air and water vapour:
       ρ = p_d / (R_d·T) + p_v / (R_v·T),   p_v = RH·p_sat(T),   p_d = p − p_v
   p_sat uses Buck (1996): over water at or above 0 °C, over ice below. The
   mixture model is within ~0.2 % of CIPM-2007 for road conditions
   (−20…50 °C, 50–110 kPa); the drag-area uncertainty is far larger.

   Pressure with altitude follows the 1976 US / ICAO Standard Atmosphere
   (troposphere to 11 km, isothermal layer to 20 km). A measured pressure
   (a barometer) always beats the standard one.

   Domain: non-finite input is a programming error (TypeError). A physically
   impossible input (T ≤ 0 K, p ≤ 0) is a RangeError. Humidity is clamped to 0–1
   and altitude to −610…20 000 m, so a noisy sensor can't produce NaN.
   ============================================================================ */

(function (root, factory) {
    if (typeof module === "object" && module.exports) module.exports = factory();
    else { const ns = /** @type {any} */ (root).MUPhysics || (/** @type {any} */ (root).MUPhysics = {}); ns.atmosphere = factory(); }
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
    "use strict";

    /** Standard gravity, m/s2 (ISO 80000-3). */
    const G0 = 9.80665;
    /** Molar gas constant, J/(mol·K) (CODATA 2018, exact). */
    const R_UNIVERSAL = 8.314462618;
    /** Molar mass of dry air, kg/mol (ICAO standard atmosphere). */
    const M_DRY = 0.0289644;
    /** Molar mass of water, kg/mol. */
    const M_WATER = 0.01801528;
    const R_DRY = R_UNIVERSAL / M_DRY;              // 287.053 J/(kg·K)
    const R_VAPOUR = R_UNIVERSAL / M_WATER;         // 461.52 J/(kg·K)

    /** ICAO standard atmosphere at mean sea level. */
    const ISA = Object.freeze({ T0: 288.15, P0: 101325, LAPSE: 0.0065, TROPOPAUSE: 11000, T_TROPOPAUSE: 216.65, MIN_ALT: -610, MAX_ALT: 20000 });
    /** ρ of dry air at 15 °C, 101 325 Pa (= 1.2250 kg/m3). */
    const RHO_SEA_LEVEL = ISA.P0 / (R_DRY * ISA.T0);

    /** @param {unknown} x @param {string} name @returns {number} */
    function finite(x, name) {
        if (typeof x !== "number" || !Number.isFinite(x)) throw new TypeError(`${name} must be a finite number (got ${String(x)})`);
        return x;
    }
    const clamp = (x, lo, hi) => (x < lo ? lo : x > hi ? hi : x);

    /**
     * Saturation vapour pressure, Pa (Buck 1996): over water at ≥ 0 °C, over ice below.
     * @param {number} temperature  K
     */
    function saturationVapourPressure(temperature) {
        const t = finite(temperature, "temperature") - 273.15;
        if (temperature <= 0) throw new RangeError("temperature must be above 0 K");
        return t >= 0
            ? 611.21 * Math.exp((18.678 - t / 234.5) * (t / (257.14 + t)))
            : 611.15 * Math.exp((23.036 - t / 333.7) * (t / (279.82 + t)));
    }

    /**
     * Density of (moist) air.
     * @param {{ pressure: number, temperature: number, relativeHumidity?: number }} s  Pa, K, 0–1
     * @returns {number} kg/m3
     */
    function airDensity(s) {
        const p = finite(s.pressure, "pressure");
        const T = finite(s.temperature, "temperature");
        if (p <= 0) throw new RangeError("pressure must be above 0 Pa");
        if (T <= 0) throw new RangeError("temperature must be above 0 K");
        const rh = clamp(s.relativeHumidity === undefined ? 0 : finite(s.relativeHumidity, "relativeHumidity"), 0, 1);
        const pv = rh === 0 ? 0 : Math.min(rh * saturationVapourPressure(T), p);
        return (p - pv) / (R_DRY * T) + pv / (R_VAPOUR * T);
    }

    /**
     * ICAO standard atmosphere at a geopotential altitude.
     * @param {number} altitude  m (clamped to −610…20 000)
     * @returns {{ altitude: number, temperature: number, pressure: number, density: number }}
     */
    function standardAtmosphere(altitude) {
        const h = clamp(finite(altitude, "altitude"), ISA.MIN_ALT, ISA.MAX_ALT);
        const expo = (G0 * M_DRY) / (R_UNIVERSAL * ISA.LAPSE);   // 5.2559
        let T, p;
        if (h <= ISA.TROPOPAUSE) {
            T = ISA.T0 - ISA.LAPSE * h;
            p = ISA.P0 * Math.pow(T / ISA.T0, expo);
        } else {
            const pTrop = ISA.P0 * Math.pow(ISA.T_TROPOPAUSE / ISA.T0, expo);
            T = ISA.T_TROPOPAUSE;
            p = pTrop * Math.exp((-G0 * M_DRY * (h - ISA.TROPOPAUSE)) / (R_UNIVERSAL * T));
        }
        return { altitude: h, temperature: T, pressure: p, density: p / (R_DRY * T) };
    }

    /**
     * Air density for riding conditions. Pressure: the measured value if given,
     * else the standard atmosphere at `altitude`. Temperature: the measured value
     * if given, else the standard one. Humidity defaults to dry, which is
     * conservative: humid air is lighter, so drag is slightly over-estimated.
     * @param {{ altitude?: number, temperature?: number, pressure?: number, relativeHumidity?: number }} [c]
     * @returns {number} kg/m3
     */
    function airDensityAt(c = {}) {
        const std = standardAtmosphere(c.altitude === undefined ? 0 : c.altitude);
        return airDensity({
            pressure: c.pressure === undefined ? std.pressure : c.pressure,
            temperature: c.temperature === undefined ? std.temperature : c.temperature,
            relativeHumidity: c.relativeHumidity === undefined ? 0 : c.relativeHumidity
        });
    }

    return { G0, R_UNIVERSAL, M_DRY, M_WATER, R_DRY, R_VAPOUR, ISA, RHO_SEA_LEVEL, saturationVapourPressure, airDensity, standardAtmosphere, airDensityAt, finite };
});
