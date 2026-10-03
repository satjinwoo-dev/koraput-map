// @ts-check
"use strict";

/* ============================================================================
   MapUnite physics — js/physics/uncertainty.js
   ==============================================================================
   ±1σ ranges by first-order propagation over every prior:

     σ_f² = Σ_k ( ∂f/∂p_k · σ_k )²       (priors treated as independent)

   ∂f/∂p_k · σ_k is taken as a central difference: f is re-evaluated with
   prior k moved to mean ± σ_k (clamped to its physical range, and rescaled if
   the clamp shortened the step). 2 evaluations per prior. Works on a number or
   on an array (element by element), so a whole cruise table gets its band in
   one pass. Each prior's share is returned, so the UI can say what dominates
   ("mostly the drag estimate") and calibration knows what to learn first.

   First order is honest for the ±10–30 % spreads of these priors; it is not a
   Monte-Carlo and doesn't claim to capture strong non-linearity (a gear change
   flipping inside the band shows up as a wider band, which is the truth).
   ============================================================================ */

(function (root, factory) {
    if (typeof module === "object" && module && module.exports) module.exports = factory(require("./core.js"), require("./profile.js"));
    else { const ns = /** @type {any} */ (root).MUPhysics; ns.uncertainty = factory(ns.core, ns.profile); }
})(typeof globalThis !== "undefined" ? globalThis : self, function (/** @type {any} */ core, /** @type {any} */ profile) {
    const { PhysicsError } = core;

    /**
     * @template {number | number[] | Float64Array} T
     * @param {any} params                     Params from profile.paramsFromBundle
     * @param {(vehicle: any) => T} evaluate   pure function of a compiled vehicle
     * @param {{ keys?: string[], floor?: number }} [opts]  floor: lower bound for `low` (e.g. 0 for fuel)
     * @returns {{ value: T, sigma: T, low: T, high: T, contributions: Array<{ key: string, origin: string, sigma: number }> }}
     */
    function propagate(params, evaluate, opts = {}) {
        const base = evaluate(profile.compileVehicle(params));
        const isArr = typeof base !== "number";
        const b = isArr ? Array.from(/** @type {ArrayLike<number>} */ (base)) : [/** @type {number} */ (base)];
        if (b.some((x) => !Number.isFinite(x))) throw new PhysicsError("evaluate() returned a non-finite value");
        const keys = opts.keys || Object.keys(params.priors).filter((k) => params.priors[k].sigma > 0);
        const variance = new Float64Array(b.length);
        const contributions = [];
        for (const key of keys) {
            const pr = params.priors[key];
            if (!pr) throw new PhysicsError(`no prior ${key}`);
            const pu = profile.withPrior(params, key, pr.mean + pr.sigma), pd = profile.withPrior(params, key, pr.mean - pr.sigma);
            const step = pu.priors[key].mean - pd.priors[key].mean;
            if (!(step > 0)) continue;
            const up = asArray(evaluate(profile.compileVehicle(pu))), dn = asArray(evaluate(profile.compileVehicle(pd)));
            let worst = 0;
            for (let i = 0; i < b.length; i++) {
                const d = ((up[i] - dn[i]) / step) * pr.sigma;
                if (!Number.isFinite(d)) throw new PhysicsError(`perturbing ${key} gave a non-finite result`);
                variance[i] += d * d;
                worst = Math.max(worst, Math.abs(d));
            }
            contributions.push({ key, origin: pr.origin, sigma: worst });
        }
        contributions.sort((x, y) => y.sigma - x.sigma);
        const floor = opts.floor === undefined ? -Infinity : opts.floor;
        const sig = Array.from(variance, Math.sqrt);
        const pack = (/** @type {number[]} */ xs) => /** @type {any} */ (isArr ? Float64Array.from(xs) : xs[0]);
        return {
            value: base,
            sigma: pack(sig),
            low: pack(b.map((x, i) => Math.max(floor, x - sig[i]))),
            high: pack(b.map((x, i) => x + sig[i])),
            contributions
        };
    }

    /** @param {number | ArrayLike<number>} x */
    const asArray = (x) => (typeof x === "number" ? [x] : Array.from(x));

    return Object.freeze({ propagate });
});
