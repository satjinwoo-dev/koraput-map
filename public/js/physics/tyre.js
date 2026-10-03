// @ts-check
"use strict";

/* ============================================================================
   MapUnite physics — js/physics/tyre.js
   ==============================================================================
   Wheel size from the tyre code moulded on the sidewall.

     unloaded radius  r0 = rim/2 + section width × aspect
     rolling radius   r  = r0 × (1 − deflection)

   Metric codes ("100/80-17 M/C 52P", "140/70R-17", "150/60 ZR 17") and numeric
   inch codes ("2.75-18", "3.00x18", ~100 % aspect). The parsing rules match
   parseTyre() in js/bikedb/bundle-contract.js (a test proves they agree on every
   tyre in the catalogue) — duplicated so the physics needs no contract.

   Deflection: a loaded tyre rolls on a radius a few per cent below its
   unloaded radius. 0.03 ± 0.01 is a MODEL ASSUMPTION (not bike data), carried
   with its uncertainty into every result; cloud calibration refines it per
   bike from GPS speed against engine speed.
   ============================================================================ */

(function (root, factory) {
    if (typeof module === "object" && module && module.exports) module.exports = factory(require("./core.js"));
    else { const ns = /** @type {any} */ (root).MUPhysics; ns.tyre = factory(ns.core); }
})(typeof globalThis !== "undefined" ? globalThis : self, function (/** @type {any} */ core) {
    const { PhysicsError, inRange } = core;
    const INCH = 0.0254;
    const DEFAULT_DEFLECTION = 0.03;
    const DEFLECTION_SIGMA = 0.01;

    /**
     * @param {string} code
     * @returns {{ widthM: number, aspect: number | null, rimM: number, unloadedRadiusM: number } | null}
     */
    function parseTyre(code) {
        if (typeof code !== "string") return null;
        const t = code.replace(/["”]/g, "").replace(/\s+/g, " ").trim();
        let m = /^(\d{2,3})\s?\/\s?(\d{2,3})\s?(?:-|\s)?\s?(?:Z?R|B|-)?\s?-?\s?(\d{2})(?!\d)/i.exec(t);
        if (m) {
            const w = Number(m[1]), a = Number(m[2]), rim = Number(m[3]);
            if (w < 50 || w > 360 || a < 30 || a > 110 || rim < 8 || rim > 23) return null;
            const rimM = rim * INCH, widthM = w / 1000;
            return { widthM, aspect: a / 100, rimM, unloadedRadiusM: rimM / 2 + widthM * (a / 100) };
        }
        m = /^(\d\.\d{2})\s?[-x×]\s?(\d{2})(?!\d)/i.exec(t);
        if (m) {
            const wIn = Number(m[1]), rim = Number(m[2]);
            if (wIn < 2 || wIn > 6 || rim < 8 || rim > 23) return null;
            return { widthM: wIn * INCH, aspect: null, rimM: rim * INCH, unloadedRadiusM: (rim / 2 + wIn) * INCH };
        }
        return null;
    }

    /**
     * Effective rolling radius, m.
     * @param {string} code
     * @param {number} [deflection]  fraction of r0 lost under load (0–0.1)
     */
    function rollingRadius(code, deflection = DEFAULT_DEFLECTION) {
        const p = parseTyre(code);
        if (!p) throw new PhysicsError(`"${code}" is not a recognised tyre size`);
        return p.unloadedRadiusM * (1 - inRange(deflection, 0, 0.1, "deflection"));
    }

    return Object.freeze({ parseTyre, rollingRadius, DEFAULT_DEFLECTION, DEFLECTION_SIGMA });
});
