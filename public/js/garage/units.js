// @ts-check
/* ============================================================================
   MapUnite garage — display units (the ONLY place SI becomes km/h, rpm, km/L)
   ==============================================================================
   The physics core and the bundles are strict SI. People read km/h, rpm, km/L,
   Wh/km and km, so the UI converts here, at the very edge, and nowhere else.
   ============================================================================ */
(function (root, factory) {
    if (typeof module === "object" && module.exports) module.exports = factory();
    else { const ns = /** @type {any} */ (root).MUGarage || (/** @type {any} */ (root).MUGarage = {}); ns.units = factory(); }
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
    "use strict";

    const LOCALE = "en-IN";
    const nf = new Map();
    /** @param {number} digits */
    const fmt = (digits) => {
        let f = nf.get(digits);
        if (!f) { f = new Intl.NumberFormat(LOCALE, { minimumFractionDigits: digits, maximumFractionDigits: digits }); nf.set(digits, f); }
        return f;
    };

    /** m/s → km/h */
    const kmh = (v) => v * 3.6;
    /** km/h → m/s */
    const fromKmh = (k) => k / 3.6;
    /** rad/s → rpm */
    const rpm = (w) => (w * 30) / Math.PI;
    /** fuel per metre (m3/m) → km per litre; +Infinity when nothing is burned */
    const kmPerLitre = (m3PerM) => (m3PerM > 0 ? 1 / (m3PerM * 1e6) : Infinity);
    /** battery energy per metre (J/m) → Wh per km */
    const whPerKm = (jPerM) => jPerM / 3.6;
    /** m → km */
    const km = (m) => m / 1000;
    /** W → kW */
    const kw = (w) => w / 1000;

    /**
     * A number for people: grouped Indian-style, fixed decimals, "∞" and "–" for the edge cases.
     * @param {number|null|undefined} x @param {number} [digits]
     */
    function num(x, digits = 0) {
        if (x === null || x === undefined || Number.isNaN(x)) return "–";
        if (x === Infinity) return "∞";
        if (x === -Infinity) return "−∞";
        return fmt(digits).format(x).replace("-", "−");
    }

    /** Sensible decimals for km/L or km values: 1 below 100, none above. @param {number} x */
    const smart = (x) => num(x, Math.abs(x) < 100 ? 1 : 0);

    /** "349 cc" / "2.9 kWh" from a catalogue row's SI size. @param {{ size: number|null, sizeUnit: string }} row */
    function size(row) {
        if (typeof row.size !== "number") return "";
        return row.sizeUnit === "J" ? `${num(row.size / 3.6e6, 1)} kWh` : `${num(row.size * 1e6, 0)} cc`;
    }

    /** "2022–" or "2019–2026" @param {{ yearFrom: number, yearTo: number|null }} row */
    const years = (row) => (row.yearTo === null ? `${row.yearFrom}–` : row.yearFrom === row.yearTo ? `${row.yearFrom}` : `${row.yearFrom}–${row.yearTo}`);

    return { LOCALE, kmh, fromKmh, rpm, kmPerLitre, whPerKm, km, kw, num, smart, size, years };
});
