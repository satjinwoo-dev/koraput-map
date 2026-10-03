// Known-answer tests: every expected number below was worked out by hand
// (the arithmetic is in the comments) — none is copied from the code's output.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { P, RPM, iceBundle, evBundle, realBundles } from "./fixtures.mjs";

const require = createRequire(import.meta.url);
const Contract = require("../../public/js/bikedb/bundle-contract.js");
const { atmosphere, tyre, roadload, engine, profile, drive, cruise, uncertainty, core } = P;
const near = (actual, expected, tol, what = "") => assert.ok(Math.abs(actual - expected) <= tol, `${what} ${actual} ≠ ${expected} ± ${tol}`);

// ---------------------------------------------------------------------------
test("air density: ISA sea level, 1000 m, and humid tropical air", () => {
    // 101325 / (287.05 × 288.15) = 1.22498
    near(atmosphere.airDensity(), 1.22498, 1e-4, "sea level");
    // p = 101325 × (1 − 0.0065·1000/288.15)^5.25588 = 89876 Pa; T = 281.65 K; ρ = 89876 / (287.05 × 281.65) = 1.11164
    near(atmosphere.airDensity({ altitude: 1000 }), 1.11164, 3e-4, "1000 m");
    // 30 °C, 70 % RH: e_s = 610.78·exp(17.27·30/267.3) = 4242.9 Pa, e = 2970.0 Pa
    // ρ = (101325 − 2970.0)/(287.05 × 303.15) + 2970.0/(461.5 × 303.15) = 1.13027 + 0.02123 = 1.15150
    near(atmosphere.airDensity({ temperature: 303.15, relativeHumidity: 0.7 }), 1.1515, 5e-4, "humid");
    assert.ok(atmosphere.airDensity({ temperature: 303.15, relativeHumidity: 0.9 }) < atmosphere.airDensity({ temperature: 303.15 }), "humid air is lighter");
    assert.throws(() => atmosphere.airDensity({ altitude: 20000 }), core.PhysicsError);
    assert.throws(() => atmosphere.airDensity({ relativeHumidity: 1.5 }), core.PhysicsError);
});

test("tyre: radius from the sidewall code", () => {
    // 100/80-17: 17 × 0.0254 / 2 + 0.100 × 0.80 = 0.2159 + 0.0800 = 0.2959 m; × 0.97 = 0.287023 m
    near(tyre.parseTyre("100/80-17 M/C 52P").unloadedRadiusM, 0.2959, 1e-9);
    near(tyre.rollingRadius("100/80-17"), 0.287023, 1e-6);
    // 140/70R-17: 0.2159 + 0.140 × 0.70 = 0.3139 m
    near(tyre.parseTyre("140/70R-17 M/C 66H").unloadedRadiusM, 0.3139, 1e-9);
    // 2.75-18 (inch, full profile): (18/2 + 2.75) × 0.0254 = 0.29845 m
    near(tyre.parseTyre("2.75-18").unloadedRadiusM, 0.29845, 1e-9);
    assert.equal(tyre.parseTyre("fat"), null);
    assert.throws(() => tyre.rollingRadius("fat"), core.PhysicsError);
});

test("tyre parsing agrees with the bundle contract on every catalogue tyre", () => {
    const codes = new Set(["100/80-17", "140/70R-17 M/C 66H", "150/60 ZR 17", "90/90 - R12", "2.75-18", "3.00x18", "120/80-18 62P", "90/100-10 53J", "fat", "80/100"]);
    for (const { bundle } of realBundles()) for (const k of ["frontTyre", "rearTyre"]) codes.add(bundle.chassis[k].v);
    for (const c of codes) {
        const a = tyre.parseTyre(c), b = Contract.parseTyre(c);
        if (a === null || b === null) { assert.equal(a, b, c); continue; }
        near(2 * a.unloadedRadiusM, b.diameterM, 1e-12, c);
    }
});
test("road load: rolling, gradient, aero and wind", () => {
    const c = { mass: 200, crr: 0.02, cda: 0.5 };
    // rolling 0.02 × 200 × 9.80665 = 39.2266 N; aero ½ × 1.2 × 0.5 × 20² = 120 N
    const flat = roadload.roadLoad({ speed: 20, rho: 1.2 }, c);
    near(flat.rolling, 39.2266, 1e-4); near(flat.aero, 120, 1e-9); near(flat.total, 159.2266, 1e-4);
    near(roadload.wheelPower({ speed: 20, rho: 1.2 }, c), 3184.532, 1e-3);
    // 10 %: θ = atan 0.1; cos θ = 0.995037, sin θ = 0.0995037 → rolling 39.0319, gradient 195.1597
    const hill = roadload.roadLoad({ speed: 20, rho: 1.2, grade: 0.1 }, c);
    near(hill.rolling, 39.0319, 1e-3); near(hill.gradient, 195.1597, 1e-3); near(hill.total, 354.1916, 2e-3);
    // headwind 5 m/s: ½ × 1.2 × 0.5 × 25² = 187.5 N; tailwind 25 m/s at 20 m/s: air from behind, −7.5 N
    near(roadload.roadLoad({ speed: 20, rho: 1.2, headwind: 5 }, c).aero, 187.5, 1e-9);
    near(roadload.roadLoad({ speed: 20, rho: 1.2, headwind: -25 }, c).aero, -7.5, 1e-9);
    // standing still: no rolling loss; on a slope gravity still pulls
    assert.equal(roadload.roadLoad({ speed: 0, rho: 1.2 }, c).total, 0);
    near(roadload.roadLoad({ speed: 0, rho: 1.2, grade: 0.1 }, c).gradient, 195.1597, 1e-3);
    // acceleration: 1.05 × 200 × 0.5 = 105 N
    near(roadload.roadLoad({ speed: 0, rho: 1.2, accel: 0.5 }, c).inertia, 105, 1e-9);
});

test("engine friction and Willans fuel", () => {
    const f = { displacement: 1.55e-4, strokes: 4, fmepA: 1e5, fmepB: 0, fmepC: 0, indicatedEfficiency: 0.31, fuelSystem: "fi", idleSpeed: 150 };
    // 1e5 Pa × 1.55e-4 m³ × 1000 rad/s / (2π × 2) = 15500 / 12.5664 = 1233.45 W
    near(engine.frictionPower(1000, f), 1233.45, 0.01);
    near(engine.frictionPower(1000, { ...f, strokes: 2 }), 2466.90, 0.02);
    // 3000 W brake: (3000 + 1233.45) / 0.31 = 13656.3 W → / 30.14e9 J/m³ = 4.5310e-7 m³/s
    near(engine.fuelPower(3000, 1000, f), 13656.3, 0.1);
    near(engine.fuelVolumeRate(13656.3, 30.14e9), 4.5310e-7, 1e-10);
    // overrun at 500 rad/s (> 1.25 × idle): fuel cut on FI …
    assert.equal(engine.fuelPower(-2000, 500, f), 0);
    // … idle circuit on a carburettor: friction at idle 1e5×1.55e-4×150/(4π) = 185.02 W / 0.31 = 596.8 W
    near(engine.fuelPower(-2000, 500, { ...f, fuelSystem: "carb" }), 596.8, 0.1);
    // light throttle, indicated (−1000 + 1233.45 = 233.45 W) above idle flow (185.02): 233.45 / 0.31 = 753.1 W
    near(engine.fuelPower(-1000, 1000, f), 753.1, 0.1);
    // a stopped engine burns nothing
    assert.equal(engine.fuelPower(0, 0, f), 0);
});

test("torque curve from peak figures: exact fit", () => {
    // 14.1 N*m @ 785.398 rad/s, 13500 W @ 1047.198 rad/s:
    // TP = 12.8916, D = 1.2084, Δ = 261.799, S = Δ·TP/ωP = 3.2229 → A = 3D − S = 0.4023, B = S − 2D = 0.8061
    // midpoint u = Δ/2: T = 14.1 − A/4 − B/8 = 14.1 − 0.10058 − 0.10076 = 13.8987
    const m = engine.torqueModel({ peakPower: 13500, peakPowerSpeed: 10000 * RPM, peakTorque: 14.1, peakTorqueSpeed: 7500 * RPM, idleSpeed: 150, redlineSpeed: 1172.9 });
    assert.equal(m.method, "fit_exact");
    near(m.torque(7500 * RPM), 14.1, 1e-9, "T at torque peak");
    near(m.power(10000 * RPM), 13500, 1e-6, "P at power peak");
    near(m.torque(8750 * RPM), 13.8987, 1e-3, "T at midpoint");
    const h = 1e-3, wP = 10000 * RPM;
    near((m.power(wP + h) - m.power(wP - h)) / (2 * h), 0, 1e-3, "dP/dω at power peak");
    // idle: 0.7 × 14.1 = 9.87
    near(m.torque(150), 9.87, 1e-9);
    assert.equal(m.torque(1173), 0, "above the limiter");
    for (let w = 1; w < 1172.9; w += 0.7) {
        assert.ok(m.torque(w) <= 14.1 + 1e-12);
        assert.ok(m.power(w) <= 13500 * (1 + 1e-12));
    }
});

test("torque curve: figures a smooth monotone curve can't meet are capped, never exceeded", () => {
    // long-stroke 350: 30 N*m @ 3000 rpm, 15.5 kW @ 5500 rpm → S > 3D, so A < 0
    const m = engine.torqueModel({ peakPower: 15500, peakPowerSpeed: 5500 * RPM, peakTorque: 30, peakTorqueSpeed: 3000 * RPM, idleSpeed: 1000 * RPM, redlineSpeed: 6200 * RPM });
    assert.equal(m.method, "fit_capped");
    near(m.power(5500 * RPM), 15500, 1e-6);
    near(m.torque(3000 * RPM), 30, 1e-9);
    for (let w = 1; w < 6200 * RPM; w += 0.5) assert.ok(m.power(w) <= 15500 * (1 + 1e-12) && m.torque(w) <= 30 + 1e-12);
    assert.throws(() => engine.torqueModel({ peakPower: 1e4, peakPowerSpeed: 500, peakTorque: 20, peakTorqueSpeed: 600, idleSpeed: 100, redlineSpeed: 700 }), core.PhysicsError);
});

test("a published curve is used as published", () => {
    const m = engine.torqueModel({ peakPower: 13500, peakPowerSpeed: 1047, peakTorque: 14.1, peakTorqueSpeed: 785, idleSpeed: 150, redlineSpeed: 1170,
        curve: { omegaStart: 200, omegaStep: 100, values: [9, 11, 12, 13, 13.8, 14.1, 13.9, 13.2, 12.6, 11] } });
    assert.equal(m.method, "published_curve");
    near(m.torque(250), 10, 1e-12);  // halfway between 9 and 11
    near(m.torque(100), 9, 1e-12);   // below the curve: held at the idle end
});

// ---------------------------------------------------------------------------
test("whole vehicle, manual: 72 km/h on the level costs what the hand calculation says", () => {
    const v = profile.compileVehicle(profile.paramsFromBundle(iceBundle()));
    // mass 120 + 80 = 200 kg; r = 0.287023; top gear overall 3 × 0.9 × 3 = 8.1
    near(v.mass, 200, 1e-9); near(v.rollingRadius, 0.287023, 1e-6);
    const p = drive.operatingPoint(v, { speed: 20, rho: 1.2 });
    assert.equal(p.gear, 5);
    // ω = 20 × 8.1 / 0.287023 = 564.42 rad/s
    near(p.engineSpeed, 564.42, 0.01);
    // brake 159.2266 × 20 / 0.9 = 3538.37 W; friction 1e5×1.55e-4×564.42/(4π) = 696.18 W
    // fuel (3538.37 + 696.18)/0.31 = 13659.8 W → 4.5321e-7 m³/s → 2.2661e-8 m³/m (2.266 L/100 km)
    near(p.fuelRate / 20, 2.2661e-8, 3e-11);
    // available in 5th: s = (785.398 − 564.42)/(785.398 − 150) = 0.34777; T = 14.1 × (1 − 0.3 s²) = 13.5884
    // force 13.5884 × 8.1 × 0.9 / 0.287023 = 345.13 N
    near(p.availableForce, 345.13, 0.05);
});

test("whole vehicle, EV: battery power at 36 km/h", () => {
    const v = profile.compileVehicle(profile.paramsFromBundle(evBundle()));
    // m = 111.6 + 72 = 183.6; rolling 0.021 × 183.6 × 9.80665 = 37.811; aero ½ × 1.225 × 0.52 × 10² = 31.85
    // wheel 696.61 W; battery 696.61 / (0.95 × 0.85) + 25 W auxiliaries = 862.67 + 25 = 887.67 W
    const p = drive.operatingPoint(v, { speed: 10, rho: 1.225 });
    near(p.wheelPower, 696.61, 0.01);
    near(p.batteryPower, 887.67, 0.05);
    // usable 0.9 × 3.7 kWh = 11.988 MJ; range 11.988e6 / 88.767 J/m = 135.05 km
    near(cruise.evRange(v, { speed: 10, rho: 1.225 }), 135050, 20);
});

test("gear engine speed on a real bike: Royal Enfield Classic 350 in 5th at 90 km/h", () => {
    const { bundle, classDefault } = realBundles().find((x) => x.bundle.id === "royal-enfield-classic-350-in");
    assert.match(bundle.chassis.rearTyre.v, /^120\/80-18/);
    const v = profile.compileVehicle(profile.paramsFromBundle(bundle, { classDefault }));
    // overall 2.313 × 0.875 × 2.8 = 5.66685; r = (0.2286 + 0.096) × 0.97 = 0.314862; ω = 25 × 5.66685 / 0.314862 = 449.95 rad/s
    near(drive.gearPoints(v, { speed: 25, rho: 1.2 })[4].engineSpeed, 449.95, 0.05);
});

test("±1σ: a linear output gets exactly σ_out = |∂f/∂p|·σ", () => {
    const params = profile.paramsFromBundle(iceBundle());
    // mass = kerb + rider: σ comes from the rider-mass prior alone (σ = 10 kg)
    const r = uncertainty.propagate(params, (v) => v.mass, { keys: ["riderMass"] });
    near(r.value, 200, 1e-9); near(r.sigma, 10, 1e-9); near(r.low, 190, 1e-9); near(r.high, 210, 1e-9);
    // rolling force ∝ Crr: σ_F = 0.004 × 200 × 9.80665 = 7.8453 N
    const f = uncertainty.propagate(params, (v) => roadload.roadLoad({ speed: 10, rho: 1.2 }, v).rolling, { keys: ["crr"] });
    near(f.sigma, 7.8453, 1e-4);
});
