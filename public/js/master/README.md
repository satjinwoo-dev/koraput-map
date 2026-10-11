# Master AI: the hierarchical core (`public/js/master/`)

The Master AI doesn't do the work itself. **Sub-agents** watch one thing each (the network, the ride, later the camera, Bluetooth and the group) and **report facts**. The **brain** decides what reaches the rider, the **persona** puts it in words (desi Hinglish by default), and the app's existing **safety gate** decides whether it's spoken.

```
 sub-agents ──report──▶ bus ──▶ brain ──▶ persona ──▶ output ──▶ voiceAnnounce() ──▶ advice gate ──▶ VoiceAssistant
 (ride, network,         │      policies   words      island +       (js/voice.js)     (quiet ride,     (queue, pre-empt,
  vision, radar, …)      │      queue                 "mu:master-say"                   busy, storms)    mute)
                         └── state.* (shared facts: state.ride, state.network …)
 capabilities: network · location · route · drive · store   (camera, bluetooth … plug in later)
 kernel: starts, stops, restarts and isolates every agent
```

The Master never has a voice of its own. It goes through the same `voiceAnnounce()` as every other cue, so it can't talk over a turn instruction, and quiet ride, mute and "Spoken alerts" all apply to it.

**Ask before tips** (on by default): a tip starts with "Bhai, ek baat bolun?", and the mic listens for about 3.5 s. The tip is spoken only after a yes; "nahi" or silence drops it. Critical lines never ask. The brain waits for the answer before anything else leaves its queue. Its decisions read `asking`, then `spoken`, `declined`, `unanswered` or `interrupted`; an interrupted tip is offered once more. See `js/advice/README.md` → "Ask before tips".

## Files

| File | What it does |
|---|---|
| `contracts.js` | The shared language: `API_VERSION`, severities and their priority bands, topic names, `normalizeReport`, `validateAgent`. Load first. |
| `bus.js` | The event bus: topics with `*`/`**` patterns, sticky state, request/response, error isolation, cleanup by owner. |
| `capabilities.js` | Sensors and services behind one door. Ships `network`, `location` (the app's own GPS pipeline, so no second GPS watch), `route`, `drive` and `store`. |
| `kernel.js` | The agent registry and lifecycle: dependencies, `runWhen`, crash back-off, watchdog, hot-swap, lazy loading, enable/disable. |
| `brain.js` | The Master: pluggable policies, a priority queue, superseding, cooldowns, delegation (`task.*`), transcript. |
| `persona.js` | Report → words: the spoken line in the voice's style (desi Hinglish or plain), and screen title + subtitle **always in English** (from the plain pack; `data.screen` overrides values on screen only). Templates, filters (`km`, `min`), line rotation, short critical lines. |
| `phrases-desi.js` | The words. `desi`: spoken only. `plain`: English, spoken in plain style and always the screen's title and sub. No logic. |
| `output.js` | Voice through `voiceAnnounce()` (and so the gate), the status island, the `mu:master-say` event. |
| `master-app.js` | Boot: wires everything, exposes `MUMaster.live`. Load last. |
| `agents/ride-agent.js` | `state.ride`: riding time, breaks and distance. Says when a break is due (1 h 30 min, then 2 h). |
| `agents/network-agent.js` | Network health (OS flag, connection type, a round trip to our server), plus no-signal zones it learns on this phone and warns about before you reach them. |
| `agents/vision-agent.js` + `vision/` | The break-time fatigue check: armed by `ride.break-due`, offered only once the bike has stood still ≥ 15 s, front camera + MediaPipe on the phone, reports `fatigue.high/moderate/low`. See `vision/README.md`. |
| `agents/_template.js` | A fully commented agent to copy. It isn't loaded by `index.html`. |

## Severities

| Severity | Priority | Gate level | What happens |
|---|---|---|---|
| `critical` | 85–100 | critical | Skips the queue and is always spoken (nothing can mute a safety call). |
| `warning` | 60–84 | warning | Spoken; in quiet ride it's shown on screen only. |
| `advice` | 20–59 | advice | Spoken if the gate allows: not in quiet ride, after a turn, in a storm, or within 45 s of another tip. |
| `info` | 0–19 | (none) | Transcript only: never spoken or shown. |

## Adding a sub-agent (the whole procedure)

1. Copy `agents/_template.js` to `agents/<id>-agent.js`. Set `id`, `version` and `apiVersion: 1`.
2. List what it needs: `requires` (it waits without these), `optional`, `depends` (other agents) and, if it should only run sometimes, `runWhen: { topic: "state.ride", test: (r) => r && r.active }`.
3. In `start(ctx)`, use only `ctx`:
   - `ctx.report(kind, { severity, data, key })` sends a fact to the Master;
   - `ctx.setState(name, value)` shares a fact with other agents;
   - `ctx.caps.get(name)` gets a sensor;
   - `ctx.timers` and `ctx.wrap()` are cleaned up for you.
4. Add its lines to `phrases-desi.js`: `desi` (spoken Hinglish, no titles) and `plain` (English, with `title` and `sub`, which is what the screen shows). Tests check that both cover the same kinds and that screen text is English.
5. Add one `<script>` tag before `master-app.js` (plus the file in `sw.js`), or load it lazily: add `{ id, src, loadOn }` to `LAZY` in `master-app.js`.

Nothing else changes. If the agent crashes, it's restarted with back-off (1 s, 2 s, 4 s … up to 60 s), and after 5 restarts in 10 minutes it stays off until `MUMaster.live.kernel.restart(id)`. The rest of the system keeps running either way.

## Other extension points

- **A new sensor:** `MUMaster.live.caps.provide("camera", provider)`. Agents that `require` it start on their own, and stop again if it's revoked (for example, permission withdrawn). Put Capacitor plugin calls in the provider, never in agents.
- **A new rule:** `MUMaster.live.brain.use("night-mode", (report, api) => report | null | { drop: "why" }, { order: 25 })`.
- **A job for a specialist:** an agent registers `ctx.bus.handle("task.deep-search", async (q) => …)`, and the Master calls `brain.delegate("deep-search", q)`. Neither knows the other.
- **A new version of an agent:** `MUMaster.define()` with the same `id` hot-swaps it.

## How the next engines plug in

| Engine | Capability to add | Agent | Reports / services |
|---|---|---|---|
| Biometric selfie | `face-scan` (**done**: `vision/face-scan.js`) | `vision` (**done**); the heavy model loads only when a check starts | `vision.offer`, `fatigue.*`; `task.fatigue-check` |
| Helmet check | `camera` | `helmet`, `runWhen` riding, every 20 min | `helmet.missing` (warning) |
| Bluetooth radar | `ble-scan` (wraps `@capacitor-community/bluetooth-le`, already bundled) | `radar` | `radar.close` (critical), `radar.follower` (warning) |
| AI-to-AI swarm | `mesh` (the trip socket and the existing BLE beacons) | `swarm`, `runWhen` in a group trip | relays trip-mates' reports into `report.swarm.*` |
| Weather 1 km ahead | (route + Open-Meteo) | `weather`, which takes over from the advice module's own weather voice line | `weather.ahead` (lines already in the pack) |
| Deep search | (server endpoint) | `deep-search` | `task.deep-search` |

## Console

```js
MUMaster.live.status()                       // every agent: state, reason, errors, restarts
MUMaster.live.debug.log(true)                // print every bus message
MUMaster.live.debug.simulate("rest.stop", { data: { distanceM: 2000, place: "Sharma chai tapri" } })
MUMaster.live.setStyle("plain"); MUMaster.live.setName("Rahul")
MUMaster.live.disable("network"); MUMaster.live.enable("network")
MUMaster.live.transcript()
```

Settings are kept on the phone only, in localStorage under `mu.master.v1`. The network agent's learned no-signal cells are stored under `mu.master.network.deadCells` (cells of about 1 km, oldest dropped after 600) and are never uploaded.

## Tests

Run `node --test test/master/*.test.mjs` (23 tests, fake clock, no browser). They cover:
- the contracts and the bus (patterns, ordering, isolation, request timeouts);
- kernel lifecycles (waiting, `runWhen`, cleanup, back-off, degrade, hot-swap, heartbeat, cycles, lazy loading);
- the persona and pack lint;
- brain ordering, superseding, cooldowns, expiry and delegation;
- the brain wired to the real advice gate;
- output;
- the ride and network agents (including zone learning);
- the template.

Type check with `tsc -p tsconfig.master.json`.
