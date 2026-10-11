# Ride summaries & privacy (`public/js/rides/`, roadmap step 10)

Three things:

1. **Ride summaries on this phone.** Every finished drive becomes a record in IndexedDB, and a dashboard shows them.
2. **Anonymous tank telemetry, opt-in.** This implements [`FLEET.md`](../../../FLEET.md) v1: the consent screen, the client queue, and server-side deletion.
3. **"Delete my history".** One place to wipe everything personal the app holds: rides, fill-ups and fuel curve, shared fuel data, offline route caches, and optionally the existing server history.

| File | What it does |
|---|---|
| `ride-model.js` | `MURides.model`: pure, strict SI. `fromTripEnd`, `merge`, `rideName`, `economy`, `rollup` (7 days, 30 days, 12 months, all), `routePath` (a north-up SVG path, no map tiles), `simplify` (≤ 160 points). |
| `ride-store.js` | `MURides.store`: IndexedDB `mu-rides` v1 with a memory fallback (private windows), keeping the newest 1 000 rides. |
| `fleet.js` | `MUFleet`: the FLEET.md contract (`coarsen`, `validateTank`, `validateEnvelope`), **shared with the server**, plus `createFleetClient` (consent, contributor secret, queue, back-off, opt-out with DELETE). |
| `rides-ui.js` | `MURides.ui`: the dashboard. `tiles`, `dur`, `byDay` and `ecoWord` are pure and tested. Loads on first open. |
| `consent-ui.js` | `MURides.consent`: the consent screen and the Delete my history dialog. `tankInWords` is pure. Loads on first open. |
| `rides-app.js` | `MURides.app`: wiring, entry points and triggers. |
| `rides.css` | Styles, scoped under `.rds` and `.cst`. Modal shells are in `trip.css`. |

**Server:** `lib/fleet.js` is the reference implementation (Express routes plus SQLite), mounted in `server.js` before the global JSON parser so its own 32 kB limit applies.

## Ride summaries

**Recording:**
- `mu:trip-end` (SmartDrive) creates the record: distance, time, idling, speeds, SmartDrive's fuel estimate, and the route simplified to ≤ 160 points.
- `mu:ride-summary` (the HUD) replaces those numbers with the physics totals: distance, moving time, fuel or battery energy, cost, eco score, harsh moments.
- Both are merged synchronously in memory before writing, so their order doesn't matter.
- Rides under 200 m aren't kept.

**Opening it:** settings → **Ride summaries**, or **All rides** in the trip summary. Inside:
- one filter row (7 days · 30 days · 12 months · All) scoping everything below it;
- six tiles: rides, distance, riding time, fuel (or energy), spent, eco score. The cost tile says "8 of 9 rides priced" instead of counting an unpriced ride as ₹0, and the eco score is distance-weighted over scored rides only;
- a bar chart (one series, mint) of distance per day or month, with a hover or focus tooltip; clicking a bar narrows the list to it, and **Table** shows the same numbers;
- the ride list, grouped by day;
- each ride: a north-up drawing of the route (drawn here, no tiles fetched), ten stats, how the numbers were made, **Share card** (the Step 11 share sheet) and **Delete this ride**;
- a **Your data** card: where rides live, sharing status (Learn more / Manage) and **Delete my history**.

## Anonymous fuel data (FLEET.md)

- **When it asks:** once, right after a fill-up makes the first *usable* full-to-full tank. Never during a ride, never for an EV. "Not now" means not again for 60 days. It's also reachable any time from settings or the dashboard.
- **The screen:**
  - "What's shared" and "Never shared" in plain words;
  - the rider's own latest tank as it would be sent ("285 km on 6.53 L · 63 % under 40 km/h …");
  - **See exactly what's sent**: the real JSON payload from `preview()`, contributor redacted;
  - the fine print: random ID not linked to the account, k = 5, 24-month retention, off any time deletes everything;
  - two equal buttons, nothing pre-ticked. "Not now" gets the focus, but the screen opens at the title.
- **Once on:**
  - new usable tanks are sent after each fill-up, when the app starts online, and on `online`;
  - the manage screen shows the count and offers **Stop sharing and delete**.
- **Off:** sends `DELETE /api/fleet/v1/contributor`. Offline, the delete is retried at the next start before anything else. Opting in again uses a new, unrelated ID, and tank ids are salted with it.

## Delete my history

The rider ticks what to erase; everything is ticked except the server history:
- ride summaries;
- the fill-up log and fuel curve (`FuelCurve.reset()`);
- shared fuel data (opt-out + DELETE);
- offline route data (`mu-trip-v1`, `mu-gradient-v1`, `mu-pitstop-v1`, which hold the shapes of routes looked at);
- and, optionally, the existing server history (trips, breadcrumbs, memories, chat), which opens the app's own `#clear-history-btn` flow with its confirmation.

One confirmation follows, then a result line for each item.

## Server work (done in this step, reference)

`lib/fleet.js` provides:
- `POST /api/fleet/v1/tanks`, `DELETE /api/fleet/v1/contributor` and `GET /api/fleet/v1/bikes/:id/summary`;
- tables `fleet_contributors` and `fleet_tanks`, which store the SHA-256 of the contributor only (no IP, no user agent);
- a daily limit of 200 tanks per contributor;
- 24-month purge.

It is mounted in `server.js` with its own rate limiter. `MU_FLEET_API` (window global) can point the client at another origin.

## Tests

`node --test test/rides/` (10 tests). They use real SQLite (`node:sqlite`) for the server, with the client talking to it through a fake fetch:
- the contract's coarsening and every validation rule;
- nothing sent before opt-in, and exactly-once uploads after;
- opt-out deletion, including offline → pending → finished;
- the 60-day re-ask, back-off and refused tanks;
- server auth, limits, duplicates, partial rejects, k-anonymity, retention, and the exact column list;
- ride records and merging, rollups;
- the memory store and the view helpers.
