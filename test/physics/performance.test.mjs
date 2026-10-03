// Plan step 4: "one table precompute in under 5 ms on a mid-range phone".
// A mid-range Android phone runs this kind of JS roughly 3–5× slower than a
// desktop/server core, so the budget here is 5 ms ÷ 4 = 1.25 ms for one table
// (median over every catalogue bike). The ±1σ table re-runs the table for each
// prior (2 per prior + 1), so it gets its own, looser budget.
import { test } from "node:test";
import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";
import { P, realBundles } from "./fixtures.mjs";

const { profile, cruise } = P;
const PHONE_SLOWDOWN = 4;
const median = (xs) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];

function timeIt(fn, reps) {
    for (let i = 0; i < 5; i++) fn(); // warm up the JIT
    const t = [];
    for (let i = 0; i < reps; i++) { const t0 = performance.now(); fn(); t.push(performance.now() - t0); }
    return median(t);
}

test("one cruise table: under 5 ms on a mid-range phone (≤ 1.25 ms here)", () => {
    const perBike = realBundles().map(({ bundle, classDefault }) => {
        const v = profile.compileVehicle(profile.paramsFromBundle(bundle, { classDefault }));
        return { id: bundle.id, ms: timeIt(() => cruise.cruiseTable(v, { rho: 1.17 }), 40) };
    });
    const worst = perBike.reduce((a, b) => (b.ms > a.ms ? b : a));
    assert.ok(worst.ms * PHONE_SLOWDOWN < 5, `slowest bike ${worst.id}: ${worst.ms.toFixed(3)} ms here ≈ ${(worst.ms * PHONE_SLOWDOWN).toFixed(2)} ms on a phone`);
});

test("cruise table with ±1σ on every row: under 25 ms on a mid-range phone", () => {
    const perBike = realBundles().map(({ bundle, classDefault }) => {
        const params = profile.paramsFromBundle(bundle, { classDefault });
        return { id: bundle.id, ms: timeIt(() => cruise.cruiseTableWithUncertainty(params, { rho: 1.17 }), 8) };
    });
    const worst = perBike.reduce((a, b) => (b.ms > a.ms ? b : a));
    assert.ok(worst.ms * PHONE_SLOWDOWN < 25, `slowest bike ${worst.id}: ${worst.ms.toFixed(2)} ms here`);
});
