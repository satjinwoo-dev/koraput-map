# Gradient from elevation (`public/js/gradient/`, roadmap step 9)

Turns terrain heights into the grades of the **road**, fixing the sections where the terrain model is wrong: bridges, tunnels and cuttings. It shows the result as an elevation profile that highlights steep climbs and every section it fixed. It works offline.

**Why it's needed:** the Copernicus 90 m DEM (via Open-Meteo) gives the height of the ground. On a river bridge the road is 20–40 m above the valley floor the DEM sees; in a tunnel it's below the hill. Raw, a bridge becomes a 40 % plunge and climb, which wrecks grades, fuel estimates and the HUD's grade under you.

| File | What it does |
|---|---|
| `gradient.js` | `MUGradient.core`: pure, strict SI. `structureIntervals`, `detectSpikes`, `applyStructures`, `sections`, `cappedRuns`, `analyze` (the pipeline), `summarize`, `gradeAt`. |
| `structures.js` | `MUGradient.structures`: OpenStreetMap bridges and tunnels along a route (Overpass), cached for 30 days. |
| `profile-chart.js` | `MUGradient.view`: the profile sheet (chart, tiles, legend, sections table). `niceTicks`, `tableRows` and `provenance` are pure and tested. Loads on first open. |
| `gradient-app.js` | `MUGradient.app`: wiring. `current` is the fixed profile for the route on screen. |
| `gradient.css` | Sheet styles, scoped under `.grd`. The entry button's styles are in `trip.css`. |

## The pipeline (`analyze`)

1. **Samples:** the same samples the trip card uses (`MUTrip.profile.plan` + `resample`). The heights therefore come from the trip card's terrain lookup (`MUTrip.app.elevation`, now exposed), from memory or Cache Storage, with no extra requests.
2. **OSM structures:** highway ways tagged `bridge=*`, `tunnel=*` or `covered=yes` within ~25 m of the route. A way counts only if it runs **along** the route: ≥ 2 of its points within 25 m, covering ≥ 25 m and ≥ 60 % of the way's length. A flyover crossing above you doesn't count. Same-kind sections less than 40 m apart merge.
3. **DEM spikes** (unmapped structures):
   - the terrain dips (or humps) ≥ 6 m below (or above) the straight line between two points ≤ 450 m apart;
   - that line itself is gentler than 10 %;
   - there's a ≥ 10 % step into the dip and another out of it.

   These become "Likely bridge" or "Likely tunnel or cutting". Longer structures (big river bridges) need OpenStreetMap: a real road can dip into a valley, so the detector stays conservative.
4. **Fix:** across each section, the height becomes a straight line between the nearest samples at least 30 m outside it, so it never starts from inside the dip. How far the DEM was off, and the grade the section has now, are reported.
5. **Clean:** the Step 7 `buildProfile` runs on the fixed heights: running median, 250 m smoothing, ±25 % cap. Stretches where the cap still bites are listed as "Terrain too steep, capped".
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
  - saved in `mu-gradient-v1` for 30 days (a stale copy is used offline);
  - only route coordinates are sent; `overpass-api.de` is already in the CSP.
- **Offline with nothing saved:** the profile is flat and says so. With terrain but no OSM data, the spike detector still fixes what it can, and the chips say bridges weren't checked.
- **Offline-ready:** every script and stylesheet is precached by `sw.js`.

## Tests

`node --test test/gradient/` (9 tests):
- a bridge along the route vs a crossing flyover;
- spikes vs a genuine climb;
- the straight-line fix;
- the whole pipeline removing a bridge dip, with and without OSM;
- capping;
- Overpass query, parsing and caching;
- the chart's tick, table and provenance helpers;
- section merging.
