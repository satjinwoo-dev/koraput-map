// Step 9: the SmartDrive HUD's live estimator and the view's pure helpers.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { buildArtifacts } from "../../scripts/bikedb/catalog-build.mjs";
import { loadCatalog } from "../../scripts/bikedb/load-catalog.mjs";

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const Physics = require("../../public/js/physics/index.js");
const Search = require("../../public/js/bikedb/catalog-search.js");
const U = require("../../public/js/garage/units.js");
const L = require("../../public/js/hud/live.js");
const V = require("../../public/js/hud/hud.js");

const art = buildArtifacts(loadCatalog());
const byHash = new Map(art.bundles.map((b) => [b.hash, JSON.parse(b.bytes)]));
const index = new Search.CatalogIndex(JSON.parse(art.catalog.bytes));
function model(q) {
    const row = index.search(q, { limit: 1 })[0];
    const b = byHash.get(row.bundle), cls = index.classes.find((c) => c.key === b.classKey);
    return Physics.createBikeModel(b, { classDefault: cls ? byHash.get(cls.bundle) : undefined });
}
const hunter = model("Hunter 350");
/** Feed a speed profile (m/s per second) → final state. */
function ride(est, speeds, extra = () => ({})) { let s; speeds.forEach((v, i) => { s = est.push({ t: i * 1000, v, ...extra(i) }); }); return s; }

test("steady cruise: live figure and trip energy are the physics at that speed", () => {
    const est = L.createLiveEstimator(Physics, hunter, { price: 100000 });
    const s = ride(est, Array(60).fill(15));
    const pm = Physics.operatingPoint(hunter, 15, { altitude: 0, accel: 0, grade: 0 }).fuelPerMetre;
    assert.ok(Math.abs(s.live - pm) / pm < 1e-9, `${s.live} vs ${pm}`);
    assert.equal(s.mode, "cruise");
    assert.ok(Math.abs(s.trip.distance - 59 * 15) < 1e-6);
    assert.ok(Math.abs(s.trip.energy - pm * 59 * 15) / (pm * 885) < 1e-9);
    assert.ok(Math.abs(s.trip.cost - s.trip.energy * 100000) < 1e-12);
    assert.equal(s.trip.harsh.accel + s.trip.harsh.brake, 0);
});

test("acceleration: the slope of speed, clamped to ±4 m/s²", () => {
    const est = L.createLiveEstimator(Physics, hunter, {});
    const s = ride(est, Array.from({ length: 10 }, (_, i) => i * 1.2));
    assert.ok(Math.abs(s.a - 1.2) < 1e-9);
    assert.equal(s.mode, "accel");
    const spike = ride(L.createLiveEstimator(Physics, hunter, {}), [0, 0, 0, 0, 20]);
    assert.ok(spike.a <= 4 + 1e-12);
});

test("idling burns the idle rate for 3 minutes, then the engine counts as off", () => {
    const est = L.createLiveEstimator(Physics, hunter, {});
    const idle = Physics.operatingPoint(hunter, 0, { altitude: 0 }).fuelRate;
    let s = ride(est, Array(121).fill(0));
    assert.equal(s.mode, "idle");
    assert.ok(Math.abs(s.trip.energy - idle * 120) / (idle * 120) < 1e-9);
    s = ride(est, Array(400).fill(0));
    assert.equal(s.mode, "off");
    assert.ok(Math.abs(s.trip.idleTime - 180) < 1e-9);
    const lf = V.liveFigure({ ...s, mode: "idle" }, U);
    assert.equal(lf.unit, "L/h");
});

test("descending on a fuel-injected bike: fuel cut, ∞ km/L, eco score 1 there", () => {
    const est = L.createLiveEstimator(Physics, hunter, {});
    const s = ride(est, Array(30).fill(14), () => ({ grade: -0.08 }));
    assert.equal(s.mode, "coast");
    assert.equal(s.rate, 0);
    const lf = V.liveFigure(s, U);
    assert.equal(lf.value, "∞");
    assert.match(lf.note, /Fuel cut/);
    assert.ok(Math.abs(s.trip.ecoScore - 1) < 1e-12);
});

test("eco band: in it at the best speed; above → ease off; below → no 'speed up'; the limit wins", () => {
    const est = L.createLiveEstimator(Physics, hunter, {});
    const band = est.band(0);
    const sIn = ride(est, Array(10).fill(band.best));
    assert.equal(sIn.eco.inBand, true);
    assert.equal(V.ecoGuidance(sIn, U).tone, "good");
    assert.ok(sIn.trip.ecoScore > 0.98);
    const hi = ride(L.createLiveEstimator(Physics, hunter, {}), Array(10).fill(band.high + 2.5));
    const gHi = V.ecoGuidance(hi, U);
    assert.match(gHi.text, /^Ease off \d+ km\/h/);
    const far = ride(L.createLiveEstimator(Physics, hunter, {}), Array(10).fill(band.high + 8));
    const gFar = V.ecoGuidance(far, U);
    assert.match(gFar.text, /^Above the eco band \(.*\) · \d+ % more fuel per km$/, "far above: what it costs, no instruction");
    const lo = ride(L.createLiveEstimator(Physics, hunter, {}), Array(10).fill(3));
    const gLo = V.ecoGuidance(lo, U);
    assert.doesNotMatch(gLo.text.toLowerCase(), /speed up|faster|accelerate/);
    assert.match(gLo.text, /Below the eco band/);
    const lim = ride(L.createLiveEstimator(Physics, hunter, {}), Array(10).fill(8), () => ({ limit: 25 / 3.6 }));
    assert.ok(Math.abs(lim.eco.high - 25 / 3.6) < 1e-9 && lim.eco.low <= lim.eco.high);
    const fast = ride(L.createLiveEstimator(Physics, hunter, {}), Array(40).fill(27));
    assert.ok(fast.trip.ecoScore < 0.75, `90+ km/h scores lower: ${fast.trip.ecoScore}`);
});

test("harsh moments: a strong launch held for a second counts once", () => {
    const est = L.createLiveEstimator(Physics, hunter, {});
    const s = ride(est, [0, 0, 0, 3.5, 7, 10.5, 14, 14, 14, 14, 14, 14]);
    assert.equal(s.trip.harsh.accel, 1);
    const b = ride(L.createLiveEstimator(Physics, hunter, {}), [20, 20, 20, 20, 16, 12, 8, 4, 0, 0, 0]);
    assert.equal(b.trip.harsh.brake, 1);
});

test("learned correction scales fuel and cost; tank and range follow", () => {
    const a = ride(L.createLiveEstimator(Physics, hunter, { price: 1e5, capacity: 0.013, level: 0.5 }), Array(100).fill(13));
    const b = ride(L.createLiveEstimator(Physics, hunter, { price: 1e5, capacity: 0.013, level: 0.5, correction: 1.2 }), Array(100).fill(13));
    assert.ok(Math.abs(b.trip.energy / a.trip.energy - 1.2) < 1e-9);
    assert.ok(Math.abs(b.trip.cost / a.trip.cost - 1.2) < 1e-9);
    assert.ok(Math.abs(a.tank.left - (0.0065 - a.trip.energy)) < 1e-15);
    const pm = a.trip.energy / a.trip.distance;
    assert.ok(Math.abs(a.tank.range - a.tank.left / pm) / a.tank.range < 1e-6);
    assert.equal(b.corrected, true);
});

test("a gap longer than 5 s (tunnel, phone asleep) isn't integrated across", () => {
    const est = L.createLiveEstimator(Physics, hunter, {});
    est.push({ t: 0, v: 15 }); est.push({ t: 1000, v: 15 });
    const before = est.state.trip.distance;
    const s = est.push({ t: 60000, v: 15 });
    assert.equal(s.trip.distance, before);
    assert.equal(est.push({ t: 1000, v: 15, accepted: false }), s, "rejected fixes change nothing");
});

test("EV: regeneration reads as charging; Wh/km otherwise", () => {
    const evm = model("Ather 450");
    const est = L.createLiveEstimator(Physics, evm, { price: 8 / 3.6e6 });
    const d = ride(est, Array(20).fill(10), () => ({ grade: -0.07 }));
    assert.equal(d.mode, "regen");
    assert.match(V.liveFigure(d, U).value, /^\+/);
    const f = ride(L.createLiveEstimator(Physics, evm, {}), Array(20).fill(10));
    assert.equal(V.liveFigure(f, U).unit, "Wh/km");
});

test("pitstop alerts: reserve, planned stop, refuel before the destination, or nothing", () => {
    assert.deepEqual(L.pitstopAlert({ progress: 0, remaining: 50000, range: 2000 }).level, "critical");
    const st = L.pitstopAlert({ progress: 10000, remaining: 200000, range: 150000, stops: [{ s: 13000, name: "HP Petrol", mine: true }, { s: 90000, name: "IOCL", mine: false }] });
    assert.equal(st.kind, "stop"); assert.equal(st.level, "warn"); assert.equal(st.distance, 3000);
    assert.equal(L.pitstopAlert({ progress: 0, remaining: 100000, range: 40000 }).kind, "refuel");
    assert.equal(L.pitstopAlert({ progress: 0, remaining: 100000, range: 40000 }).level, "info");
    assert.equal(L.pitstopAlert({ progress: 0, remaining: 100000, range: 20000 }).level, "warn");
    assert.equal(L.pitstopAlert({ progress: 0, remaining: 30000, range: 40000 }), null);
    assert.equal(L.pitstopAlert({ progress: null, remaining: null, range: null }), null);
    const t = V.alertText(st, U, false);
    assert.equal(t.title, "Fuel stop in 3.0 km");
    assert.equal(V.alertText({ kind: "stop", level: "info", distance: 20000, name: "IOCL", mine: false }, U, false).sub, "IOCL · you can wait");
});

test("speed scale geometry stays on the scale and marks the band and limit", () => {
    const g = V.scaleGeometry({ v: 12, eco: { low: 9, high: 11.5 }, limit: 50 / 3.6 });
    assert.ok(g.max >= 60 && g.max % 20 === 0);
    assert.ok(g.low < g.high && g.high <= 100 && g.needle <= 100 && g.limit > 0);
    assert.equal(g.ticks[0], 0);
});

test("HUD files are precached; index.html wiring is additive; smartdrive.js emits the events", () => {
    const sw = fs.readFileSync(path.join(ROOT, "public/sw.js"), "utf8");
    for (const f of ["hud/live.js", "hud/hud.js", "hud/hud-app.js", "hud/hud.css", "share/share-app.js", "share/card-model.js", "share/card-render.js", "share/share-ui.js", "share/share.css"]) {
        assert.ok(sw.includes(`"/js/${f}"`), f);
        assert.ok(fs.existsSync(path.join(ROOT, "public/js", f)), f);
    }
    const html = fs.readFileSync(path.join(ROOT, "public/index.html"), "utf8");
    for (const id of ["smartdrive-hud", "speed-dial", "share-modal", "share-mount", "share-ride-btn", "close-results-btn", "results-panel"]) assert.equal((html.match(new RegExp(`id="${id}"`, "g")) || []).length, 1, id);
    const sd = fs.readFileSync(path.join(ROOT, "public/js/smartdrive.js"), "utf8");
    assert.match(sd, /new CustomEvent\("mu:fix"/);
    assert.match(sd, /new CustomEvent\("mu:trip-end"/);
});
