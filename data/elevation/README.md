# 30 m terrain model (pilot corridors)

MapUnite's own elevation data, replacing Open-Meteo's 90 m elevation API (its free plan isn't for
commercial use). The phone asks the server (`POST /api/elevation`); the server answers from grids
cut from **Copernicus DEM GLO-30** (ESA / European Union, the default) or **NASADEM** (NASA).
ISRO data (Bhuvan / CartoDEM) is deliberately not used: its terms restrict navigation use and
redistribution.

| file | committed | what |
|---|---|---|
| `corridors.json` | yes | the pilot corridors: id, name, bounding box |
| `grids/<id>.json` | no | the grid (origin, pixel size, size), source, licence credit, files used + SHA-256 |
| `grids/<id>.f32` | no | heights, Float32 little-endian, row 0 = north, NaN = void (~35 MB for both corridors) |
| `grids/_downloads/` | no | the source tiles, kept so a rebuild needs no network |

## Build (on the server, once per corridor change)

```
node scripts/elevation-ingest.mjs                     # Copernicus GLO-30 from the public AWS bucket, no account
node scripts/elevation-ingest.mjs --only rourkela     # one corridor
node scripts/elevation-ingest.mjs --source nasadem --from ~/nasadem   # NASADEM N18E082.hgt files you downloaded
```

Then restart the server. `ELEVATION_DIR` points it elsewhere. Without grids the app works, and
routes are shown flat with "no terrain data here yet".

## What the numbers are

- 1 arc-second grid (~30 m), heights in metres above the EGM2008 geoid (Copernicus) or EGM96
  (NASADEM). A **surface** model: trees and roofs are included, bridges are not the road (the gradient
  module fixes bridges and tunnels from OpenStreetMap).
- Lookups interpolate bilinearly between the four surrounding pixel centres; beside a void, the nearest
  valid one is used; all void, or outside every corridor: `null`, never a guess.
- Every answer carries the source's credit line (from `data/sources.json`), and the gradient sheet shows it.

## Adding a corridor

Add `{ "id", "name", "bbox": { "s", "w", "n", "e" } }` to `corridors.json` and run the script with
`--only <id>`. A 0.8° × 0.7° box is ~29 MB of heights in memory.
