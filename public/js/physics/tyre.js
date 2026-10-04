// @ts-check
/* ============================================================================
   MapUnite physics — wheel size from the tyre code (strict SI: metres)
   ==============================================================================
   Metric codes:    width/aspect-rim     "140/70-17 66P", "140/70R17 M/C", "150/60 ZR 17"
     unloaded diameter D = rim·0.0254 + 2·width·aspect/100        (width in m)
   Numeric (inch):  width-rim             "2.75-18", "3.00x18"
     D = (rim + 2·width)·0.0254   (aspect ≈ 100 %: section height ≈ width)

   Speed comes from the ROLLING radius, which is smaller than the unloaded one
   because the loaded tyre deflects: r_roll = (D/2)·(1 − deflection). For
   motorcycle tyres at normal pressure the deflection is typically 2–3 %, so the
   model uses 2.5 % ± 1 % (σ), and that uncertainty is propagated into the ±1σ ranges.
   ============================================================================ */

(function (root, factory) {
    if (typeof module === "object" && module.exports) module.exports = factory();
    else { const ns = /** @type {any} */ (root).MUPhysics || (/** @type {any} */ (root).MUPhysics = {}); ns.tyre = factory(); }
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
    "use strict";

    const INCH = 0.0254;
    /** Rolling-radius reduction under load, fraction of the unloaded radius. */
    const DEFLECTION = Object.freeze({ mean: 0.025, sigma: 0.01 });

    /**
     * @param {string} code
     * @returns {{ widthM: number, aspect: number|null, rimM: number, diameterM: number }}
     */
    function parseTyre(code) {
        if (typeof code !== "string") throw new TypeError("tyre code must be a string");
        const t = code.replace(/["”]/g, "").replace(/\s+/g, " ").trim();
        let m = /^(\d{2,3})\s?\/\s?(\d{2,3})\s?(?:-|\s)?\s?(?:Z?R|B|-)?\s?-?\s?(\d{2})(?!\d)/i.exec(t);
        if (m) {
            const wMm = Number(m[1]), a = Number(m[2]), rim = Number(m[3]);
            if (wMm >= 50 && wMm <= 360 && a >= 30 && a <= 110 && rim >= 8 && rim <= 23) {
                const widthM = wMm / 1000;
                return { widthM, aspect: a, rimM: rim * INCH, diameterM: rim * INCH + 2 * widthM * (a / 100) };
            }
        } else {
            m = /^(\d\.\d{2})\s?[-x×]\s?(\d{2})(?!\d)/i.exec(t);
            if (m) {
                const wIn = Number(m[1]), rim = Number(m[2]);
                if (wIn >= 2 && wIn <= 6 && rim >= 8 && rim <= 23) return { widthM: wIn * INCH, aspect: null, rimM: rim * INCH, diameterM: (rim + 2 * wIn) * INCH };
            }
        }
        throw new RangeError(`"${code}" is not a recognised tyre size (e.g. 120/80-18 or 2.75-18)`);
    }

    /**
     * Wheel geometry for speed ↔ wheel speed.
     * @param {string} code
     * @param {number} [deflection]  fraction (default 0.025)
     * @returns {{ unloadedRadius: number, rollingRadius: number, rollingCircumference: number }}  m
     */
    function wheelFromTyre(code, deflection = DEFLECTION.mean) {
        if (!(deflection >= 0 && deflection < 0.2)) throw new RangeError("deflection must be in [0, 0.2)");
        const r0 = parseTyre(code).diameterM / 2;
        const r = r0 * (1 - deflection);
        return { unloadedRadius: r0, rollingRadius: r, rollingCircumference: 2 * Math.PI * r };
    }

    return { INCH, DEFLECTION, parseTyre, wheelFromTyre };
});
