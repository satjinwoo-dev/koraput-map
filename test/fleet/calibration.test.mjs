// Roadmap Step 11: the class-level fit (lib/bikedb/calibration.js) on synthetic fleets with
// KNOWN true parameters — it must find them, say how sure it is, refuse to propose
// when the data can't justify a change, and not be moved by bad data or one rider.
import { test } from "node:test";
import assert from "node:assert/strict";
import { syntheticFleet, Physics, Cal, classDefault, bundlesById, ranges } from "./synthetic.mjs";

const K = "ice_manual.commuter";
const cd = classDefault(K);
const fit = (tanks, options) => Cal.fitClass({ physics: Physics, classDefault: cd.runtime, classDefaultHash: cd.hash, bundles: bundlesById, tanks, ranges, options });
const TRUTH = { cda: 1.15, indicatedEfficiency: 0.92, overhead: 1.12 };
const clean = syntheticFleet({ classKey: K, truth: TRUTH, seed: 7 });
const main = fit(clean);

/** θ (log multipliers + log overhead) of a fit result, to re-predict with. */
const thetaOf = (r) => [...Cal.CAL_PARAMS.map((c) => Math.log(r.priors[c.prior].mean / r.basedOn.priors[c.prior].mean)), Math.log(r.overhead.mean)];
const honest = Cal.evaluator(Physics, cd.runtime, bundlesById, clean);
/** mean log(predicted / measured) and mean |error| over the clean fleet */
function errorOn(r) {
    const p = honest.predict(thetaOf(r), clean.map((_, i) => i));
    return {
        bias: p.reduce((s, x, i) => s + Math.log(x / clean[i].litres), 0) / p.length,
        abs: p.reduce((s, x, i) => s + Math.abs(x - clean[i].litres) / clean[i].litres, 0) / p.length
    };
}

test("fit: proposes, and the fleet's litres are predicted to within the fill-up noise", () => {
    assert.equal(main.proposed, true, main.reason);
    assert.equal(main.reason, null);
    assert.deepEqual(main.evidence.tanks, clean.length);
    assert.equal(main.evidence.riders, 40);
    assert.equal(main.classKey, K);
    assert.equal(main.classDefault, cd.id);
    assert.equal(main.basedOn.bundle, cd.hash);
    // held-out riders: today's priors are ~22 % off (the truth is 15 % more drag, 8 % worse engine, 12 % overhead)
    assert.ok(main.cv.prior > 0.15, JSON.stringify(main.cv));
    assert.ok(main.cv.posterior < 0.06, JSON.stringify(main.cv));
    assert.equal(main.cv.folds, 5);
    const e = errorOn(main);
    assert.ok(Math.abs(e.bias) < 0.01, `bias ${e.bias}`);
    assert.ok(e.abs < 0.06, `mean error ${e.abs}`);
    assert.ok(main.noise > 0.04 && main.noise < 0.09, `noise ${main.noise} (truth 0.06)`);
});

test("fit: every speed band is unbiased afterwards (no band traded for another)", () => {
    assert.equal(main.bands.length, 4);
    assert.ok(Math.abs(main.bands.reduce((s, b) => s + b.share, 0) - 1) < 0.01);
    for (const b of main.bands) {
        assert.ok(b.biasPrior < -0.15, `${b.band}: today's priors under-predict (${b.biasPrior})`);
        assert.ok(Math.abs(b.biasPosterior) < 0.02, `${b.band}: ${b.biasPosterior}`);
    }
});

test("fit: the truth lies inside the posterior's uncertainty, and conf grows only where data informed", () => {
    for (const c of Cal.CAL_PARAMS) {
        const p = main.priors[c.prior], b = main.basedOn.priors[c.prior];
        const truth = b.mean * (TRUTH[c.prior] ?? 1);
        assert.ok(Math.abs(p.mean - truth) < 2.5 * p.sigma, `${c.prior}: ${p.mean} ± ${p.sigma} vs truth ${truth}`);
        assert.ok(p.sigma <= b.sigma * 1.0001, `${c.prior}: the posterior can't be less certain than the prior`);
        assert.equal(p.u, b.u, "SI unit kept");
        assert.ok(p.informed >= 0 && p.informed <= 1);
        assert.ok(p.conf >= (b.conf ?? 0.3) && p.conf <= 0.9, `${c.prior}: conf ${p.conf}`);
        assert.ok(p.mean >= ranges[c.prior][0] && p.mean <= ranges[c.prior][1]);
    }
    assert.ok(Math.abs(main.overhead.mean - TRUTH.overhead) < 2.5 * main.overhead.sigma, JSON.stringify(main.overhead));
    assert.equal(main.overhead.u, "1");
    // correlations: a symmetric matrix with a unit diagonal
    const m = main.correlation.matrix;
    assert.deepEqual(main.correlation.names, ["cda", "crr", "indicatedEfficiency", "fmepA", "overhead"]);
    m.forEach((row, i) => row.forEach((v, j) => { assert.ok(Math.abs(v - m[j][i]) < 1e-9); assert.ok(Math.abs(v) <= 1.0001); if (i === j) assert.equal(v, 1); }));
});

test("fit: deterministic (same tanks in any order → the same result)", () => {
    const shuffled = clean.slice().reverse();
    assert.deepEqual(JSON.parse(JSON.stringify(fit(shuffled))), JSON.parse(JSON.stringify(main)));
});

test("gate: no proposal when today's priors already predict the fleet", () => {
    const r = fit(syntheticFleet({ classKey: K, seed: 7 }));
    assert.equal(r.proposed, false);
    assert.match(r.reason, /held-out riders/);
    assert.ok(r.cv && r.cv.posterior > r.cv.prior - 0.01);
});

test("gate: no proposal without enough tanks and riders", () => {
    const few = fit(syntheticFleet({ classKey: K, truth: TRUTH, riders: 4, tanksPerRider: 5, seed: 3 }));
    assert.equal(few.proposed, false);
    assert.match(few.reason, /needs 30 tanks \(has 20\)/);
    const riders = fit(syntheticFleet({ classKey: K, truth: TRUTH, riders: 4, tanksPerRider: 12, seed: 3 }));
    assert.equal(riders.proposed, false);
    assert.match(riders.reason, /riders/);
    const none = fit([]);
    assert.equal(none.proposed, false);
    assert.equal(none.reason, "no tanks yet");
});

test("robust: 5 % of tanks with litres ×3 (a missed fill-up) barely move the fit", () => {
    const bad = clean.map((t, i) => (i % 20 === 0 ? { ...t, litres: Math.round(t.litres * 300) / 100 } : t));
    const r = fit(bad);
    assert.equal(r.proposed, true);
    assert.ok(Math.abs(r.overhead.mean - main.overhead.mean) < 0.02, `${r.overhead.mean} vs ${main.overhead.mean}`);
    assert.ok(Math.abs(errorOn(r).bias) < 0.01);
});

test("robust: one rider with 300 tanks can't move the class (contributor cap)", () => {
    const spam = syntheticFleet({ classKey: K, truth: { ...TRUTH, overhead: 1.8 }, riders: 1, tanksPerRider: 300, seed: 9 }).map((t) => ({ ...t, contributor: "spammer" }));
    const capped = fit([...clean, ...spam]);
    assert.equal(capped.evidence.riders, 41);
    assert.ok(Math.abs(errorOn(capped).bias) < 0.01, `honest riders' bias with the cap: ${errorOn(capped).bias}`);
    // the same data without the cap would shift every honest rider's estimate by > 10 %
    const uncapped = fit([...clean, ...spam], { contributorCap: 1e9 });
    assert.ok(errorOn(uncapped).bias > 0.1, `without the cap: ${errorOn(uncapped).bias}`);
});

test("tanks for bikes not in the catalogue are ignored; electric classes are never fitted from fill-ups", () => {
    const r = fit([...clean, { ...clean[0], bike: "no-such-bike", contributor: "x" }]);
    assert.equal(r.evidence.tanks, clean.length);
    const ev = classDefault("ev.scooter");
    const e = Cal.fitClass({ physics: Physics, classDefault: ev.runtime, bundles: bundlesById, tanks: clean, ranges });
    assert.equal(e.proposed, false);
    assert.match(e.reason, /electric/);
});

test("the linear solver and inverse are exact on a small SPD system", () => {
    const A = [[4, 1, 0.5], [1, 3, 0.2], [0.5, 0.2, 2]];
    const x = Cal.solve(A, [1, 2, 3]);
    A.forEach((row, i) => assert.ok(Math.abs(row.reduce((s, a, j) => s + a * x[j], 0) - [1, 2, 3][i]) < 1e-12));
    const inv = Cal.invert(A);
    A.forEach((row, i) => row.forEach((_, j) => assert.ok(Math.abs(row.reduce((s, a, k) => s + a * inv[k][j], 0) - (i === j ? 1 : 0)) < 1e-12)));
});
