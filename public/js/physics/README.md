# MapUnite physics core (`public/js/physics/`)

Pure functions, plain JavaScript with JSDoc types (`// @ts-check`, checked by `tsc -p tsconfig.physics.json` in **strict** mode). No dependencies, no DOM. The same files run in the browser, the Android app (WebView or a Web Worker) and Node.

**Strict SI throughout.** Inputs and outputs are m/s, rad/s, W, N, N·m, kg, m, m³, J, Pa, K. It reads only runtime bundles marked `"units": "SI"` and checks the unit of every value and prior it reads. Display conversions (km/h, rpm, km/L, Wh/km) belong in the UI.

## Files

| File | What it does |
|---|---|
| `atmosphere.js` | Air density of moist air (ideal mixture of dry air and vapour; Buck 1996 saturation pressure, over water and over ice). Pressure from the ICAO / US 1976 standard atmosphere up to 20 km, or a measured pressure. |
| `tyre.js` | Wheel size from a tyre code (metric `140/70-17`, `150/60 ZR 17`, inch `2.75-18`). Rolling radius = unloaded radius × (1 − deflection), with deflection 2.5 % ± 1 %. |
| `powertrain.js` | Full-throttle torque curve built from the published peaks. Willans-line fuel model. EV motor force envelope and battery power. |
| `roadload.js` | Rolling + aero (with wind) + gradient + inertia forces, and the tyre's traction limit. |
| `model.js` | `createBikeModel(bundle, { classDefault, settings })`: turns a bundle plus the rider's settings into plain numbers and uncertain parameters (mean ± σ). |
| `cruise.js` | Operating points, gear choice, shift points, top speed, the cruise-band table with ±1σ, and the eco speed band. |
| `index.js` | Entry point. In the browser, load the files in the order above, then `window.MUPhysics`. |

```js
const model = Physics.createBikeModel(bundle, { classDefault, settings: { riderMass: 78, pillionMass: 0 } });
const table = Physics.cruiseTable(model, { altitude: 920, temperature: 303.15, relativeHumidity: 0.6 });
table.eco          // { speedLow, speedHigh, speedBest, perMetreBest }   m/s and m³/m (petrol) or J/m (EV)
Physics.operatingPoint(model, 16.7, { grade: 0.04 })   // one state: gear, ω, powers, fuel or battery energy, feasibility
Physics.shiftPoints(model)                             // economy and full-throttle shifts (manual bikes only)
```

To review a bike's numbers in everyday units: `node scripts/physics/cruise-table.mjs royal-enfield-hunter-350-metro-in [--grade 0.04 --altitude 900 --temp 35]`.

## The models

**Torque curve.** It is built from P̂ at ω_P, T̂ at ω_T, idle and top engine speed. When the peaks are consistent (T̂·ω_T ≤ P̂ ≤ T̂·ω_P, which the data contract enforces), it guarantees:
- T(ω_T) = T̂ and P(ω_P) = P̂, exactly;
- T ≤ T̂ and P ≤ P̂ everywhere;
- dP/dω = 0 at ω_P;
- zero torque outside idle…top.

The pieces:
- **Idle to ω_T:** a quadratic rise from 0.65·T̂.
- **ω_T to ω_P:** T = T̂ − D·x^κ, with κ chosen so that dP/dω = 0 at ω_P. The proof that P ≤ P̂ is in the source: P″ = 2T′ + ωT″ ≤ 0.
- **Past ω_P:** P = P̂(1 − 3z²).
- **Bad data:** contradictory peaks are repaired, flagged, and still never exceed either peak.

**Willans fuel.**
- Fuel power = (P_brake + P_friction)/η_ind.
- P_friction = FMEP(ω)·V_d·ω/(2π·n_R), with FMEP = A + Bω + Cω² in Pa, Pa·s/rad and Pa·s²/rad², and n_R = 2 for a 4-stroke or 1 for a 2-stroke.
- Volume flow = fuel power ÷ LHV (J/m³) of the fuel actually in the tank (E20 by default).
- Overrun is when the *indicated* power is ≤ 0 (gravity beats drag, rolling **and** engine braking). A fuel-injected engine then cuts fuel above 1.3 × idle with the clutch engaged.
- Anywhere else the idle circuit is the floor, so fuel is continuous through zero wheel power.

**Drivetrains.**
- **Manual:**
  - The overall ratio is primary × gear × final.
  - Below idle, the clutch slips: the engine supplies clutch torque × its own speed.
- **CVT:**
  - The clutch slips below the engagement speed, max(1.8 × idle, 0.5·ω_T).
  - The variator then holds a cruise speed (0.85·ω_T) until it reaches its top ratio, and revs up towards ω_P under load.
- **EV:** wheel force ≤ min(T_wheel/r, P̂·η_dt/v).
  - The drivetrain loss applies to the motor's output. Torque published at the wheel already includes it.
  - Battery power = P_w/(η_dt·η_motor) + P_aux when driving, and max(P_w·η_regen, −regen limit) + P_aux when braking.

**Gear choice.** A gear is *advisable* when the clutch is engaged, the engine is at or above its lugging limit, max(1.6 × idle, 0.35·ω_T), and the steady load uses ≤ 85 % of the power available there. The advisable gear that burns the least is chosen; ties go to the higher gear.

**Shift points.**
- **Economy upshift:** where the next gear reaches its lugging limit and carries the load.
- **Full-throttle upshift:** where the next gear's wheel force overtakes the current gear's.
- `atRedline` marks points that hit the redline first.
- Gear advice is off when the gearing came from the class default (C4). CVT scooters and EVs get none.

**±1σ.** Every uncertain parameter is moved by ±σ one at a time, at the chosen gear, and the effects are combined in quadrature: σ_f = √Σ((f⁺ − f⁻)/2)². The parameters are drag area, rolling resistance, η_dt, η_ind, FMEP A/B/C, rider mass and tyre deflection; for an EV, η_motor, η_regen and auxiliary load instead of η_ind and FMEP. They are treated as independent. Petrol ranges are clamped at 0. EV range uses R/(1 ± σ_rel), because range ∝ 1/energy.

**Eco band.** The contiguous feasible speeds at or above 30 km/h whose cost per metre is within 10 % of the best. Below 30 km/h the physics optimum (the slowest speed in top gear) isn't useful advice.

## Documented assumptions (not bike data)

| Assumption | Value | Where |
|---|---|---|
| Torque at idle ÷ peak torque | 0.65 | `CURVE_DEFAULTS` |
| Power past its peak | P̂(1 − 3z²), about 96 % at 1.12·ω_P | `CURVE_DEFAULTS` |
| Tyre deflection | 2.5 % ± 1 % | `tyre.DEFLECTION` |
| Rotating-mass factor, tyre grip, rear weight share | 1.05, 0.8, 0.6 | `ROAD_DEFAULTS` |
| Lugging limit, fuel-cut speed, CVT engagement and cruise speeds, dry-mass fuel and fluids, usable battery share (92 % ± 3 %), EV auxiliary load (35 ± 15 W), regen limit | see source | `MODEL_DEFAULTS` |
| Advisable load (85 % of available power), table step 0.5 m/s, eco band | see source | `CRUISE_DEFAULTS` |

When data is missing, the model uses, in order: the bike's own value, the rider's setting, the class default's value (flagged), then a documented default (flagged). `model.flags` lists every fallback used, so the UI can show lower confidence.

## Tests (`node --test test/physics/*.test.mjs`)

- **Known answers:** every expected value is worked out by hand in the test or taken from a published table.
  - ISA / USSA-1976 table to ±0.02 %, steam-table vapour pressures, humid-air density.
  - Tyre diameters, road load (flat, 10 %, wind, acceleration, standstill), torque curve shape, Willans friction and fuel, EV force and battery power, CVT engine speed.
  - A whole-chain hand calculation (43.16 km/L at 72 km/h for a bike with round numbers) and economy shift speeds.
- **Validation:** computed top speed is within 10 % of the published figure for every petrol bike that publishes one: Apache 117 vs 114 km/h, Raider 98 vs 99, Jupiter 82 vs 82.
- **Properties:** seeded fuzzing, the same numbers on every run.
  - 7,000 random engines: never above either peak, peaks exact.
  - No NaN at standstill, for any bike, weather or slope.
  - Fuel never negative, over 20,000 random states.
  - Descents cost no fuel on fuel-injected bikes; carburettors keep their idle feed.
  - Climbing never costs less; more drag, mass or loss always costs more.
  - Walls and cliffs (gradient ±10¹⁶) give finite answers.
  - The gear choice is optimal among advisable gears.
  - lo ≤ mean ≤ hi.
- **Model:** strict-SI refusal, class-default fallbacks, rider settings, EV torque placement.
- **Regressions:** one test per finding of the independent review.
- **Browser:** the files load as plain `<script>` tags into `window.MUPhysics` and give identical results.
- **Performance:** across all 35 bikes, the median precompute is ~0.12 ms on this machine; the slowest bike's 95th percentile is under 0.5 ms. The first table in a fresh process takes ~6 ms, which is JIT warm-up and happens once. A mid-range phone runs this about 3–5× slower, which still leaves it well under the 5 ms budget.

## Known limits (for calibration in Step 11)

Class priors are deliberately wide. On the seed data:
- **Faired sports bikes look optimistic:** the drag-area prior is low.
- **CVT scooters look pessimistic on fuel.**
- **The Ola S1 Pro tops out at 111 km/h (published 125):** the EV drag-area prior is high, or its peak power is understated.

The ±1σ bands are meant to cover this until per-rider calibration narrows them.
