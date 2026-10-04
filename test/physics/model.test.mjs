// createBikeModel: strict-SI input, fallbacks, rider settings, EV torque placement.
import { test } from "node:test";
import assert from "node:assert/strict";
import { Physics, bundleById, classDefaultOf, handBike, RPM, KMH } from "./helpers.mjs";

const B = (id) => structuredClone(bundleById.get(id));
const model = (id, settings) => { const b = B(id); return Physics.createBikeModel(b, { classDefault: classDefaultOf(b), settings }); };

test("refuses anything that isn't a strict-SI runtime bundle", () => {
    const h = B("royal-enfield-hunter-350-metro-in");
    assert.throws(() => Physics.createBikeModel({ ...h, units: undefined }), /strict-SI/);
    assert.throws(() => Physics.createBikeModel({ ...h, format: "mapunite-bike-bundle/0" }), /expected format/);
    const published = structuredClone(h);
    published.engine.peakPower = { v: 14.87, u: "kW", src: "x", conf: 0.9 };          // a published-unit value sneaking in
    assert.throws(() => Physics.createBikeModel(published), /must be in W/);
    assert.throws(() => Physics.createBikeModel(null), TypeError);
});

test("Hunter 350: SI numbers straight from the bundle", () => {
    const m = model("royal-enfield-hunter-350-metro-in");
    assert.equal(m.vehicleMass, 181);
    assert.equal(m.engine.displacement, 0.00034934);
    assert.ok(Math.abs(m.engine.omegaIdle - 1050 * RPM) < 1e-9);
    assert.ok(Math.abs(m.engine.curve.omegaPower - 6100 * RPM) < 1e-9);
    assert.equal(m.engine.curve.peakPower, 14870);
    assert.equal(m.engine.revsPerCycle, 2);
    assert.equal(m.engine.fuelInjected, true);
    assert.deepEqual(m.drive.ratios, [2.615, 1.706, 1.3, 1.04, 0.875].map((g) => 2.313 * g * 2.8));
    assert.equal(m.gearAdvice, true);
    assert.equal(m.fuel.code, "E20");
    assert.equal(m.fuel.lhv, 3.014e10);
    assert.ok(Math.abs(m.unloadedRadius - (17 * 0.0254 + 2 * 0.140 * 0.70) / 2) < 1e-12);
    assert.doesNotThrow(() => structuredClone(m), "plain data: can be posted to a Web Worker");
});

test("missing gearing comes whole from the class default, flagged, and gear advice turns off", () => {
    const m = model("honda-shine-125-obd2b-in");
    const d = bundleById.get("default-ice-manual-commuter");
    assert.equal(m.drive.source, "class_default");
    assert.equal(m.gearAdvice, false);
    assert.deepEqual(m.drive.gearRatios, d.transmission.gearRatios.v);
    assert.ok(m.flags.some((f) => /gearing from the class default/.test(f)));
    assert.throws(() => Physics.createBikeModel(B("honda-shine-125-obd2b-in")), /gearing incomplete.*opts\.classDefault/);
    assert.throws(() => Physics.createBikeModel(B("honda-shine-125-obd2b-in"), { classDefault: bundleById.get("default-ev-scooter") }), /class default for ice_manual\.commuter/);
    assert.ok(model("honda-hness-cb350-dlx-in").flags.some((f) => /idle speed from the class default/.test(f)));
});

test("rider settings: sprockets, masses, rear tyre and fuel", () => {
    const base = model("royal-enfield-hunter-350-metro-in");
    const spr = model("royal-enfield-hunter-350-metro-in", { frontSprocket: 15, rearSprocket: 45 });
    assert.equal(spr.drive.final, 3);
    assert.deepEqual(spr.drive.ratios, base.drive.gearRatios.map((g) => 2.313 * g * 3));
    const w0 = /** @type {number} */ (Physics.operatingPoint(base, 50 * KMH, {}, { gear: 4 }).omega);
    const w1 = /** @type {number} */ (Physics.operatingPoint(spr, 50 * KMH, {}, { gear: 4 }).omega);
    assert.ok(Math.abs(w1 / w0 - 3 / 2.8) < 1e-12, "engine speed scales with the final ratio");
    assert.ok(spr.flags.some((f) => /sprockets/.test(f)));

    const heavy = model("royal-enfield-hunter-350-metro-in", { riderMass: 95, pillionMass: 70, luggageMass: 10 });
    assert.deepEqual(heavy.params.riderMass, { mean: 95, sigma: 2 });
    assert.equal(heavy.massFixed, 181 + 70 + 10);
    assert.ok(/** @type {number} */ (Physics.operatingPoint(heavy, 15).fuelRate) > /** @type {number} */ (Physics.operatingPoint(base, 15).fuelRate));

    const tyre = model("royal-enfield-hunter-350-metro-in", { rearTyre: "150/60-17" });
    assert.ok(Math.abs(tyre.unloadedRadius - (17 * 0.0254 + 2 * 0.150 * 0.60) / 2) < 1e-12);
    const e10 = model("royal-enfield-hunter-350-metro-in", { fuelCode: "E10" });
    assert.equal(e10.fuel.code, "E10");
    assert.ok(/** @type {number} */ (Physics.operatingPoint(e10, 15).fuelRate) < /** @type {number} */ (Physics.operatingPoint(base, 15).fuelRate), "E10 carries more energy per litre than E20");

    assert.throws(() => model("royal-enfield-hunter-350-metro-in", { fuelCode: "E50" }), /not in the bundle's fuel-grade table/);
    assert.throws(() => model("royal-enfield-hunter-350-metro-in", { frontSprocket: 15.5, rearSprocket: 45 }), /whole numbers/);
    assert.throws(() => model("royal-enfield-hunter-350-metro-in", { frontSprocket: 15 }), RangeError);
    assert.throws(() => model("royal-enfield-hunter-350-metro-in", { riderMass: -5 }), RangeError);
});

test("a dry mass gets fuel and fluids added; a 2-stroke turns once per cycle", () => {
    const b = handBike();
    b.chassis.mass.basis = "dry";
    const m = Physics.createBikeModel(b);
    assert.ok(Math.abs(m.vehicleMass - (100 + 3 + 0.9 * 0.01 * 755.8)) < 1e-9);     // 109.8022 kg: 90 % of a 10 L tank of E20
    assert.equal(Physics.createBikeModel(handBike({ strokes: 2 })).engine.revsPerCycle, 1);
});

test("EV motor torque is placed at the wheel only when the data allows it", () => {
    assert.equal(model("tvs-iqube-3-5kwh-in").motor.wheelTorque, 140);                       // hub motor: motor torque is wheel torque
    assert.ok(Math.abs(model("ather-450x-2-9kwh-2025-in").motor.wheelTorque - 26 * 7.8) < 1e-9);   // through its 7.8 reduction
    const f77 = model("ultraviolette-f77-mach2-recon-in");
    assert.equal(f77.drive.source, "class_default");
    assert.ok(Math.abs(/** @type {number} */ (f77.motor.wheelTorque) - 100 * 6.5) < 1e-9);
    const ola = model("ola-s1-pro-gen3-4kwh-in");
    assert.equal(ola.motor.wheelTorque, null);
    assert.ok(ola.flags.some((f) => /power only/.test(f)));
    assert.deepEqual(model("ather-450x-2-9kwh-2025-in").params.usableShare, { mean: 0.92, sigma: 0.03 });
    assert.equal(model("default-ev-scooter").params.usableShare, undefined, "usable capacity published: no assumption");
    assert.equal(model("ather-450x-2-9kwh-2025-in").motor.speedLimit, 25);
});
