# Fuel learner dashboard (`public/js/insights/`)

The SmartDrive learner (`js/smartdrive.js` `FuelCurve`) learns how the rider's bike really burns fuel from full-to-full fill-ups. This screen sets that learned curve beside the bike's physics baseline.

**Opening it:** SmartDrive settings → My fuel curve → **See how your bike really does** (`#open-fuel-dash-btn`). It opens `#fuel-dash-modal`.

| File | What it does |
|---|---|
| `fuel-insights.js` | Pure logic, in strict SI. See the functions below. |
| `fuel-dashboard.js` | The screen. `describeFindings`, `kpis`, `mileageGeometry`, `niceTicks` and `pct` are pure and tested. |
| `fuel-dashboard.css` | Styles, scoped under `.fd`. |
| `insights-app.js` | Wiring. It opens the modal, loads the two scripts above and the stylesheet on first use, and reads the learner. |

`fuel-insights.js` has three main functions:

- **`snapshotFromLearner(FuelCurve)`:** the only place that knows the learner's units (km/L, litres, km, hours). Everything it returns is SI.
- **`physicsCurve(MUPhysics, model)`:** the flat-road baseline with ±1σ.
- **`compare(snapshot, physics)`:** produces:
  - the chart rows;
  - each speed band's real use against the physics;
  - every full tank predicted three ways (physics, starting curve, learned) against what the pump said;
  - accuracy, and the findings.

## What the rider sees

- **Status pill:** one of "Using your curve", "Learning · 2 of 3 tanks", "Starting curve fits better", or "Ready · switched off".
- **Three tiles:**
  - **Real world vs physics:** your real fuel ÷ the physics fuel over the riding you actually did, weighted by band distance.
  - **Your best speed:** the band with the best real km/L. Before that is known, the physics' eco band.
  - **Tank accuracy:** your curve against the physics alone, as the mean absolute error over usable tanks.
- **Mileage by speed:**
  - The physics as a line in blue, with its ±1σ ribbon. Your learned curve in mint, one level per speed band, so it steps at 40, 60 and 80 km/h. The starting curve as a muted dashed line. The legend chips toggle each one.
  - The band edges are marked, and "Where you ride" sits underneath, aligned to the x axis.
  - Readout: a crosshair tooltip on wide screens, and a docked readout on phones. The chart works with the keyboard: ←/→, Home, End, Esc.
- **Real use vs physics, by speed:** diverging bars around the physics. Blue means less fuel, red means more. Bands with less than 50 km of riding are hatched and starred.
- **Every full tank:** the pump (white), physics (blue ring) and your curve (mint) on one litres axis, with each prediction's error. Tanks the learner couldn't use are greyed and give the learner's own reason.
- **"What your tanks say":** the findings in plain words. Idling is only mentioned when the fill-ups actually pinned it down; a multiplier stuck at its bound means they couldn't.
- **"Show the numbers":** both tables.

Empty states:

- **No fill-ups yet:** a three-step "How the learner works" with a button to log the first fill-up.
- **No bike chosen:** a call to action to choose one. The comparison still runs against the starting curve.
- **Electric bike:** an honest "nothing to compare yet".

## Colour and accessibility

- **Series colours:** blue `#3987e5` and mint `#34e0b4`. They were run through the validator against `--ink-2` (`#0e1724`): CVD ΔE 27.4 and normal-vision ΔE 28.2, both far above the floor.
- **Brand exception:** mint is lighter than the categorical lightness band. It's the brand colour, it passes contrast, and it's always paired with a legend chip and a direct label.
- **Status:** never shown by colour alone. Tiles and findings carry an icon and words.

## The learner's limits, shown honestly

The learner keeps its starting curve's shape inside each band and learns one level per band. If that starting curve is the generic U-shape (`rated × fuelShape`), the learned curve and the physics differ in shape inside a band, and the chart shows that difference as it is. If the learner exposes `FuelCurve.priorKmPerL(kmh)`, for example a physics-based starting curve, the adapter uses it automatically.

## Tests

`node --test test/insights/*.test.mjs` runs 11 tests against the **real** learner code. `learner-sim.mjs` extracts it from `smartdrive.js` and runs it in a sandbox, fed by a simulated rider whose true fuel use is the physics × a factor per band. The tests cover:

- the band rule matching `fuelBandIndex` at every speed;
- recovering band speeds;
- exact unit conversion;
- a rider who burns exactly the physics: every tank predicted within 6 %;
- a rider 20 % thirstier: overall about +20 %, and the learned curve beats the physics;
- the no-bike and empty states;
- idling suppression;
- the findings text, the tiles and the chart geometry;
- lazy-loaded files being precached.
