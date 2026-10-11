# MapUnite garage: "My bike" (`public/js/garage/`)

The bike picker, the rider's settings and the physics visualizer. Plain JavaScript with JSDoc types (`tsc -p tsconfig.garage.json`), no framework and no build step. It uses the app's design tokens (`--ink`, `--mint`, Sora / Inter) with fallbacks, so it looks native inside the app and also works on its own page, `public/garage.html`.

| File | What it does |
|---|---|
| `units.js` | The **only** place SI becomes km/h, rpm, km/L, Wh/km and km. Numbers are grouped Indian-style. |
| `store.js` | Data layer: catalogue (network first, cached fallback), bundles (cache first, checked against their SHA-256 name), the rider's bike and settings (on the phone), and the missing-bike request outbox. |
| `silhouettes.js` | Original line drawings, one per class, shown when `image_url` is null. |
| `picker.js` | Type-ahead search over the offline catalogue, then the model year, or "My bike isn't listed": pick the closest type (marked *estimated*) and optionally ask for the bike to be added. |
| `settings.js` | Rider weight, usual pillion and luggage, sprockets (manual bikes), rear tyre, and the fuel in the tank. |
| `visualizer.js` | The chart, the headline, the shift guide and a table view. `prepareChart()` is pure and tested. |
| `garage.js` | `MUGarage.mount(root, { store, physics })` puts it all together. |
| `garage.css` | Styles, scoped under `.mu-garage`. |

## What the rider sees

- **Headline:** the eco band in big numerals ("Best mileage 31–41 km/h") and what it's worth ("About 54.8 km/L at 36 km/h"). EVs show "Longest range" and km per charge.
- **What-if controls:** road (flat, 3 % and 6 % climbs, 3 % downhill) and load (solo or with pillion) in one row above the chart. The table recomputes in under 1 ms.
- **The chart.** Everything shares one speed axis:
  - **The curve:** km/L for petrol bikes. EVs plot energy use in Wh/km, which stays linear and drops below zero when the motor recharges; range stays in the headline and tooltip.
  - **±1σ ribbon:** the likely range.
  - **Eco band:** lit on the speed scale.
  - **Hatching:** speeds the bike can't hold on that road.
  - **"No fuel" / "charging" labels:** where the fuel-injection cut or regeneration means nothing is spent.
  - **Gear ribbon:** the gear the physics picks at each speed, in a validated one-hue ramp. It shows the downshifts on a steep climb.
- **Readout:** on wide screens, a crosshair tooltip snaps to the nearest speed. On phones (< 560 px) the readout is docked above the chart and always shows a speed, so it never covers the curve. The chart is keyboard-operable: focus it, then ←/→ in 5 km/h steps, Home/End, Esc.
- **Shift guide (manual bikes):** for each gear change, the easy-riding and full-throttle speeds with rpm, and a note where the redline comes first.
- **"Show the numbers":** the table every 10 km/h, which is the chart's accessible twin.
- **Rules from the plan:**
  - **Gear advice (C4):** only shown when the bike's own gearing is known. Never for CVT scooters, EVs, bikes whose gearing comes from the class default, or "typical" (estimated) bikes.
  - **Fuel safety:** a fuel is only called "approved" when the bundle's `fuelAdvice` lists it. Any other choice shows a warning to check the owner's manual. Flex blends are hidden unless the engine is certified flex-fuel.
  - **Estimates are labelled:** every fallback the physics used is listed under "Some numbers are estimated".

## Offline and privacy

- **Bike list:** `bikedb/catalog.json` is fetched with a 6 s timeout, and the copy saved in Cache Storage is the fallback. In the Android app it ships inside the app, so search always works offline.
- **Bike data:** each bike's file is fetched once and served from the cache after that. A download whose SHA-256 doesn't match its name is refused, not cached.
- **Your bike and settings:** saved only on the phone (`localStorage`, key `mu.garage.v1`) and never sent anywhere.
- **"My bike isn't listed" requests:** queued in `mu.garage.requests.v1` and sent when there is a connection and a server (`POST /api/bikes/request`).
- **Cache name:** `mu-bikedb-v1`. It deliberately doesn't start with `mapunite-`, because `sw.js` deletes every `mapunite-*` cache but its own on update.

## Wiring it into the app

1. **Build the catalogue:** `node scripts/build-bike-catalog.mjs` writes `public/bikedb/`. `build-native.mjs` already does this for the Android app.
2. **Linked from the map (Step 7, done):** the tool rail (`#garage-btn`), the SmartDrive settings (`#my-bike-section`) and the trip-energy card all open the garage in a sheet over the map (`#garage-modal`). The sheet is mounted by `js/trip/trip-app.js`, which loads `picker`, `settings`, `visualizer`, `garage` and `garage.css` on first open. `garage.html` stays as the full-page version (also a PWA shortcut). Its boot code now lives in `garage-page.js`, because the CSP has no `'unsafe-inline'` for scripts. It also loads `shell.js`, so the service worker is registered even when this page is the first one opened.
3. **Step 5 endpoints:** set `window.MU_GARAGE_API` to the server origin (or `""` for same origin) before `garage-page.js` (map: `trip-app.js`) runs, e.g. from a small script loaded ahead of it, since inline scripts are blocked by the CSP. The store will then:
   - try `GET /api/bikes/bundle/:hash` first, falling back to the static file. The endpoint must return the bundle bytes exactly as built, so the hash check passes.
   - send requests to `POST /api/bikes/request` with `{ description, classKey }`. A 2xx or 4xx response clears the request; a 5xx or network error keeps it queued.
4. **Website offline (Step 7, done):** `sw.js` precaches `garage.html` and every garage, physics and trip script. It serves the cached page when offline, precaches the fonts stylesheet and its Latin files, and seeds the bike list into `mu-bikedb-v1` on install. `/bikedb/` requests bypass the service worker, because the store does its own verified caching there.

## Tests

`node --test test/garage/*.test.mjs` runs 19 tests:
- the units;
- the store against fake network, Cache Storage and localStorage: offline fallback, a malformed catalogue never replacing the cache, tampered bundles refused, endpoint-then-static order, the localStorage fallback, the garage following data corrections, settings sanitising, the request outbox;
- settings validation and the fuel rule;
- chart preparation for petrol (flat, climb, descent), CVT, EV (energy below zero downhill) and estimated bikes;
- the gear ribbon only appearing under C4;
- silhouettes.

The DOM was also exercised in headless Chromium, at 390 px and 1280 px, across these flows: search, year, a manual bike, CVT, EV, "not listed" with a typical bike and a request, the what-if controls, keyboard on the chart, persistence across reloads, and offline loading from the cache.
