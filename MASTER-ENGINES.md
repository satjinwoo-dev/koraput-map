# Master AI: the cognitive engines

This adds the "Section 2" engines to the Master AI's existing kernel (`public/js/master/`): the 2 km Ultra-Radar, vetted places, Deep Search, destination safety, music mood and the rider's context. It also adds three brain policies that learn and reason. The kernel, bus, brain, persona and voice gate are unchanged. Every new piece is a sub-agent or a capability, and all speech still goes through `voiceAnnounce()` and the advice gate.

```
 phone (public/js/master/)                                        server (lib/master/, keys live here)
 ───────────────────────────────────────────────────────          ──────────────────────────────────────
 corridor ── state.corridor (2 km ahead) ──┬─ weather    ──POST──▶ /weather      Open-Meteo forecast + air quality
                                           ├─ traffic    ──POST──▶ /traffic      TomTom flow          (TOMTOM_API_KEY)
                                           ├─ topology   ──POST──▶ /road         OSM via Overpass
                                           │   + terrain cap (DEM) → ghats; geometry → hairpins
                                           └─ blackspot  ──POST──▶ /blackspots   official lists you import
 poi (ranks every 1 s from its tile cache) ──────────────POST──▶ /poi          Google Places (vetted) + OSM
 deep-search (task.deep-search) ─────────────────────────POST──▶ /search       Gemini + Google Search (GEMINI_API_KEY)
                                                                     └─ fallback: Ollama on this machine (+ Wikipedia)
 destination (on a new route) ───────────────────────────POST──▶ /destination  sun, forecast, blackspots, hospital/police
 mood (media cap: Android media sessions) ───────────────POST──▶ /music        Last.fm tags/similar  (LASTFM_API_KEY)
 link (radio cap + response timings) ─────────────────────GET──▶ /bw           random bytes, timed on the phone
 context (app-context cap) → state.user, state.affect
 brain policies (cognition.js): interest (learning) · affect · fusion (reasoning)
```

## Running it

Nothing to install: the routes are mounted in `server.js` and the scripts are in `index.html` and the service worker. Each provider is optional, and without its key that one feature switches off (the agent shows as `degraded`):

| Env var | Feature | Without it |
|---|---|---|
| none | weather, air quality, road features, destination check | always on (Open-Meteo, Overpass) |
| `GOOGLE_MAPS_SERVER_KEY` | ratings and reviews for places (vetting). Cost: up to 5 Places calls per new 2.2 km tile, with the reviews field (a premium SKU). `MASTER_POI_GOOGLE=0` turns this off and keeps the key for the search box | OSM places only, labelled "unvetted" |
| `TOMTOM_API_KEY` | live jams and closures | no traffic reports |
| `GEMINI_API_KEY` (+ `GEMINI_MODEL`, `GEMINI_DAILY_MAX`) | Deep Search on Google Gemini's free tier, grounded with Google Search | Deep Search runs on local Ollama only |
| `OLLAMA_URL`, `OLLAMA_MODEL` (no key) | Deep Search on a local model, free and private; the fallback when Gemini is down or over quota | without Gemini either, the voice says it can't look things up |
| `MASTER_LLM_ORDER` | `gemini,ollama` (default), `ollama,gemini` (local first), `ollama` (local only) | |
| `LASTFM_API_KEY` | music mood from tags, song suggestions | mood from title words only, no suggestions |
| `OPEN_METEO_API_KEY` | only with a commercial Open-Meteo plan | keyless (free for non-commercial use) |
| `MASTER_BLACKSPOTS_DIR` | where the official blackspot files are | `data/master/blackspots/` (empty until you import a list) |

`GET /api/master/status` shows what's configured, how many blackspots are loaded, and the cache and circuit-breaker health of each upstream.

**Local reasoning on your RTX 3050 (Ollama).** Install Ollama on the machine that runs `server.js`, then pull a model sized for your card:

```bash
ollama pull llama3.2:3b     # 4 GB laptop RTX 3050: fits fully on the GPU (the default)
ollama pull llama3.1:8b     # 6–8 GB RTX 3050: better reasoning and Hinglish
ollama pull qwen2.5:7b      # 6–8 GB alternative, strong at following the JSON format
```

Set `OLLAMA_MODEL` to the one you pulled. Ollama listens on `127.0.0.1:11434`, which is the default `OLLAMA_URL`. If the server runs somewhere else (Render, a VPS), the local GPU isn't reachable from there: run `server.js` on the GPU machine, or point `OLLAMA_URL` at it over a private network, and never expose Ollama to the internet. Start-up prints which engines are ready, for example `Master AI reasoning [gemini → ollama]: gemini (gemini-flash-latest) · ollama (llama3.2:3b)`. `GET /api/master/status` shows the same under `reasoning`. The first question after a cold start loads the model into the GPU, which takes a few seconds. `OLLAMA_KEEP_ALIVE=30m` keeps it loaded.

**Android:** `node scripts/setup-perception-android.mjs` now also copies `native/android/radar/` (the `MapUniteRadio` and `MapUniteMedia` plugins) and declares the media listener service. Then run `npx cap sync android`.

## How each requirement is met, and where its limits are

**Network.** Radio-level signal (RSRP, RSRQ, SINR, level, generation, Wi-Fi RSSI) is read by `RadioPlugin.kt` every 2 s. The link agent fits a slope to the last 60 s and warns about 45 s before the signal crosses the coverage edge. Bandwidth is measured from real responses, which costs nothing, plus a 64 KB probe every 2 minutes while riding. A browser can't read signal strength, so outside the Android app the agent runs on bandwidth only.

**2 km ahead.** One corridor agent defines "ahead" for everyone: the route if you're navigating, otherwise a straight line along your heading. Ghats, hairpins and road features need a route, because without one the road ahead isn't known. Weather and blackspots work either way.

**Weather.** Storms, rain, drizzle, ice, fog, wind, heat, cold, dust (PM10), dry air, and rain within the hour. The thresholds are in `lib/master/weather.js`. Model data has a resolution of 1–11 km, so the agent asks again every 1 km or every 5 minutes, not every second. Weather you're already riding in stays with the existing advice module's voice line, so nothing is said twice.

**Accident blackspots.** No data ships with this, and none was made up. Import an official list with coordinates using `scripts/master/import-blackspots.mjs` (see `data/master/blackspots/README.md`). Until you do, the blackspot agent reports itself as degraded.

**Places, every second.** Ranking runs on the phone every second from a cache of 0.02° tiles, so an emergency answer is instant and works offline. The network is used only to fetch a tile you haven't got.
- **Vetting:** a Bayesian rating, a minimum number of reviews, red-flag words in recent reviews (English and Hinglish), detection of review bursts and copy-pasted reviews, and a check that the place really is that category.
- **What "vetted" means:** reviews can be filtered but not verified, so the app says "well reviewed".
- **What's stored:** Google's terms allow storing only place IDs and coordinates. Names, phone numbers and ratings from Google stay in memory. OpenStreetMap places (phone numbers included) are stored in full, and they're what makes an offline emergency answer possible.

**Deep Search.** A spoken question that isn't a voice command goes to `/api/master/search`. It runs on one of two engines (`lib/master/llm.js`), with no paid dependency:
- **Google Gemini (cloud, primary):** `generateContent` with the `google_search` tool, on the free tier. Gemini plans the searches, reads and cross-checks, and the sources are Google's own grounding chunks. `GEMINI_DAILY_MAX` (default 200) keeps a margin under the free quota.
- **Ollama (local fallback):** a model on your own GPU. It takes over when Gemini is over quota, rate-limited, down, slow, or gives a reply that doesn't parse. A local model has no web access, so it first gets Wikipedia excerpts (free, keyless). For live facts (weather, traffic, opening hours) it says it can't check them live, and its confidence is capped at 0.6. The screen then says "Local AI, not checked live".
- **Live data from the phone:** the phone also sends what its agents already know (the weather at the rider and the 2 km ahead, the best places nearby), so either engine can answer "aage baarish hai kya?" or "kahan rukein?" from real data.
- **Same output either way:** both engines return the same strict JSON (Ollama is held to it by a JSON schema), so the persona, the voice and the screen don't change. The answer carries `engine` and `grounded`.
- **While riding:** the spoken line has no URLs and no long numbers, any phone action starts with "ruk ke…", and emergencies always mention 112.
- **Offline:** questions are kept on the phone and answered when the network comes back.

**Mood and music.** The mood agent reads the track playing in any app through Android's media sessions. The rider has to switch on notification access once; no app can do that for itself. Mood comes from the track's tags as two values: valence (sad to happy) and energy (calm to intense).
- **What it suggests:** something energising if the fatigue check found drowsiness, calmer music if the ride is stressful, otherwise more of the same.
- **Respecting the rider:** "no music tips" silences it, two "nahi" in a row mute it for an hour, and it only changes the track when told to ("agla gaana").
- **Voice tone:** "Respect voice tone" is done from what the rider *says* (the context agent's irritation score), not from the sound of the voice. Reading emotion from the sound would need an on-device model and explicit opt-in.

**Destination safety.** This is an arrival-risk check, not a crime score. No fair, current, per-place crime data exists, so the check only uses things that are measurable and that the rider can act on: daylight at arrival, the forecast, blackspots, how far the nearest hospital and police station are, how remote the spot is, and how long the ride is.

**Persona.** Every new line exists in desi Hinglish (spoken) and plain English (always what the screen shows). The tests enforce this.

**Units.** SI throughout: m, s, m/s, °C, mm/h, µg/m³, dBm. TomTom's km/h is converted on the server. Speeds are never spoken; distances are spoken in metres and kilometres.

## What "monitors everything" covers

The context agent tracks:
- the bike in the garage;
- whether you're in a group trip, and its size;
- the destination and place searches (two new `mu:place-search` / `mu:destination` events in `navigation.js`);
- memories you share;
- trip summaries;
- what the mic heard after the app's own commands had their turn (a new `mu:voice-heard` event in `voice.js`).

All of it stays on the phone. `MUMaster.live.forget()` wipes what was learned.

"Thousands of sub-agents" is honestly eleven new agents. Inside them, fan-out happens where it pays (per tile, per category, per corridor sample). Every agent is isolated, restarted with back-off when it crashes, and started only while its `runWhen` condition holds, so the radar costs nothing while you're parked.

## Tests

- `node --test test/master/cognitive.test.mjs`: 17 tests covering geometry, every agent with a fake server and a fake clock, the learning, affect and fusion policies, the phrase pack, and the providers.
- `node --test test/server/master-api.test.mjs`: 19 tests covering the cache, circuit breaker, thresholds, vetting, Deep Search on Gemini and the Ollama fallback (quota, bad reply, model not pulled, Ollama down), speech safety, router wiring and CORS.
- `npm run master:typecheck` and `npm run master-server:typecheck`.
