# Road perception (unified multitask model): JS side

The camera, the model, tracking and sensor fusion run natively in the
`MapUnitePerception` Capacitor plugin (not built yet). JS receives about
10 **PerceptionFrames** per second and decides what the Master AI says.
Pixels never cross the bridge.

| File | Role |
| --- | --- |
| `contract.js` | PerceptionFrame schema v1 (objects, hazards, relations, lanes, ego, quality, perf). Every distance and speed carries a sigma. Invalid items are dropped, not the whole frame. |
| `provider.js` | Capability `perception`: the native plugin, or a replay of recorded frames (JSONL or an array). |
| `confirm.js` | No single-frame alerts: hazard confirmer (≥ 1 s, ≥ 2/3 seen, conf ≥ 0.6, physics check), closing watch (TTC ≤ 4 s, 3 frames), relation watch. |
| `governor.js` | Frame rate from heat, speed, battery and view quality, with hysteresis. |
| `native.js` | Typed interface to the whole `MapUnitePerception` plugin (recorder, preview, calibration, status), with owners and `PerceptionError` codes. |
| `recorder-page.js` | The road data recorder page (`/recorder.html`, Android app only). |
| `../agents/road-agent.js` | The Master AI sub-agent: runs only while riding, speaks hazards 2–8 s ahead, keeps a 20 m hazard map on the phone. |

## Plugging in a trained model

1. Make the native plugin emit `frame` events in contract v1. Nothing in JS changes.
2. Before the plugin exists, set `window.MU_PERCEPTION_REPLAY` to JSONL text of frames;
   the whole chain (confirmation, voice, map) runs on them.
3. Review a new model by replaying a recorded ride through it and comparing what would be said.
4. A breaking schema change bumps `version` to 2.

## Native plugin API (Phase 1 built: native/android/perception/)

| Call / event | Meaning |
| --- | --- |
| `start({ targetFps, emitHz, scenario, owner })` | Open camera, load the model, start emitting (camera stays on while any owner holds it) |
| `stop()` | Release camera and model |
| `setTargetFps({ fps })` | Governor cap; 0 pauses inference |
| `status()` / `calibrate({ mountHeightM })` / `preview()` | Delegate, fps, latency, thermal / mount pitch, roll, height / a JPEG to aim the mount |
| `startRecording()` / `stopRecording()` / `mark({ label })` | Dataset mode: 2 fps frames + IMU + GNSS + rider marks; faces blurred on the phone (placeholder), plates not yet |
| event `frame` | One PerceptionFrame v1 |
| event `state` | starting, running, error, thermal |

Voice alerts are advisory early warnings. A spoken line takes about 1 s end to end,
so this never claims to prevent collisions.

Tests: `node --test test/master/perception.test.mjs` (simulated rides).
