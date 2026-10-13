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
 deep-search (task.deep-search) ─────────────────────────POST──▶ /search       free chain: Gemini (GEMINI_API_KEY)
                                                                     → Groq (GROQ_API_KEY) → Ollama on this machine
                                                                     (+ Wikipedia notes for engines without live web)
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
| `GEMINI_API_KEY` (+ `GEMINI_MODEL`, `GEMINI_THINKING`, `GEMINI_GROUNDING`, `GEMINI_DAILY_MAX`) | Deep Search on Google Gemini's free tier, no card. Default model `gemini-flash-lite-latest`, about 1 s an answer. Google Search grounding is **off** by default: without billing it answers 429 | the next engine answers |
| `GROQ_API_KEY` (+ `GROQ_MODEL`, `GROQ_DAILY_MAX`, `GROQ_BASE_URL`) | Deep Search on Groq's free tier, no card (OpenAI-compatible). Default model `llama-3.3-70b-versatile` | the next engine answers |
| `OLLAMA_URL`, `OLLAMA_MODEL` (no key) | Deep Search on a local model, free and private; the last fallback | without any engine, the voice says it can't look things up |
| `MASTER_LLM_ORDER` | `gemini,groq,ollama` (default); any subset, any order (`ollama,groq` = local first) | |
| `MASTER_RETRIEVAL` | `wikipedia` (default) or `none`: notes for the engines that don't search the web themselves (`OLLAMA_RETRIEVAL` is the old name) | |
| `LASTFM_API_KEY` | music mood from tags, song suggestions | mood from title words only, no suggestions |
| `OPEN_METEO_API_KEY` | only with a commercial Open-Meteo plan | keyless (free for non-commercial use) |
| `MASTER_BLACKSPOTS_DIR` | where the official blackspot files are | `data/master/blackspots/` (empty until you import a list) |

`GET /api/master/status` shows what's configured, how many blackspots are loaded, and the cache and circuit-breaker health of each upstream.

**The free cloud engines (no credit card).** Make both keys. Both have free tiers with per-minute and per-day limits, and the chain moves on when one is used up:
- **Gemini:** create a key in Google AI Studio and set `GEMINI_API_KEY`. Leave `GEMINI_GROUNDING` unset unless the key's project has billing.
- **Groq:** sign up at console.groq.com, create an API key, and set `GROQ_API_KEY`.
- **Where the keys go:** on Render, under the service's **Environment** settings. On your machine, run `GEMINI_API_KEY=… GROQ_API_KEY=… npm start`. The server reads no `.env` file, and a key never goes in the repository.

**Local reasoning on your RTX 3050 (Ollama).** Install Ollama on the machine that runs `server.js`, then pull a model sized for your card:

```bash
ollama pull llama3.2:3b     # 4 GB laptop RTX 3050: fits fully on the GPU (the default)
ollama pull llama3.1:8b     # 6–8 GB RTX 3050: better reasoning and Hinglish
ollama pull qwen2.5:7b      # 6–8 GB alternative, strong at following the JSON format
```

Set `OLLAMA_MODEL` to the one you pulled. Ollama listens on `127.0.0.1:11434`, which is the default `OLLAMA_URL`. If the server runs somewhere else (Render, a VPS), the local GPU isn't reachable from there: run `server.js` on the GPU machine, or point `OLLAMA_URL` at it over a private network, and never expose Ollama to the internet. Start-up prints which engines are ready, for example `Master AI reasoning [gemini → groq → ollama]: gemini (gemini-flash-lite-latest) · groq (llama-3.3-70b-versatile) · ollama (llama3.2:3b)`. `GET /api/master/status` shows the same under `reasoning`. The first question after a cold start loads the model into the GPU, which takes a few seconds. `OLLAMA_KEEP_ALIVE=30m` keeps it loaded.

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

**Deep Search.** A spoken question that isn't a voice command goes to `/api/master/search`. It runs on a chain of free engines (`lib/master/llm.js`), none needing a credit card. The first that answers wins; a 429, quota, outage, timeout or unparseable reply hands over to the next, inside one 48 s deadline:
1. **Google Gemini (free tier):** `gemini-flash-lite-latest` with low thinking (`GEMINI_THINKING=low`). Measured on a free key: about 1–2 s an answer. `gemini-flash-latest` took 6–28 s, because it reasons at length first, and it's the one Google sheds under load (503 "high demand"). **Google Search grounding is off by default:** on a key without billing it answers 429 while plain answers work. `GEMINI_GROUNDING=auto` tries it, and the first 429 turns it off until the next UTC day; the same question is then asked again without it, so a quota on Search never costs an answer. `GEMINI_DAILY_MAX` (default 200) keeps a margin under the free quota.
2. **Groq (free tier):** an OpenAI-compatible API (`/chat/completions`, JSON mode). Default `llama-3.3-70b-versatile`, a large open model with good Hinglish. Groq retires models over time; start-up and `/api/master/status` say whether `GROQ_MODEL` is still served. `GROQ_DAILY_MAX` (default 500) is our own margin: set it to your plan's limit. `GROQ_BASE_URL` points it at any other OpenAI-compatible server.
3. **Ollama (local, last):** a model on your own GPU, for when the cloud is down or for private, offline development.
- **No live web, honestly:** only Gemini with grounding on searches the web. Every other engine first gets Wikipedia excerpts (free, keyless, fetched once per question and shared down the chain) and is told it can't check live facts (weather, traffic, opening hours), so it says so instead of guessing. Its confidence is capped at 0.6. The answer carries `live: false`, and the screen says "Not checked live" ("Local AI, not checked live" for Ollama).
- **Live data from the phone:** the phone also sends what its agents already know (the weather at the rider and the 2 km ahead, the best places nearby), so either engine can answer "aage baarish hai kya?" or "kahan rukein?" from real data.
- **Same output from every engine:** each returns the same strict JSON (Ollama is held to it by a JSON schema, Groq by JSON mode, Gemini by the prompt), so the persona, the voice and the screen don't change. The answer carries `engine`, `grounded` (sources were read) and `live` (the web was searched just now).
- **The voice (`SYSTEM` in `lib/master/search.js`, the same for every engine):** "Master", a desi riding companion who knows the local roads and babysits the gang without nagging.
  - **Language:** colloquial Hinglish in Roman script ("Bhai, 2 kilometer aage ek badhiya mechanic hai, wahan chalte hain"). Never robotic or formal English, never bookish Hindi or Devanagari.
  - **Length:** intercom-short, usually under 30 words, and under 20 while riding.
  - **Context:** uses the live data from the phone.
  - **Plain style:** if the rider chose it, the same buddy speaks in simple English.
  - **Screen text** (title, summary, bullets) stays in clear English.
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
- `node --test test/server/llm-engines.test.mjs`: the free chain. Covers:
  - Gemini without Search by default, with the Wikipedia notes and the "can't check live" line;
  - Flash-Lite with low thinking, and the retry without thinking on a 400;
  - `GEMINI_GROUNDING=auto`, dropped for the day on a 429 and asked again plainly;
  - Groq's request shape, JSON mode, the retry without it, its budget, and `/models` health;
  - one Wikipedia lookup per question, shared down the chain;
  - everything down, reported as one clear failure.
- `npm run master:typecheck` and `npm run master-server:typecheck`.
