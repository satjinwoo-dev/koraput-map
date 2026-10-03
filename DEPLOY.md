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
| `POST /api/bikes/fillups`, `POST /api/bikes/fillups/mine`, `DELETE /api/bikes/fillups` | Anonymous full-to-full tanks from riders who opted in (Step 8), what a contributor token sent, and deleting it. See `FLEET.md`. |
| `GET /api/bikes/calibration`, `GET /api/bikes/calibration/<class-key>` | Per-class fleet data and the latest fit, for the Fuel Learner dashboard. |

- **Android app.** The page origin `https://localhost` calls the API cross-origin. The routes answer allowed origins with CORS, using the same list as Socket.IO: `CORS_ORIGIN` plus `NATIVE_APP_ORIGINS`. That includes the preflight for the JSON POST. A POST from any other site is refused with 403. `public/js/bikedb/bike-api.js` is the client for the website and the app. It searches the server first and falls back to `catalog.json` offline. It loads bundles from the copy shipped with the page or APK first, then from the server.
- **Rate limits.** The bike routes have their own limits: search 240/min, bundles 600/min and requests 20/hour per IP. They don't count against `HTTP_RATE_LIMIT_MAX`, because type-ahead sends one search per keystroke.
- **Requests for missing bikes** are stored in the server's own database (`DB_PATH`), not in `bikes.sqlite`. The queue keeps one row per bike and counts one vote per requester. Requesters are an HMAC pseudonym from `SERVER_SECRET`; IP addresses are never stored. A request is only a name: a curator researches the bike into `data/bikes/` like any other bike. List the queue with `npm run bikes:requests` (`DB_PATH=… npm run bikes:requests -- --set <id> researching|added|rejected` changes a status).

### Fleet calibration (Step 8)

`FLEET.md` has the full contract. For the server:

- **Storage.** Tanks live in the server's own database (`DB_PATH`), in the `fleet_tank` and `fleet_fit` tables, created on first use, never in `bikes.sqlite`.
- **Privacy.** Contributors are an HMAC of the app's random token under `SERVER_SECRET`. No location, times or IP addresses are stored, only the day a tank arrived. Tanks older than 730 days are purged on every calibration run (`FLEET_RETENTION_DAYS`).
- **Rate limits.** The new routes have their own limits: fill-ups 30/hour, calibration reads 120/minute per IP.
- **Fitting.** Run `DB_PATH=… npm run bikes:calibrate` (for example nightly from cron) from a checkout of the deployed commit. It fits every class with tanks and stores the results the dashboard reads. It changes nothing riders see.
- **Service worker.** The release bumps the version to `mu-2026-10-03.16`, because `smartdrive.js` and `fuel-baseline.js` changed.
- **Shipping a calibration.** Run `npm run bikes:calibrate -- --write`. It writes `data/bikes/calibration/<class-key>.json` for each class that passed every check. Review and commit it, then rebuild the catalogue and deploy as usual. The rebuilt bundles carry the new priors and the real-riding overhead; the server picks up the new `bikes.sqlite` within 5 seconds, and phones get the new bundles through the catalogue.

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
