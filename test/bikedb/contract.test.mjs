// Every rule in validateBundle() has a failing case here, built by breaking one
// thing in a real seed file.
import { test } from "node:test";
import assert from "node:assert/strict";
import { Contract, ref, clone, has, hasWarn, codes } from "./helpers.mjs";

const V = (b) => Contract.validateBundle(b, ref);
const RE = "royal-enfield-classic-350-in";
const EV = "ather-450x-3-7kwh-2025-in";

test("a correct seed bundle passes with no errors", () => {
    const r = V(clone(RE));
    assert.deepEqual(r.errors, []);
    assert.equal(r.ok, true);
});

// ---- units ----
test("rejects a non-canonical unit (hp instead of kW)", () => {
    const b = clone(RE); b.engine.peakPower.u = "hp";
    assert.ok(has(V(b), "unit", "engine.peakPower.u"));
});
test("rejects 'Nm' — the canonical torque unit is N*m", () => {
    const b = clone(RE); b.engine.peakTorque.u = "Nm";
    assert.ok(has(V(b), "unit", "engine.peakTorque.u"));
});
test("rejects a missing unit", () => {
    const b = clone(RE); delete b.chassis.mass.u;
    assert.ok(has(V(b), "unit", "chassis.mass"));
});
test("rejects litres given as gallons and mass in pounds", () => {
    const b = clone(RE); b.chassis.fuelTank.u = "gal"; b.chassis.mass.u = "lb";
    const r = V(b);
    assert.ok(has(r, "unit", "chassis.fuelTank") && has(r, "unit", "chassis.mass"));
});

// ---- provenance / confidence ----
test("rejects a value with no source", () => {
    const b = clone(RE); delete b.engine.bore.src;
    assert.ok(has(V(b), "provenance", "engine.bore"));
});
test("rejects a source id that isn't listed in sources[]", () => {
    const b = clone(RE); b.engine.bore.src = "made-up-source";
    assert.ok(has(V(b), "provenance", "engine.bore"));
});
test("rejects a missing or out-of-range confidence", () => {
    const b = clone(RE); delete b.engine.bore.conf; b.engine.stroke.conf = 1.2;
    const r = V(b);
    assert.ok(has(r, "confidence", "engine.bore") && has(r, "confidence", "engine.stroke"));
});
test("rejects over-claiming: an aggregator value can't be more than 0.8 confident", () => {
    const b = clone("yamaha-yzf-r15-v4-in"); b.emission.standard.conf = 0.95;   // zigwheels source
    assert.ok(has(V(b), "overclaim", "emission.standard"));
});
test("rejects an empty sources list", () => {
    const b = clone(RE); b.sources = [];
    assert.ok(has(V(b), "required", "sources"));
});
test("a manufacturer source needs a URL; an estimate needs a method note", () => {
    const b = clone(RE);
    delete b.sources[0].url;
    b.sources.push({ id: "my-guess", kind: "estimated", title: "A guess", retrieved: "2026-10-02" });
    b.engine.compressionRatio.src = "my-guess"; b.engine.compressionRatio.conf = 0.5;
    const r = V(b);
    assert.ok(has(r, "required", "sources[0].url"));
    assert.ok(has(r, "required", ".note"));
});
test("an estimated value can't claim more than 0.6 confidence", () => {
    const b = clone(RE);
    b.sources.push({ id: "my-guess", kind: "estimated", title: "A guess", retrieved: "2026-10-02", note: "eyeballed from a photo of the tachometer" });
    b.engine.redlineRpm = { v: 7000, u: "rpm", src: "my-guess", conf: 0.7 };
    assert.ok(has(V(b), "overclaim", "engine.redlineRpm"));
});

// ---- physically impossible values ----
test("rejects negative mass and negative displacement", () => {
    const b = clone(RE); b.chassis.mass.v = -195; b.engine.displacement.v = -349.34;
    const r = V(b);
    assert.ok(has(r, "impossible", "chassis.mass") && has(r, "impossible", "engine.displacement"));
});
test("rejects redline below idle", () => {
    const b = clone(RE); b.engine.redlineRpm = { v: 900, u: "rpm", src: b.engine.idleRpm.src, conf: 0.8 };
    const r = Contract.validateBundle(b, ref);
    assert.ok(r.errors.some((e) => e.code === "impossible" && e.path === "engine.redlineRpm"));
});
test("rejects idle above the peak-torque rpm", () => {
    const b = clone(RE); b.engine.idleRpm.v = 2400; b.engine.peakTorqueRpm.v = 2000;
    assert.ok(has(V(b), "impossible", "engine.idleRpm"));
});
test("rejects a limiter below redline", () => {
    const b = clone(RE);
    b.engine.redlineRpm = { v: 7000, u: "rpm", src: "re-classic-site", conf: 0.8 };
    b.engine.limiterRpm = { v: 6500, u: "rpm", src: "re-classic-site", conf: 0.8 };
    assert.ok(has(V(b), "impossible", "engine.limiterRpm"));
});
test("catches a bore typo through the displacement cross-check (72 mm → 27 mm)", () => {
    const b = clone(RE); b.engine.bore.v = 27;           // below the plausible bore range
    assert.ok(has(V(b), "impossible", "engine.bore"));
    b.engine.bore.v = 75;      // in range, but the displacement no longer adds up (+8.5 %)
    assert.ok(has(V(b), "inconsistent", "engine.displacement"));
});
test("rejects torque that would exceed peak power (27 → 40 N*m at 4000 rpm is 16.8 kW > 14.87 kW)", () => {
    const b = clone(RE); b.engine.peakTorque.v = 40;
    assert.ok(has(V(b), "impossible", "engine.peakTorque"));
});
test("rejects peak power that needs more torque than stated", () => {
    const b = clone(RE); b.engine.peakPowerRpm.v = 3000;      // 14.87 kW at 3000 rpm needs 47 N*m
    assert.ok(has(V(b), "impossible", "engine.peakPower"));
});
test("rejects gear ratios that don't decrease, or don't match the gear count", () => {
    const b = clone(RE); b.transmission.gearRatios.v = [2.615, 1.706, 1.8, 1.04, 0.875];
    assert.ok(has(V(b), "impossible", "transmission.gearRatios"));
    const c = clone(RE); c.transmission.gearRatios.v = [2.615, 1.706, 1.3, 1.04];
    assert.ok(has(V(c), "inconsistent", "transmission.gearRatios"));
});
test("rejects sprockets that contradict the final ratio", () => {
    const b = clone("hero-splendor-plus-obd2b-in"); b.transmission.rearSprocket.v = 40;
    assert.ok(has(V(b), "inconsistent", "transmission.finalRatio"));
});
test("rejects a CVT whose minimum ratio is above its maximum", () => {
    const b = clone("tvs-jupiter-110-disc-sxc-in"); b.transmission.cvtRatioMin.v = 1.3; b.transmission.cvtRatioMax.v = 1.25;
    assert.ok(has(V(b), "impossible", "transmission.cvtRatioMin"));
});
test("rejects an unparseable tyre size and a non-integer gear count", () => {
    const b = clone(RE); b.chassis.rearTyre.v = "big and round"; b.transmission.speeds.v = 5.5;
    const r = V(b);
    assert.ok(has(r, "format", "chassis.rearTyre") && has(r, "integer", "transmission.speeds"));
});
test("rejects usable battery above installed capacity, and rated above peak power", () => {
    const b = clone("tvs-iqube-3-5kwh-in");
    b.battery.usableCapacity = { v: 3.9, u: "kWh", src: "tvs-iqube-3-5", conf: 0.8 };
    b.motor.ratedPower.v = 5;
    const r = V(b);
    assert.ok(has(r, "impossible", "battery.usableCapacity") && has(r, "impossible", "motor.ratedPower"));
});
test("rejects a hub motor with a reduction other than 1", () => {
    const b = clone("tvs-iqube-3-5kwh-in"); b.transmission.reductionRatio.v = 7.8;
    assert.ok(has(V(b), "inconsistent", "transmission.reductionRatio"));
});

// ---- fuel safety ----
test("rejects a petrol vehicle that is approved for no fuel at all", () => {
    const b = clone(RE); b.fuel.compat = b.fuel.compat.map((c) => ({ ...c, status: "not_approved" }));
    assert.ok(has(V(b), "no_fuel", "fuel.compat"));
    const c = clone(RE); c.fuel.compat = [];
    assert.ok(has(V(c), "no_fuel", "fuel.compat"));
    const d = clone(RE); delete d.fuel.compat;
    assert.ok(has(V(d), "required", "fuel.compat"));
});
test("rejects E85/E100 approval for an engine not certified as flex-fuel", () => {
    const b = clone(RE); b.fuel.compat.push({ fuel: "E85", status: "certified", src: "re-classic-site", conf: 0.9 });
    assert.ok(has(V(b), "fuel_safety", "fuel.compat"));
});
test("allows E85 approval when the engine IS certified flex-fuel", () => {
    const b = clone(RE);
    b.engine.flexFuel = { v: true, src: "re-classic-site", conf: 0.9 };
    b.fuel.compat.push({ fuel: "E85", status: "certified", src: "re-classic-site", conf: 0.9 });
    assert.deepEqual(V(b).errors, []);
});
test("a 'compatible' blend derived from a certification may only go DOWN in ethanol", () => {
    const b = clone("royal-enfield-hunter-350-metro-in");
    b.fuel.compat = [{ fuel: "E10", status: "certified", src: "re-hunter-om-2022", conf: 0.85 }, { fuel: "E20", status: "compatible", src: "lower-blend-rule", conf: 0.8 }];
    b.sources.push({ id: "lower-blend-rule", kind: "derived", title: "Lower blends", retrieved: "2026-10-02", note: "lower-ethanol blends of a certified fuel" });
    assert.ok(has(V(b), "fuel_safety", "fuel.compat[1]"));
});
test("a real vehicle's fuel approval can't rest on an estimate", () => {
    const b = clone(RE);
    b.sources.push({ id: "my-guess", kind: "estimated", title: "A guess", retrieved: "2026-10-02", note: "most bikes take E20 these days" });
    b.fuel.compat[0] = { fuel: "E20", status: "certified", src: "my-guess", conf: 0.5 };
    assert.ok(has(V(b), "fuel_safety", "fuel.compat[0]"));
});
test("rejects an unknown fuel code and a duplicate fuel", () => {
    const b = clone(RE); b.fuel.compat.push({ fuel: "E30", status: "certified", src: "re-classic-site", conf: 0.9 }, { ...b.fuel.compat[0] });
    const r = V(b);
    assert.ok(has(r, "unknown_fuel") && has(r, "duplicate"));
});

// ---- powertrain consistency ----
test("rejects fuel, engine and emission blocks on an electric vehicle", () => {
    const b = clone(EV);
    b.fuel = { compat: [{ fuel: "E20", status: "certified", src: "ather-450x-site", conf: 0.8 }] };
    b.engine = clone(RE).engine;
    const r = V(b);
    assert.ok(has(r, "not_applicable", "fuel") && has(r, "not_applicable", "engine"));
});
test("rejects a motor and battery on a petrol bike", () => {
    const b = clone(RE); b.motor = clone(EV).motor;
    assert.ok(has(V(b), "not_applicable", "motor"));
});
test("rejects a transmission that doesn't match the powertrain", () => {
    const b = clone("tvs-jupiter-110-disc-sxc-in"); b.transmission.kind.v = "manual";
    assert.ok(has(V(b), "powertrain", "transmission.kind"));
});
test("rejects an unsupported class (CVT cruiser) and a classKey that doesn't match", () => {
    const b = clone("tvs-jupiter-110-disc-sxc-in"); b.segment = "cruiser";
    const r = V(b);
    assert.ok(has(r, "invalid_class", "segment") && has(r, "mismatch", "classKey"));
});
test("rejects missing required fields per powertrain", () => {
    const b = clone(EV); delete b.battery.grossCapacity; delete b.motor.peakPower;
    const r = V(b);
    assert.ok(has(r, "required", "battery.grossCapacity") && has(r, "required", "motor.peakPower"));
});

// ---- strictness ----
test("rejects typos in field names instead of silently ignoring them", () => {
    const b = clone(RE); b.engine.displacment = b.engine.displacement; delete b.engine.displacement;
    const r = V(b);
    assert.ok(has(r, "unknown_key", "engine.displacment") && has(r, "required", "engine.displacement"));
});
test("rejects an unsupported schema major version", () => {
    const b = clone(RE); b.schemaVersion = "2.0.0";
    assert.ok(has(V(b), "unsupported", "schemaVersion"));
});
test("rejects an unknown emission code", () => {
    const b = clone(RE); b.emission.standard.v = "BS7";
    assert.ok(has(V(b), "unknown_standard", "emission.standard"));
});

// ---- priors ----
test("class defaults must carry the full prior set; sigma must be > 0 and < mean", () => {
    const d = clone("default-ice-manual-commuter"); delete d.priors.cda;
    assert.ok(has(V(d), "required", "priors.cda"));
    const e = clone("default-ice-manual-commuter"); e.priors.crr.sigma = 0;
    assert.ok(has(V(e), "range", "priors.crr.sigma"));
    const f = clone("default-ice-manual-commuter"); f.priors.cda.sigma = 0.9;
    assert.ok(has(V(f), "range", "priors.cda.sigma"));
});
test("a class default's id must follow the default-<powertrain>-<segment> pattern", () => {
    const d = clone("default-ev-scooter"); d.id = "generic-ev";
    assert.ok(has(V(d), "default_id", "id"));
});

// ---- curves ----
test("accepts a consistent quantised torque curve and rejects one whose peak contradicts the spec", () => {
    const b = clone(RE);
    // 1000–6000 rpm every 500, peak 27.0 N*m at 4000 rpm, scale 0.1 N*m
    b.curves = { torque: { rpmStart: 1000, rpmStep: 500, scale: 0.1, u: "N*m", method: "digitized_dyno", src: "re-classic-site", conf: 0.6,
        data: [190, 215, 235, 250, 260, 266, 269, 270, 266, 258, 245] } };
    assert.deepEqual(V(b).errors, []);
    b.curves.torque.data = b.curves.torque.data.map((x) => x + 40);
    assert.ok(has(V(b), "inconsistent", "curves.torque"));
});

// ---- warnings ----
test("warns (doesn't fail) on a dry-mass figure and on an implausible top speed", () => {
    const b = clone("tvs-apache-rtr-160-4v-dual-abs-usd-in");
    b.chassis.mass.basis = "dry"; b.chassis.topSpeed.v = 190;
    const r = V(b);
    assert.equal(r.ok, true, JSON.stringify(r.errors));
    assert.ok(hasWarn(r, "dry_mass") && hasWarn(r, "inconsistent"));
});
test("the published top speed and gearing agree for the bikes that publish both", () => {
    for (const id of ["tvs-apache-rtr-160-4v-dual-abs-usd-in", "tvs-raider-125-split-seat-in", "tvs-jupiter-110-disc-sxc-in"]) {
        const r = V(clone(id));
        assert.ok(!hasWarn(r, "inconsistent"), `${id}: ${JSON.stringify(r.warnings)}`);
    }
});
test("parseTyre handles metric, radial, ZR and inch sizes, and rejects junk", () => {
    assert.ok(Math.abs(Contract.parseTyre("120/80-18 62P").diameterM - 0.6492) < 1e-6);
    assert.equal(Contract.parseTyre("140/70R-17 M/C 66H").rimIn, 17);
    assert.equal(Contract.parseTyre("110/70ZR17 M/C 54W").widthMm, 110);
    assert.equal(Contract.parseTyre("2.75-18").rimIn, 18);
    assert.equal(Contract.parseTyre("abc"), null);
    assert.equal(Contract.parseTyre("999/1-3"), null);
});
test("non-object input is rejected cleanly", () => {
    for (const x of [null, 42, "bike", []]) assert.equal(Contract.validateBundle(x, ref).ok, false);
    assert.ok(codes(Contract.validateBundle({}, ref)).includes("required"));
});

// ---- fuel safety: a variant needs a real manufacturer certification ----
test("rejects a variant whose only approvals are 'compatible' entries (no_certified_fuel)", () => {
    const b = clone(RE);
    b.fuel.compat = b.fuel.compat.map((c) => ({ ...c, status: "compatible" }));
    assert.ok(has(V(b), "no_certified_fuel", "fuel.compat"));
});
test("rejects a certification that rests only on press or an aggregator", () => {
    const b = clone(RE);
    b.sources.push({ id: "some-news", kind: "press", title: "News report", url: "https://example.com/news", retrieved: "2026-10-03" });
    b.fuel.compat[0] = { fuel: "E20", status: "certified", src: "some-news", conf: 0.8 };
    assert.ok(has(V(b), "no_certified_fuel", "fuel.compat"));
});
test("rejects a manufacturer certification below confidence 0.5 (e.g. another market's manual)", () => {
    const b = clone(RE);
    b.fuel.compat[0].conf = 0.4;
    assert.ok(has(V(b), "no_certified_fuel", "fuel.compat"));
    b.fuel.compat[0].conf = 0.5;
    assert.ok(!has(V(b), "no_certified_fuel"), "0.5 is enough to be in the catalogue");
});
test("warns (doesn't reject) when a certification exists but none is strong enough to advise", () => {
    const b = clone(RE);
    b.fuel.compat[0].conf = 0.6;
    const r = V(b);
    assert.equal(r.ok, true);
    assert.ok(hasWarn(r, "no_advisable_fuel", "fuel.compat"));
});
test("a class default can never be 'certified' for a fuel", () => {
    const d = clone("default-ice-manual-commuter");
    d.fuel.compat[0].status = "certified";
    assert.ok(has(V(d), "fuel_safety", "fuel.compat[0].status"));
});
