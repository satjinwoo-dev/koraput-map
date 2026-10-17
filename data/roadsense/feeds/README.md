# RoadSense feeds: official lists and model predictions

Drop GeoJSON `FeatureCollection` files (`*.geojson`) here, or set `ROADSENSE_FEEDS_DIR`. The server reads them at start (`lib/master/roadsense-feeds.js`). Their items are served with riders' evidence by `/api/master/roadsense/area` and judged by the same rules (`public/js/master/roadsense/roadsense.js`).

**No list ships with the app.** No MoRTH, NHAI, municipal or SACHET list with coordinates for Koraput–Araku was found published. Add one only from its publisher, with its name in `ref` and its own dates.

## Format

Each feature is a `Point`, or a `LineString` for a closed stretch, which is sampled every 100 m. Its `properties`:

| Property | Required | Meaning |
|---|---|---|
| `id` | yes | Stable id from the source list (letters, digits, `_ . : # -`, ≤ 64 characters). Re-importing updates it. |
| `type` | yes | `roadworks`, `waterlogging`, `pothole`, `debris`, `gravel`, `rough`, `speed_breaker`, `animal` or `bump`. |
| `source` | yes | `official` (a government list) or `prediction` (a model's forecast). |
| `ref` | yes | Who says so, shown and spoken as-is, e.g. `MoRTH roadworks list` or `IMD nowcast + ISRO Bhuvan CartoDEM`. ≤ 80 characters. |
| `published` | yes | ISO time the source published it. |
| `valid_until` | yes | ISO time it stops applying. Items without one are refused: a list that doesn't say how long can't be shown as current. |
| `confidence` | prediction only | 0–1, from the model. Official items use the `official` prior (0.95) unless given. |
| `url` | no | https link to the source. |
| `detail` | no | ≤ 200 characters. |

```json
{ "type": "FeatureCollection", "features": [
  { "type": "Feature", "geometry": { "type": "LineString", "coordinates": [[82.71, 18.81], [82.72, 18.81]] },
    "properties": { "id": "example-1", "type": "roadworks", "source": "official", "ref": "<publisher's list name>",
                    "published": "2026-10-01T00:00:00Z", "valid_until": "2026-11-15T00:00:00Z" } } ] }
```

## How they're treated

| Source | Treatment |
|---|---|
| **Official** | Verifies on its own until `valid_until`. Shown as *Official: <ref>* and spoken as "sarkari jaankari … <ref> ke mutaabik". |
| **Prediction** | Never verifies, never counts as a rider, never clears a report. Shown as *AI prediction · <ref> · not seen by anyone* and spoken after the evidence as "ek anumaan bhi hai … kisi ne dekha nahi". |

`createWaterloggingPredictor({ rule })` (low-lying ground from an elevation model + a rain nowcast) stays **off** until its thresholds are given with their source: `minRainMmPerHour`, `maxReliefM`, `conf`, `ref`. None are set by default.
