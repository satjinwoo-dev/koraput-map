# Known hospital locations (government directory)

This folder is empty until you import a directory. The Ride Plan then shows these hospitals along a route as **known locations**, next to what OpenStreetMap maps. They are not verified: a directory can be years old, a hospital can have moved or closed, and geo-codes are often approximate. The app says "known location (government directory, may be out of date: call ahead)" and never presents them as a guarantee of care.

1. Download a directory **with coordinates**. For example, data.gov.in publishes the National Hospital Directory with geo-codes under the Government Open Data License – India (free, commercial use allowed, with attribution).
2. Import it (one file per source; `--state` keeps one state only):

```bash
node scripts/master/import-hospitals.mjs hospitals.csv --id nhd-geocode \
  --name "National Hospital Directory with Geo Code" --url "<download page>" \
  --licence "Government Open Data License - India" --state Odisha
```

3. Restart the server. `GET /api/master/status` shows how many were loaded and from which sources.

Rows without usable coordinates are skipped, never guessed. The format is in `lib/master/hospitals.js`.
