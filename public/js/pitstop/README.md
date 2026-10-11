# Convoy & pitstop planner (`public/js/pitstop/`)

For a group trip or meetup, this planner works out who will need fuel or charge first and where the group should stop. It also gives every rider's trip cost, each worked out with their own bike.

**Opening it:** group-trip panel → **Plan fuel stops** (`#pitstop-plan-btn`). It opens the `#pitstop-panel` overlay: a bottom sheet on phones, a right-hand panel from 900 px. The stops are drawn on the map as numbered pins. A stop with no station shows as an amber dashed stretch of road.

| File | What it does |
|---|---|
| `plan.js` | Pure planning, in strict SI. See the functions below. |
| `stations.js` | Fuel pumps and chargers along the route from OpenStreetMap. One Overpass query per route, cached for 7 days in `mu-pitstop-v1`, then projected onto the route. Only route coordinates are sent. |
| `convoy-panel.js` | The overlay. `statusFor`, `levelSeries`, `kmText`, `durText` and `energyText` are pure and tested. |
| `convoy-panel.css` | Styles: the panel, the map pins. |
| `pitstop-app.js` | Wiring to the app. It loads the files above on first use and builds the model from app state. `myShare()` returns the payload a server can relay. |

`plan.js` has these main functions:

- **`cumulative()`:** a rider's energy along the route.
- **`reach()`:** how far a budget gets a rider. For EVs, it's the first point where they'd run out, so regenerating downhill can't make them skip a crossing.
- **`planConvoy()`:** every rider's status and the communal stops.
- **`costs()`:** each rider's own cost, the total, and the even split.

## How the plan is made

1. **Budgets.** Each rider's budget is what's in their tank or battery minus a reserve the plan never touches: 12 % of a tank, 10 % of a battery. Their energy along the route comes from **their own bike**, through `MUTrip.energy`, with the route's hills (Open-Meteo) and traffic. Stops and idling are spread evenly along the route.
2. **The deadline.** If anyone can't reach the destination, the earliest point where somebody hits their reserve is the deadline.
3. **Where to stop.** The group stops at the **last** suitable station before the deadline, because stopping later means fewer stops.
   - It prefers a station that serves everyone who's short, petrol and charging.
   - A pump and a charger within 3 km of each other count as one stop: "Ather Grid + Nayara, pump 1.0 km on".
   - Stations within 3 km of the previous stop are skipped.
   - A rider already on reserve gets the nearest station ahead.
4. **At the stop.** Riders of that kind who still couldn't reach the destination refuel: petrol to a full tank, EVs to 80 %. Charging time assumes a 3 kW charger. Everyone else waits.
5. **Repeat** from that stop until everyone arrives. At most 8 stops; past that, the plan says it couldn't plan the whole way.
6. **No station data** (offline, or nothing mapped): the stop becomes a 15 km stretch of road for the most urgent rider's kind, and the card says so.

**Status** (an icon and words, never colour alone), ranked most urgent first:

1. On reserve now
2. Needs fuel or charge soon (within 40 km)
3. Needs a stop
4. Tight (arrives with less than 15 % above the reserve)
5. Fine to the destination

## Where each number comes from

| What | Source |
|---|---|
| Group, destination, positions | `currentTrip` or `GroupNavigation`, and `friendData`. Rider colours are `routeColors`, the same as their route line on the map. |
| Route | Your road to the destination from the group-trip route layer; otherwise one OSRM request. |
| Your bike | My bike (`MUTrip.app.loadBike()`). |
| Others' bikes | `TripFuel.profiles[id].bike = { bundle, classKey, title, settings }` once the server relays it. Until then, a typical commuter scaled to the km/L they already share, labelled "est.". |
| Levels | In this order: set here (kept on this phone for 6 h, in `mu.pitstop.v1`); shared (`TripFuel.profiles[id].level = { share, at }`); yours estimated from your last full fill-up (the learner's trips since); otherwise "assumed half — set it below". The rider's detail row always says which one. |
| Prices | The rider's ₹/L and ₹/kWh from the trip card, labelled "example" until set. EV cost includes about 12 % charging loss. |

## Server work it's ready for (optional)

Relay `MUPitstop.app.myShare()` (`{ bike, level }`) into each member's `TripFuel.profiles` entry, the same way `setMileage` is relayed today. Nothing else changes.

## Needed in `server.js`

Add `https://overpass-api.de` to the CSP's `connect-src`. That line is in this change.

## Tests

`node --test test/pitstop/*.test.mjs` runs 17 tests:

- **Reach:** exact on a constant-cost road; an EV's regeneration gives the first crossing.
- **Plans:**
  - no stops when everyone has enough;
  - the last station before the deadline;
  - a mixed group choosing a station that serves both, with EVs charged to 80 % and the wait time;
  - a twin stop (charger plus pump);
  - a stretch of road when there are no stations;
  - a rider on reserve getting the nearest station;
  - a rider joining part-way;
  - the ranking order and the status words.
- **Costs.**
- **Real bikes on a 260 km highway:** the Activa needs fuel, the Hunter 350 doesn't, the Ather needs chargers.
- **Stations:** query, parse, projection and merging; network → cache → stale → none.
- **Panel:** the level series, including the refill jump.
- **Wiring:** precache completeness, additive `index.html` edits, and the CSP line.
