# Ride summaries & privacy (`public/js/rides/`, roadmap step 10)

Three things:

1. **Ride summaries on this phone.** Every finished drive becomes a record in the ride log (localStorage `mu_ride_summaries_v1`), and a dashboard shows them. They are never uploaded.
2. **Anonymous full-tank data, opt-in.** The consent screen and client side of [`FLEET.md`](../../../FLEET.md): tanks go to `POST /api/bikes/fillups` (`lib/bikedb/fleet.js`) for the Step 11 cloud calibration.
3. **"Delete my history".** One place to wipe everything personal the app holds: rides, fill-ups and fuel curve, shared fuel data, offline route caches, and optionally the existing server history.

| File | What it does |
|---|---|
| `ride-log.js` | `MURides.core`: pure, strict SI. The ride accumulator (speed bands and 5 km/h bins, moving and idle time, coasting, hard braking), the ride log (≤ 400 rides, ≤ 365 days; `get`, `remove`, `clear`) and the fleet share (consent, contributor token, sending, erasure on opt-out, `shouldAsk`, `preview`). |
| `ride-model.js` | `MURides.model`: pure, strict SI. `fromTripEnd`, `merge`, `rideName`, `economy`, `rollup` (7 days, 30 days, 12 months, all), `routePath` (a north-up SVG path, no map tiles), `simplify` (≤ 160 points). |
| `rides-ui.js` | `MURides.ui`: the dashboard. `tiles`, `dur`, `byDay` and `ecoWord` are pure and tested. Loads on first open. |
| `consent-ui.js` | `MURides.consent`: the consent screen and the Delete my history dialog. `tankInWords` is pure. Loads on first open. |
| `rides-app.js` | `MURides.app`: wiring. SmartDrive's hooks, the HUD's totals, sending, entry points and triggers. |
| `rides.css` | Styles, scoped under `.rds` and `.cst`. Modal shells are in `trip.css`. |

**Server:** nothing new for this folder. The tanks use the Step 11 routes in `lib/bikedb/http-api.js` (`POST` / `DELETE /api/bikes/fillups`), with their own body limit and rate limit.

## Ride summaries

**Recording:**
- SmartDrive's hooks feed the accumulator during the ride (it's kept in the ride itself, so a restored ride keeps it).
- At the end of the ride, `finish()` makes the record: distance, times, speeds, bands and bins, coasting, hard brakes, the fill-ups logged during the ride, the fuel estimate and where it came from, the bike, the nearest town, and the route simplified to ≤ 160 points. The record id is `ride-<start time>`, and `mu:ride-saved` announces it.
- `mu:ride-summary` (the HUD) merges its physics totals into the same record: distance, moving time, fuel or battery energy, cost, eco score, harsh moments. Either can arrive first: the record is looked up by id, and the log's own fields survive the merge.
- Rides under 200 m aren't kept.

**Opening it:** settings → **Ride summaries**, or **All rides** in the trip summary. Inside:
- one filter row (7 days · 30 days · 12 months · All) scoping everything below it;
- six tiles: rides, distance, riding time, fuel (or energy), spent, eco score. The cost tile says "8 of 9 rides priced" instead of counting an unpriced ride as ₹0, and the eco score is distance-weighted over scored rides only;
- a bar chart (one series, mint) of distance per day or month, with a hover or focus tooltip; clicking a bar narrows the list to it, and **Table** shows the same numbers;
- the ride list, grouped by day;
- each ride: a north-up drawing of the route (drawn here, no tiles fetched), its stats, how the numbers were made, **Share card** and **Delete this ride**;
- a **Your data** card: where rides live, sharing status (Learn more / Manage) and **Delete my history**.

## Anonymous fuel data (FLEET.md)

- **When it asks:** once, right after a fill-up makes the first usable full-to-full tank (`FuelCurve.fleetTanks()`). Never during a ride, never for an EV, never when the app has no server. "Not now" means not again for 60 days. It's also reachable any time from settings or the dashboard.
- **The screen:**
  - "What's shared" and "Never shared" in plain words: distance and litres, time in 5 km/h speed ranges, idling, the weight on the bike rounded to 5 kg and the fuel grade. No places, routes, dates (not even the month), odometer or device ids;
  - the rider's own latest tank as it would be sent ("412 km on 11.45 L · 18 % under 40 km/h …");
  - **See exactly what's sent**: the real request from `preview()`, with the contributor token replaced by a placeholder;
  - the fine print: a random token, not linked to the account (the server keeps a keyed hash of it); a class is only fitted with at least 5 riders, and a person reviews every change; 24-month retention; turning it off deletes everything;
  - two equal buttons, nothing pre-ticked. "Not now" gets the focus, but the screen opens at the title.
- **Once on:** new usable tanks are sent after each fill-up and ride, when the app starts online (at most every 10 minutes), and on `online`. The manage screen shows the count and offers **Stop sharing and delete**.
- **Off:** sends `DELETE /api/bikes/fillups` with the token. Offline, the erasure is retried until the server confirms it, even after the token is gone from view. Opting in again makes a new, unrelated token.

## Delete my history

The rider ticks what to erase; everything is ticked except the server history:
- ride summaries;
- the fill-up log and fuel curve (`FuelCurve.reset()`);
- shared fuel data (opt-out and server erasure);
- offline route data (`mu-trip-v1` and `mu-pitstop-v1` in Cache Storage, which hold the shapes of routes looked at and the bridges and tunnels along them);
- and, optionally, the existing server history (trips, breadcrumbs, memories, chat), which opens the app's own `#clear-history-btn` flow with its confirmation.

One confirmation follows, then a result line for each item. The app's existing "Clear my history" calls the same `clearAll()`.

## Tests

- `node --test test/rides/`: the accumulator (bands, coasting, hard brakes), the ride log's limits, nothing sent before opt-in, exactly-once sending after, erasure on opt-out (offline → pending → finished), the consent bookkeeping (ask once, 60 days after "Not now", never without a server), the exact preview payload, ride records and merging in either order, rollups and the view helpers.
- The server side of the tanks is tested in `test/fleet/`.
