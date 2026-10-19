# MapUnite Ride Plan (trip intelligence)

Before a ride, the rider picks a destination, the day and time they'll leave, how often they want a break, and (optionally) how far a full tank goes. MapUnite then reads up to three routes and reports on each one. The rider chooses the route and the stops; the plan only informs.

Every part of the plan shows **its source, when its data was made, how far to trust it, and "estimate" where it is one**. Where there is no data, it says so instead of guessing.

| File | What it does |
|---|---|
| `rideplan-app.js` | The sheet in the route preview ("Ride plan"), the plan's screen, the rider's choices (`mu.rideplan.v1`). |
| `schedule.js` | Hyper-Vision's scheduler (pure, runs on the phone): the rider's stop-by-stop plan, its reasons, and advice. |
| `hypervision-app.js` | Hyper-Vision in the plan's screen (inputs, editable timeline, "Start with this plan") and the next-stop line in the turn banner during the ride. |
| `stop-ask.js` | After a ride: "Did you stop at one of these?" for long stops (opt-in, never automatic). |
| `lib/master/rideplan.js` | `/api/master/ride-plan`: the report for each route. |
| `lib/master/metno.js` | MET Norway's forecast, fetched by our server only. |
| `lib/master/nasapower.js` | NASA POWER: the month's usual weather when no forecast reaches the ride day. |
| `lib/master/place-ratings.js` | Riders' 👍/👎 for places they said they stopped at. |
| `lib/master/hospitals.js` | Known hospital locations from a government directory (imported). |

## Hyper-Vision: the rider's own schedule

Inputs → the route's data → a stop-by-stop schedule → the rider reviews and edits it → it follows them on the ride.

| Input | From |
|---|---|
| When they leave | the plan's "When will you leave?" |
| Longest ride without a break (1–3 h) | the plan's "Ride without a break up to" |
| Cruising speed (40–80 km/h) | Hyper-Vision; riding time is never quicker than the router's, and an average below the cruising speed (×0.8: towns, villages, overtaking) |
| Fuel now (full, ¾, ½, ¼), full-tank range, km/L | Hyper-Vision; km/L from My bike when it's set (the bike, pillion and luggage are in it), else the rider's own number |
| Stay at the destination | Hyper-Vision, for the way back |
| Arrive by (optional) | Hyper-Vision |

How a stop is chosen, in riding order: a **break** when the riding since the last stop reaches the rider's limit; **breakfast / lunch / dinner** where the ride is in the meal's window (7:30–9:30, 12:30–14:30, 19:30–21:30; up to 45 min early rather than a break and a meal minutes apart); **fuel** at the last mapped pump before the tank reaches its reserve (a fifth of a full tank). If there's none, the first pump the reserve still reaches, said plainly; if none either, a warning and the plan stops counting fuel. Things due within 20 minutes of each other share one stop. No stop in the last 20 minutes. The place is the riders' best-rated nearby (3 ratings or more), else the nearest mapped one; with nothing mapped, "somewhere safe off the road".

Every stop lists its reasons. The arrival is a range (5 % earlier to 15 % + 10 min later than the estimate). Advice: minutes of riding in the dark and the daylight window — leave after first light, early enough to arrive before sunset even with delays (the next morning when leaving after sunset; "longer than one day's daylight" when it can't fit); the latest departure for "arrive by"; the way back after the stay, with its dark riding and when to start back in daylight (or "stay the night"); forecast warnings at the time the plan reaches them; riders' confirmed hazards.

**Edit mode: the plan becomes the rider's.** "Edit this plan" turns MapUnite's stops into the rider's own. They can tap any stop and change what it is (break, meal, fuel, or break/meal + fuel), how long (±5 min or 10–60), where (a slider over the whole route, or one of the mapped places within 30 km, with riders' ratings), add a note, or remove it; "+ Add a stop" adds one between any two. Two stops within 1 km become one. MapUnite times the rider's plan and checks it — over their riding limit (from where to where), fuel on reserve or running out, a meal time spent riding — and never changes it. "Fill the gaps" adds MapUnite's stops around theirs only when asked (their meal counts as that meal; nothing lands straight after their stop). Undo steps back; "MapUnite's plan" starts over.

"Start with this plan" keeps it on the phone (`mu.hypervision.plan.v1`). During that ride, a line in the turn banner shows the next planned stop, minutes ahead of / behind the plan and the arrival moved to match. A start more than 10 minutes off the plan moves the plan to the real start (once); a plan more than 6 hours off isn't used for this ride. It's cleared when the trip ends.

## Data in v1 (all free; nothing paid, nothing scraped)

| Part | Source | Shown as |
|---|---|---|
| Routes, times | OSRM (the app's router) | Fastest and Best, with the exact trade-offs. Times are estimates. |
| Fuel, hospitals, mechanics, tyres, hotels, dhabas, tea, police, toilets | OpenStreetMap (Overpass), with OSM's own data time | Counts, km marks, the longest stretch without fuel / a hospital / a mechanic. |
| Known hospitals | Government hospital directory (import with `scripts/master/import-hospitals.mjs`) | "Known location: may be out of date, call ahead". Never "verified". |
| Stop picks | OSM places, ranked by MapUnite riders' ratings (3 or more) | 👍/👎 from riders who said they stopped there; else nearest first. |
| Weather on the day | MET Norway (server-side, User-Agent per MET's terms) | Hourly near the ride, 6-hourly further; "less certain" past 3 days; about 9 days ahead at most. |
| Weather further ahead | NASA POWER monthly climatology | "Usual weather in <month> (not a forecast)", with the averaging period. |
| Rider road reports | MapUnite RoadPulse (published, reviewed reports) | Status (confirmed / reviewed report / disputed / may be repaired), how many riders agree, last seen. |
| Road | OpenStreetMap | Breakers, level crossings, mapped hazards, unpaved or bad km. "Not mapped" isn't "not there". |
| Hills | Copernicus GLO-30 (30 m), where our corridors cover | Climb, descent, steepest 200 m. Ground heights, not the road's exact slope. |
| Accidents | Official blackspot lists loaded on the server only | MoRTH's definition: a ~500 m stretch with 5 serious crashes or 10 deaths in 3 years. Not a road's full accident history. Without a list: "no official accident data loaded". |
| Daylight | Computed (sun position) | Setting off or arriving in the dark. |
| Fuel range | The rider's own full-tank range | A warning when a stretch without fuel is more than 80 % of it. |

## Next (v2), and why not yet

| Source | What it would add | Why later |
|---|---|---|
| NDMA SACHET (CAP alerts) | Official heavy-rain / cyclone / flood alerts on the route | The feed's format and areas need checking against the live feed (blocked from our build sandbox). |
| NASA GPM IMERG | Heavy rain in the last day or two: wet roads, flooding risk | Needs a NASA Earthdata login and a server job to fetch the grids. |
| NASA FIRMS | Satellite fire alerts near forest roads ("satellite fire alert", never "fire confirmed") | Needs a free FIRMS map key. |
| Overture Maps Places | Places OSM is missing | A large download to process on the server (with the OSM extract below). |
| Geofabrik OSM extract on our server | No dependence on the public Overpass server, long routes fast | Server storage and a daily import job. |
| OpenCelliD | Stretches with few mobile towers ("estimate") | Needs a key and a large download. |
| Valhalla | Motorcycle routing, rider-suitable alternatives | Its own server to host. |
| data.gov.in road-accident statistics | District/state context ("Koraput district, 2023") | Aggregates only; shown as context, never per road. |
| Mapillary, Open Charge Map, toll rates | Street photos, EV charging, toll cost | Lower priority for riders now; licences to confirm. |

Not used, on purpose: Google Places reviews (paid, and their display and storage terms), scraping any website (reviews, fuel-company pump locators), Bhuvan (dropped by product decision).
