// Property tests: invariants that must hold for every bike in the catalogue and
// thousands of seeded random conditions (same numbers on every run).
import { test } from "node:test";
import assert from "node:assert/strict";
import { Physics, models, handBike, prng, between, numbersIn, RPM } from "./helpers.mjs";

const { powertrain, atmosphere } = Physics;
const ice = models.filter((m) => m.powertrain !== "ev");
const ev = models.filter((m) => m.powertrain === "ev");
const fi = ice.filter((m) => m.engine && m.engine.fuelInjected);
const randomEnv = (rnd) => ({ altitude: between(rnd, -100, 4500), temperature: between(rnd, 263, 323), relativeHumidity: rnd(), wind: between(rnd, -12, 12) });
const allFinite = (x) => numbersIn(x).every((n) => Number.isFinite(n));

// ---------------------------------------------------------------------------
// Torque curve
// ---------------------------------------------------------------------------
test("torque curve: peaks exact, never above either peak, zero outside its range (5,000 random engines)", () => {
    const rnd = prng(1);
    for (let i = 0; i < 5000; i++) {
        const wT = between(rnd, 150, 1000);
        const wP = wT * between(rnd, 1, 1.8);
        const Tp = between(rnd, 3, 150);
        // torque at the power peak, from peaky to flat, but consistent: T̂·ω_T ≤ P̂ ≤ T̂·ω_P
        const TP = Tp * between(rnd, Math.max(0.25, wT / wP), 1);
        const k = powertrain.buildTorqueCurve({ peakPower: TP * wP, omegaPower: wP, peakTorque: Tp, omegaTorque: wT, omegaIdle: wT * between(rnd, 0.1, 0.6), omegaMax: wP * between(rnd, 1, 1.3) });
        assert.ok(Math.abs(powertrain.torqueAt(k, k.omegaTorque) - k.peakTorque) <= 1e-9 * k.peakTorque, `T(ω_T) case ${i}`);
        assert.ok(Math.abs(powertrain.powerAt(k, k.omegaPower) - k.peakPower) <= 1e-9 * k.peakPower, `P(ω_P) case ${i}`);
        let prevT = powertrain.torqueAt(k, k.omegaIdle);
        for (let j = 0; j <= 400; j++) {
            const w = j === 400 ? k.omegaMax : k.omegaIdle + ((k.omegaMax - k.omegaIdle) * j) / 400;
            const T = powertrain.torqueAt(k, w);
            assert.ok(Number.isFinite(T) && T >= 0, `finite, ≥ 0 (case ${i})`);
            assert.ok(T <= k.peakTorque * (1 + 1e-12), `T ≤ T̂ (case ${i}, shape ${k.shape})`);
            assert.ok(T * w <= k.peakPower * (1 + 1e-12), `P ≤ P̂ (case ${i}, shape ${k.shape}, κ ${k.kappa})`);
            assert.ok(Math.abs(T - prevT) <= 0.25 * k.peakTorque, `continuous (case ${i})`);
            prevT = T;
        }
        assert.equal(powertrain.torqueAt(k, k.omegaIdle * 0.99), 0);
        assert.equal(powertrain.torqueAt(k, k.omegaMax * 1.01), 0);
    }
});

test("torque curve: peaks that contradict each other still never exceed either peak (2,000 random cases)", () => {
    const rnd = prng(11);
    for (let i = 0; i < 2000; i++) {
        const wT = between(rnd, 150, 1000), wP = wT * between(rnd, 0.8, 1.8), Tp = between(rnd, 3, 150);
        const k = powertrain.buildTorqueCurve({ peakPower: Tp * wP * between(rnd, 0.2, 1.2), omegaPower: wP, peakTorque: Tp, omegaTorque: wT, omegaIdle: wT * between(rnd, 0.05, 1.2), omegaMax: wP * between(rnd, 0.8, 1.3) });
        for (let j = 0; j <= 200; j++) {
            const w = j === 200 ? k.omegaMax : k.omegaIdle + ((k.omegaMax - k.omegaIdle) * j) / 200, T = powertrain.torqueAt(k, w);
            assert.ok(Number.isFinite(T) && T >= 0 && T <= k.peakTorque * (1 + 1e-12) && T * w <= k.peakPower * (1 + 1e-12), `case ${i}: ${k.flags.join("; ")}`);
        }
    }
});

test("torque curve: inconsistent peaks are repaired and flagged, never NaN", () => {
    const k = powertrain.buildTorqueCurve({ peakPower: 20000, omegaPower: 600, peakTorque: 20, omegaTorque: 700, omegaIdle: 800, omegaMax: 500 });
    assert.ok(k.flags.length >= 3, k.flags.join("; "));
    assert.ok(allFinite(powertrain.sampleCurve(k, 50)));
    assert.throws(() => powertrain.buildTorqueCurve({ peakPower: NaN, omegaPower: 600, peakTorque: 20, omegaTorque: 400, omegaIdle: 100, omegaMax: 700 }), TypeError);
});

// ---------------------------------------------------------------------------
// Standstill and finiteness
// ---------------------------------------------------------------------------
test("standstill: no NaN or Infinity in an operating point, any bike, any weather, any slope", () => {
    const rnd = prng(2);
    for (const m of models) for (let i = 0; i < 40; i++) {
        const env = { ...randomEnv(rnd), grade: between(rnd, -1, 1) };
        const op = Physics.operatingPoint(m, 0, env);
        assert.ok(allFinite(op), `${m.id} ${JSON.stringify(env)} → ${JSON.stringify(op)}`);
        if (m.powertrain === "ev") {
            assert.equal(op.energyPerMetre, null);
            assert.ok(/** @type {number} */ (op.batteryPower) > 0, "auxiliary load only");
        } else {
            assert.equal(op.fuelPerMetre, null);
            assert.ok(/** @type {number} */ (op.fuelRate) > 0, `${m.id}: idling burns fuel`);
            assert.equal(op.omega, m.engine.omegaIdle);
        }
    }
});

test("cruise tables: no NaN anywhere; per-metre cost is +Infinity only at standstill", () => {
    const rnd = prng(3);
    for (const m of models) for (let i = 0; i < 5; i++) {
        const t = Physics.cruiseTable(m, { ...randomEnv(rnd), grade: between(rnd, -0.15, 0.15) });
        for (const k of ["speed", "omega", "wheelPower", "enginePower", "perMetre", "perMetreLo", "perMetreHi", "fuelRate", "range", "rangeLo", "rangeHi"]) {
            const arr = /** @type {any} */ (t)[k];
            if (!arr) continue;
            for (let j = 0; j < arr.length; j++) assert.ok(!Number.isNaN(arr[j]), `${m.id} ${k}[${j}] is NaN`);
        }
        assert.equal(t.perMetre[0], Infinity);
        for (let j = 1; j < t.speed.length; j++) assert.ok(Number.isFinite(t.perMetre[j]), `${m.id} perMetre[${j}]`);
    }
});

// ---------------------------------------------------------------------------
// Fuel
// ---------------------------------------------------------------------------
test("fuel is never negative (20,000 random states, including braking and steep descents)", () => {
    const rnd = prng(4);
    for (let i = 0; i < 20000; i++) {
        const m = ice[i % ice.length];
        const env = { ...randomEnv(rnd), grade: between(rnd, -2, 2), accel: between(rnd, -4, 3) };
        const op = Physics.operatingPoint(m, between(rnd, 0, 45), env);
        assert.ok(/** @type {number} */ (op.fuelRate) >= 0 && Number.isFinite(op.fuelRate), `${m.id} ${JSON.stringify(env)} fuel ${op.fuelRate}`);
        if (op.fuelPerMetre !== null) assert.ok(op.fuelPerMetre >= 0);
    }
});

test("descents cost no fuel on fuel-injected bikes (overrun fuel cut)", () => {
    const rnd = prng(5);
    let checked = 0;
    for (const m of fi) for (let i = 0; i < 60; i++) {
        const v = between(rnd, 8, 25), grade = -between(rnd, 0.12, 0.6);
        const op = Physics.operatingPoint(m, v, { altitude: 500, grade });
        if (!op.overrun || op.clutchSlipping) continue;   // engine braking not yet enough to shut the throttle at this speed
        assert.equal(op.fuelRate, 0, `${m.id} at ${v.toFixed(1)} m/s on ${(grade * 100).toFixed(0)} %`);
        assert.equal(op.fuelCut, true);
        checked++;
    }
    assert.ok(checked > fi.length * 30, `${checked} descents checked`);
});

test("carburettor bikes keep burning their idle feed downhill — less than on the flat, more than zero", () => {
    const m = Physics.createBikeModel(handBike({ fuelSystem: "carb" }));
    const down = Physics.operatingPoint(m, 15, { rho: 1.2, grade: -0.2 });
    const flat = Physics.operatingPoint(m, 15, { rho: 1.2 });
    assert.ok(down.wheelPower < 0);
    assert.ok(/** @type {number} */ (down.fuelRate) > 0 && /** @type {number} */ (down.fuelRate) < /** @type {number} */ (flat.fuelRate));
    assert.equal(down.fuelCut, false);
});

test("climbing costs more: fuel and battery energy per metre never fall as the road gets steeper", () => {
    const rnd = prng(6);
    for (const m of models) for (let i = 0; i < 25; i++) {
        const v = between(rnd, 6, 25), env = randomEnv(rnd);
        let prev = -Infinity;
        for (let g = -0.1; g <= 0.12 + 1e-9; g += 0.02) {
            const op = Physics.operatingPoint(m, v, { ...env, grade: g });
            if (!op.feasible) break;
            const c = /** @type {number} */ (m.powertrain === "ev" ? op.energyPerMetre : op.fuelPerMetre);
            assert.ok(c >= prev - 1e-15, `${m.id} v=${v.toFixed(1)} grade=${g.toFixed(2)}: ${c} < ${prev}`);
            prev = c;
        }
    }
});

test("more drag, more mass or a less efficient engine always costs more fuel", () => {
    for (const m of ice) {
        const P = Physics.cruise.meanParams(m);
        const base = /** @type {number} */ (Physics.operatingPoint(m, 15, { rho: 1.2 }, { params: P }).fuelRate);
        const worse = (k, f) => /** @type {number} */ (Physics.operatingPoint(m, 15, { rho: 1.2 }, { params: { ...P, [k]: P[k] * f } }).fuelRate);
        assert.ok(worse("cda", 1.2) > base, `${m.id} cda`);
        assert.ok(worse("crr", 1.2) > base, `${m.id} crr`);
        assert.ok(worse("riderMass", 1.3) > base, `${m.id} mass`);
        assert.ok(worse("etaInd", 0.9) > base, `${m.id} η_ind`);
        assert.ok(worse("etaDt", 0.95) > base, `${m.id} η_dt`);
    }
});

// ---------------------------------------------------------------------------
// Extreme gradients
// ---------------------------------------------------------------------------
test("extreme gradients: walls and cliffs give finite answers — climbs infeasible, descents free (FI) or regenerating (EV)", () => {
    for (const m of models) for (const grade of [1, -1, 10, -10, 1e6, -1e6, 1e300, -1e300]) {
        const op = Physics.operatingPoint(m, 10, { altitude: 0, grade });
        assert.ok(allFinite(op), `${m.id} grade ${grade}: ${JSON.stringify(op)}`);
        if (grade > 0) assert.equal(op.feasible, false, `${m.id} can't climb a ${grade * 100} % slope`);
        else if (m.powertrain === "ev") {
            assert.ok(/** @type {number} */ (op.batteryPower) < 0, `${m.id} regenerates downhill`);
            assert.ok(/** @type {number} */ (op.batteryPower) >= -m.motor.regenLimit + 0, `${m.id} regen within the motor's limit`);
        } else if (m.engine.fuelInjected) assert.equal(op.fuelRate, 0, `${m.id} fuel cut on a ${grade * 100} % descent`);
    }
    assert.throws(() => Physics.operatingPoint(models[0], 10, { grade: Infinity }), TypeError);
    assert.throws(() => Physics.operatingPoint(models[0], 10, { grade: NaN }), TypeError);
    assert.throws(() => Physics.operatingPoint(models[0], -1), RangeError);
});

test("a road too steep for the tyre is infeasible because of traction, before power", () => {
    const m = Physics.createBikeModel(handBike());
    // tyre limit: 0.8 × 0.6 × m g cos θ ⇒ grade where m g sin θ alone exceeds it: tan θ > 0.48
    assert.equal(Physics.operatingPoint(m, 2, { rho: 1.2, grade: 0.6 }, { gear: 1 }).reason, "traction");
});

// ---------------------------------------------------------------------------
// Gears
// ---------------------------------------------------------------------------
test("gear choice: the chosen gear is real, within the rev range, carries the load, and respects the lugging limit", () => {
    const rnd = prng(7);
    for (const m of ice.filter((x) => x.drive.kind === "manual")) for (let i = 0; i < 80; i++) {
        const v = between(rnd, 1, 40), env = { ...randomEnv(rnd), grade: between(rnd, -0.08, 0.12) };
        const op = Physics.operatingPoint(m, v, env);
        const g = /** @type {number} */ (op.gear);
        assert.ok(Number.isInteger(g) && g >= 1 && g <= m.drive.ratios.length);
        if (op.reason !== "over-rev") assert.ok(/** @type {number} */ (op.omega) <= m.engine.omegaMax * (1 + 1e-9), `${m.id} over-rev at ${v}`);
        if (op.feasible && op.wheelPower > 0) {
            assert.ok(/** @type {number} */ (op.enginePower) <= op.availablePower * (1 + 1e-9));
            if (op.reason === null && g > 1) assert.ok(/** @type {number} */ (op.omega) >= m.engine.omegaLug - 1e-9, `${m.id} lugging in gear ${g}`);
        }
        if (op.reason === "over-rev") {
            assert.equal(op.feasible, false);
            assert.equal(g, m.drive.ratios.length, "over-revving in every gear: reported in the tallest");
        }
        // no other advisable gear burns less
        if (op.feasible && op.reason === null && op.wheelPower > 0) {
            for (let other = 1; other <= m.drive.ratios.length; other++) {
                const o = Physics.operatingPoint(m, v, env, { gear: other });
                const advisable = o.feasible && !o.clutchSlipping && /** @type {number} */ (o.omega) >= m.engine.omegaLug && /** @type {number} */ (o.enginePower) <= 0.85 * o.availablePower;
                if (advisable) assert.ok(/** @type {number} */ (o.fuelRate) >= /** @type {number} */ (op.fuelRate) - 1e-15, `${m.id} gear ${other} beats chosen ${g}`);
            }
        }
    }
});

test("shift points: finite, in order, up-shifts below the redline and landing above the lugging limit", () => {
    for (const m of ice.filter((x) => x.drive.kind === "manual")) {
        const sp = /** @type {NonNullable<ReturnType<typeof Physics.shiftPoints>>} */ (Physics.shiftPoints(m, { altitude: 300 }, { diagnostic: true }));
        assert.ok(allFinite(sp.ecoUp) && allFinite(sp.perfUp) && allFinite(sp.ecoDown), m.id);
        assert.equal(sp.advisory, m.gearAdvice);
        assert.equal(sp.ecoUp.length, m.drive.ratios.length - 1, `${m.id}: diagnostic shift points are always computed`);
        for (let i = 0; i < sp.ecoUp.length; i++) {
            assert.ok(sp.ecoUp[i].omegaTo >= m.engine.omegaLug - 1e-9);
            assert.ok(sp.perfUp[i].omegaFrom <= m.engine.omegaMax * (1 + 1e-9));
            if (i > 0) assert.ok(sp.ecoUp[i].speed > sp.ecoUp[i - 1].speed && sp.perfUp[i].speed > sp.perfUp[i - 1].speed, `${m.id} order`);
        }
    }
    assert.equal(Physics.shiftPoints(ev[0]), null, "EVs get no gear advice");
    assert.equal(Physics.shiftPoints(/** @type {any} */ (ice.find((x) => x.drive.kind === "cvt"))), null, "nor do CVT scooters");
});

// ---------------------------------------------------------------------------
// ±1σ
// ---------------------------------------------------------------------------
test("±1σ: lo ≤ mean ≤ hi, petrol lo ≥ 0, and the band collapses when nothing is uncertain", () => {
    for (const m of models) {
        const t = Physics.cruiseTable(m, { altitude: 200 });
        for (let j = 1; j < t.speed.length; j++) {
            assert.ok(t.perMetreLo[j] <= t.perMetre[j] + 1e-18 && t.perMetre[j] <= t.perMetreHi[j] + 1e-18, `${m.id} row ${j}`);
            if (m.powertrain !== "ev") assert.ok(t.perMetreLo[j] >= 0);
            if (t.range && t.rangeLo && t.rangeHi && Number.isFinite(t.range[j])) assert.ok(t.rangeLo[j] <= t.range[j] && t.range[j] <= t.rangeHi[j]);
        }
        const exact = { ...m, params: Object.fromEntries(Object.entries(m.params).map(([k, u]) => [k, { mean: u.mean, sigma: 0 }])) };
        const t0 = Physics.cruiseTable(exact, { altitude: 200 });
        for (let j = 1; j < t0.speed.length; j++) assert.equal(t0.perMetreHi[j] - t0.perMetreLo[j], 0);
    }
});

test("±1σ grows when a prior gets less certain", () => {
    const m = models.find((x) => x.id === "royal-enfield-hunter-350-metro-in");
    const wide = { ...m, params: { ...m.params, cda: { mean: m.params.cda.mean, sigma: m.params.cda.sigma * 3 } } };
    const a = Physics.cruiseTable(m, { altitude: 0 }), b = Physics.cruiseTable(wide, { altitude: 0 });
    const j = Math.round(20 / a.step);
    assert.ok(b.perMetreHi[j] - b.perMetreLo[j] > a.perMetreHi[j] - a.perMetreLo[j]);
});

// ---------------------------------------------------------------------------
// EV
// ---------------------------------------------------------------------------
test("EV: positive energy and finite range on the flat; nothing above the controller's speed limit", () => {
    for (const m of ev) {
        const t = Physics.cruiseTable(m, { altitude: 0 });
        for (let j = 1; j < t.speed.length; j++) if (t.feasible[j]) {
            assert.ok(t.perMetre[j] > 0, `${m.id} energy at ${t.speed[j]}`);
            assert.ok(t.range && Number.isFinite(t.range[j]) && t.range[j] > 0);
        }
        if (m.motor.speedLimit !== null) assert.equal(Physics.operatingPoint(m, m.motor.speedLimit + 1, { altitude: 0 }).reason, "speed-limit");
    }
});

// ---------------------------------------------------------------------------
// Air
// ---------------------------------------------------------------------------
test("air density falls with altitude, temperature and humidity; noisy inputs are clamped, not NaN", () => {
    for (let h = 0; h < 19000; h += 500) assert.ok(atmosphere.standardAtmosphere(h + 500).density < atmosphere.standardAtmosphere(h).density);
    for (let T = 250; T < 320; T += 5) assert.ok(atmosphere.airDensity({ pressure: 1e5, temperature: T + 5 }) < atmosphere.airDensity({ pressure: 1e5, temperature: T }));
    for (let i = 0; i < 10; i++) assert.ok(atmosphere.airDensity({ pressure: 1e5, temperature: 300, relativeHumidity: (i + 1) / 10 }) < atmosphere.airDensity({ pressure: 1e5, temperature: 300, relativeHumidity: i / 10 }));
    assert.equal(atmosphere.airDensity({ pressure: 1e5, temperature: 300, relativeHumidity: 7 }), atmosphere.airDensity({ pressure: 1e5, temperature: 300, relativeHumidity: 1 }));
    assert.equal(atmosphere.standardAtmosphere(-5000).altitude, -610);
    assert.throws(() => atmosphere.airDensity({ pressure: -1, temperature: 300 }), RangeError);
    assert.throws(() => atmosphere.airDensity({ pressure: 1e5, temperature: NaN }), TypeError);
    void RPM;
});
