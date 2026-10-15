# RoadSense Live: the road event log (`public/js/master/roadsense/`)

One record of what is on the road, kept on the phone. **Sensors and people add observations, and fixed rules decide what can be believed.** No language model is involved: *language models talk, solvers decide, sensors verify.*

| File | What it does |
|---|---|
| `roadsense.js` | The observation format, the event log (merging, a 20 m spatial index, saving), and the verification and expiry rules (`assess`). Pure and `// @ts-check`. It is shared as the capability `roadsense` (`master-app.js`). |
| `../agents/dynamics-agent.js` | The first writer. It adds IMU jolts ("bump") and rough 20 m stretches, plus **clean passes** (rode over a known bump at ≥ 3 m/s and felt nothing). It warns `road.bump-ahead` only for **verified** bumps. |

## Observations and events

```
observation { type, t, lat, lng, source, rider, present, conf, peakMs2? }
  type     bump · pothole · speed_breaker · rough · waterlogging · gravel · debris · animal
  source   imu · camera · rider (a spoken or tapped report) · official (SACHET CAP, IMD, NHAI)
  rider    an opaque id: "self" for this phone; other riders' ids come from the server later, never names or numbers
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
| `verified` | An official source, or ≥ 2 independent pieces with confidence ≥ 0.5. A piece is a different rider, a separate pass by the same rider (≥ 60 s apart), or a second sensor on the same pass (IMU + camera). |
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

## Next (not built yet)

| Step | What it adds |
|---|---|
| 3 | Opt-in server sync of observations, with per-cell aggregation and the offline cache along the route. |
| 4 | Voice and Truth Card lines that use `riders`, `sources` and `lastSeen`. |
| 5 | The labelled 1D-CNN behind the same DynamicsFrame. |
| Camera | The road agent (`road.hazards`) becomes a second writer. `road.bump-ahead`'s words ("where you hit one before") then need a variant for spots this phone hasn't felt. |
| Rough road | The dynamics agent sends smooth 20 m stretches as clean passes for `rough`. Today rough events expire only by fading (30-day half-life). |
