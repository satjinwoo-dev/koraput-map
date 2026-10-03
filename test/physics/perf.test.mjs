// Performance: the one-table precompute must take under 5 ms on a mid-range phone.
// A phone runs this kind of JavaScript about 3–5× slower than a desktop core, so
// on this machine the median must stay under 1 ms (≥ 5× headroom), and every
// bike's 95th percentile under the 5 ms budget itself.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { Physics, models } from "./helpers.mjs";

const BUDGET_MS = 5;
const MEDIAN_MS = 1;

test(`cruise-table precompute: every bike p95 < ${BUDGET_MS} ms, median < ${MEDIAN_MS} ms`, (t) => {
    const env = { altitude: 900, temperature: 303.15, relativeHumidity: 0.5 };
    for (const m of models) for (let i = 0; i < 20; i++) Physics.cruiseTable(m, env);       // JIT warm-up
    const all = [];
    let worst = { id: "", p95: 0 };
    for (const m of models) {
        const times = [];
        for (let i = 0; i < 60; i++) { const t0 = performance.now(); Physics.cruiseTable(m, env); times.push(performance.now() - t0); }
        times.sort((a, b) => a - b);
        const p95 = times[Math.floor(0.95 * times.length)];
        if (p95 > worst.p95) worst = { id: m.id, p95 };
        all.push(...times);
        assert.ok(p95 < BUDGET_MS, `${m.id}: p95 ${p95.toFixed(2)} ms`);
    }
    all.sort((a, b) => a - b);
    const median = all[Math.floor(all.length / 2)];
    t.diagnostic(`median ${median.toFixed(3)} ms, p95 ${all[Math.floor(0.95 * all.length)].toFixed(3)} ms, worst bike ${worst.id} p95 ${worst.p95.toFixed(3)} ms (${models.length} bikes × 60 runs)`);
    assert.ok(median < MEDIAN_MS, `median ${median.toFixed(3)} ms`);
});

test("first table in a fresh process (cold JIT) is reported", (t) => {
    const script = `
        const { performance } = require("node:perf_hooks");
        const t0 = performance.now();
        const P = require(${JSON.stringify(fileURLToPath(new URL("../../public/js/physics/index.js", import.meta.url)))});
        const b = JSON.parse(process.argv[1]);
        const m = P.createBikeModel(b);
        const t1 = performance.now();
        P.cruiseTable(m, { altitude: 900 });
        const t2 = performance.now();
        console.log(JSON.stringify({ load: t1 - t0, table: t2 - t1 }));`;
    const hand = models.find((m) => m.id === "royal-enfield-hunter-350-metro-in");
    assert.ok(hand);
    // the Hunter's bundle has complete gearing, so it needs no class default
    const r = spawnSync(process.execPath, ["-e", script, JSON.stringify(bundleFor(hand.id))], { encoding: "utf8" });
    assert.equal(r.status, 0, r.stderr);
    const { load, table } = JSON.parse(r.stdout);
    t.diagnostic(`cold: load + model ${load.toFixed(1)} ms, first table ${table.toFixed(1)} ms`);
    assert.ok(table < 50, `cold first table ${table.toFixed(1)} ms`);
});

import { bundleById } from "./helpers.mjs";
function bundleFor(id) { return bundleById.get(id); }
