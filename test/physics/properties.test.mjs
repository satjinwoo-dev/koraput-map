// Property tests over every bike in the real catalogue (and synthetic edge
// cases): invariants that must hold for ANY input, checked on thousands of
// seeded random states — no NaN, fuel never negative, standstill and extreme
// gradients handled, descents free on fuel-injected bikes, results within the
// published peaks, uncertainty bands well formed.
import { test } from "node:test";
import assert from "node:assert/strict";
import { P, RPM, iceBundle, cvtBundle, evBundle, realBundles, rng } from "./fixtures.mjs";

const { profile, drive, cruise, uncertainty, core } = P;
const STATES_PER_BIKE = 400;

const vehicles = () => realBundles().map(({ bundle, classDefault }) => {
    const params = profile.paramsFromBundle(bundle, { classDefault });
    return { id: bundle.id, params, vehicle: profile.compileVehicle(params) };
});

/** Every number in an operating point must be finite (Number.MAX_VALUE stands in for "unlimited"). */
function assertFinitePoint(p, where) {
    for (const k of ["engineSpeed", "wheelForce", "wheelPower", "availableForce", "fuelRate", "batteryPower"]) {
        assert.ok(Number.isFinite(p[k]), `${where}: ${k} = ${p[k]}`);
    }
    assert.equal(typeof p.feasible, "boolean", where);
}

test("every catalogue bike builds a vehicle; flags say where estimates were used", () => {
    for (const { id, params, vehicle } of vehicles()) {
        assert.ok(vehicle.mass > 100 && vehicle.mass < 400, `${id} mass ${vehicle.mass}`);
        assert.ok(vehicle.rollingRadius > 0.2 && vehicle.rollingRadius < 0.4, `${id} r ${vehicle.rollingRadius}`);
        for (const [k, pr] of Object.entries(params.priors)) assert.ok(pr.sigma > 0 && ["bundle", "class_default", "rider", "model"].includes(pr.origin), `${id} ${k}`);
        if (params.kind === "class_default") assert.ok(params.flags.some((f) => /class default/i.test(f)), id);
    }
});

test("random states: no NaN anywhere, fuel never negative, chosen gears inside the rev range", () => {
    const rand = rng(4242);
    const u = (lo, hi) => lo + (hi - lo) * rand();
    for (const { id, vehicle } of vehicles()) {
        const vmax = cruise.maxSpeed(vehicle, { rho: 1.2 });
        for (let k = 0; k < STATES_PER_BIKE; k++) {
            const c = { speed: k % 25 === 0 ? 0 : u(0, vmax * 1.1), grade: u(-0.3, 0.3), accel: u(-3, 3), headwind: u(-10, 10), rho: u(0.9, 1.3) };
            const where = `${id} ${JSON.stringify(c)}`;
            const p = drive.operatingPoint(vehicle, c);
            assertFinitePoint(p, where);
            assert.ok(p.fuelRate >= 0, `${where}: negative fuel`);
            if (params(vehicle).powertrain === "ice_manual" && p.feasible && p.gear !== null) {
                assert.ok(p.engineSpeed <= vehicle.engine.redline + 1e-9, `${where}: over redline`);
                assert.ok(p.engineSpeed >= vehicle.engine.lugSpeed - 1e-9, `${where}: lugging`);
            }
            if (vehicle.ev && p.wheelPower < 0) assert.ok(p.batteryPower - vehicle.ev.auxPower >= p.wheelPower - 1e-9, `${where}: regen recovered more than the wheel gave`);
        }
    }
});
const params = (v) => v.params;

test("standstill: the engine idles (or the EV draws only its auxiliaries) — no NaN", () => {
    for (const { id, vehicle } of vehicles()) {
        const p = drive.operatingPoint(vehicle, { speed: 0, rho: 1.2 });
        assertFinitePoint(p, id);
        if (vehicle.engine) {
            assert.equal(p.engineSpeed, vehicle.engine.fuel.idleSpeed, id);
            assert.ok(p.fuelRate > 0, `${id}: an idling engine burns fuel`);
        } else assert.equal(p.batteryPower, vehicle.ev.auxPower, id);
        // pulling away up a 10 % hill: first gear (or the CVT's launch ratio), finite
        const go = drive.operatingPoint(vehicle, { speed: 0, rho: 1.2, grade: 0.1, accel: 1 });
        assertFinitePoint(go, `${id} launch`);
    }
});

// Physics, stated precisely: a fuel-injected engine cuts fuel whenever the road
// drives it — i.e. whenever gravity overcomes the engine's own braking. On a
// gentle descent, holding a steady speed can still need a little throttle (the
// engine's friction is the bigger drag), so the plan's "descents cost no fuel"
// is checked where it is true: a steep descent (25 %) and, for every descent,
// "never more than riding on the level". A centrifugal-clutch CVT is driven
// only while the road keeps the engine above clutch engagement; slower, the
// clutch lets go and the engine idles (idle flow, no more).
test("descents cost no fuel on fuel-injected bikes once gravity beats engine braking", () => {
    let manual = 0, cvtCut = 0;
    for (const { id, vehicle } of vehicles()) {
        if (!vehicle.engine || vehicle.engine.fuel.fuelSystem !== "fi") continue;
        const idleFlow = drive.idlePoint(vehicle, 0, 0).fuelRate;
        for (const kmh of [30, 40, 50, 60, 70]) {
            const v = kmh / 3.6;
            if (v > cruise.maxSpeed(vehicle, { rho: 1.2 })) continue;
            const steep = drive.operatingPoint(vehicle, { speed: v, grade: -0.25, rho: 1.2 });
            if (vehicle.overallRatios) { assert.equal(steep.fuelRate, 0, `${id} at ${kmh} km/h on -25 %`); manual++; }
            else if (steep.engineSpeed === vehicle.engine.fuel.idleSpeed) assert.equal(steep.fuelRate, idleFlow, `${id}: clutch out means idle flow, no more`);
            else { assert.equal(steep.fuelRate, 0, `${id} at ${kmh} km/h on -25 %`); cvtCut++; }
            for (const grade of [-0.03, -0.06, -0.12]) {
                const level = drive.operatingPoint(vehicle, { speed: v, rho: 1.2 });
                const down = drive.operatingPoint(vehicle, { speed: v, grade, rho: 1.2 });
                assert.ok(down.fuelRate <= level.fuelRate + 1e-18, `${id} at ${kmh} km/h: ${grade * 100} % costs more than the level`);
            }
        }
    }
    assert.ok(manual > 60, `${manual} manual descents`);
    assert.ok(cvtCut > 0, "a CVT at speed is driven by the road: fuel cut");
    const b = iceBundle();
    b.engine.fuelSystem = { v: "carb", conf: 0.9, src: "test" };
    const carb = profile.compileVehicle(profile.paramsFromBundle(b));
    assert.ok(drive.operatingPoint(carb, { speed: 14, grade: -0.12, rho: 1.2 }).fuelRate > 0);
});

test("extreme gradients: ±100 % gives finite answers (and an honest 'not enough power'); steeper is rejected", () => {
    for (const { id, vehicle } of vehicles()) {
        for (const grade of [1, -1, 0.6, -0.6]) {
            const p = drive.operatingPoint(vehicle, { speed: 8, grade, rho: 1.2 });
            assertFinitePoint(p, `${id} grade ${grade}`);
            if (grade === 1) assert.equal(p.feasible, false, `${id} can't climb a 45° wall`);
            if (grade < 0) assert.ok(p.fuelRate >= 0);
        }
        assert.throws(() => drive.operatingPoint(vehicle, { speed: 8, grade: 1.5, rho: 1.2 }), core.PhysicsError);
        assert.throws(() => drive.operatingPoint(vehicle, { speed: Number.NaN, rho: 1.2 }), core.PhysicsError);
        assert.throws(() => drive.operatingPoint(vehicle, { speed: -1, rho: 1.2 }), core.PhysicsError);
    }
});

test("torque models: never above the published peaks; exact at the peaks they were fitted to", () => {
    for (const { id, vehicle } of vehicles()) {
        if (!vehicle.engine) continue;
        const m = vehicle.engine.torque, map = m.map;
        for (let w = 1; w <= vehicle.engine.limiter * 1.05; w += 2) {
            assert.ok(m.torque(w) >= 0 && m.torque(w) <= Math.max(map.peakTorque, map.peakPower / map.peakPowerSpeed) * (1 + 1e-12), `${id} T(${w})`);
            assert.ok(m.power(w) <= map.peakPower * (1 + 1e-12), `${id} P(${w})`);
        }
        if (m.method !== "published_curve") {
            assert.ok(Math.abs(m.power(map.peakPowerSpeed) - map.peakPower) < 1e-6, `${id} P(ωP)`);
            assert.ok(m.torque(map.peakTorqueSpeed) <= map.peakTorque + 1e-9, `${id} T(ωT)`);
        }
        assert.equal(m.torque(vehicle.engine.limiter * 1.01), 0, `${id} above the limiter`);
    }
});

test("road load grows with speed on the level; fuel per hour grows with speed in a fixed gear", () => {
    for (const { id, vehicle } of vehicles()) {
        let prevF = -Infinity;
        for (let v = 0.5; v < 30; v += 0.5) {
            const f = drive.demand(vehicle, { speed: v, rho: 1.2 }).force;
            assert.ok(f > prevF, `${id} at ${v}`);
            prevF = f;
        }
        if (!vehicle.overallRatios) continue;
        const top = vehicle.overallRatios.length - 1;
        let prev = -Infinity;
        for (let v = 10; v < 25; v += 1) {
            const p = drive.gearPoints(vehicle, { speed: v, rho: 1.2 })[top];
            assert.ok(p.fuelRate >= prev, `${id} ${v} m/s`);
            prev = p.fuelRate;
        }
    }
});

test("gear advice: only for a real bike with its own published gearing — never CVT, EV or class defaults", () => {
    for (const { id, params: p } of vehicles()) {
        if (p.powertrain !== "ice_manual" || p.kind === "class_default") assert.equal(p.gearAdvice, false, id);
        if (p.gearAdvice) assert.equal(p.ice.gearing.origin, "variant", id);
        if (p.powertrain === "ice_manual" && p.ice.gearing.origin === "class_default") {
            assert.equal(p.gearAdvice, false, id);
            assert.ok(p.flags.some((f) => /class-default gearing/.test(f)), id);
        }
    }
    const byId = Object.fromEntries(vehicles().map((x) => [x.id, x.params]));
    assert.equal(byId["royal-enfield-classic-350-in"].gearAdvice, true);
    assert.equal(byId["yamaha-mt-15-v2-in"].gearAdvice, false, "MT-15 V2: primary and final ratios not published");
});

test("shift points: upshifts inside the rev range, economy no later than performance", () => {
    for (const { id, vehicle } of vehicles()) {
        if (!vehicle.overallRatios) continue;
        const sp = drive.shiftPoints(vehicle, { rho: 1.2 });
        assert.equal(sp.length, vehicle.overallRatios.length - 1, id);
        let prev = 0;
        for (const s of sp) {
            assert.ok(s.performanceEngineSpeed <= vehicle.engine.redline + 1e-6, `${id} ${s.from}→${s.to}`);
            assert.ok(s.performanceSpeed >= prev, `${id}: upshift speeds rise with gear`);
            prev = s.performanceSpeed;
            if (s.economySpeed !== null) assert.ok(s.economySpeed <= s.performanceSpeed + 0.05, `${id} ${s.from}→${s.to}`);
        }
    }
});

test("cruise tables: finite, non-negative cost, eco band inside the feasible range", () => {
    for (const { id, vehicle } of vehicles()) {
        const t = cruise.cruiseTable(vehicle, { rho: 1.17 });
        assert.ok(t.speeds.length > 10, id);
        for (let i = 0; i < t.speeds.length; i++) {
            assert.ok(Number.isFinite(t.perDistance[i]) && t.perDistance[i] >= 0, `${id} row ${i}`);
            assert.ok(Number.isFinite(t.engineSpeed[i]), `${id} row ${i}`);
        }
        assert.ok(t.eco, `${id}: some speed must be feasible on the level`);
        assert.ok(t.eco.lo <= t.eco.best && t.eco.best <= t.eco.hi, id);
        const iBest = t.speeds.indexOf(t.eco.best);
        assert.equal(t.feasible[iBest], 1, id);
        for (let i = 0; i < t.speeds.length; i++) if (t.feasible[i]) assert.ok(t.perDistance[i] >= t.perDistance[iBest] - 1e-18, `${id}: best isn't the cheapest`);
    }
});

test("±1σ bands are well formed for every bike, and every prior is accounted for", () => {
    for (const { id, params: p } of vehicles()) {
        const u = cruise.cruiseTableWithUncertainty(p, { rho: 1.17 }, { step: 1 });
        for (let i = 0; i < u.table.speeds.length; i++) {
            assert.ok(u.perDistanceSigma[i] >= 0 && Number.isFinite(u.perDistanceSigma[i]), `${id} row ${i}`);
            assert.ok(u.perDistanceLow[i] <= u.table.perDistance[i] && u.table.perDistance[i] <= u.perDistanceHigh[i], `${id} row ${i}`);
        }
        const keys = new Set(u.contributions.map((c) => c.key));
        for (const k of Object.keys(p.priors)) assert.ok(keys.has(k), `${id}: prior ${k} not propagated`);
        assert.ok(u.contributions[0].sigma >= u.contributions[u.contributions.length - 1].sigma, `${id}: contributions sorted`);
    }
});

test("rider settings: mass, sprockets, tyre and fuel move the answer the right way; nonsense is refused", () => {
    const base = profile.paramsFromBundle(iceBundle());
    const v0 = profile.compileVehicle(base);
    const heavy = profile.compileVehicle(profile.paramsFromBundle(iceBundle(), { rider: { riderMass: 95, pillionMass: 60, luggageMass: 10 } }));
    assert.equal(heavy.mass, 120 + 95 + 60 + 10);
    assert.equal(profile.paramsFromBundle(iceBundle(), { rider: { riderMass: 95 } }).priors.riderMass.origin, "rider");
    // a bigger rear sprocket raises the final ratio and the engine speed in the same gear
    const geared = profile.compileVehicle(profile.paramsFromBundle(iceBundle(), { rider: { frontSprocket: 14, rearSprocket: 46 } }));
    const w0 = drive.gearPoints(v0, { speed: 20, rho: 1.2 })[4].engineSpeed, w1 = drive.gearPoints(geared, { speed: 20, rho: 1.2 })[4].engineSpeed;
    assert.ok(Math.abs(w1 / w0 - (46 / 14) / 3) < 1e-9);
    // E10 carries more energy per litre than E20: fewer litres for the same ride
    const e10 = profile.compileVehicle(profile.paramsFromBundle(iceBundle(), { rider: { fuelGrade: "E10" } }));
    assert.ok(drive.operatingPoint(e10, { speed: 20, rho: 1.2 }).fuelRate < drive.operatingPoint(v0, { speed: 20, rho: 1.2 }).fuelRate);
    for (const bad of [{ riderMass: 5 }, { frontSprocket: 14.5, rearSprocket: 40 }, { frontSprocket: 14 }, { rearTyre: "fat" }, { fuelGrade: "E85" }, { pillionMass: -3 }]) {
        assert.throws(() => profile.paramsFromBundle(iceBundle(), { rider: bad }), core.PhysicsError, JSON.stringify(bad));
    }
});

test("missing data is never guessed: no class default → a clear error, not a made-up number", () => {
    const b = iceBundle();
    delete b.engine.idleRpm;
    assert.throws(() => profile.paramsFromBundle(b), /idle speed/);
    const c = cvtBundle();
    delete c.transmission.cvtRatioMax;
    assert.throws(() => profile.paramsFromBundle(c), /CVT/);
    assert.throws(() => profile.paramsFromBundle({ ...evBundle(), units: "published" }), /SI/);
});

test("CVT and EV specifics", () => {
    const cvt = profile.compileVehicle(profile.paramsFromBundle(cvtBundle()));
    for (let v = 1; v < 22; v += 1) {
        const p = drive.operatingPoint(cvt, { speed: v, rho: 1.2 });
        assert.equal(p.gear, null);
        assert.ok(p.engineSpeed >= cvt.engine.fuel.idleSpeed - 1e-9 && p.engineSpeed <= cvt.engine.limiter + 1e-9, `${v} m/s`);
    }
    // coasting slowly with the throttle shut: the clutch lets go and the engine idles
    const coast = drive.operatingPoint(cvt, { speed: 3, grade: -0.05, rho: 1.2 });
    assert.equal(coast.engineSpeed, cvt.engine.fuel.idleSpeed);
    const ev = profile.compileVehicle(profile.paramsFromBundle(evBundle()));
    assert.equal(drive.operatingPoint(ev, { speed: 26, rho: 1.2 }).feasible, false, "beyond the published top speed");
    // regenerating downhill: the battery gains, but never more than the wheel gave up
    const down = drive.operatingPoint(ev, { speed: 15, grade: -0.08, rho: 1.2 });
    assert.ok(down.batteryPower < ev.ev.auxPower && down.batteryPower - ev.ev.auxPower >= down.wheelPower);
});

test("determinism: the same inputs give bit-identical tables", () => {
    const p = profile.paramsFromBundle(iceBundle());
    const a = cruise.cruiseTableWithUncertainty(p, { rho: 1.2 }), b = cruise.cruiseTableWithUncertainty(p, { rho: 1.2 });
    assert.deepEqual(Array.from(a.table.perDistance), Array.from(b.table.perDistance));
    assert.deepEqual(Array.from(a.perDistanceSigma), Array.from(b.perDistanceSigma));
    void RPM;
});
