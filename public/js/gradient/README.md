# Gradient from elevation (`public/js/gradient/`, roadmap step 9)

Turns terrain heights into the grades of the **road**, fixing the sections where the terrain model is wrong: bridges, tunnels and cuttings. It shows the result as an elevation profile that highlights steep climbs and every section it fixed. It works offline.

**Why it's needed:** the Copernicus 90 m DEM (via Open-Meteo) gives the height of the ground. On a river bridge the road is 20–40 m above the valley floor the DEM sees; in a tunnel it's below the hill. Raw, a bridge becomes a 40 % plunge and climb, which wrecks grades, fuel estimates and the HUD's grade under you.

| File | What it does |
|---|---|
| `gradient.js` | `MUGradient.core`: pure, strict SI. `analyze` (the shared pipeline, reported), `cappedRuns`, `sections`, `summarize`, `gradeAt`. |
| `profile-chart.js` | `MUGradient.view`: the profile sheet (chart, tiles, legend, sections table). `niceTicks`, `tableRows` and `provenance` are pure and tested. Loads on first open. |
| `gradient-app.js` | `MUGradient.app`: wiring. Gets the bridges and tunnels from `MUTrip.structures` (the trip card's own, one cache); `current` is the fixed profile for the route on screen. |
| `gradient.css` | Sheet styles, scoped under `.grd`. The entry button's styles are in `trip.css`. |

## The pipeline (`analyze`)

There is **one** bridge-and-tunnel pipeline in the app: `js/trip/structures.js` inside `MUTrip.profile.buildProfile` (roadmap Step 9). The trip card, the convoy planner, the fuel estimate and this sheet all use it, so they never disagree about a bridge. This folder only reports what it did.

1. **Samples:** the same samples the trip card uses (`MUTrip.profile.plan` + `resample`). The heights therefore come from the trip card's terrain lookup (`MUTrip.app.elevation`), from memory or Cache Storage, with no extra requests.
2. **OSM structures** (`MUTrip.structures.createStructures().along(route)`): highway ways tagged `bridge=*` (not "no"), `tunnel=yes` or `avalanche_protector` within 25 m of the route, one Overpass query per route. A flyover crossing above the route isn't on it.
3. **Terrain tell-tales** (unmapped structures, inside `buildProfile`): a stretch ≤ 1.5 km long lying at least 8 m below (or above) the surrounding ground line, entered and left by a step steeper than 15 %, with the ground on either side no more than 10 % apart. No public road does that; a DEM does exactly that at the edges of a bridge or tunnel. These become "Likely bridge" or "Likely tunnel or cutting".
4. **Clamp:** across each span the height becomes a straight line between the heights just beyond its two ends. `analyze` reports how far the DEM was off inside it, and the grade it has now.
5. **Clean:** `buildProfile` goes on with its running median, 250 m smoothing and ±25 % cap. Stretches where the cap still bites are listed as "Terrain too steep, capped".
6. **Sections:** steep is ≥ 6 %, very steep is a ≥ 10 % stretch of at least 100 m. Climbs (or descents) less than 200 m apart merge, because a short easing doesn't end a climb. Runs under 150 m are dropped.

## Where it shows

- **"Gradient & bridges"** sits under the trip card's elevation chart, with a one-line summary: "4 steep climbs · 3 fixed · max 13 %".
- **The sheet:**
  - provenance chips (terrain from Copernicus or saved on the phone; bridges and tunnels from OpenStreetMap, from the saved copy, or not checked offline);
  - five tiles;
  - the chart: road height in mint; steep stretches amber, very steep red-orange, with a ▲/▼ lane so climb vs descent never rests on colour; fixed sections as grey bands with an icon and word, the raw terrain line faintly inside them; "You" while navigating;
  - a crosshair and tooltip (pointer, or ← → Home End on the keyboard);
  - a legend;
  - the **Sections** table (the chart's table twin), with a filter row (All · Climbs · Descents · Bridges & tunnels) and "Show on map" for each row, which draws the section on the map for 20 s.
- **The HUD:** `MUGradient.app.current` (when the profile is real terrain) replaces the trip card's profile for the grade under you, so the live estimate no longer sees bridge plunges.

## Network and offline

- **Terrain:** Open-Meteo elevation, shared with the trip card, saved in `mu-trip-v1`.
- **Bridges and tunnels:**
  - one Overpass POST per route, made only when navigation starts or the rider opens the sheet;
  - saved in `mu-trip-v1` for 30 days, shared with the trip card (a stale copy is used offline);
  - only route coordinates are sent; `overpass-api.de` is already in the CSP.
- **Offline with nothing saved:** the profile is flat and says so. With terrain but no OSM data, the terrain tell-tales still fix what they can, and the chips say bridges weren't checked.
- **Offline-ready:** every script and stylesheet is precached by `sw.js`.

## Tests

`node --test test/gradient/`:
- the bridge dip disappears from the grades (OSM spans, and the terrain tell-tales alone), against a naive profile with no structures; steep sections are found and graded;
- terrain still unbelievable after cleaning is capped and reported; no data gives a flat profile that says so;
- "one pipeline": the sheet's profile is exactly the trip card's `buildProfile` with the same spans;
- section merging;
- the chart's tick, table and provenance helpers.

The detector, the along-the-route rule (a crossing flyover doesn't count) and the Overpass client are tested in `test/trip/`.
