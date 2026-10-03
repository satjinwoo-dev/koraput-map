// Known-answer tests: each expected value is worked out by hand in the comment
// next to it (or taken from a published table), never computed by the code under test.
import { test } from "node:test";
import assert from "node:assert/strict";
import { Physics, Contract, handBike, RPM, KMH, modelById, bundleById } from "./helpers.mjs";

const { atmosphere, tyre, powertrain, roadload, cruise } = Physics;
const near = (actual, expected, tol, what = "") => assert.ok(Math.abs(actual - expected) <= tol, `${what} ${actual} ≠ ${expected} ± ${tol}`);
const rel = (actual, expected, r, what = "") => near(actual, expected, Math.abs(expected) * r, what);

// ---------------------------------------------------------------------------
// Air density
// ---------------------------------------------------------------------------
test("ISA sea level: 288.15 K, 101 325 Pa, 1.2250 kg/m3", () => {
    const s = atmosphere.standardAtmosphere(0);
    assert.equal(s.temperature, 288.15);
    assert.equal(s.pressure, 101325);
    near(s.density, 1.2250, 5e-5, "ρ0");                         // 101325 / (287.053 × 288.15) = 1.22500
    near(atmosphere.airDensity({ pressure: 101325, temperature: 288.15 }), 1.2250, 5e-5);
});

test("standard atmosphere against the US Standard Atmosphere 1976 table (±0.02 %)", () => {
    // altitude m: [pressure Pa, density kg/m3] (USSA-1976, geopotential altitude)
    const table = { 1000: [89874.6, 1.11164], 2000: [79495.2, 1.00649], 5000: [54019.9, 0.736116], 11000: [22632.1, 0.363918], 15000: [12044.6, 0.193674] };
    for (const [h, [p, rho]] of Object.entries(table)) {
        const s = atmosphere.standardAtmosphere(Number(h));
        rel(s.pressure, p, 2e-4, `p(${h} m)`);
        rel(s.density, rho, 2e-4, `ρ(${h} m)`);
    }
    near(atmosphere.standardAtmosphere(1000).temperature, 281.65, 1e-9);   // 288.15 − 0.0065 × 1000
});

test("saturation vapour pressure (Buck 1996) against steam tables", () => {
    near(atmosphere.saturationVapourPressure(273.15), 611.21, 1e-9);         // the formula's anchor
    rel(atmosphere.saturationVapourPressure(293.15), 2339.2, 1e-3);        // 20 °C: 2.3392 kPa
    rel(atmosphere.saturationVapourPressure(303.15), 4246.9, 1.5e-3);      // 30 °C: 4.2470 kPa
    rel(atmosphere.saturationVapourPressure(373.15), 101325, 2e-3);        // 100 °C: boiling at 1 atm
    rel(atmosphere.saturationVapourPressure(263.15), 259.9, 3e-3);         // −10 °C over ice: 259.9 Pa
});

test("humid air: 30 °C, saturated, 1 atm → 1.1459 kg/m3", () => {
    // p_v = 4246 Pa: (101325 − 4246) / (287.053 × 303.15) + 4246 / (461.52 × 303.15) = 1.11560 + 0.03035 = 1.14595
    near(atmosphere.airDensity({ pressure: 101325, temperature: 303.15, relativeHumidity: 1 }), 1.14595, 3e-4);
    // dry air at the same state is denser: 101325 / (287.0531 × 303.15) = 1.164366
    near(atmosphere.airDensity({ pressure: 101325, temperature: 303.15 }), 1.164366, 2e-6);
});

test("riding conditions: altitude sets the pressure, the measured temperature wins", () => {
    // 1000 m standard pressure 89 874.6 Pa at a measured 35 °C: 89874.6 / (287.0531 × 308.15) = 1.016027
    near(atmosphere.airDensityAt({ altitude: 1000, temperature: 308.15 }), 1.016027, 5e-5);
});

// ---------------------------------------------------------------------------
// Tyres
// ---------------------------------------------------------------------------
test("wheel size from the tyre code", () => {
    near(tyre.parseTyre("140/70-17 66P").diameterM, 0.6278, 1e-12);       // 17 × 0.0254 + 2 × 0.140 × 0.70
    near(tyre.parseTyre("150/60 ZR 17 66W").diameterM, 0.6118, 1e-12);    // 0.4318 + 2 × 0.150 × 0.60
    near(tyre.parseTyre("90/90-12 54J").diameterM, 0.4668, 1e-12);        // 0.3048 + 2 × 0.090 × 0.90
    near(tyre.parseTyre("2.75-18 42P").diameterM, 0.5969, 1e-12);         // (18 + 2 × 2.75) × 0.0254
    near(tyre.parseTyre("3.00x18").diameterM, 0.6096, 1e-12);             // (18 + 6) × 0.0254
    const w = tyre.wheelFromTyre("140/70-17");
    near(w.rollingRadius, 0.3139 * 0.975, 1e-12);                         // 2.5 % deflection
    near(w.rollingCircumference, 2 * Math.PI * 0.3139 * 0.975, 1e-12);
    assert.throws(() => tyre.parseTyre("big wheel"), RangeError);
});

test("the physics tyre parser agrees with the data contract on every seed tyre", () => {
    for (const b of bundleById.values()) for (const k of ["frontTyre", "rearTyre"]) {
        const code = b.chassis[k].v;
        near(tyre.parseTyre(code).diameterM, Contract.parseTyre(code).diameterM, 1e-12, code);
    }
});

// ---------------------------------------------------------------------------
// Road load
// ---------------------------------------------------------------------------
test("road load: flat, 10 % grade, wind, acceleration, standstill", () => {
    const base = { mass: 200, v: 20, cda: 0.5, crr: 0.015, rho: 1.2 };
    let r = roadload.roadLoad(base);
    near(r.aero, 120, 1e-9);                                    // ½ × 1.2 × 0.5 × 20²
    near(r.rolling, 29.41995, 1e-9);                            // 0.015 × 200 × 9.80665
    near(r.total, 149.41995, 1e-9);
    near(r.power, 2988.399, 1e-9);                              // × 20 m/s
    r = roadload.roadLoad({ ...base, grade: 0.1 });
    near(r.gravity, 195.159629, 1e-6);                          // 200 × 9.80665 × 0.1/√1.01  (√1.01 = 1.00498756)
    near(r.rolling, 29.273944, 1e-6);                           // 29.41995 / √1.01
    near(r.total, 344.433574, 1e-6);
    near(roadload.roadLoad({ ...base, wind: 5 }).aero, 187.5, 1e-9);    // ½ × 1.2 × 0.5 × 25²
    near(roadload.roadLoad({ ...base, wind: -25 }).aero, -7.5, 1e-9);   // tailwind faster than the bike pushes: −½ × 1.2 × 0.5 × 5²
    near(roadload.roadLoad({ ...base, accel: 1 }).inertia, 210, 1e-9);  // 1.05 × 200 × 1
    r = roadload.roadLoad({ ...base, v: 0, grade: 0.1 });
    assert.equal(r.rolling, 0);
    assert.equal(r.power, 0);
    near(r.total, 195.159629, 1e-6);                            // only gravity: what the brake must hold
});

// ---------------------------------------------------------------------------
// Torque curve
// ---------------------------------------------------------------------------
test("torque curve from Hunter 350 peaks: exact peaks, hand-computed shape", () => {
    // 14.87 kW @ 6100 rpm, 27 N·m @ 4000 rpm, idle 1050 rpm, top 1.12 × 6100 rpm
    const k = powertrain.buildTorqueCurve({ peakPower: 14870, omegaPower: 6100 * RPM, peakTorque: 27, omegaTorque: 4000 * RPM, omegaIdle: 1050 * RPM, omegaMax: 1.12 * 6100 * RPM });
    // ω_P = 638.79050, ω_T = 418.87902; T_P = 14870/638.79050 = 23.278367; D = 3.721633;
    // κ = 23.278367 × 219.91148 / (638.79050 × 3.721633) = 2.153319
    near(k.torqueAtPowerPeak, 23.278367, 1e-6);
    near(k.kappa, 2.153319, 1e-6);
    assert.equal(k.shape, "power-law");
    near(powertrain.torqueAt(k, 4000 * RPM), 27, 1e-12);
    near(powertrain.powerAt(k, 6100 * RPM), 14870, 1e-9);
    near(powertrain.torqueAt(k, 1050 * RPM), 0.65 * 27, 1e-12);                  // 17.55 at idle
    near(powertrain.torqueAt(k, (1050 + 4000) / 2 * RPM), 27 - 9.45 * 0.25, 1e-9); // 24.6375 halfway up
    near(powertrain.torqueAt(k, 5050 * RPM), 26.163396, 1e-6);                    // 27 − 3.721633 × 0.5^2.153319
    near(powertrain.powerAt(k, 1.1 * 6100 * RPM), 14870 * (1 - 3 * 0.01), 1e-9);  // 96 % … 97 % of peak past it
    assert.equal(powertrain.torqueAt(k, 1000 * RPM), 0);                          // below idle
    assert.equal(powertrain.torqueAt(k, 7000 * RPM), 0);                          // above the top speed
});

// ---------------------------------------------------------------------------
// Willans line
// ---------------------------------------------------------------------------
test("Willans fuel: friction power and fuel flow by hand", () => {
    const f = { A: 1e5, B: 50, C: 0.05 };
    near(powertrain.frictionMep(f, 500), 137500, 1e-9);                         // 1e5 + 50 × 500 + 0.05 × 500²
    const pf = powertrain.frictionPower(2e-4, 2, f, 500);
    near(pf, 1094.190234, 1e-6);                                                // 137 500 × 2e-4 × 500 / (4π) = 13 750 / 12.566371
    near(powertrain.frictionPower(2e-4, 1, f, 500), 2 * 1094.190234, 2e-6);     // 2-stroke: one revolution per cycle
    const fuelW = powertrain.willansFuelPower(5000, pf, 0.3);
    near(fuelW, 20313.967446, 1e-5);                                            // (5000 + 1094.190234) / 0.30
    near(fuelW / 3.014e10, 6.7398698e-7, 1e-13);                                // m3/s on E20
    near(powertrain.willansFuelPower(-500, pf, 0.3), pf / 0.3, 1e-9);           // negative brake power never "makes" fuel
});

test("friction terms published per krpm convert to SI consistently", () => {
    // FMEP 100 kPa + 8 kPa/krpm + 0.6 kPa/krpm² at 6 krpm = 100 + 48 + 21.6 = 169.6 kPa
    const f = { A: Contract.toSI(100, "kPa"), B: Contract.toSI(8, "kPa/krpm"), C: Contract.toSI(0.6, "kPa/krpm2") };
    near(powertrain.frictionMep(f, 6000 * RPM), 169600, 1e-6);
});

// ---------------------------------------------------------------------------
// Electric drive
// ---------------------------------------------------------------------------
test("EV: motor force envelope and battery power by hand", () => {
    const m = { peakPower: 4000, wheelTorque: 200 };
    near(powertrain.motorForceMax(m, 2, 0.25), 800, 1e-12);        // torque-limited: 200 / 0.25
    near(powertrain.motorForceMax(m, 10, 0.25), 400, 1e-12);       // power-limited: 4000 / 10
    near(powertrain.motorForceMax(m, 0, 0.25), 800, 1e-12);
    const p = { etaDt: 0.95, etaMotor: 0.85, etaRegen: 0.6, aux: 35, regenLimit: 3000 };
    near(powertrain.batteryPower(1000, p), 1273.390, 1e-3);         // 1000 / (0.95 × 0.85) + 35
    near(powertrain.batteryPower(-2000, p), -1165, 1e-9);           // −2000 × 0.6 + 35
    near(powertrain.batteryPower(-2000, { ...p, regenLimit: 1000 }), -965, 1e-9);   // regen capped at 1 kW
    near(84812.67, 1.08e7 / (1273.390 / 10), 0.5);                  // 3 kWh at 10 m/s: 1.08e7 J ÷ 127.339 J/m ≈ 84.8 km
});

// ---------------------------------------------------------------------------
// CVT
// ---------------------------------------------------------------------------
test("CVT engine speed: clutch slip, launch ratio, variator hold, top ratio", () => {
    const c = { ratioMax: 2.5, ratioMin: 0.8, final: 10, omegaEngage: 300, omegaCruise: 500 };
    assert.equal(cruise.cvtOmega(c, 0, 0.2, 150), 150);                          // standing: idle
    assert.equal(cruise.cvtOmega(c, 1, 0.2, 150), 300);                          // 1/0.2 × 25 = 125 < engage: clutch slips at 300
    near(cruise.cvtOmega(c, 3, 0.2, 150), 375, 1e-9);                            // 3/0.2 × 25
    assert.equal(cruise.cvtOmega(c, 10, 0.2, 150), 500);                         // top ratio would give 400: variator holds 500
    near(cruise.cvtOmega(c, 20, 0.2, 150), 800, 1e-9);                           // 20/0.2 × 8
});

// ---------------------------------------------------------------------------
// Whole chain on a bike with round numbers
// ---------------------------------------------------------------------------
test("whole chain: hand bike at 72 km/h on a flat road", () => {
    const m = Physics.createBikeModel(handBike());
    const op = Physics.operatingPoint(m, 20, { rho: 1.2 });
    // r = 0.5969/2 × 0.975 = 0.29098875 m; mass 180 kg
    // F = 0.02 × 180 × 9.80665 + ½ × 1.2 × 0.5 × 20² = 35.30394 + 120 = 155.30394 N → 3106.0788 W at the wheel
    near(op.wheelForce, 155.30394, 1e-9);
    near(op.wheelPower, 3106.0788, 1e-6);
    assert.equal(op.gear, 5);                                   // top gear: lowest engine speed, least friction
    // ω = 20 / 0.29098875 × (3 × 1.0 × 3) = 618.580615 rad/s
    near(/** @type {number} */ (op.omega), 618.580615, 1e-6);
    near(/** @type {number} */ (op.enginePower), 3451.198667, 1e-6);   // 3106.0788 / 0.90
    // friction: 1e5 × 1.5e-4 × 618.580615 / (4π) = 738.376220 W; fuel power (3451.198667 + 738.376220) / 0.30 = 13965.249621 W
    near(/** @type {number} */ (op.fuelRate), 13965.249621 / 3.014e10, 1e-15);          // 4.633460e-7 m3/s
    near(/** @type {number} */ (op.fuelPerMetre), 13965.249621 / 3.014e10 / 20, 1e-16); // 2.316730e-8 m3/m = 43.16 km/L
    assert.equal(op.feasible, true);
    assert.equal(op.fuelCut, false);
});

test("whole chain: idle at standstill burns the friction power at idle, and goes nowhere", () => {
    const m = Physics.createBikeModel(handBike());
    const op = Physics.operatingPoint(m, 0, { rho: 1.2 });
    // 1e5 × 1.5e-4 × 100 / (4π) = 119.3662 W friction at idle → / 0.30 / 3.014e10
    near(/** @type {number} */ (op.fuelRate), 119.3662 / 0.3 / 3.014e10, 1e-15);
    assert.equal(op.fuelPerMetre, null);
    assert.equal(op.wheelPower, 0);
});

test("shift points for the hand bike: economy upshift where the next gear reaches its lugging limit", () => {
    const m = Physics.createBikeModel(handBike());
    const sp = /** @type {NonNullable<ReturnType<typeof Physics.shiftPoints>>} */ (Physics.shiftPoints(m, { rho: 1.2 }));
    // lug = max(1.6 × 100, 0.35 × 500) = 175 rad/s; overall ratios 27, 18, 13.5, 10.8, 9; r = 0.29098875
    const r = 0.29098875;
    const ratios = [27, 18, 13.5, 10.8, 9];
    for (let i = 0; i < 4; i++) {
        near(sp.ecoUp[i].speed, 175 * r / ratios[i + 1], 1e-9, `${i + 1}→${i + 2}`);
        near(sp.ecoUp[i].omegaTo, 175, 1e-9);
        near(sp.ecoDown[i].speed, 175 * r / ratios[i + 1], 1e-9);
    }
    assert.equal(sp.advisory, true);
    for (const s of sp.perfUp) assert.ok(s.omegaFrom <= m.engine.omegaMax * (1 + 1e-9) && s.omegaFrom > 500, `${s.from}→${s.to} at ${s.omegaFrom} rad/s`);
});

// ---------------------------------------------------------------------------
// Validation against published figures
// ---------------------------------------------------------------------------
test("validation: computed top speed within 10 % of the published figure (petrol bikes that publish one)", () => {
    let checked = 0;
    for (const m of modelById.values()) {
        if (m.powertrain === "ev" || m.topSpeed === null) continue;
        const v = Physics.maxSpeed(m, { altitude: 0, temperature: 298.15 });
        rel(v, m.topSpeed, 0.10, `${m.id} top speed ${(v / KMH).toFixed(1)} km/h vs published ${(m.topSpeed / KMH).toFixed(1)}`);
        checked++;
    }
    assert.ok(checked >= 3, `${checked} bikes checked`);
});
