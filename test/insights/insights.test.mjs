// Step 8: the Fuel Learner dashboard's logic — the real SmartDrive learner (run in a sandbox),
// fed by a simulated rider, compared with the physics; and the dashboard's pure helpers.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { buildArtifacts } from "../../scripts/bikedb/catalog-build.mjs";
import { loadCatalog } from "../../scripts/bikedb/load-catalog.mjs";
import { makeLearner, rideAndFill } from "./learner-sim.mjs";

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const Physics = require("../../public/js/physics/index.js");
const Search = require("../../public/js/bikedb/catalog-search.js");
const U = require("../../public/js/garage/units.js");
const I = require("../../public/js/insights/fuel-insights.js");
const D = require("../../public/js/insights/fuel-dashboard.js");

const art = buildArtifacts(loadCatalog());
const byHash = new Map(art.bundles.map((b) => [b.hash, JSON.parse(b.bytes)]));
const index = new Search.CatalogIndex(JSON.parse(art.catalog.bytes));
function model(q) {
    const row = index.search(q, { limit: 1 })[0];
    const b = byHash.get(row.bundle);
    const cls = index.classes.find((c) => c.key === b.classKey);
    return Physics.createBikeModel(b, { classDefault: cls ? byHash.get(cls.bundle) : undefined });
}
const hunter = model("Hunter 350");
const phys = I.physicsCurve(Physics, hunter);
const physicsPm = (v) => I.at(phys.speed, phys.pm, v);

test("bands: the same rule as the learner's fuelBandIndex, at every speed", () => {
    const { g } = makeLearner();
    for (let kmh = 0; kmh <= 140; kmh += 0.5) assert.equal(I.bandIndex(kmh / 3.6), g.fuelBandIndex(kmh), `${kmh} km/h`);
});

test("bandSpeed: recovers the speed a band was ridden at from the learner's totals", () => {
    const { g } = makeLearner();
    for (const [j, kmh] of [[0, 28], [2, 72], [3, 96]]) {
        const km = 10, shapeKm = km / g.fuelShape(kmh);
        const v = I.bandSpeed(g.fuelShape, I.DEFAULT_BANDS[j], km, shapeKm);
        assert.ok(Math.abs(v * 3.6 - kmh) < 0.01, `band ${j}: ${v * 3.6}`);
    }
    assert.equal(I.bandSpeed(g.fuelShape, I.DEFAULT_BANDS[1], 10, 10), I.DEFAULT_BANDS[1].mid, "flat band: its middle");
    assert.equal(I.bandSpeed(g.fuelShape, I.DEFAULT_BANDS[0], 0, 0), I.DEFAULT_BANDS[0].mid, "no data: its middle");
});

test("snapshot: the learner's km/L, litres and km become SI exactly", () => {
    const L = makeLearner({ rated: 35 });
    rideAndFill(L, { physicsPm, idleRate: phys.idleRate, truth: [1.1, 1, 1.05, 1.2], tanks: 4 });
    assert.ok(L.FC.active(), "learner fitted and in use");
    const sn = I.snapshotFromLearner(L.FC, L.g);
    for (const kmh of [20, 45, 70, 90]) {
        const want = 1 / (L.FC.kmPerL(kmh) * 1e6);
        assert.ok(Math.abs(sn.learned(kmh / 3.6) - want) / want < 1e-12, `${kmh} km/h`);
    }
    const iv = L.FC.fit.intervals[0];
    assert.equal(sn.tanks[0].fuel, iv.litres / 1000);
    assert.equal(sn.tanks[0].distance, iv.km * 1000);
    assert.equal(sn.tanks[0].idleTime, iv.idleH * 3600);
    assert.ok(Math.abs(sn.tanks[0].learnedFuel * 1000 - L.FC.design(iv, 35).reduce((a, x, j) => a + x * L.FC.fit.beta[j], 0)) < 1e-12);
    assert.equal(sn.status.usable, 4);
    assert.equal(sn.status.active, true);
    assert.ok(Math.abs(sn.startIdleRate - 0.4 / 1000 / 3600) < 1e-18);
});

test("compare: a rider who burns exactly the physics → physics predicts every tank within 6 %", () => {
    const L = makeLearner({ rated: 35 });
    rideAndFill(L, { physicsPm, idleRate: phys.idleRate, truth: [1, 1, 1, 1], noise: 0, tanks: 6 });
    const c = I.compare(I.snapshotFromLearner(L.FC, L.g), phys);
    assert.equal(c.tanks.length, 6);
    for (const t of c.tanks) assert.ok(Math.abs(t.errPhysics) < 0.06, `tank error ${t.errPhysics}`);
    assert.ok(c.accuracy.physics < 0.04);
    assert.ok(Math.abs(c.overall - 1) < 0.12, `overall ${c.overall}`);
});

test("compare: a rider 20 % thirstier than the physics → overall ≈ +20 %, learned beats physics on tanks", () => {
    const L = makeLearner({ rated: 35 });
    rideAndFill(L, { physicsPm, idleRate: phys.idleRate, truth: [1.2, 1.2, 1.2, 1.2], truthIdle: 1.2, tanks: 6 });
    const c = I.compare(I.snapshotFromLearner(L.FC, L.g), phys);
    assert.ok(Math.abs(c.overall - 1.2) < 0.08, `overall ${c.overall}`);
    assert.ok(c.accuracy.learned < c.accuracy.physics, `${c.accuracy.learned} vs ${c.accuracy.physics}`);
    assert.ok(c.accuracy.physics > 0.12);
    const kinds = c.findings.map((f) => f.kind);
    assert.ok(kinds.includes("overall") && kinds.includes("accuracy"));
    assert.ok(c.bands.every((b) => b.enough && b.distance > 50000));
    assert.ok(Math.abs(c.bands.reduce((a, b) => a + b.share, 0) - 1) < 1e-9);
    // rows: one per table speed from 2 m/s; ribbon bounds the physics
    assert.ok(c.rows[0].v >= 2 - 1e-9);
    for (const r of c.rows) if (r.feasible) assert.ok(r.physLo <= r.phys && r.phys <= r.physHi);
});

test("compare: no bike (no physics) and an empty learner still give a usable picture", () => {
    const empty = makeLearner();
    empty.FC.refit();
    const s0 = I.snapshotFromLearner(empty.FC, empty.g);
    const c0 = I.compare(s0, null);
    assert.equal(c0.tanks.length, 0);
    assert.equal(c0.overall, null);
    assert.ok(c0.findings.some((f) => f.kind === "need-tanks" && f.need === 3));
    assert.ok(c0.rows.length > 10 && c0.rows.every((r) => r.phys === null && r.start > 0 && r.learned === null));
    const L = makeLearner({ rated: 35 });
    rideAndFill(L, { physicsPm, idleRate: phys.idleRate, truth: [1, 1, 1, 1], tanks: 3 });
    const c1 = I.compare(I.snapshotFromLearner(L.FC, L.g), null);
    assert.ok(c1.tanks.every((t) => t.physics === null && t.errPhysics === null));
    assert.equal(c1.accuracy.physics, null);
    assert.throws(() => I.physicsCurve(Physics, model("Ather 450")), /petrol/);
    assert.throws(() => I.snapshotFromLearner(null), /FuelCurve/);
});

test("compare: idling isn't reported when the fill-ups can't pin it down", () => {
    const L = makeLearner({ rated: 35 });
    rideAndFill(L, { physicsPm, idleRate: phys.idleRate, truth: [1.1, 1.1, 1.1, 1.1], truthIdle: 1, tanks: 6 });
    const sn = I.snapshotFromLearner(L.FC, L.g);
    const c = I.compare(sn, phys);
    const atBound = sn.beta[4] <= 0.05 || sn.beta[4] >= 4.95;
    assert.equal(c.findings.some((f) => f.kind === "idle"), !atBound && Math.abs(sn.learnedIdleRate / phys.idleRate - 1) >= 0.3);
    if (atBound) assert.ok(!c.findings.some((f) => f.kind === "idle"));
});

// ---------------------------------------------------------------------------
// Dashboard helpers (pure)
// ---------------------------------------------------------------------------
test("dashboard: ticks, km/L conversion and signed percentages", () => {
    assert.deepEqual(D.niceTicks(63), [0, 20, 40, 60, 80]);
    assert.deepEqual(D.niceTicks(9.3, 4), [0, 2.5, 5, 7.5, 10]);
    assert.equal(D.kmpl(1 / 40e6), 40);
    assert.equal(D.kmpl(null), null);
    assert.equal(D.kmpl(0), null);
    assert.equal(D.pct(1.123, U), "+12 %");
    assert.equal(D.pct(0.9, U), "−10 %");
});

test("dashboard: findings and tiles read naturally", () => {
    const L = makeLearner({ rated: 35 });
    rideAndFill(L, { physicsPm, idleRate: phys.idleRate, truth: [1.3, 1.0, 1.1, 1.35], tanks: 6 });
    const sn = I.snapshotFromLearner(L.FC, L.g);
    const c = I.compare(sn, phys);
    const lines = D.describeFindings(c, U);
    assert.ok(lines.length >= 3);
    assert.ok(lines.some((l) => /^Over the riding you do, your bike uses \d+ % more fuel than the physics predicts\.$/.test(l.text)), lines.map((l) => l.text).join("\n"));
    assert.ok(lines.some((l) => /predicts your tanks within ±\d+ %; the physics alone within ±\d+ %\./.test(l.text)));
    for (const l of lines) assert.ok(["good", "warn", "info"].includes(l.tone) && l.icon);
    const tiles = D.kpis(c, sn, U, true);
    assert.equal(tiles.length, 3);
    assert.match(tiles[0].value, /^\+\d+ %$/);
    assert.match(tiles[2].value, /^±\d+ %$/);
    const need = D.describeFindings({ bands: c.bands, findings: [{ kind: "need-tanks", need: 1 }] }, U);
    assert.match(need[0].text, /^Log 1 more full tank \(/);
    const noBike = D.kpis(I.compare(sn, null), sn, U, false);
    assert.match(noBike[0].sub, /Choose your bike/);
});

test("dashboard: chart geometry — the learned curve breaks at band edges, the ribbon closes, physics only where feasible", () => {
    const L = makeLearner({ rated: 35 });
    rideAndFill(L, { physicsPm, idleRate: phys.idleRate, truth: [1.1, 1, 1.05, 1.2], tanks: 4 });
    const c = I.compare(I.snapshotFromLearner(L.FC, L.g), phys);
    const geo = D.mileageGeometry(c, { W: 600, H: 280, m: { l: 40, r: 14, t: 22, b: 26 }, show: { physics: true, yours: true, start: true } });
    const bandsPresent = new Set(c.rows.filter((r) => r.learned !== null).map((r) => r.band)).size;
    assert.equal((geo.yours.match(/M/g) || []).length, bandsPresent);
    assert.ok(geo.ribbon.endsWith("Z"));
    assert.ok(geo.ticksY[geo.ticksY.length - 1] >= geo.yTop - 1e-9);
    assert.deepEqual(geo.bandEdges, [40, 60, 80].filter((k) => k < geo.xMaxKmh));
    const infeasible = c.rows.filter((r) => !r.feasible).length;
    if (infeasible) assert.ok((geo.physics.match(/[ML]/g) || []).length <= c.rows.length - infeasible);
    const yMaxPix = Math.max(...[...geo.yours.matchAll(/[ML][\d.]+ ([\d.]+)/g)].map((m) => Number(m[1])));
    assert.ok(yMaxPix <= 280 - 26 + 1e-6, "everything stays above the baseline");
});

test("insights-app reads the learner by name and lazy-loads files that exist and are precached", () => {
    const app = fs.readFileSync(path.join(ROOT, "public/js/insights/insights-app.js"), "utf8");
    assert.match(app, /typeof FuelCurve !== "undefined" \? FuelCurve/);
    const files = [...app.matchAll(/"(js\/insights\/[a-z-]+\.(?:js|css))"/g)].map((m) => m[1]);
    assert.ok(files.length >= 3);
    const sw = fs.readFileSync(path.join(ROOT, "public/sw.js"), "utf8");
    for (const f of files) {
        assert.ok(fs.existsSync(path.join(ROOT, "public", f)), f);
        assert.ok(sw.includes(`"/${f}"`), `${f} not precached`);
    }
});
