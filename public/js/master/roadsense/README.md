# RoadSense Live: the road event log (`public/js/master/roadsense/`)

One record of what is on the road, kept on the phone. **Sensors and people add observations, and fixed rules decide what can be believed.** No language model is involved: *language models talk, solvers decide, sensors verify.*

| File | What it does |
|---|---|
| `roadsense.js` | The observation format, the event log (merging, a 20 m spatial index, saving), and the verification and expiry rules (`assess`). Pure and `// @ts-check`. It is shared as the capability `roadsense` (`master-app.js`). |
| `../agents/dynamics-agent.js` | The first writer. It adds IMU jolts ("bump") and rough 20 m stretches, plus **clean passes** (rode over a known bump at ≥ 3 m/s and felt nothing). It warns only for **verified** bumps: `road.bump-ahead` when this phone felt it before, `road.bump-reported` ("reported by 2 riders") when only other riders did. |
| `sync.js` | **Opt-in** sync with our server (capability `roadsense-sync`): the outbox of this phone's own observations, private zones, daily pseudonyms, and downloads by ≈ 5.5 km tile into the same log, which is the offline cache. |
| `../agents/roadsense-agent.js` | Drives the sync: uploads every minute, fetches the tiles along a route when one is set and around the rider every 5 minutes, and marks where rides start and end as private. |
| `roadsense-ui.js` | Settings → **Community road reports**: the switch (off by default), a status line, and **Delete my road reports from the server**. |
| `truth.js` | The **Route Truth Card**: the events on a route, nearest first, each with who saw it, when, and how confident. Says "unknown" when there is nothing, never "clear". Pure. |
| `../agents/truth-agent.js` | Keeps the card current (`state.truth`): route changes, new evidence, the rider moving along the route. Answers `task.road-truth`, and says a one-line summary when navigation starts on a route with confirmed reports. |
| `truth-card.js` + `roadsense.css` | The card in the route sheet (`#road-truth`), with 🔊 to hear it. |
| `lib/master/roadsense.js` (server) | `/api/master/roadsense/upload`, `/area` and `/forget` on the server's SQLite database. It runs the same `roadsense.js` rules per tile. |

## Observations and events

```
observation { type, t, lat, lng, source, rider, present, conf, peakMs2? }
  type     bump · pothole · speed_breaker · rough · waterlogging · gravel · debris · animal
  source   imu · camera · rider (a spoken or tapped report) · official (SACHET CAP, IMD, NHAI)
  rider    "self" for this phone; other riders are labels from the server (see Sync), never names or numbers
  id       random, 12 characters: an observation already in the log is a duplicate and changes nothing
  present  true = "it is here"; false = "I went over this spot and it was NOT there"
```

- **One event per spot:** observations within 12 m (GNSS error) of the same group of things share one event.
- **The specific name wins:** `bump`, `pothole` and `speed_breaker` are one group, so the IMU's "bump" becomes "pothole" once a camera or a rider names it.
- **"Not there" never creates an event.**
- Invalid observations are refused with a reason, never guessed.

## The rules (`assess`)

1. **Evidence fades:** weight = conf × ½^(age / half-life of that kind).
2. **Confidence** = 1 − Π(1 − weight) over the sightings. It is then lowered by `absenceWeight` × weight for each clean pass made **after** the latest sighting. Clean passes before a sighting don't count: the thing came back, or that rider went round it.
3. **Status**, checked in this order:

| Status | When |
|---|---|
| `expired` | Nothing alive: faded below 0.1, or older than the kind's maxAge. |
| `cleared` | Enough clean passes after the last sighting: 3 for shocks and rough road; 2 for water, gravel and debris; 1 for an animal. Only sources that can sense that kind count, so an IMU clean pass doesn't clear water. |
| `verified` | An official source, or ≥ 2 independent pieces with confidence ≥ 0.5. A piece is a different rider, a separate pass by this phone (≥ 60 s apart), or a second sensor on the same pass (IMU + camera). **Another rider counts as one piece per sensor however many passes they claim, and their clean passes as one.** So one uploader can neither verify a fake pothole nor clear a real one. |
| `candidate` | Seen, not confirmed. **Never spoken as fact.** |

- **Expiry is mostly rule 2:** riders going over a repaired pothole clear it. Half-lives are only the backstop for roads nobody rides.
- **No evidence means "unknown":** `truthAt()` returns `status: "unknown"`, never "clear". The Route Truth Card says *Condition unknown*.

## Where the numbers come from

| Value | Basis |
|---|---|
| 60 s between passes, 12 m merge radius, 20 m cells, 2 pieces to verify, 12 m/s² for a warned bump | Carried over unchanged from the dynamics agent, which shipped and passes the Kotlin ride fixture. |
| The jolt's own confidence | Comes from DynamicsCore with every event. |
| The camera's confidence | Comes from `confirm.js`. |
| Half-life, maxAge and clear passes per kind; `absenceWeight` 0.4; `verifyConf` 0.5; `floorConf` 0.1; rider reports 0.6; official feeds 0.95; a rough segment 0.6 | **Design priors.** These are marked `basis: "prior"` in `TYPES` and `SOURCES`, to be calibrated from the pilot: how often a verified event is still there, and how many clean passes a repair takes. |

## Storage

- Saved under `mu.master.roadsense.events` in a packed form, with seconds, integer percentages and short codes.
- **Limits:** the 8 newest observations per event and 2,000 events, so about 0.5 MB when full. The least recently seen go first; expired and cleared events are pruned every 5 minutes.
- The dynamics agent writes once a minute and when the ride ends.
- **What a crash can lose:** at most the last minute of observations, plus clean passes still waiting their 3 s for a late jolt.
- The old per-agent jolt cells (`mu.master.dynamics.cells`) are removed on start.

**Cost:** measured in Node on a desktop CPU with a full log, a phone will be slower:
- assessing all 2,000 events takes about 37 ms;
- a 200 m query, run once a second, takes about 0.5 ms.

**Limits of the IMU's view:**
- A clean pass can't tell "repaired" from "rode round it". That's why one clean pass only lowers confidence and 3 are needed to clear.
- A clean pass counts only at ≥ 3 m/s, with the IMU at ≥ 50 Hz and position error ≤ 10 m, when the track passes within 5 m of the spot.

**Tests:**
- `node --test test/master/roadsense.test.mjs`: the rules, storage and wiring.
- `test/master/dynamics.test.mjs`: the Kotlin ride fixture end to end, including a repaired pothole being cleared after 3 clean passes and no longer warned.

## Sync (step 3): opt-in, anonymous, offline-first

**Off by default.** Settings → *Community road reports* turns on sharing and receiving together. Turning it off empties the queue; nothing from before it was turned on is ever sent.

**What leaves the phone.** Only this phone's own observations (rider `"self"`, sources imu, camera or rider):
- uploaded no sooner than **10 minutes** after they happened, so nothing is ever live tracking;
- never within **250 m** of where a ride started or ended, or of the first fix after the app opens (a ride the phone died in never "ended"). Those observations are **dropped**, not delayed. The private zones stay on the phone;
- with time rounded to 10 s and position to 1e-5° (≈ 1 m: a pothole needs it);
- under a **pseudonym that changes every calendar day**, random and made on the phone.

**What the server keeps** (`roadsense_obs` in the server's database):
- the observation's id, kind, time, position, source, present or not there, confidence and shock size;
- a **rider label** = HMAC(`SERVER_SECRET`, pseudonym).

It never stores the pseudonym or the IP address. Labels let phones count distinct riders without learning who they are; a new day is a new label, so `riders` counts rider-days.

**Server limits:**
- 200 observations per upload; only imu, camera and rider sources (phones can't claim to be IMD);
- times from 30 days ago to 10 minutes ahead; 3,000 observations per label per day;
- per-route rate limits.

**Retention:** each observation is deleted once past its kind's `maxAge`, checked hourly.

**Delete my road reports:** the phone keeps its pseudonyms (≤ 800 days) only so it can send them to `/forget`; the server deletes every row under their labels.

**What comes down.**
- `/area` runs the same rules over each requested tile and returns only the evidence of live (candidate or verified) events, verified first, at most 300 events per tile and 4,000 observations per answer.
- The phone fetches every tile along a route when one is set (≤ 200 tiles, about 1,000 km), and around itself every 5 minutes while riding. A tile fetched in the last 15 minutes isn't fetched again.
- Everything lands in the **same log** in phone storage, so it warns with no signal and survives restarts.
- The phone's own uploads coming back are recognised by id (and by a remembered list of 5,000 sent ids) and never counted as another rider.
- Failures back off from 1 to 30 minutes, and every call goes through `master-api`, which answers at once when offline.

**What this doesn't stop.** Anyone can post to the API. The limits above stop one uploader. A coordinated group posting under many pseudonyms (a Sybil attack) could still verify a fake spot. Device attestation (Play Integrity) is the fix for that when the app is in the Play Store.

**Tests:**
- `test/server/roadsense-api.test.mjs`: the server on in-memory SQLite, plus the mounted routes.
- `test/master/roadsense-sync.test.mjs`: several simulated phones syncing through the real server handlers. Covers privacy, offline and restart, abuse, delete, the agent, and the wiring.
- `test/master/dynamics.test.mjs`: a pothole verified only by other riders is warned on a first ride.

## The Route Truth Card and the voice (step 4)

**Rule: sensors verify, language models talk.** Every value the rider hears or sees comes from the log's rules:
- status, confidence, riders, sources, last seen, valid until.

**How those values become words:**
- Fixed phrases in `phrases-desi.js` turn them into words: `road.truth`, `road.truth-unconfirmed`, `road.truth-unknown`, `road.route-truth`, and the bump warnings.
- No model is asked what the road is like. A test checks that the truth path never calls the network or a model.
- The Deep Search model's only part is routing: it may answer "how's the road?" with the action `road_ahead`, which runs the same solver. Its system prompt forbids it to describe road condition itself.

**On screen** (the route sheet, under the trip card):
- **Pill:** *N confirmed*, *N unconfirmed* or *Condition unknown*.
- **One summary line.**
- **One row per report:**
  - distance;
  - kind;
  - *Confirmed* / *Unconfirmed*;
  - *who · which sensor · how long ago · confidence %*;
  - *until* (when it fades if nobody sees it again).
- **Where the data came from:** this phone only, other riders updated N min ago, a saved copy with no signal, or reports saved before sharing was turned off.
- **Always:** *No report doesn't mean the road is clear.*
- **While navigating:** the next 2 reports, counted from the rider.

**By voice:**

| When | What is said |
|---|---|
| "aage sadak kaisi hai?", "how's the road ahead", "any potholes ahead" (`js/voice.js` `masterRoadTruth`) | The confirmed count and kinds, then the first one with its evidence and confidence ("bharosa zyada", high confidence). The rest is "haalat pata nahi" (condition unknown). |
| Only unconfirmed reports | Said as unconfirmed ("kachchi report … abhi pakka nahi"). |
| Nothing at all | "koi report nahi … haalat pata nahi". |
| Navigation starts on a route with confirmed reports | One summary, as advice behind the ask-first gate. |
| A warning 2–8 s before a bump | Only a short who-and-when ("2 riders ne bataya, kal" / "you hit it here 3 hours ago"). It has to finish before the bike reaches the spot. The confidence and sensors are on the screen line. |

Confidence is spoken in bands:
- **high:** ≥ 0.8;
- **medium:** ≥ 0.5;
- **low:** below that.

The screen shows the exact percentage.

**What the card doesn't cover yet:**
- Official layers (SACHET, IMD) aren't in the log, so the card shows RoadSense evidence only.
- "Unknown" stretches aren't told apart from "ridden recently, nothing found". The log keeps events, not coverage.

**Tests:**
- `test/master/truth.test.mjs`: the card, the words in both styles, the agent, the screen view model, and the no-model rule.
- `test/advice/ask.test.mjs`: road questions go to the solver, never to the model.
- `test/master/dynamics.test.mjs`: the evidence said and shown in a bump warning.

## Next (not built yet)

| Step | What it adds |
|---|---|
| Coverage | Remember stretches ridden with nothing found, so the card can say "ridden yesterday, nothing felt" instead of "unknown". |
| Official layers | SACHET CAP and IMD alerts as `official` observations on the card. |
| 5 | The labelled 1D-CNN behind the same DynamicsFrame. |
| Camera | The road agent (`road.hazards`) becomes a second writer. |
| Bigger cache | localStorage holds 2,000 events. A long route in a dense area can exceed that, and the least recently seen go first. IndexedDB would remove the limit. |
| Rough road | The dynamics agent sends smooth 20 m stretches as clean passes for `rough`. Today rough events expire only by fading (30-day half-life). |
