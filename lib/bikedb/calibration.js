// @ts-check
"use strict";
/* ============================================================================
   MapUnite fleet calibration — "learning in the cloud" (roadmap Step 11)
   ==============================================================================
   Riders who opt in send anonymous full-to-full tank records (lib/bikedb/fleet.js):
   litres, km, idle hours, km per 5 km/h speed bin, mass, fuel grade and which
   bundle. This module fits, per vehicle class, how the physics' priors should
   move so the physics predicts those tanks.

   The model (per class):
     litres_t = λ · Σ_b km_tb · f(v_b; θ_t) + idleHours_t · idle(θ_t)
       f(v; θ)   steady-state fuel per km of the tank's bike at speed v on the flat
                 (the physics core, with that tank's mass and fuel grade)
       θ_t       the bike's parameter means, with the CALIBRATED ones multiplied
                 by exp(φ_k): drag area, rolling resistance, indicated efficiency,
                 friction MEP A — one class-level φ_k each
       λ         "real riding" overhead: acceleration, stops, hills, wind and warm-up
                 that a steady-state, flat-road model can't see. It is fitted
                 separately ON PURPOSE, so those effects don't masquerade as a
                 bigger drag area or a worse engine (the trip card models stops
                 itself and would count them twice otherwise).
     log litres_obs = log litres_t + ε,   ε ~ Student-t(ν = 4, scale s)
   Priors: φ_k ~ N(0, (σ_k/μ_k)²) from the class default's current prior (μ ± σ);
           log λ ~ N(0, 0.3²) — a documented, deliberately wide model assumption.

   Fit: Gauss–Newton on the posterior mode (MAP), iteratively reweighted for the
   Student-t residuals (a wrong litres figure or an unrecorded ride can't drag the
   fit), with the noise scale s re-estimated robustly (MAD) each round. One
   rider's tanks together weigh at most CONTRIBUTOR_CAP tanks, so nobody can move
   a class alone. Posterior covariance: the Laplace approximation (inverse of the
   Gauss–Newton Hessian), reported as each parameter's new ±σ and correlations.

   Honesty checks before anything is proposed:
     - enough data: ≥ minTanks tanks from ≥ minRiders riders;
     - cross-validation BY RIDER (k folds): held-out riders' tanks must be predicted
       better by the posterior than by today's priors (rider-balanced mean |error|);
     - every new mean inside the contract's plausible range for that field.
   A proposal is a reviewable file (scripts/bikedb/calibrate.mjs writes it to
   data/bikes/calibration/); the build applies it with provenance. Nothing changes
   riders' numbers without a reviewed diff.

   Strict SI throughout (m2, 1, Pa, m3/m, J); litres and km appear only in the
   tank records, which is how fill-ups are measured.
   ============================================================================ */

/** Calibrated priors: bundle prior key ↔ physics parameter name. ICE classes only. */
const CAL_PARAMS = Object.freeze([
    { prior: "cda", param: "cda" },
    { prior: "crr", param: "crr" },
    { prior: "indicatedEfficiency", param: "etaInd" },
    { prior: "fmepA", param: "fmepA" }
]);
const BIN_KMH = 5;
const BINS = 40;
const DEFAULTS = Object.freeze({
    overheadLogSigma: 0.3,      // prior on log λ: λ within ×0.74…×1.35 at 1σ
    noiseInit: 0.1,             // starting scale of log-litre residuals
    noiseFloor: 0.03,           // fill-ups are never better than ±3 %
    studentNu: 4,
    contributorCap: 10,         // one rider's tanks weigh at most this many tanks
    minTanks: 30,
    minRiders: 5,
    folds: 5,
    minImprovement: 0.01,       // cross-validated mean |error| must drop by ≥ 1 point
    maxIter: 30,
    jacobianStep: 1e-3
});

/**
 * @typedef {{ contributor: string, bike: string, massKg: number, fuelCode: string,
 *             litres: number, km: number, idleH: number, hist: number[] }} Tank
 *   bike: the bike's id (stable across builds: the fit always uses its CURRENT bundle)
 *   hist: km in each 5 km/h bin (40 bins, 0–200 km/h; the last takes anything faster)
 * @typedef {{ mean: number, sigma: number, u: string, conf?: number }} Prior
 */

/**
 * Fit one class.
 * @param {{ physics: any, classDefault: any, classDefaultHash?: string, bundles: Map<string, any>, tanks: Tank[],
 *            ranges?: Record<string, number[]>, options?: Partial<typeof DEFAULTS> }} o
 *   classDefault:      runtime bundle of the class default (SI priors); classDefaultHash: its content hash
 *   bundles:           current runtime bundles by bike id (variants and the class default)
 *   ranges:            plausible SI range per prior key (the contract's FIELDS)
 */
function fitClass(o) {
    const opt = { ...DEFAULTS, ...(o.options || {}) };
    const cd = o.classDefault;
    const classKey = cd.classKey;
    if (cd.powertrain === "ev") return { classKey, proposed: false, reason: "electric classes calibrate from charging data, not fill-ups", tanks: 0, riders: 0 };
    const base = basePriors(cd);
    const tanks = o.tanks.filter((t) => o.bundles.has(t.bike)).slice().sort(byTank);
    const riders = new Set(tanks.map((t) => t.contributor));
    const evidence = { tanks: tanks.length, riders: riders.size, km: round(tanks.reduce((a, t) => a + t.km, 0), 1), litres: round(tanks.reduce((a, t) => a + t.litres, 0), 2) };
    const result = { classKey, classDefault: cd.id, basedOn: { bundle: o.classDefaultHash || null, priors: base }, evidence };
    if (tanks.length === 0) return { ...result, proposed: false, reason: "no tanks yet" };

    const ev = evaluator(o.physics, cd, o.bundles, tanks);
    const all = tanks.map((_, i) => i);
    const fit = mapFit(ev, all, base, opt);

    // cross-validation by rider
    const order = [...riders].sort();
    const fold = new Map(order.map((r, i) => [r, i % Math.max(2, opt.folds)]));
    const k = Math.min(opt.folds, order.length);
    /** @type {{ prior: number[], post: number[], rider: string[] }} */
    const held = { prior: [], post: [], rider: [] };
    if (k >= 2) {
        for (let f = 0; f < k; f++) {
            const train = all.filter((i) => fold.get(tanks[i].contributor) !== f);
            const test = all.filter((i) => fold.get(tanks[i].contributor) === f);
            if (!train.length || !test.length) continue;
            const ff = mapFit(ev, train, base, opt);
            const p0 = ev.predict(zeros(CAL_PARAMS.length + 1), test), p1 = ev.predict(ff.theta, test);
            test.forEach((i, j) => {
                held.prior.push(Math.abs(p0[j] - tanks[i].litres) / tanks[i].litres);
                held.post.push(Math.abs(p1[j] - tanks[i].litres) / tanks[i].litres);
                held.rider.push(tanks[i].contributor);
            });
        }
    }
    const cv = held.rider.length ? { folds: k, prior: round(riderMean(held.prior, held.rider), 4), posterior: round(riderMean(held.post, held.rider), 4) } : null;

    // the new priors
    /** @type {Record<string, Prior & { informed: number }>} */
    const priors = {};
    CAL_PARAMS.forEach((c, j) => {
        const b = base[c.prior];
        const mean = b.mean * Math.exp(fit.theta[j]);
        const relSd = Math.sqrt(fit.cov[j][j]);
        const prior0 = b.sigma / b.mean;
        const informed = Math.max(0, 1 - relSd / prior0);              // share of the prior's uncertainty the fleet removed
        const conf0 = typeof b.conf === "number" ? b.conf : 0.3;
        priors[c.prior] = { mean: sig(mean, 4), sigma: sig(mean * relSd, 3), u: b.u, conf: round(Math.min(0.9, conf0 + (1 - conf0) * informed), 2), informed: round(informed, 3) };
    });
    const nλ = CAL_PARAMS.length;
    const overhead = { mean: round(Math.exp(fit.theta[nλ]), 4), sigma: round(Math.exp(fit.theta[nλ]) * Math.sqrt(fit.cov[nλ][nλ]), 4), u: "1" };
    const names = [...CAL_PARAMS.map((c) => c.prior), "overhead"];
    const correlation = names.map((_, i) => names.map((__, j) => round(fit.cov[i][j] / Math.sqrt(fit.cov[i][i] * fit.cov[j][j]), 3)));
    const inSample = { prior: round(meanAbsRel(ev.predict(zeros(nλ + 1), all), tanks), 4), posterior: round(meanAbsRel(ev.predict(fit.theta, all), tanks), 4) };

    // honesty checks
    let reason = "";
    if (tanks.length < opt.minTanks) reason = `needs ${opt.minTanks} tanks (has ${tanks.length})`;
    else if (riders.size < opt.minRiders) reason = `needs tanks from ${opt.minRiders} riders (has ${riders.size})`;
    else if (!cv || !(cv.posterior + opt.minImprovement <= cv.prior)) reason = `doesn't predict held-out riders better (${pct(cv && cv.posterior)} vs ${pct(cv && cv.prior)} today)`;
    else {
        for (const c of CAL_PARAMS) {
            const r = o.ranges && o.ranges[c.prior];
            if (r && !(priors[c.prior].mean >= r[0] && priors[c.prior].mean <= r[1])) { reason = `${c.prior} would leave its plausible range (${priors[c.prior].mean} ${base[c.prior].u})`; break; }
        }
    }
    return {
        ...result, proposed: !reason, reason: reason || null,
        priors, overhead, correlation: { names, matrix: correlation },
        noise: round(fit.noise, 4), iterations: fit.iterations, cv, inSample,
        bands: bandResiduals(ev, fit.theta, tanks)
    };
}

// ----------------------------------------------------------------------------
// The forward model, evaluated per group of tanks that share a bike, mass and fuel
// ----------------------------------------------------------------------------
/**
 * @param {any} physics @param {any} cd @param {Map<string, any>} bundles @param {Tank[]} tanks
 */
function evaluator(physics, cd, bundles, tanks) {
    /** @type {Map<string, { model: any, P0: Record<string, number>, idx: number[], bins: number[], v: number[] }>} */
    const groups = new Map();
    tanks.forEach((t, i) => {
        const key = `${t.bike}|${t.massKg}|${t.fuelCode}`;
        let g = groups.get(key);
        if (!g) {
            const b = bundles.get(t.bike);
            const model = physics.createBikeModel(b, { classDefault: b.kind === "variant" ? cd : undefined, settings: { riderMass: t.massKg, fuelCode: t.fuelCode } });
            const vmax = physics.maxSpeed(model);
            const v = Array.from({ length: BINS }, (_, k) => Math.min((k + 0.5) * BIN_KMH / 3.6, 0.98 * vmax));
            g = { model, P0: physics.cruise.meanParams(model), idx: [], bins: [], v };
            groups.set(key, g);
        }
        g.idx.push(i);
    });
    for (const g of groups.values()) {
        const used = new Set();
        for (const i of g.idx) tanks[i].hist.forEach((km, k) => { if (km > 0) used.add(k); });
        g.bins = [...used].sort((a, b) => a - b);
    }
    const nP = CAL_PARAMS.length;
    /**
     * Predicted litres for the tanks `which` (indices into tanks), and the moving share.
     * @param {number[]} theta @param {number[]} which
     */
    function predict(theta, which) {
        const want = new Set(which);
        /** @type {Map<number, number>} */
        const out = new Map();
        const lambda = Math.exp(theta[nP]);
        for (const g of groups.values()) {
            if (!g.idx.some((i) => want.has(i))) continue;
            const P = { ...g.P0 };
            CAL_PARAMS.forEach((c, j) => { P[c.param] = g.P0[c.param] * Math.exp(theta[j]); });
            const f = new Float64Array(BINS);
            for (const k of g.bins) {
                const op = physics.operatingPoint(g.model, g.v[k], {}, { params: P });
                f[k] = Number.isFinite(op.fuelPerMetre) && op.fuelPerMetre > 0 ? op.fuelPerMetre : 0;
            }
            const idleLph = physics.operatingPoint(g.model, 0, {}, { params: P }).fuelRate * 3.6e6;
            for (const i of g.idx) {
                if (!want.has(i)) continue;
                const t = tanks[i];
                let moving = 0;
                for (const k of g.bins) moving += t.hist[k] * f[k] * 1e6;   // km · m3/m → L
                out.set(i, lambda * moving + t.idleH * idleLph);
            }
        }
        return which.map((i) => /** @type {number} */ (out.get(i)));
    }
    return { predict, tanks };
}

/**
 * Posterior mode and Laplace covariance on the tanks `which`.
 * @param {ReturnType<typeof evaluator>} ev @param {number[]} which @param {Record<string, Prior>} base @param {typeof DEFAULTS} opt
 */
function mapFit(ev, which, base, opt) {
    const tanks = ev.tanks;
    const n = CAL_PARAMS.length + 1;
    const priorPrec = [...CAL_PARAMS.map((c) => (base[c.prior].mean / base[c.prior].sigma) ** 2), 1 / opt.overheadLogSigma ** 2];
    const y = which.map((i) => Math.log(tanks[i].litres));
    // one rider's tanks weigh at most contributorCap tanks
    const perRider = new Map();
    for (const i of which) perRider.set(tanks[i].contributor, (perRider.get(tanks[i].contributor) || 0) + 1);
    const cw = which.map((i) => Math.min(1, opt.contributorCap / perRider.get(tanks[i].contributor)));
    let theta = zeros(n), /** @type {number} */ s = opt.noiseInit, iterations = 0;
    /** @type {number[][]} */
    let A = [];
    for (; iterations < opt.maxIter; iterations++) {
        const mu = ev.predict(theta, which).map(Math.log);
        const r = y.map((v, i) => v - mu[i]);
        s = Math.max(opt.noiseFloor, 1.4826 * median(r.map(Math.abs)));
        const w = r.map((ri, i) => cw[i] * (opt.studentNu + 1) / (opt.studentNu + (ri / s) ** 2));
        // Jacobian of log-litres (central differences)
        const J = which.map(() => new Array(n).fill(0));
        for (let j = 0; j < n; j++) {
            const tp = theta.slice(), tm = theta.slice();
            tp[j] += opt.jacobianStep; tm[j] -= opt.jacobianStep;
            const up = ev.predict(tp, which), dn = ev.predict(tm, which);
            for (let i = 0; i < which.length; i++) J[i][j] = (Math.log(up[i]) - Math.log(dn[i])) / (2 * opt.jacobianStep);
        }
        A = Array.from({ length: n }, (_, a) => Array.from({ length: n }, (__, b) => (a === b ? priorPrec[a] : 0)));
        const g = theta.map((th, a) => -priorPrec[a] * th);
        for (let i = 0; i < which.length; i++) {
            const wi = w[i] / (s * s);
            for (let a = 0; a < n; a++) {
                g[a] += wi * J[i][a] * r[i];
                for (let b = 0; b < n; b++) A[a][b] += wi * J[i][a] * J[i][b];
            }
        }
        const step = solve(A, g);
        const big = Math.max(...step.map(Math.abs));
        const damp = big > 0.5 ? 0.5 / big : 1;                       // never jump more than ×1.65 in one round
        theta = theta.map((th, a) => th + damp * step[a]);
        if (big < 1e-7) { iterations++; break; }
    }
    return { theta, cov: invert(A), noise: s, iterations };
}

// ----------------------------------------------------------------------------
// Inputs and reports
// ----------------------------------------------------------------------------
/** The class default's current priors for the calibrated keys (SI). @param {any} cd */
function basePriors(cd) {
    /** @type {Record<string, Prior>} */
    const out = {};
    for (const c of CAL_PARAMS) {
        const p = cd.priors && cd.priors[c.prior];
        if (!p || !(p.mean > 0) || !(p.sigma > 0)) throw new Error(`${cd.id}: prior ${c.prior} is missing`);
        out[c.prior] = { mean: p.mean, sigma: p.sigma, u: p.u, conf: p.conf };
    }
    return out;
}

/** Residuals by SmartDrive's speed bands (share of each tank's km), for the dashboard. */
function bandResiduals(/** @type {ReturnType<typeof evaluator>} */ ev, /** @type {number[]} */ theta, /** @type {Tank[]} */ tanks) {
    const all = tanks.map((_, i) => i);
    const p0 = ev.predict(zeros(theta.length), all), p1 = ev.predict(theta, all);
    const bands = [{ label: "under 40", lo: 0, hi: 40 }, { label: "40–60", lo: 40, hi: 60 }, { label: "60–80", lo: 60, hi: 80 }, { label: "over 80", lo: 80, hi: Infinity }];
    return bands.map((b) => {
        let wsum = 0, e0 = 0, e1 = 0;
        tanks.forEach((t, i) => {
            const km = t.hist.reduce((a, x, k) => a + ((k + 0.5) * BIN_KMH >= b.lo && (k + 0.5) * BIN_KMH < b.hi ? x : 0), 0);
            const share = t.km > 0 ? km / t.km : 0;
            wsum += share;
            e0 += share * (p0[i] - t.litres) / t.litres;
            e1 += share * (p1[i] - t.litres) / t.litres;
        });
        return { band: b.label, share: round(wsum / Math.max(1, tanks.length), 3), biasPrior: wsum ? round(e0 / wsum, 4) : null, biasPosterior: wsum ? round(e1 / wsum, 4) : null };
    });
}

// ----------------------------------------------------------------------------
// Small numerics (5 × 5)
// ----------------------------------------------------------------------------
/** Solve A x = b (Gaussian elimination, partial pivoting). @param {number[][]} A @param {number[]} b */
function solve(A, b) {
    const n = b.length, M = A.map((row, i) => [...row, b[i]]);
    for (let c = 0; c < n; c++) {
        let p = c;
        for (let r = c + 1; r < n; r++) if (Math.abs(M[r][c]) > Math.abs(M[p][c])) p = r;
        [M[c], M[p]] = [M[p], M[c]];
        if (Math.abs(M[c][c]) < 1e-300) throw new Error("calibration: singular system");
        for (let r = c + 1; r < n; r++) { const f = M[r][c] / M[c][c]; for (let k = c; k <= n; k++) M[r][k] -= f * M[c][k]; }
    }
    const x = new Array(n).fill(0);
    for (let r = n - 1; r >= 0; r--) { let s = M[r][n]; for (let k = r + 1; k < n; k++) s -= M[r][k] * x[k]; x[r] = s / M[r][r]; }
    return x;
}
/** @param {number[][]} A */
function invert(A) {
    const n = A.length;
    const cols = Array.from({ length: n }, (_, j) => solve(A, Array.from({ length: n }, (__, i) => (i === j ? 1 : 0))));
    return Array.from({ length: n }, (_, i) => Array.from({ length: n }, (__, j) => cols[j][i]));
}
const zeros = (/** @type {number} */ n) => new Array(n).fill(0);
function median(/** @type {number[]} */ a) {
    if (!a.length) return 0;
    const s = a.slice().sort((x, y) => x - y), m = s.length >> 1;
    return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}
/** Mean over riders of each rider's mean: a rider with 100 tanks counts once. @param {number[]} e @param {string[]} who */
function riderMean(e, who) {
    const by = new Map();
    e.forEach((x, i) => { const a = by.get(who[i]) || [0, 0]; a[0] += x; a[1]++; by.set(who[i], a); });
    let s = 0;
    for (const [sum, n] of by.values()) s += sum / n;
    return s / by.size;
}
const meanAbsRel = (/** @type {number[]} */ p, /** @type {Tank[]} */ t) => p.reduce((a, x, i) => a + Math.abs(x - t[i].litres) / t[i].litres, 0) / t.length;
const byTank = (/** @type {Tank} */ a, /** @type {Tank} */ b) => (a.contributor < b.contributor ? -1 : a.contributor > b.contributor ? 1 : a.litres - b.litres || a.km - b.km);
const round = (/** @type {number} */ x, /** @type {number} */ d) => Math.round(x * 10 ** d) / 10 ** d;
const sig = (/** @type {number} */ x, /** @type {number} */ d) => Number(x.toPrecision(d));
const pct = (/** @type {number|null|undefined} */ x) => (typeof x === "number" ? `±${Math.round(x * 100)} %` : "n/a");

module.exports = { CAL_PARAMS, BIN_KMH, BINS, DEFAULTS, fitClass, evaluator, mapFit, solve, invert };
