# MapUnite Ride Plan (trip intelligence)

Before a ride, the rider picks a destination, the day and time they'll leave, how often they want a break, and (optionally) how far a full tank goes. MapUnite then reads up to three routes and reports on each one. The rider chooses the route and the stops; the plan only informs.

Every part of the plan shows **its source, when its data was made, how far to trust it, and "estimate" where it is one**. Where there is no data, it says so instead of guessing.

| File | What it does |
|---|---|
| `rideplan-app.js` | The sheet in the route preview ("Ride plan"), the plan's screen, the rider's choices (`mu.rideplan.v1`). |
| `stop-ask.js` | After a ride: "Did you stop at one of these?" for long stops (opt-in, never automatic). |
| `lib/master/rideplan.js` | `/api/master/ride-plan`: the report for each route. |
| `lib/master/metno.js` | MET Norway's forecast, fetched by our server only. |
| `lib/master/nasapower.js` | NASA POWER: the month's usual weather when no forecast reaches the ride day. |
| `lib/master/place-ratings.js` | Riders' 👍/👎 for places they said they stopped at. |
| `lib/master/hospitals.js` | Known hospital locations from a government directory (imported). |

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
