# MapUnite trip energy (`public/js/trip/`)

Fuel, battery energy and cost for the route on the map, worked out by the Step 4 physics core using the rider's own bike from "My bike". It is plain JavaScript with JSDoc types (`tsc -p tsconfig.trip.json`) and needs no build step.

| File | What it does |
|---|---|
| `profile.js` | Pure geometry. It resamples the route polyline evenly (90 m spacing at minimum, 400 points at most), then cleans the terrain heights: fills gaps, applies a running median (which removes flyover and cutting artefacts), smooths over about 250 m and clamps grades to ±25 %. It also returns ascent and descent, and each segment's average speed taken from the router's own step distances and durations. |
| `elevation.js` | Gets terrain heights from Open-Meteo's `/v1/elevation` (90 m Copernicus DEM, free, no key, already allowed in the CSP's `connect-src`). It sends 100 points per request, two requests at a time, each with an 8 s timeout. Points are rounded to about 11 m and remembered in memory and in Cache Storage (`mu-trip-v1`, up to 20 000 points), so a route you ride often needs no network. Only coordinates are sent. |
| `energy.js` | The estimate itself (strict SI). See below. |
| `trip-card.js` | The card in the route sheet. `describe()`, `flagLines()` and `chartPaths()` are pure and tested. |
| `trip-app.js` | Wiring into `index.html`: route events, the in-app "My bike" sheet and the SmartDrive settings summary. |
| `trip.css` | Styles. They use the app's design tokens, with fallbacks. |

## How a trip is costed (`energy.js`)

1. **Cruising.** Each profile segment is ridden at the router's average speed for that stretch, on that segment's grade. The cost per metre comes from `cruiseTable()`, the same precompute the garage chart uses.
   - Tables are built lazily for each 1 % grade bucket, stop just above the route's top speed, and are interpolated in both grade and speed.
   - If the bike can't hold traffic speed on a climb, that segment is ridden at the fastest speed it *can* hold and flagged "slow climb".
   - If a climb is steeper than the bike can manage at all, it is costed at the demanded load and flagged.
2. **Stops.** Each stop costs a launch at 1.0 m/s², a stop at −1.5 m/s² and some idling, all computed by the physics with acceleration. That means injected engines get their overrun fuel cut and EVs get regeneration.
   - The base rate depends on the segment's speed: about 1.5 stops per km in slow city traffic, falling to none above 55 km/h.
   - That rate is multiplied by the rider's traffic setting: light ×0.5 with 10 s idle per stop, normal ×1 with 25 s, heavy ×1.8 with 45 s.
   - Idling is capped at 30 % of the router's own trip time, because the waiting is already inside that time.
   - This is the one part that is assumed, and the card says so.
3. **Range.** The physics' ±1σ per metre is summed linearly along the route. The same bike's drag or friction error applies on every segment, so the errors are correlated, not independent. The stop and idle terms get ±50 % on top.
4. **Cost.** `tripCost(r, { fuelPerM3, energyPerJ })` takes prices whose denominators are already SI. The card converts the rider's ₹/L (×1000) and ₹/kWh (÷3.6e6) at the edge. EVs pay for battery energy ÷ 0.88 to cover charging loss; a net recharge costs ₹0.

Air density uses the route's mean height, rounded to 100 m. Speed comes from OSRM's steps, or Google's steps scaled to its live-traffic duration.

Performance on a laptop: 6–8 ms the first time a bike is used on a route (building about 25 tables plus the stop costs), then under 1 ms when the traffic or price changes. The card computes after the sheet has painted.

## What the rider sees

- **Before a bike is chosen:** "See the fuel and cost of this trip" with a **Choose my bike** button, which opens "My bike" in a sheet over the map, so the route stays put.
- **Figures:**
  - litres, or kWh with the share of a full charge;
  - the likely range;
  - the cost at the rider's price, labelled **example** (₹100/L, ₹8/kWh) until they enter their own (tap the price to change it);
  - km/L or Wh/km on this route.
- **Elevation profile:**
  - one mint series, minimum and maximum heights, and ascent and descent;
  - "hills +0.40 L", meaning how much the gradients add compared with the same ride on the flat;
  - amber where the bike can't hold traffic speed;
  - pointer or keyboard readout (←/→, Home/End, Esc) of distance, height and grade.
  - It first shows "Checking the hills…" over a flat estimate. Offline it shows "Hills not included".
- **What-ifs:** traffic (light, normal or heavy) and load (solo or pillion). These recompute instantly.
- **"How this is worked out":**
  - the breakdown: cruising on the flat, hills, stops, idling, and regeneration for EVs;
  - every assumption that applied.
- **While driving:** a single line ("1.24 L · ₹130"). Tap it to peek at the details.
- **EVs:** a warning to plan a charging stop when the likely high end is above 90 % of the battery.

The card follows the C4 rule: it never gives gear advice.

## Events (from `js/navigation.js`)

```js
document.dispatchEvent(new CustomEvent("mu:route", { detail: {
  path: [[lat, lng], …], distanceM, durationSec,
  steps: [{ distance, duration }],          // metres, seconds
  reason: "preview" | "reroute"
}}));
document.dispatchEvent(new CustomEvent("mu:route-clear"));
// and the existing "mu:drive-state" { navigating } → compact card
```

Any other route source, such as group navigation, can show the card by dispatching the same event.

## Storage (all on the phone)

| Key | What |
|---|---|
| `mu.garage.v1` | The bike and the rider's settings (the garage store) |
| `mu.trip.v1` | Traffic, load, the rider's ₹/L and ₹/kWh, and whether the card is open |
| Cache `mu-trip-v1` | Remembered terrain heights |
| Cache `mu-bikedb-v1` | The bike list and bike files (the garage store; seeded by `sw.js` on install) |

## Tests

`node --test test/trip/trip.test.mjs` runs 23 tests:

- **Geometry:** haversine, resampling, a 5 % ramp read as exactly 5 %, a flyover dip removed, the ±25 % clamp, gap filling, flat fallback, step speeds and traffic scaling.
- **Physics:**
  - a steady flat ride equals the cruise table exactly, with σ summed linearly;
  - climbs cost monotonically more;
  - fuel is never negative on a 6 % descent;
  - a petrol round trip over a hill costs more than the flat ride;
  - EV regeneration gives negative energy, and a net recharge costs ₹0;
  - traffic and pillion move the estimate the right way, with no stops above 55 km/h and the idle cap applied;
  - a 22 % climb is slowed and flagged, never NaN;
  - the other flags appear when they should;
  - a warm estimate on a 400-point route takes under 5 ms.
- **Cost:** unit conversions.
- **Card helpers:** text for petrol and EV, the example-price label, charging-stop warning, chart paths, prefs sanitising, flag text.
- **Elevation:** batching, rounding, the memory cache, Cache Storage persistence, offline and server errors.
- **Offline completeness:** every script and stylesheet that `garage.html`, `index.html` and the lazy-loaded garage use is in `sw.js`'s precache, both pages use the precached fonts stylesheet, and `garage.html` has no inline script.
- **`index.html`:** the edits are additive, the Maps `<script>` is unchanged, and the new ids are unique.

It was also run in headless Chromium at 390 px and 1280 px against a copy of `index.html`:

- no bike, then choosing one in the sheet;
- a 34 km climb to 2,000 m (Dehradun to Mussoorie profile);
- the what-ifs, a custom price, the details and the keyboard readout;
- compact mode while driving;
- the SmartDrive summary;
- an EV city trip;
- offline elevation, and clearing the route.

The service worker was tested on its own:

- installed, then `garage.html` reloaded offline and opened in a fresh tab offline;
- the map shell opened offline;
- the lazily loaded garage files served from the cache.
