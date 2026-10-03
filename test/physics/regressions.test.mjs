// Regression tests for the findings of the independent review (one test per finding).
import { test } from "node:test";
import assert from "node:assert/strict";
import { Physics, bundleById, classDefaultOf, handBike, KMH } from "./helpers.mjs";

const make = (id, settings) => { const b = structuredClone(bundleById.get(id)); return Physics.createBikeModel(b, { classDefault: classDefaultOf(b), settings }); };

test("a slipping CVT clutch passes torque, so the engine supplies clutch torque × its own speed", () => {
    const m = make("honda-activa-110-dlx-obd2b-in");
    const P = Physics.cruise.meanParams(m);
    const r = m.unloadedRadius * (1 - P.deflection);
    const c = m.drive.cvt;
    const op = Physics.operatingPoint(m, 0.5, { rho: 1.2, grade: 0.4 });
    assert.equal(op.clutchSlipping, true);
    // T_clutch = F·r / (ratioMax·final·η_dt); engine power = T_clutch × ω_engage
    const expected = (op.wheelForce * r) / (c.ratioMax * c.final * P.etaDt) * c.omegaEngage;
    assert.ok(Math.abs(/** @type {number} */ (op.enginePower) - expected) < 1e-9 * expected, `${op.enginePower} vs ${expected}`);
    // overloaded: infeasible at every crawl speed, and the bike can't move off
    const loaded = make("honda-activa-110-dlx-obd2b-in", { pillionMass: 80, luggageMass: 20 });
    for (const v of [0.2, 0.5, 1, 2.5]) assert.equal(Physics.operatingPoint(loaded, v, { rho: 1.2, grade: 0.4 }).reason, "power", `v = ${v}`);
    assert.equal(Physics.maxSpeed(loaded, { rho: 1.2, grade: 0.4 }), 0);
});

test("overrun is when indicated power ≤ 0: fuel is continuous through zero wheel power, and cut only beyond it", () => {
    for (const fuelSystem of ["fi", "carb"]) {
        const m = Physics.createBikeModel(handBike({ fuelSystem }));
        let prev = null, maxJump = 0, cutSeen = false;
        for (let g = -0.04; g >= -0.2; g -= 0.0005) {
            const op = Physics.operatingPoint(m, 20, { rho: 1.2, grade: g }, { gear: 4 });
            const f = /** @type {number} */ (op.fuelRate);
            if (prev !== null) maxJump = Math.max(maxJump, Math.abs(f - prev));
            prev = f;
            if (op.fuelCut) { cutSeen = true; assert.equal(op.overrun, true); assert.equal(f, 0); }
            if (op.wheelPower < 0 && !op.overrun) assert.ok(f > 0, `throttle still open at grade ${g.toFixed(4)}`);
        }
        const flat = /** @type {number} */ (Physics.operatingPoint(m, 20, { rho: 1.2 }, { gear: 4 }).fuelRate);
        assert.ok(maxJump < 0.01 * flat, `${fuelSystem}: jump ${maxJump} vs flat ${flat}`);
        assert.equal(cutSeen, fuelSystem === "fi");
    }
});

test("rider sprockets: refused on a CVT and a hub motor; scale only the chain stage on an EV", () => {
    assert.throws(() => make("honda-activa-110-dlx-obd2b-in", { frontSprocket: 14, rearSprocket: 40 }), /no sprockets/);
    assert.throws(() => make("tvs-iqube-3-5kwh-in", { frontSprocket: 14, rearSprocket: 40 }), /hub motor/);
    assert.throws(() => make("ather-450x-2-9kwh-2025-in", { frontSprocket: 14, rearSprocket: 40 }), /stock sprockets unknown/);
    const f77 = make("ultraviolette-f77-mach2-recon-in", { frontSprocket: 14, rearSprocket: 56 });
    assert.equal(f77.drive.evRatio, 4);
    assert.ok(f77.flags.some((f) => /whole motor-to-wheel reduction/.test(f)));
});

test("an EV torque published at the wheel isn't reduced again by the drivetrain efficiency", () => {
    const m = make("tvs-iqube-3-5kwh-in");
    const r = 0.2;
    assert.equal(Physics.powertrain.motorForceMax(m.motor, 1, r, 0.9), 140 / r);
    const ather = make("ather-450x-2-9kwh-2025-in");                         // motor torque × ratio: the loss applies
    assert.ok(Math.abs(Physics.powertrain.motorForceMax(ather.motor, 1, r, 0.9) - (26 * 7.8 * 0.9) / r) < 1e-9);
});

test("shift points say when no shift point was found before the redline", () => {
    const sp = /** @type {NonNullable<ReturnType<typeof Physics.shiftPoints>>} */ (Physics.shiftPoints(make("royal-enfield-hunter-350-metro-in")));
    for (const s of [...sp.ecoUp, ...sp.perfUp, ...sp.ecoDown]) assert.equal(typeof s.atRedline, "boolean");
    const steep = /** @type {NonNullable<ReturnType<typeof Physics.shiftPoints>>} */ (Physics.shiftPoints(make("royal-enfield-hunter-350-metro-in"), { grade: 0.3 }));
    assert.ok(steep.ecoUp.some((s) => s.atRedline), "on a 30 % climb some gears can't take over before the redline");
});

test("a CVT engine above its top speed is an over-rev, not a power shortfall", () => {
    const op = Physics.operatingPoint(make("honda-activa-110-dlx-obd2b-in"), 200 * KMH, { rho: 1.2, grade: -0.5 });
    assert.equal(op.reason, "over-rev");
    assert.equal(op.feasible, false);
});

test("a prior in the wrong unit is refused", () => {
    const b = structuredClone(bundleById.get("royal-enfield-hunter-350-metro-in"));
    b.priors.fmepB = { ...b.priors.fmepB, u: "kPa/krpm" };
    assert.throws(() => Physics.createBikeModel(b), /prior fmepB must be in Pa\*s\/rad/);
});
