// Missing data is never invented, gear advice is only given on trustworthy gearing,
// published curves win over synthesized ones, and the ±1σ band says which prior drives it.
import { test } from "node:test";
import assert from "node:assert/strict";
import { Physics, bundleById, classDefaultOf, handBike, models, prng, between, RPM, KMH } from "./helpers.mjs";

const B = (id) => structuredClone(bundleById.get(id));
const cdOf = (b) => structuredClone(classDefaultOf(b));

// ---------------------------------------------------------------------------
// Missing data: bike → class default → error. Never a guessed number.
// ---------------------------------------------------------------------------
test("idle speed: bike, else class default (flagged), else an error — never a fraction of the power peak", () => {
    const h = handBike();
    delete h.engine.idleRpm;
    assert.throws(() => Physics.createBikeModel(h), /no idle speed published.*never guessed/);
    const cd = handBike({ kind: "class_default" });
    cd.engine.idleRpm.v = 120;
    const m = Physics.createBikeModel(h, { classDefault: cd });
    assert.equal(m.engine.omegaIdle, 120);
    assert.ok(m.flags.includes("idle speed from the class default"));
    delete cd.engine.idleRpm;
    assert.throws(() => Physics.createBikeModel(h, { classDefault: cd }), /no idle speed published/);
    // every catalogue bike without its own idle speed resolves through its class default
    for (const id of ["honda-hness-cb350-dlx-in", "yamaha-mt-15-v2-in"]) {
        const b = B(id);
        assert.equal(b.engine.idleRpm, undefined);
        const mm = Physics.createBikeModel(b, { classDefault: cdOf(b) });
        assert.equal(mm.engine.omegaIdle, classDefaultOf(b).engine.idleRpm.v);
    }
});

test("dry mass: the tank comes from the bike or the class default, never an assumed 10 litres", () => {
    const h = handBike();
    h.chassis.mass.basis = "dry";
    const own = Physics.createBikeModel(h);
    assert.ok(own.vehicleMass > 100, "fuel and fluids added to the dry mass");
    delete h.chassis.fuelTank;
    assert.throws(() => Physics.createBikeModel(h), /mass is dry and no tank capacity is known/);
    const cd = handBike({ kind: "class_default" });
    cd.chassis.fuelTank.v = 0.012;
    const fromCd = Physics.createBikeModel(h, { classDefault: cd });
    assert.ok(fromCd.vehicleMass > own.vehicleMass, "the class default's bigger tank adds more fuel");
});

test("fuel: exactly the grade asked for, or an error — never silently another grade", () => {
    const h = handBike();
    assert.equal(Physics.createBikeModel(h).fuel.code, Physics.model.MODEL_DEFAULTS.defaultFuel);
    assert.equal(Physics.createBikeModel(h, { settings: { fuelCode: "E10" } }).fuel.code, "E10");
    assert.throws(() => Physics.createBikeModel(h, { settings: { fuelCode: "E85" } }), /fuel E85 is not in the bundle's fuel-grade table/);
    // the default grade missing from the table is an error too (the old code fell back to E10 / the first grade)
    h.reference.fuelGrades.grades = h.reference.fuelGrades.grades.filter((g) => g.code !== Physics.model.MODEL_DEFAULTS.defaultFuel);
    assert.throws(() => Physics.createBikeModel(h), /is not in the bundle's fuel-grade table/);
    h.reference.fuelGrades.grades = [];
    assert.throws(() => Physics.createBikeModel(h, { settings: { fuelCode: "E10" } }), /fuel E10 is not in the bundle's fuel-grade table/);
});

test("no catalogue model carries an invented number: every fallback is named in its flags", () => {
    for (const m of models) {
        for (const f of m.flags) assert.doesNotMatch(f, /estimated|guess/i, `${m.id}: ${f}`);
        assert.ok(Number.isFinite(m.vehicleMass) && m.vehicleMass > 0, m.id);
    }
});

// ---------------------------------------------------------------------------
// Gear advice
// ---------------------------------------------------------------------------
test("gear advice: own, complete, consistent and trustworthy gearing only", () => {
    assert.equal(Physics.createBikeModel(handBike()).gearAdvice, true);

    const wrongCount = handBike();
    wrongCount.transmission.speeds.v = 6;
    const a = Physics.createBikeModel(wrongCount);
    assert.equal(a.gearAdvice, false);
    assert.ok(a.flags.some((f) => /5 gear ratios for a 6-speed gearbox/.test(f)));

    const shaky = handBike();
    shaky.transmission.gearRatios.conf = 0.4;
    const b = Physics.createBikeModel(shaky);
    assert.equal(b.gearAdvice, false);
    assert.ok(b.flags.some((f) => /too uncertain for gear advice \(confidence 0\.4\)/.test(f)));

    // the final drive's confidence comes from wherever the final drive comes from
    const sprockets = handBike();
    delete sprockets.transmission.finalRatio;
    sprockets.transmission.frontSprocket = { v: 15, u: "1", src: "hand", conf: 0.3 };
    sprockets.transmission.rearSprocket = { v: 45, u: "1", src: "hand", conf: 0.9 };
    assert.equal(Physics.createBikeModel(sprockets).gearAdvice, false, "a shaky published sprocket");
    assert.equal(Physics.createBikeModel(sprockets, { settings: { frontSprocket: 15, rearSprocket: 45 } }).gearAdvice, true, "the rider's own sprockets are exact");

    const cd = Physics.createBikeModel(handBike({ kind: "class_default" }));
    assert.equal(cd.gearAdvice, false, "a class default describes a typical bike, not this one");
});

test("gear advice in the catalogue: never for class defaults, CVTs, EVs or borrowed gearing", () => {
    for (const m of models) {
        if (m.kind === "class_default" || m.powertrain !== "ice_manual" || m.drive.source !== "bike") assert.equal(m.gearAdvice, false, m.id);
        if (m.gearAdvice) {
            const sp = Physics.shiftPoints(m);
            assert.equal(sp.advisory, true, m.id);
            assert.equal(Physics.cruiseTable(m, {}, { sigma: false }).gearAdvice, true, m.id);
        }
    }
    assert.ok(models.some((m) => m.gearAdvice), "some real bikes do get gear advice");
});

// ---------------------------------------------------------------------------
// Published curves
// ---------------------------------------------------------------------------
/** Runtime (SI) curve as catalog-build emits it. */
const curve = (u, values, method = "manufacturer", omegaStart = 100, omegaStep = 50) =>
    ({ omegaStart, omegaStep, scale: 0.01, u, data: values.map((x) => Math.round(x / 0.01)), method, src: "hand", conf: 0.8 });

test("a published torque curve replaces the synthesized one: exact at the samples, linear between, held at the ends", () => {
    const h = handBike();
    const T = [10, 12, 13.5, 14.5, 15, 15, 14.8, 14.2, 13.6, 13, 12.5, 12, 11.4, 10.8, 10, 9];   // 100 … 850 rad/s
    h.curves = { torque: curve("N*m", T) };
    const m = Physics.createBikeModel(h);
    const k = m.engine.curve;
    assert.equal(k.shape, "published");
    assert.ok(m.flags.includes("torque curve as published (manufacturer)"));
    T.forEach((t, i) => assert.ok(Math.abs(Physics.torqueAt(k, 100 + 50 * i) - t) < 1e-9, `sample ${i}`));
    assert.ok(Math.abs(Physics.torqueAt(k, 125) - 11) < 1e-9, "linear between samples");
    assert.equal(Physics.torqueAt(k, k.omegaMax), 9, "last sample held to the redline");
    assert.equal(Physics.torqueAt(k, k.omegaMax * 1.01), 0, "nothing beyond the redline");
    assert.equal(Physics.torqueAt(k, 99), 0, "nothing below idle");
    // the whole chain uses it: wide-open power at 500 rad/s is 15 N·m × 500 rad/s
    const synth = Physics.createBikeModel(handBike());
    assert.notEqual(Physics.torqueAt(synth.engine.curve, 300), Physics.torqueAt(k, 300));
});

test("a published power curve becomes torque exactly (T = P/ω); synthesized curves and wrong units are not used", () => {
    const h = handBike();
    const P = [500, 1500, 3000, 4500, 6000, 7200, 8200, 9000, 9600, 10000, 9800, 9400];        // W at 100 … 650 rad/s
    h.curves = { power: curve("W", P) };
    const m = Physics.createBikeModel(h);
    P.forEach((p, i) => assert.ok(Math.abs(Physics.torqueAt(m.engine.curve, 100 + 50 * i) - p / (100 + 50 * i)) < 1e-6));
    assert.ok(m.flags.some((f) => /torque from the published power curve/.test(f)));

    const atZero = handBike();
    atZero.curves = { power: curve("W", P, "manufacturer", 0) };
    assert.throws(() => Physics.createBikeModel(atZero), /T = P\/ω|torque = P\/ω is undefined/);

    const synth = handBike();
    synth.curves = { torque: curve("N*m", [1, 2, 3, 4], "synthesized") };
    assert.notEqual(Physics.createBikeModel(synth).engine.curve.shape, "published");

    const kw = handBike();
    kw.curves = { torque: { ...curve("N*m", [10, 12, 14, 15]), u: "kgf*m" } };
    assert.throws(() => Physics.createBikeModel(kw), /curves\.torque must be in N\*m/);

    const neg = handBike();
    neg.curves = { torque: curve("N*m", [10, -1, 14, 15]) };
    assert.throws(() => Physics.createBikeModel(neg), /samples\.values\[1\]/);
});

// ---------------------------------------------------------------------------
// Energy balance and σ contributions
// ---------------------------------------------------------------------------
test("EV regeneration never returns more than the wheel gives up, nor more than the regen limit", () => {
    const rnd = prng(77);
    for (const m of models.filter((x) => x.powertrain === "ev")) {
        for (let i = 0; i < 400; i++) {
            const v = between(rnd, 1, 25), grade = between(rnd, -0.3, 0);
            const op = Physics.operatingPoint(m, v, { grade, accel: between(rnd, -2, 0) });
            const pb = /** @type {number} */ (op.batteryPower);
            if (op.wheelPower < 0) {
                assert.ok(-pb <= -op.wheelPower + 1e-6, `${m.id}: regen ${-pb} W from ${-op.wheelPower} W at the wheel`);
                assert.ok(-pb <= /** @type {any} */ (m.motor).regenLimit + 1e-6, `${m.id}: above the regen limit`);
            }
        }
    }
});

test("σ contributions: one per uncertain prior, largest first, and in quadrature they rebuild the band", () => {
    for (const m of models) {
        const t = Physics.cruiseTable(m);
        const names = (m.powertrain === "ev" ? Physics.cruise.EV_SIGMA_PARAMS : Physics.cruise.ICE_SIGMA_PARAMS).filter((k) => m.params[k] && m.params[k].sigma > 0);
        assert.deepEqual(t.contributions.map((c) => c.param).sort(), [...names].sort(), m.id);
        for (let i = 1; i < t.contributions.length; i++) assert.ok(t.contributions[i - 1].relative >= t.contributions[i].relative, m.id);
        for (const c of t.contributions) assert.ok(Number.isFinite(c.relative) && c.relative >= 0, `${m.id} ${c.param}`);
        // Σ relative² = mean over feasible rows of (σ/f)², the same σ as perMetreHi − perMetre
        let sum = 0, rows = 0;
        for (let i = 0; i < t.speed.length; i++) {
            const f = t.perMetre[i];
            if (!t.feasible[i] || !(f > 0) || !Number.isFinite(f)) continue;
            const s = (t.perMetreHi[i] - f) / f;
            sum += s * s; rows++;
        }
        const total = t.contributions.reduce((a, c) => a + c.relative * c.relative, 0);
        assert.ok(Math.abs(total - sum / rows) <= 1e-9 * Math.max(1, total), `${m.id}: ${total} vs ${sum / rows}`);
    }
    assert.deepEqual(Physics.cruiseTable(models[0], {}, { sigma: false }).contributions, [], "no σ, no contributions");
});

test("the band's drivers follow the physics: friction dominates near idle, drag's share grows with speed", () => {
    const m = /** @type {any} */ (models.find((x) => x.id === "royal-enfield-hunter-350-metro-in"));
    /** @param {number} lo @param {number} hi km/h */
    const share = (lo, hi) => Object.fromEntries(Physics.cruiseTable(m, {}, { vMin: lo * KMH, vMax: hi * KMH }).contributions.map((c) => [c.param, c.relative]));
    const slow = share(15, 25), mid = share(40, 50), fast = share(90, 110);
    assert.equal(Object.entries(slow).sort((x, y) => y[1] - x[1])[0][0], "fmepA", "near idle the friction intercept matters most");
    assert.ok(slow.cda < mid.cda && mid.cda < fast.cda, "drag's share grows with speed");
    assert.ok(slow.fmepA > mid.fmepA && mid.fmepA > fast.fmepA, "idle friction's share shrinks with load");
    // fuel ∝ 1/η_ind at any speed: its share is the central difference of 1/η, σ·η/(η² − σ²), everywhere
    const { mean: e, sigma: se } = m.params.etaInd, exact = (se * e) / (e * e - se * se);
    for (const s of [slow, mid, fast]) assert.ok(Math.abs(s.etaInd - exact) < 1e-9, `${s.etaInd} vs ${exact}`);
});

test("deterministic: the same bike and conditions give bit-identical tables", () => {
    for (const m of models.slice(0, 8)) {
        const env = { altitude: 900, temperature: 303.15, relativeHumidity: 0.6, grade: 0.03, wind: 2 };
        const a = Physics.cruiseTable(m, env), b = Physics.cruiseTable(structuredClone(m), env);
        assert.deepEqual(a, b, m.id);
    }
    assert.ok(RPM > 0);
});

// ---------------------------------------------------------------------------
// Gaps the mutation check (npm run physics:mutation) found in the combined suite
// ---------------------------------------------------------------------------
test("the allocation-free hot path equals the reference road load, slopes and wind included (10,000 random cases)", () => {
    const rnd = prng(2024);
    for (let i = 0; i < 10000; i++) {
        const s = { mass: between(rnd, 80, 450), v: rnd() < 0.05 ? 0 : between(rnd, 0, 45), grade: between(rnd, -1.5, 1.5), cda: between(rnd, 0.2, 0.9),
            crr: between(rnd, 0.008, 0.03), rho: between(rnd, 0.7, 1.3), wind: between(rnd, -15, 15), accel: between(rnd, -3, 3) };
        const ref = Physics.roadLoad(s);
        const { sin, cos } = Physics.roadload.slope(s.grade);
        const hot = Physics.roadload.tractiveForce(s.mass, s.v, sin, cos, s.cda, s.crr, s.rho, s.wind, Physics.roadload.ROAD_DEFAULTS.rotatingMassFactor * s.mass * s.accel);
        assert.ok(Math.abs(hot - ref.total) <= 1e-9 * Math.max(1, Math.abs(ref.total)), `case ${i}: ${hot} vs ${ref.total}`);
    }
});

test("on overrun the drivetrain loss is on the engine's side: the crank absorbs wheel power × η_dt, not ÷", () => {
    const m = Physics.createBikeModel(handBike());
    for (const grade of [-0.12, -0.18, -0.25]) {
        const op = Physics.operatingPoint(m, 72 * KMH, { grade }, { gear: 5 });
        assert.ok(op.wheelPower < 0, `grade ${grade}`);
        assert.ok(Math.abs(/** @type {number} */ (op.enginePower) - op.wheelPower * 0.9) < 1e-9, `grade ${grade}: ${op.enginePower} vs ${op.wheelPower * 0.9}`);
    }
    const climb = Physics.operatingPoint(m, 72 * KMH, { grade: 0.03 }, { gear: 5 });
    assert.ok(Math.abs(/** @type {number} */ (climb.enginePower) - climb.wheelPower / 0.9) < 1e-9, "driving: the engine supplies the loss");
});

// ---------------------------------------------------------------------------
// Gear advice is refused, not just flagged (so no UI can show it by mistake)
// ---------------------------------------------------------------------------
test("shiftPoints refuses advice for typical or borrowed gearing: no shift speeds, and the reason why", () => {
    for (const m of models) {
        const sp = Physics.shiftPoints(m);
        if (m.drive.kind !== "manual") {
            assert.equal(sp, null, m.id);
            assert.equal(m.gearAdvice, false);
            assert.equal(m.gearAdviceReason, m.powertrain === "ev" ? "single-speed" : "cvt", m.id);
            continue;
        }
        const s = /** @type {NonNullable<typeof sp>} */ (sp);
        assert.equal(s.advisory, m.gearAdvice, m.id);
        assert.equal(s.reason, m.gearAdviceReason, m.id);
        if (m.gearAdvice) {
            assert.equal(m.gearAdviceReason, null, m.id);
            assert.equal(s.ecoUp.length, m.drive.ratios.length - 1, m.id);
        } else {
            assert.deepEqual([s.ecoUp, s.perfUp, s.ecoDown], [[], [], []], `${m.id}: no shift speeds to show`);
            assert.equal(m.gearAdviceReason, m.kind === "class_default" ? "typical-bike" : "borrowed-gearing", m.id);
            const diag = /** @type {NonNullable<typeof sp>} */ (Physics.shiftPoints(m, {}, { diagnostic: true }));
            assert.equal(diag.advisory, false, "diagnostic numbers are never advisory");
            assert.equal(diag.ecoUp.length, m.drive.ratios.length - 1);
        }
    }
    const count = handBike();
    count.transmission.speeds.v = 6;
    assert.equal(Physics.createBikeModel(count).gearAdviceReason, "gear-count-mismatch");
    const shaky = handBike();
    shaky.transmission.gearRatios.conf = 0.4;
    const sm = Physics.createBikeModel(shaky);
    assert.equal(sm.gearAdviceReason, "uncertain-gearing");
    assert.deepEqual(/** @type {any} */ (Physics.shiftPoints(sm)).ecoUp, []);
    assert.equal(Physics.createBikeModel(handBike()).gearAdviceReason, null);
    assert.equal(Physics.createBikeModel(handBike({ kind: "class_default" })).gearAdviceReason, "typical-bike");
});
