// @ts-check
/* ============================================================================
   MapUnite garage — line-drawn silhouettes, one per class
   ==============================================================================
   Shown wherever a bike has no picture (image_url is null) and for the
   "estimated" class defaults. Original drawings, stroke = currentColor, so they
   take the colour of the text around them. Static markup only: safe to insert.
   ============================================================================ */
(function (root, factory) {
    if (typeof module === "object" && module.exports) module.exports = factory();
    else { const ns = /** @type {any} */ (root).MUGarage || (/** @type {any} */ (root).MUGarage = {}); ns.silhouettes = factory(); }
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
    "use strict";

    const wheel = (cx, cy, r) => `<circle cx="${cx}" cy="${cy}" r="${r}"/><circle cx="${cx}" cy="${cy}" r="${(r * 0.28).toFixed(1)}"/>`;
    const BOLT = `<path class="sil-bolt" d="M47 19 l-5 8 h5 l-3 7 l8 -10 h-5 l3 -5 z"/>`;

    /** Body strokes per segment (viewBox 0 0 96 56). */
    const SHAPES = {
        commuter: wheel(20, 40, 12) + wheel(76, 40, 12) +
            `<path d="M20 40 L40 38 M38 31 h14 v8 h-14 z M30 27 h14 Q50 21 58 24 L60 25 M22 27 h10 M59 22 L76 40 M56 17 l6 2 M60 19 l-1 4"/>`,
        naked: wheel(20, 40, 12) + wheel(76, 40, 12) +
            `<path d="M20 40 L39 37 M37 30 h16 v9 h-16 z M28 24 l8 2 Q46 17 57 22 M18 22 l10 2 M58 21 L76 40 M55 14 l8 3 M61 17 l-1 4 M64 24 a3 3 0 1 0 0.1 0"/>`,
        sport: wheel(20, 40, 12) + wheel(76, 40, 12) +
            `<path d="M20 40 L40 37 M15 22 l14 3 l9 -4 Q48 17 58 21 L72 24 L68 33 L52 36 L40 36 M60 21 L76 40 M62 19 l6 -6 M58 22 l6 1"/>`,
        adventure: wheel(20, 40, 12) + wheel(77, 39, 13) +
            `<path d="M20 40 L40 37 M38 29 h15 v9 h-15 z M24 23 h12 Q47 15 58 20 M14 24 l10 -1 M59 18 L77 39 M58 12 l6 4 M64 14 l4 -8 M62 22 h8"/>`,
        cruiser: wheel(18, 41, 11) + wheel(80, 41, 11) +
            `<path d="M18 41 L44 40 M40 32 h14 v8 h-14 z M22 33 Q28 29 38 31 M40 30 Q50 23 60 26 M60 25 L80 41 M56 18 q6 -2 9 3 M14 30 l8 2"/>`,
        scooter: wheel(22, 44, 9) + wheel(74, 44, 9) +
            `<path d="M14 36 Q16 24 34 25 L46 26 L48 36 Z M30 25 h12 M48 36 H60 L66 18 M64 18 l8 -2 M66 18 L74 44 M14 36 L22 44"/>`,
        maxi_scooter: wheel(22, 43, 10) + wheel(75, 43, 10) +
            `<path d="M12 35 Q15 22 34 23 L48 25 L50 35 Z M28 22 l4 -4 h10 M50 35 H60 L66 17 M64 17 l6 -8 M66 17 L75 43 M12 35 L22 43"/>`
    };

    /**
     * Silhouette SVG for a class key ("ice_manual.naked", "ev.scooter" …).
     * @param {string} classKey @param {{ label?: string }} [o]
     */
    function silhouette(classKey, o = {}) {
        const [powertrain, segment] = String(classKey || "").split(".");
        const body = SHAPES[segment] || SHAPES.commuter;
        const label = o.label ? `<title>${o.label.replace(/[<&>"]/g, "")}</title>` : "";
        return `<svg class="sil" viewBox="0 0 96 56" role="img" aria-hidden="${o.label ? "false" : "true"}" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">${label}${body}${powertrain === "ev" ? BOLT : ""}</svg>`;
    }

    return { silhouette, SEGMENTS: Object.keys(SHAPES) };
});
