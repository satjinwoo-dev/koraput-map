# MapUnite garage: "My bike" (`public/js/garage/`)

The bike picker, the rider's settings and the physics visualizer. Plain JavaScript with JSDoc types (`tsc -p tsconfig.garage.json`), no framework and no build step. It uses the app's design tokens (`--ink`, `--mint`, Sora / Inter) with fallbacks, so it looks native inside the app and also works on its own page, `public/garage.html`.

| File | What it does |
|---|---|
| `units.js` | The **only** place SI becomes km/h, rpm, km/L, Wh/km and km. Numbers are grouped Indian-style. |
| `store.js` | Data layer: catalogue (network first, cached fallback), search (offline index, plus the server when its catalogue is newer), bundles (cache first, checked against their SHA-256 name), the rider's bike and settings (on the phone), and the missing-bike request outbox. |
| `silhouettes.js` | Original line drawings, one per class, shown when `image_url` is null. |
| `picker.js` | Type-ahead search (offline index instantly, `GET /api/bikes/search` alongside), then the model year, or "My bike isn't listed": pick the closest type (marked *estimated*) and optionally ask for the bike to be added (make, model, year). |
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
  - **Gear advice (C4):** decided by the physics core, not the UI. `model.gearAdvice` is false, with a reason in `model.gearAdviceReason`, for CVT scooters, EVs, typical (estimated) bikes, gearing borrowed from the class default, and inconsistent or low-confidence ratios. `shiftPoints()` then returns no shift speeds. The gear ribbon and the shift guide only show what the core returns, and the shift guide explains the reason.
  - **Fuel safety:** a fuel is only called "approved" when the bundle's `fuelAdvice` lists it. Any other choice shows a warning to check the owner's manual. Flex blends are hidden unless the engine is certified flex-fuel.
  - **Estimates are labelled:** every fallback the physics used is listed under "Some numbers are estimated".

## Offline and privacy

- **Bike list:** `bikedb/catalog.json` is fetched with a 6 s timeout, and the copy saved in Cache Storage is the fallback. In the Android app it ships inside the app, so search always works offline.
- **Bike data:** each bike's file is fetched once and served from the cache after that. A download whose SHA-256 doesn't match its name is refused, not cached.
- **Your bike and settings:** saved only on the phone (`localStorage`, key `mu.garage.v1`) and never sent anywhere.
- **"My bike isn't listed" requests:** queued in `mu.garage.requests.v1` and sent when there is a connection and a server (`POST /api/bikes/requests`). If the server already lists the bike, the garage offers it ("Use it" / "Not my bike").
- **Cache name:** `mu-bikedb-v1`. It deliberately doesn't start with `mapunite-`, because `sw.js` deletes every `mapunite-*` cache but its own on update.

## Wiring it into the app

1. **Build the catalogue:** `node scripts/build-bike-catalog.mjs` writes `public/bikedb/`. `build-native.mjs` already does this for the Android app.
2. **Link the page:** for example in the SmartDrive settings, next to "My fuel curve":
   ```html
   <a class="btn-secondary-nav" href="garage.html">My bike</a>
   ```
   Or mount it in any sheet: load the scripts in the order used by `garage.html`, then call
   `MUGarage.mount(el, { store: MUGarage.store.createStore({ search: BikeCatalogSearch, physics: MUPhysics }), physics: MUPhysics })`.
3. **Step 5 endpoints** (`lib/bikedb/http-api.js`): `window.MU_GARAGE_API` is the server origin (`""` = this page's origin, `null` = no server).
   - **Defaults.** On the website it defaults to the page's own origin, since `server.js` serves both. In the Android app, `scripts/build-native.mjs` sets it to `MU_SERVER_ORIGIN`. The app's own origin (`https://localhost`, `capacitor:`) is never used as the server.
   - **Search.** The offline index answers instantly. `GET /api/bikes/search?q=…&limit=30` is asked too, debounced. If the server has the same `catalogVersion`, its answer is identical (it ranks with the same code), so it isn't asked again that session. If the server's catalogue is newer, its results replace the list, so a bike added since the phone's `catalog.json` can be found and picked.
   - **Bundles.** The shipped or static copy is used first: inside the Android app it is packaged, offline and instant. `GET /api/bikes/bundles/<hash>` is the fallback, for a bike newer than the app. Both are checked against the hash.
   - **Requests.** `POST /api/bikes/requests` with `{ make, model, year, powertrain, note }`, where the powertrain and note come from the closest type the rider picked.
     - Cleared: 2xx (a `"listed"` answer is offered to the rider), and 400 / 413 / 415, which the server will never accept.
     - Kept for later: no network, 403, 404, 429 and 5xx.
4. **Website offline:** to make `garage.html` and `js/garage/*` work offline on the web, add them to `OPTIONAL_PRECACHE` in `sw.js` and bump its `VERSION`. The bike data has its own cache either way.

## Tests

`node --test test/garage/*.test.mjs` runs 33 tests. `integration.test.mjs` runs the store against the real Step 5 router, as the website (one origin) and as the Android app (packaged `www/`, API cross-origin from `https://localhost`, CORS checked on every answer). It also checks which server `garage.html` talks to. The rest (`garage.test.mjs`) covers:
- the units;
- the store against fake network, Cache Storage and localStorage: offline fallback, a malformed catalogue never replacing the cache, tampered bundles refused (from the static copy and from the API), static-then-endpoint order, the localStorage fallback, the garage following data corrections, settings sanitising, search (same or newer server catalogue, offline and errors), the request outbox and "already listed" offers;
- settings validation and the fuel rule;
- chart preparation for petrol (flat, climb, descent), CVT, EV (energy below zero downhill) and estimated bikes;
- the gear ribbon only appearing under C4;
- silhouettes.

The DOM was also exercised in headless Chromium, at 390 px and 1280 px, across these flows: search, year, a manual bike, CVT, EV, "not listed" with a typical bike and a request, the what-if controls, keyboard on the chart, persistence across reloads, and offline loading from the cache.
