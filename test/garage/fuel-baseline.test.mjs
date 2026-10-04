// Step 7: the physics of the rider's bike as SmartDrive's fuel baseline (js/garage/fuel-baseline.js).
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { buildArtifacts } from "../../scripts/bikedb/catalog-build.mjs";
import { loadCatalog } from "../../scripts/bikedb/load-catalog.mjs";

const require = createRequire(import.meta.url);
const Physics = require("../../public/js/physics/index.js");
const FB = require("../../public/js/garage/fuel-baseline.js");
const art = buildArtifacts(loadCatalog());
const classDefaultOf = (b) => art.bundles.find((x) => x.kind === "class_default" && x.classKey === b.classKey).runtime;
const garageOf = (b, settings = {}) => ({ bikeId: b.id, classKey: b.runtime.classKey, bundle: b.hash, settings, title: b.id, estimated: b.kind !== "variant" });
const modelOf = (b, settings = {}) => Physics.createBikeModel(b.runtime, { classDefault: b.kind === "variant" ? classDefaultOf(b.runtime) : undefined, settings });

test("every petrol bike and typical bike in the catalogue gives a valid, compact snapshot that agrees with the physics", () => {
    let n = 0;
    for (const b of art.bundles.filter((x) => x.runtime.powertrain !== "ev")) {
        const m = modelOf(b);
        const s = FB.buildFuelBaseline(Physics, m, garageOf(b));
        assert.equal(s.kind, "petrol", b.id);
        assert.deepEqual(FB.readSnapshot(JSON.parse(JSON.stringify(s))), JSON.parse(JSON.stringify(s)), `${b.id}: survives storage`);
        assert.equal(s.kmPerL.length, Math.round(s.vMaxKmh / s.step) + 1);
        assert.ok(s.kmPerL.every((k) => Number.isFinite(k) && k > 0), b.id);
        assert.ok(JSON.stringify(s).length < 4096, `${b.id}: small enough for localStorage`);
        // The grid is the physics sampled at every 0.5 km/h. Between two grid speeds it is linear, so it
        // matches the physics within 1 % (3 % below 10 km/h) — except inside the one cell where the gear changes, where the
        // physics steps and a straight line can't: that cell is checked through the band totals below.
        const onGrid = Physics.cruiseTable(m, {}, { step: s.step / 3.6, sigma: false });
        const t = Physics.cruiseTable(m, {}, { step: 0.1, sigma: false });
        const band = new Map();
        let checked = 0;
        for (let i = 0; i < t.speed.length; i++) {
            const kmh = t.speed[i] * 3.6;
            if (kmh < 5 || kmh > s.vMaxKmh - s.step || !t.feasible[i]) continue;
            const phys = 1e-6 / t.perMetre[i];
            const c = Math.floor(kmh / s.step);
            const shiftCell = onGrid.gear[c] !== onGrid.gear[c + 1] || onGrid.gear[c] !== t.gear[i];
            // below 10 km/h km/L bends sharply (clutch slip, idle feed): 3 % there, 1 % above
            if (!shiftCell) { assert.ok(Math.abs(FB.kmPerLAt(s, kmh) / phys - 1) < (kmh < 10 ? 0.03 : 0.01), `${b.id} at ${kmh.toFixed(2)} km/h: ${FB.kmPerLAt(s, kmh)} vs ${phys}`); checked++; }
            const j = kmh < 40 ? 0 : kmh <= 60 ? 1 : kmh <= 80 ? 2 : 3;          // SmartDrive's bands
            const acc = band.get(j) || { snap: 0, phys: 0 };
            acc.snap += 1 / FB.kmPerLAt(s, kmh); acc.phys += 1 / phys;
            band.set(j, acc);
        }
        assert.ok(checked > 100, b.id);
        // … and the litres SmartDrive adds up over each speed band within 1.5 % (the gear-change cells
        // pile up below 40 km/h; the physics itself is only known to ±15–20 %)
        for (const [j, acc] of band) assert.ok(Math.abs(acc.snap / acc.phys - 1) < 0.015, `${b.id} band ${j}: ${acc.snap / acc.phys}`);
        // the reference is the fuel-weighted mean over 40–60 km/h
        let litres = 0, k = 0;
        for (let v = 40; v <= 60; v += 0.5) { litres += 1 / FB.kmPerLAt(s, v); k++; }
        assert.ok(Math.abs(s.referenceKmPerL / (k / litres) - 1) < 0.005, b.id);
        const idle = Physics.operatingPoint(m, 0).fuelRate * 3.6e6;
        assert.ok(Math.abs(s.idleLPerHour - idle) < 1e-3 && idle > 0 && idle < 1, `${b.id}: idle ${idle} L/h`);
        assert.ok(s.sigmaRel > 0 && s.sigmaRel < 0.5, `${b.id}: ±${s.sigmaRel}`);
        if (s.eco) assert.ok(s.eco.fromKmh <= s.eco.bestKmh && s.eco.bestKmh <= s.eco.toKmh);
        n++;
    }
    assert.ok(n >= 25);
});

test("held at the ends: below the grid and above the top speed the nearest figure applies", () => {
    const b = art.bundles.find((x) => x.id === "royal-enfield-hunter-350-metro-in");
    const s = FB.buildFuelBaseline(Physics, modelOf(b), garageOf(b));
    assert.equal(FB.kmPerLAt(s, -5), s.kmPerL[0]);
    assert.equal(FB.kmPerLAt(s, 500), s.kmPerL.at(-1));
    assert.equal(FB.kmPerLAt(s, 50), s.kmPerL[100]);
    assert.ok(Math.abs(FB.kmPerLAt(s, 50.25) - (s.kmPerL[100] + s.kmPerL[101]) / 2) < 1e-12);
});

test("the rider's settings are in the baseline: a pillion costs mileage, and changes the key", () => {
    const b = art.bundles.find((x) => x.id === "royal-enfield-hunter-350-metro-in");
    const solo = FB.buildFuelBaseline(Physics, modelOf(b), garageOf(b));
    const two = FB.buildFuelBaseline(Physics, modelOf(b, { pillionMass: 75 }), garageOf(b, { pillionMass: 75 }));
    assert.ok(two.referenceKmPerL < solo.referenceKmPerL);
    assert.notEqual(two.key, solo.key);
    assert.equal(FB.garageKey(garageOf(b, { riderMass: 80, pillionMass: 70 })), FB.garageKey(garageOf(b, { pillionMass: 70, riderMass: 80 })), "key order doesn't matter");
    assert.equal(solo.bikeTag, "bike:royal-enfield-hunter-350-metro-in");
    assert.equal(FB.bikeTag({ bikeId: null, classKey: "ice_cvt.scooter" }), "class:ice_cvt.scooter");
});

test("electric bikes: no litres, just the kind", () => {
    for (const b of art.bundles.filter((x) => x.runtime.powertrain === "ev")) {
        const s = FB.buildFuelBaseline(Physics, modelOf(b), garageOf(b));
        assert.equal(s.kind, "ev", b.id);
        assert.equal(s.kmPerL, undefined);
        assert.ok(FB.readSnapshot(s));
    }
});

test("readSnapshot refuses anything malformed", () => {
    const b = art.bundles.find((x) => x.id === "hero-splendor-plus-obd2b-in");
    const good = FB.buildFuelBaseline(Physics, modelOf(b), garageOf(b));
    for (const bad of [null, 1, "x", {}, { ...good, format: 2 }, { ...good, kind: "diesel" }, { ...good, kmPerL: [] }, { ...good, kmPerL: [1, -1] }, { ...good, kmPerL: [1, NaN] },
        { ...good, step: 0 }, { ...good, referenceKmPerL: 0 }, { ...good, key: 1 }, { ...good, title: null }]) assert.equal(FB.readSnapshot(bad), null, JSON.stringify(bad).slice(0, 60));
    assert.ok(FB.readSnapshot(good));
});

test("fleet calibration (roadmap Step 11): the bundle's real-riding overhead scales the moving fuel; idle stays; without one, nothing changes", () => {
    const b = art.bundles.find((x) => x.id === "hero-splendor-plus-obd2b-in");
    const plain = FB.buildFuelBaseline(Physics, modelOf(b), garageOf(b));
    const calibration = { date: "2026-10-03", tanks: 400, riders: 40, overhead: { mean: 1.12, sigma: 0.05, u: "1", src: "fleet-calibration" } };
    const cal = FB.buildFuelBaseline(Physics, modelOf(b), garageOf(b), { calibration });
    assert.deepEqual(cal.fleet, { overhead: 1.12, overheadSigma: 0.05, date: "2026-10-03", tanks: 400, riders: 40 });
    cal.kmPerL.forEach((k, i) => assert.ok(Math.abs(k * 1.12 / plain.kmPerL[i] - 1) < 2e-3, `grid ${i}: ${k} vs ${plain.kmPerL[i]} ÷ 1.12`));
    assert.ok(Math.abs(cal.referenceKmPerL * 1.12 / plain.referenceKmPerL - 1) < 1e-3);
    assert.ok(Math.abs(cal.eco.bestKmPerL * 1.12 / plain.eco.bestKmPerL - 1) < 1e-3);
    assert.deepEqual([cal.eco.fromKmh, cal.eco.toKmh, cal.eco.bestKmh], [plain.eco.fromKmh, plain.eco.toKmh, plain.eco.bestKmh], "a constant factor doesn't move the eco band");
    assert.equal(cal.idleLPerHour, plain.idleLPerHour, "idle is fitted separately from the overhead");
    assert.ok(Math.abs(cal.sigmaRel - Math.hypot(plain.sigmaRel, 0.05 / 1.12)) < 2e-3, "the overhead's uncertainty is added");
    assert.ok(FB.readSnapshot(JSON.parse(JSON.stringify(cal))));
    // no calibration, or one that isn't usable: exactly the plain snapshot (no `fleet` key at all)
    for (const c of [undefined, null, {}, { overhead: { mean: 9, sigma: 0, u: "1" } }, { overhead: { mean: 1.1, u: "%" } }, { overhead: { mean: "1.1", u: "1" } }]) {
        assert.deepEqual(FB.buildFuelBaseline(Physics, modelOf(b), garageOf(b), { calibration: c }), plain, JSON.stringify(c));
    }
    assert.equal("fleet" in plain, false);
});
