# MapUnite — Batch 2 deployment guide

Batch 2 covers privacy, architecture and the backend: trip-only sharing, friend circles, "you were here before", the OSM credit, chat history, photos on disk, the split frontend, and multi-process scaling over Redis.

## 1. What's in this delivery

```
mapunite/
├── server.js            ← replaces your server.js
├── lib/
│   ├── cluster.js       ← NEW: multi-process state bus (Redis) + optional Socket.IO adapter
│   └── media.js         ← NEW: photo / attachment store on disk
├── public/
│   ├── index.html       ← replaces yours (new settings, loads js/*.js and /config.js)
│   ├── sw.js            ← replaces yours (VERSION mu-2026-10-01.1)
│   ├── shell.js         ← comments only
│   ├── manifest.json, icon-*.png   (unchanged)
│   └── js/              ← NEW: the former app.js + features.js, split by concern
└── DEPLOY.md            ← this file
```

**`public/app.js` and `public/features.js` are gone.** Every line of both files now lives in exactly one file under `public/js/`. The split was checked mechanically: no line was lost or added. Only three small edits were made on top of it:
- `/config.js` support;
- the OSRM URL now comes from config;
- the socket connects only after the last script has loaded.

| File | What's in it |
|---|---|
| `core.js` | Config, the socket, the map + base layers, shared state, device identity, GPS filter, helpers, TripDB |
| `voice.js` | `voiceAnnounce()` + VoiceAssistant (speech queue, voice commands) |
| `gps.js` | Speed limits, walk/ride detection, GPS power saving, `startGPS()` |
| `navigation.js` | Route options, Places search, turn-by-turn, traffic ETA |
| `smartdrive.js` | Speed alerts, the fuel model and your personal fuel curve, trip summary |
| `groupnav.js` | Group navigation, trip panel, meetup planner, carpool, gear checklist |
| `privacy.js` | Sharing settings, **circles**, **place recall**, export and clear |
| `analytics.js` | Ride history, rollups, charts, replay |
| `deadreckoning.js` | Tunnel mode |
| `presence.js` | Connection + identity handshake, friend markers, online list, geofence alerts |
| `controls.js` | Map tools, join screen |
| `chat.js` / `memories.js` | Chat / memory pins, gallery, heatmap |
| `calls.js` | 1:1 calls + the voice squad |
| `sos.js`, `pwa.js`, `skunkworks.js` | SOS / install button / experimental tools |
| `radio.js` / `convoy.js` | Meshtastic relay + radar / convoy alerts, relative motion, regroup |
| `boot.js` | Starts everything. Must stay last. |

The load order is fixed in `index.html`: `core` first and `boot` last. All files are plain `<script>` tags with no build step. The Google Maps `<script>` tag is untouched.

## 2. Upgrading an existing server

1. **Back up** your `data/` folder (the SQLite database) first.
2. Stop the server.
3. Copy `server.js` and the whole `lib/` folder next to your existing `package.json`.
4. In `public/`:
   - replace `index.html`, `sw.js` and `shell.js`, and add the `js/` folder;
   - **delete** `public/app.js` and `public/features.js`;
   - keep your own assets (e.g. `satyam.png`).
5. No new npm packages are needed for a single server.
6. Start the server. On the first boot it:
   - adds the new tables and columns (chat, circles, privacy settings) automatically;
   - **moves every base64 memory photo out of the database** into `data/media/memories/` and logs `Media: moved N memory photo(s)…`. It's safe to interrupt: re-running it only finishes what's left. A row that can't be decoded is left as it was and still displays.
7. Riders get the new version the usual way (the "update available" prompt), because `sw.js` has a new `VERSION`.

On Render, or anywhere with an ephemeral disk: the persistent disk must hold **both** `DB_PATH` and `MEDIA_DIR`. By default `MEDIA_DIR` is `<folder of DB_PATH>/media`, so one disk mounted at `data/` covers both.

### New / changed environment variables

| Variable | Default | Purpose |
|---|---|---|
| `MEDIA_DIR` | `<DB dir>/media` | Where photos and chat files are stored |
| `CHAT_RETENTION_DAYS` | `30` | Chat older than this is deleted with its files (`0` = keep forever) |
| `OSRM_PUBLIC_URL` | public demo server | The routing URL **browsers** use (see §6) |
| `PUBLIC_DIR` | `./public` | Static files |
| `REDIS_URL` | — | Turns on multi-process mode (see §5) |
| `CLUSTER_PREFIX` | `mapunite` | Redis channel prefix |
| `NODE_ID` | host-pid-random | This process's name in the cluster |
| `STICKY_SESSIONS` | — | Set to `1` if your load balancer pins clients to one process |
| `NATIVE_APP_ORIGINS` | `https://localhost,capacitor://localhost` | Android app origins allowed in addition to `CORS_ORIGIN` (see `ANDROID.md`); empty turns app access off |
| `ADMIN_TOKEN` | — | Bearer token for the bike curator's admin API (`/api/admin`, `public/admin/curator.html`). At least 16 characters; unset = the admin API doesn't exist (404). Use a long random value (`openssl rand -hex 32`) and keep it out of the repo |
| `BIKES_DATA_DIR` | `./data/bikes` | The curated bike files the curator's **Approve** writes into (and rebuilds from) |

`OSRM_BASE_URL`, `OVERPASS_URL`, `TRIP_RETENTION_DAYS` and the rest are unchanged.

### Bike catalogue (build step)

The bike catalogue is built from `data/bikes/` and isn't committed, so run the build after every pull and before starting the server:

```bash
node scripts/build-bike-catalog.mjs        # writes public/bikedb/ and build/bikedb/bikes.sqlite
```

It uses `better-sqlite3`, which the server already depends on, or Node 22.5+'s built-in `node:sqlite`. It refuses to write anything if a bike file doesn't validate. `node scripts/build-native.mjs` rebuilds `public/bikedb/` by itself before packaging the Android app. See `data/bikes/README.md` for details.

The running server picks up a rebuilt `bikes.sqlite` by itself within 5 seconds: no restart needed on Linux or macOS. On Windows, stop the server first, because a running process holding `bikes.sqlite` open blocks the replacement. If the file is missing or from an incompatible build, the server still starts. `/api/bikes/search` and `/api/bikes/bundles/…` then answer 503 until a valid build appears, and `/healthz` shows `"bikes": { "available": false }`. Set `BIKES_DB_PATH` if the file lives somewhere other than `build/bikedb/bikes.sqlite`.

### My bike in the app (Step 7)

- **Where riders find it:** Settings → **My bike** opens the garage in a sheet over the map. It never navigates away, so the convoy connection stays up.
- **What it changes:** once a rider picks their bike, SmartDrive's fuel numbers come from that bike's physics instead of the fixed 18 km/L. That covers trip fuel, the efficient-drive comparison and the km/L shared for meetup costing. Fill-ups then refine it.
- **No bike:** riders who don't pick a bike see no change.
- **Service worker:** the release bumps the version to `mu-2026-10-03.15`.
  - It precaches My bike, the bike list and the typical-bike data, and the Socket.IO client library, so the app also opens offline.
  - Bike data lives in its own cache (`mu-bikedb-v1`), which survives releases.
- **Testing in a browser:** `node scripts/e2e/garage-offline.mjs` runs the flows in headless Chromium against a local `server.js`. It needs Playwright.

### Bike catalogue API

The server reads `bikes.sqlite` read-only and serves it under `/api/bikes` (`lib/bikedb/http-api.js`):

| Route | What it does |
|---|---|
| `GET /api/bikes/search?q=royal+enf&limit=20` | FTS5 search. It uses the same tokeniser and ranking as the app's offline search over `catalog.json`, so both return the same bikes in the same order. Results carry `bundle` (the content hash), `image_url` and the SI `size`; the answer carries `catalogVersion`. |
| `GET /api/bikes/bundles/<hash>` | A runtime bundle, byte-identical to `public/bikedb/bundles/<hash>.json`. Cached for a year (`immutable`), and `If-None-Match` gets a 304. |
| `GET /api/bikes/bundles/<bike-id>` | The same bytes by bike id, cached for 5 minutes. `Content-Location` names the hash URL. |
| `POST /api/bikes/requests` | `{"make", "model", "variant"?, "market"?, "year"?, "powertrain"?, "note"?}` (JSON, at most 4 KB). A bike that's already listed comes back as `{"status": "listed", "matches": […]}`. Otherwise the request is queued (202), or a vote is added to the same request. Send `"force": true` when the rider says the listed bike isn't theirs. |
| `GET /api/bikes/status` | Catalogue version, number of variants and bundles. |
| `POST /api/bikes/fillups`, `POST /api/bikes/fillups/mine`, `DELETE /api/bikes/fillups` | Anonymous full-to-full tanks from riders who opted in (roadmap Step 11), what a contributor token sent, and deleting it. See `FLEET.md`. |
| `GET /api/bikes/calibration`, `GET /api/bikes/calibration/<class-key>` | Per-class fleet data and the latest fit, for the Fuel Learner dashboard. |

- **Android app.** The page origin `https://localhost` calls the API cross-origin. The routes answer allowed origins with CORS, using the same list as Socket.IO: `CORS_ORIGIN` plus `NATIVE_APP_ORIGINS`. That includes the preflight for the JSON POST. A POST from any other site is refused with 403. `public/js/bikedb/bike-api.js` is the client for the website and the app. It searches the server first and falls back to `catalog.json` offline. It loads bundles from the copy shipped with the page or APK first, then from the server.
- **Rate limits.** The bike routes have their own limits: search 240/min, bundles 600/min and requests 20/hour per IP. They don't count against `HTTP_RATE_LIMIT_MAX`, because type-ahead sends one search per keystroke.
- **Requests for missing bikes** are stored in the server's own database (`DB_PATH`), not in `bikes.sqlite`. The queue keeps one row per bike and counts one vote per requester. Requesters are an HMAC pseudonym from `SERVER_SECRET`; IP addresses are never stored. A request is only a name: a curator researches the bike into `data/bikes/` like any other bike. List the queue with `npm run bikes:requests` (`DB_PATH=… npm run bikes:requests -- --set <id> researching|added|rejected` changes a status).

### Fleet calibration (roadmap Step 11)

`FLEET.md` has the full contract. For the server:

- **Storage.** Tanks live in the server's own database (`DB_PATH`), in the `fleet_tank` and `fleet_fit` tables, created on first use, never in `bikes.sqlite`.
- **Privacy.** Contributors are an HMAC of the app's random token under `SERVER_SECRET`. No location, times or IP addresses are stored, only the day a tank arrived. Tanks older than 730 days are purged on every calibration run (`FLEET_RETENTION_DAYS`).
- **Rate limits.** The new routes have their own limits: fill-ups 30/hour, calibration reads 120/minute per IP.
- **Fitting.** Run `DB_PATH=… npm run bikes:calibrate` (for example nightly from cron) from a checkout of the deployed commit. It fits every class with tanks and stores the results the dashboard reads. It changes nothing riders see.
- **Service worker.** The release bumps the version to `mu-2026-10-04.2`. It precaches the Fuel learner dashboard and the convoy pitstop planner, plus the roadmap Steps 8–10 scripts (`js/advice/`, `js/rides/`, `js/trip/structures.js`), and picks up the changed core, voice, navigation, SmartDrive, privacy and trip scripts.
- **Fuel learner dashboard and convoy pitstop planner.** These are the Web Architect's screens; see `public/js/insights/README.md` and `public/js/pitstop/README.md`.
  - **CSP.** The planner looks up fuel pumps and chargers along a group route from OpenStreetMap, so `connect-src` now includes `https://overpass-api.de`. Only route coordinates are sent.
  - **Convoy relay.** Riders share their bike from My bike and the fuel or charge level they set (`setFuelShare`). The server validates it and relays it only to their trip-mates, inside `tripFuelProfiles`.
- **Shipping a calibration.** Run `npm run bikes:calibrate -- --write`. It writes `data/bikes/calibration/<class-key>.json` for each class that passed every check. Review and commit it, then rebuild the catalogue and deploy as usual. The rebuilt bundles carry the new priors and the real-riding overhead; the server picks up the new `bikes.sqlite` within 5 seconds, and phones get the new bundles through the catalogue.

### Riding advice, route gradients and ride summaries (roadmap Steps 8–10)

These run on the phone; the server only stores the anonymous tanks of riders who opt in (above).

- **Step 8: the advice layer and its safety gate** (`public/js/advice/`).
  - **What it says.** Economy advice from the rider's bike in My bike, for example "Easing to 60 would use about 12 percent less fuel". It only ever suggests easing off, by 15 km/h at most, never to a speed above the posted limit (`SpeedLimits`), and says nothing at all over the limit, where the speed alerts take over. Without a bike it stays silent.
  - **When it holds.** The gate holds advice:
    - while cornering, from the gyroscope, the GPS heading or the route's curvature, and with a tight bend ahead;
    - for 30 s after hard braking;
    - on a wet road, and for 30 minutes after the last wet weather report;
    - when the speed isn't steady, near a navigation turn, on a weak GPS fix, and below 15 km/h;
    - for 3 minutes after any advice, and 10 minutes before the same advice again.
  - **Quiet ride.** The rider can switch advice off by saying "quiet ride" or "coaching off" (`MUAdvice.app.setQuiet`). Safety alerts never pass through the gate.
  - **Voice.** Advice goes through `VoiceAssistant` at priority 30, below every navigation, convoy and safety cue, with the new `dropIfBusy` option: if anything else is speaking or queued, the advice is dropped instead of waiting.
- **Step 9: gradients from elevation** (`public/js/trip/structures.js`).
  - **Already there:** the planned route's heights come from Open-Meteo's elevation API, cached offline (`js/trip/elevation.js`).
  - **New:** bridges and tunnels are now held at a straight grade from one end to the other. Their positions come from OpenStreetMap (one Overpass query per route, cached 30 days), or, where OSM has nothing, from the DEM's own tell-tale dips and humps. A 30 m gully under a bridge no longer costs a phantom descent and climb.
- **Step 10: ride summaries and privacy** (`public/js/rides/`).
  - **What's stored.** Every ride leaves a summary on the phone: distance and time per speed band and per 5 km/h, moving and idle time, coasting (an estimate from GPS speed), hard braking, the fill-ups logged during the ride, the fuel estimate, the nearest town, and the route simplified to ≤ 160 points for the ride's own drawing and share card. None of it is uploaded. At most 400 rides or 365 days are kept (`MURides.app.summaries()`).
  - **Opt-in upload.** Sharing the anonymous tanks is off until the app's consent screen calls `MURides.app.optIn()`. Opting out (`optOut()`) erases them on the server.
  - **Clear my history** now also deletes:
    - the ride summaries;
    - the fuel learner's fill-up log and rides, and the curve learned from them;
    - the convoy levels typed in;
    - the cached route heights, bridges and fuel stations;
    - and, on the server, every tank this phone shared. If the phone is offline, the server erasure is retried until the server confirms it.

### The screens for Steps 8–11 (the Web Architect's UI, wired to the backend above)

There's one backend for each feature. The screens read it and drive it; none has a second copy of its rules.

- **Advice badge and settings** (`js/advice/advice-ui.js`, `conditions.js`, `overlay.js`). Live road conditions (Open-Meteo, the position rounded to ~5 km, only while riding) give an **advised** speed under the limit sign, always below the posted limit and never presented as a legal one. A wet road is handed to the gate, so tips are held there too. Quiet ride is the gate's one setting, whether it's switched from settings, the badge or the HUD. The CSP already allows `api.open-meteo.com`.
- **Gradient sheet** (`js/gradient/`). "Gradient & bridges" under the trip card's elevation chart: the profile with steep climbs, every clamped bridge or tunnel, and a sections table. It reads the same `buildProfile` and the same OSM cache (`mu-trip-v1`) as the trip card, so the two never disagree.
- **Ride dashboard, consent and Delete my history** (`js/rides/ride-model.js`, `rides-ui.js`, `consent-ui.js`). Settings → Ride summaries, or **All rides** in the trip summary. The consent screen shows the rider's own latest tank and the exact request `POST /api/bikes/fillups` would carry, with the token redacted. "Delete my history" lets the rider pick what to erase.
- **Live HUD** (`js/hud/`) while navigating or on a SmartDrive trip: live km/L (or Wh/km), the cost so far, the eco band on a speed scale with the posted limit and the advised speed, and the next fuel or charge stop. The grade under you comes from the gradient sheet's fixed profile. At the end of a ride its physics totals are merged into the ride's summary (`mu:ride-summary`).
- **Share card** (`js/share/`): after a ride of 1 km or more, or from **Share** in the trip summary, an image card with the route shape (the first and last 400 m cut off by default), eco score, distance, mileage, cost and moving time. It's drawn on a canvas on the phone with no map tiles; nothing is uploaded.
- **Service worker.** The version is now `mu-2026-10-04.4`. All of the above is precached; the bike curator isn't (it's an admin page).

### Bike curator (admin)

`/admin/curator.html` (not linked from the app, `noindex`) turns riders' "my bike isn't listed" requests into reviewed bike files. See `public/js/curator/README.md`.

- **Turning it on.** Set `ADMIN_TOKEN` and restart. Without it, `/api/admin/*` answers 404. The page asks for the token and keeps it in `sessionStorage` for the tab only.
- **Approve writes to disk.** An approved bike becomes `data/bikes/variants/<id>.json` (`BIKES_DATA_DIR`), and the server rebuilds the catalogue in a child process (`public/bikedb/`, `BIKES_DB_PATH`). The running server picks it up within 5 s. The server's user therefore needs write access to `data/bikes/`, `public/bikedb/` and the folder of `bikes.sqlite`. Commit `data/bikes/` from the server afterwards (or copy the file into your checkout): an approval that isn't committed is lost at the next deploy, which rebuilds from the repository.
- **The picture rule.** An approved bike must have a picture: `image.url` (https) and the source that published it. The server checks this on every approve, whatever the browser sent. A bike without one is kept in `data/bikes/pending/` with the reasons and is never shipped. The catalogue build also refuses any variant without a picture, except the 25 older bikes on the frozen `PICTURE_GRANDFATHERED` list in `public/js/bikedb/bundle-contract.js`. Their pictures haven't been sourced yet; the list can only shrink.
- **Several processes.** Approve rebuilds on the process that received it; the other processes pick up the new `bikes.sqlite` within 5 s if they share the folder. With several machines, curate on one and deploy the commit.

## 3. The features (what riders see)

**Settings → Privacy**
- **Who can see me: Everyone / My circles.** With *My circles*, only people who share a circle with you see you. They see your position, your name in the online list, your geofence alerts, and can include you in meetup plans. Riders in the **same trip** always see each other. Everyone else doesn't see you at all.
- **Share only during a trip or ride.** Your position is sent only while a Drive / Bike / Walk ride is recording or you're in a group trip.
  - The rest of the time the phone sends nothing, and the server drops anything that arrives anyway.
  - Others see you listed as "not sharing".
  - A status line under the setting always says exactly what is being shared, with whom, and whether it's paused.
- All three privacy choices (exact / approx / off, audience, trip-only) are now **stored per device on the server**. Previously a reconnect silently reset them to "exact".
- **Remind me of places I've been** (on by default). "You've been here before" appears:
  - under a searched destination;
  - when you arrive by navigation;
  - when you park somewhere you've ridden to before.

  It uses only *your own* saved rides and memories. Rides from the last 6 hours don't count.

**Settings → Circles**
- Create a circle and share its code (`ABCD-EF23`) or its invite link (`…/?circle=ABCD-EF23`, which joins automatically after sign-in).
- The owner can issue a **new code** (the old one stops working), **remove** members, or **delete** the circle. Anyone can **leave**; if the owner leaves, ownership passes to the longest-standing member.
- **Trips I start are visible to:** Everyone, or one circle. A circle trip is only shown to that circle and only that circle can join it. **Several trips can now run at the same time** (the old server allowed one trip for the whole map).
- Limits: 10 circles per rider, 50 riders per circle.

**Chat**
- Chat history survives restarts. The last 200 messages are sent on connect, and messages are deleted after `CHAT_RETENTION_DAYS`.
- Your messages stay "yours" after a reconnect, and reactions are kept per device.
- Attachments are checked by their actual bytes, not just their label. A web page renamed to `.jpg` is refused. Files are stored on disk and sent as links.
- This also closes an old hole: the server used to relay any text as an image address.

**Clear my history** now also deletes your chat messages and their files, and your memory photo files. With "remove my device identity" ticked, you also leave all your circles.

**Map credit:** the Satellite layer now credits OpenStreetMap next to Esri. The routes, place names and speed limits drawn on top of it are OpenStreetMap data. All OSM credits link to openstreetmap.org/copyright.

## 4. Photos and files on disk

- Photos are stored as `MEDIA_DIR/memories/<uuid>.<ext>` and chat files as `MEDIA_DIR/chat/<uuid>.<ext>`. The database only stores the path.
- They are served at `/media/…` with:
  - their real type, `nosniff`, a sandboxing CSP and long caching;
  - byte ranges, which Safari needs to play audio and video;
  - documents always as downloads, never displayed in the browser.
- File names are random, so a link can't be guessed. Anyone who has the link can open the file, just as anyone on the map already received the photo.
- Upload limits: photos 4.5 MB, chat files 5 MB. Uploads still go over the socket as before, so the offline queue keeps working.
- The service worker keeps up to 300 photos for offline viewing (cache `mapunite-media-v1`). "Clear my history" empties it.

## 5. Running several server processes (Redis)

**Why the adapter alone isn't enough:** the Socket.IO Redis adapter only carries *messages* between processes. MapUnite's live state lives in each process's memory: who is online, positions, trips, voice squad, recent chat. With the adapter alone, a rider on process A would be invisible in process B's online list, and a trip started on A couldn't be joined from B.

**What `lib/cluster.js` does:**
- Every change to shared state is published as an operation on one Redis channel.
- Redis delivers them to every process in the same order, so all processes hold identical state.
- A process that starts late, or loses Redis for a while, asks its peers for a snapshot and then catches up.
- Each process heartbeats every 5 s. If a process dies, its riders are dropped everywhere within about 25 s; their phones reconnect to a live process.
- Calls and signalling between processes use the official `@socket.io/redis-adapter` when it's installed, and the same Redis bus when it isn't.

This was tested with three real server processes and a real Redis server, including killing one process.

**Requirements**
- Redis 6 or newer. Use a managed or replicated Redis if you can: while Redis is unreachable, processes can't change shared state.
- **All processes must share the same `DB_PATH` and `MEDIA_DIR` and the same `SERVER_SECRET`.** Several processes on **one machine** sharing one SQLite file is supported: WAL mode plus a 5 s busy timeout, and schema migrations are safe to run at the same time. Several **machines** need a shared database the processes can all reach; SQLite over a network filesystem (NFS/SMB) is not safe.
- Optional but recommended:
  ```bash
  npm install @socket.io/redis-adapter redis
  ```

**Example: 2 processes with PM2**
```js
// ecosystem.config.js
const common = { script: "server.js", env: {
  NODE_ENV: "production", REDIS_URL: "redis://127.0.0.1:6379/0",
  DB_PATH: "/srv/mapunite/data/mapunite.db", SERVER_SECRET: "<the same long random value everywhere>" } };
module.exports = { apps: [
  { ...common, name: "mu-1", env: { ...common.env, PORT: 3001, NODE_ID: "mu-1" } },
  { ...common, name: "mu-2", env: { ...common.env, PORT: 3002, NODE_ID: "mu-2" } }
] };
```

**nginx in front, with sticky sessions**
```nginx
upstream mapunite { ip_hash; server 127.0.0.1:3001; server 127.0.0.1:3002; }
server {
  listen 443 ssl; server_name maps.example.com;   # your certificate lines here
  location / {
    proxy_pass http://mapunite;
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_read_timeout 75s;
  }
}
```
- With sticky sessions like this, set `STICKY_SESSIONS=1`.
- Without them, leave it unset. The server then tells browsers (through `/config.js`) to use WebSocket only, which needs no stickiness.

**Checking it:** `GET /healthz` on each process shows `node`, `cluster: "redis"`, `clusterReady: true` and the same `users` and `trips` counts.

## 6. Self-hosted routing (OSRM) and Overpass (optional)

The browser used to be hard-wired to the public OSRM demo server. Now it uses whatever `/config.js` says:

1. Build an OSRM car profile for your region. Download a region file from download.geofabrik.de; for Odisha that's the India "eastern-zone" extract (check the site for the exact file name).
   ```bash
   docker run -t -v "$PWD:/data" ghcr.io/project-osrm/osrm-backend osrm-extract -p /opt/car.lua /data/eastern-zone-latest.osm.pbf
   docker run -t -v "$PWD:/data" ghcr.io/project-osrm/osrm-backend osrm-partition /data/eastern-zone-latest.osrm
   docker run -t -v "$PWD:/data" ghcr.io/project-osrm/osrm-backend osrm-customize /data/eastern-zone-latest.osrm
   docker run -d -p 5000:5000 -v "$PWD:/data" ghcr.io/project-osrm/osrm-backend osrm-routed --algorithm mld /data/eastern-zone-latest.osrm
   ```
2. Expose it over HTTPS on your own domain:
   ```nginx
   location /osrm/ { proxy_pass http://127.0.0.1:5000/; }
   ```
3. Set:
   - `OSRM_PUBLIC_URL=https://maps.example.com/osrm` (for browsers);
   - `OSRM_BASE_URL=http://127.0.0.1:5000` (for the server's meetup and carpool maths).
4. For speed limits, point `OVERPASS_URL` at your own Overpass instance, e.g. the `wiktorn/overpass-api` Docker image loaded with the same region file.

The CSP allows the configured routing server automatically.

## 7. Still outside what a web app can do

- **Background location and acting as a Bluetooth peripheral** need a native app. The browser stops GPS when the page is hidden and can only be a Bluetooth *central*. The Android app (Capacitor) does both — see **`ANDROID.md`**.
- **Phase 0 console check** is done on your side. After deploying, open the app with DevTools and confirm:
  - no red errors;
  - the `[CSP]` lines in the server log are clean before you set `ENFORCE_CSP=1`;
  - the Application tab shows one service worker with version `mu-2026-10-01.1`.

## 8. What was tested

- Every earlier test suite passes against the split frontend and the new server: 37 suites plus the tunnel simulation.
- New tests for Batch 2:
  - privacy, circles, circle trips, chat, media, recall, export and delete on the real server (46 checks);
  - restarts on the same database: chat, reactions, privacy settings, circles, photo migration and the media handler (16 checks);
  - the Redis bus and a three-process cluster, including a killed process (9 + 15 checks);
  - three riders' real pages end to end (28 checks);
  - hostile-input fuzzing of every socket event, including the new ones.
