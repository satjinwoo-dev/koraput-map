# SmartDrive HUD (`public/js/hud/`)

The riding display for active navigation and SmartDrive trips. It shows live km/L (or Wh/km on an EV), the cost so far, how the rider sits against the bike's eco band, and the next fuel or charge stop. All figures come from the physics model, fed by live GPS.

It has two views:

- **Strip:** a glanceable bar next to the speed dial with live economy, the eco ring and the cost so far. An alert sits above it (beside it in short landscape, so it never covers the turn banner).
- **Riding dashboard:** opens when the rider taps the strip. It is a full-screen view for a mounted phone: a large live figure, a speed scale with the eco band, the posted limit and a needle, one line of guidance, four tiles (cost, fuel, eco score, range) and the next stop. Landscape uses two columns. It sits under the status island, never over it.

| File | What it does |
|---|---|
| `live.js` | `MUHud.live`: pure estimator in strict SI. `createLiveEstimator(physics, model, opts)` → `push(fix)`, `band(grade)`, `state`; also `pitstopAlert()`. No DOM. |
| `hud.js` | `MUHud.view`: the strip and the dashboard. `liveFigure`, `ecoGuidance`, `scaleGeometry` and `alertText` are pure and tested. |
| `hud.css` | Styles, scoped under `.hud` / `#smartdrive-hud`. Container query for the narrow strip; landscape layouts. |
| `hud-app.js` | `MUHud.app`: wiring. Starts on `mu:drive-state`, feeds `mu:fix` into the estimator, renders at 1 Hz, checks stops every 5 s, and sends `mu:ride-summary` when a trip ends. |

## Events

| Event | From | Detail |
|---|---|---|
| `mu:fix` | `SmartDrive.tick` (`smartdrive.js`, new in this step) | every GPS verdict, as SmartDrive sees it: `{ t, smoothedKmh, distKm, accepted, … }`. `hud-app.js` converts it to SI (m/s, m) before it reaches `live.js` |
| `mu:drive-state` | existing | `{ driving, navigating }`: the HUD starts on either one, but not in walking mode |
| `mu:speed-limit` | existing | `{ limit }` in km/h; the eco band is clamped to it |
| `mu:trip-end` | `SmartDrive.endTrip` (new) | the trip's points and totals |
| `mu:ride-summary` | `hud-app.js` (new) | `{ trip, live, powertrain, correction?, bike, priceUnit, priceExample }`: the share card listens for it |

## How the live numbers are worked out

1. **Acceleration** is the least-squares slope of speed over the last 4 s, clamped to ±4 m/s², so a GPS jump doesn't read as full throttle.
2. **Fuel rate** comes from `operatingPoint(model, v, { accel, grade, altitude })`, capped at full throttle. Below 0.8 m/s the bike counts as idling; after 180 s at rest the engine counts as off.
3. **Energy** is integrated with the trapezoid rule. Gaps over 5 s (a tunnel, say) are skipped rather than guessed.
4. The **live figure** covers a 6 s window: steady enough to read, quick enough to react.
5. **Eco band:** from `cruiseTable` at the current grade, cached per grade bucket. Descents use the flat band, and the band is clamped to the posted limit.
6. **Eco score:** best fuel per metre ÷ actual, weighted by distance, from 0 to 100. Harsh events (≥ 2.5 m/s² or ≤ −3.5 m/s² held for 1 s) are counted separately.
7. **Correction:** the ratio between the rider's logged fill-ups and the physics (`fuel-insights.js` `compare().overall`), clamped to 0.6–1.6. The dashboard says "Matched to your fill-ups" only when that ratio comes from the learner, never from a stated km/L.
8. **Range:** fuel left ÷ a 5 km moving average of consumption. The level comes from `MUPitstop.app.levelFor()`: the level set in the convoy planner within the last 6 h, otherwise an estimate from the fill-up log.

## Guidance rules

These are deliberate, and tested:

- It never says "speed up". Below the band, it only describes where the band is.
- Up to 15 km/h above the band: "Ease off N km/h · eco band X–Y km/h".
- More than 15 km/h above: the cost instead of an instruction ("Above the eco band (X–Y km/h) · N % more fuel per km"). Asking someone at 70 to drop 27 km/h isn't useful advice.
- No gear advice. C4 still holds: no CVT, EV or unknown-gearing hints.
- State is always an icon plus words; colour is never the only signal.

## Alerts (`pitstopAlert`)

| Situation | Level |
|---|---|
| Range < 3 km | critical, "On reserve" |
| A planned stop within 60 km | info (warn under 5 km) |
| Range short of the destination and < 50 km | info; warn < 30 km; critical < 15 km |

Warn and critical alerts are spoken once through `speak()`. Critical alerts can be dismissed. A cancelled navigation stops the HUD without sending a ride summary.

## Tests

`node --test test/hud/` (12 tests): estimator integration against the physics, idle and engine-off, the harsh-event threshold, limit clamping, the guidance rules, scale geometry and the alert levels.
