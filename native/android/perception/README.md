# MapUnitePerception: native Android plugin (Phase 1)

The road camera, sensors and dataset recorder for MapUnite's road model, as a
Capacitor plugin in Kotlin. Phase 1 runs a **dummy model**. Everything around it
is real: the camera, IMU, GNSS, thermal, the 10 Hz PerceptionFrame emitter and
the recorder. Phase 2 drops a trained LiteRT model into the same slot.

## Files

| File | What it does |
| --- | --- |
| `PerceptionPlugin.kt` | Capacitor shell: methods, events, permissions, keeps the screen on |
| `PerceptionEngine.kt` | Orchestrates everything; threads; owners; status |
| `CameraPipeline.kt` | CameraX ImageAnalysis: rear camera, ~1280 × 720, 30 fps, fixed focus, `STRATEGY_KEEP_ONLY_LATEST`, no stabilisation |
| `FrameScheduler.kt` | Which frames get inference / quality / recording; native thermal cap |
| `PerceptionModel.kt` | The model interface + `DummyModel` (nothing, or desk-test simulations) |
| `QualityEstimator.kt` | Brightness, glare, sharpness → `quality.usable` + reasons |
| `SensorHub.kt` | Accelerometer, gyroscope, rotation vector (100 Hz), GNSS (1 Hz); simple ego estimate |
| `ThermalMonitor.kt` | Android thermal status + headroom, battery |
| `FrameJson.kt` | PerceptionFrame contract v1 → JSON (no dependency, unit-tested on the JVM) |
| `PerceptionTypes.kt` | Data classes mirroring contract v1 |
| `DynamicsCore.kt` | Bike dynamics from IMU 100 Hz + GNSS: hard braking / acceleration, road jolts, roughness per 20 m (pure Kotlin, JVM-tested) |
| `DynamicsJson.kt` | DynamicsFrame contract v1 → JSON, 1 per second |
| `DatasetRecorder.kt` | Session folders: JPEG frames at 2 fps, imu.csv, gnss.csv, events.csv, meta.json |
| `PrivacyRedactor.kt` | Pixelates faces (placeholder detector) and plates (model hints) before saving |

## Set up

```bash
npx cap add android                          # once (ANDROID.md step 5)
node scripts/setup-perception-android.mjs    # copies the .kt files, adds Kotlin + CameraX to Gradle
npx cap sync android
npm run android:run
```

In the app: **Smart Drive Settings → Road data recorder**.

## Threads

```
main           CameraX binding, start/stop
mu-camera      per frame: schedule → quality → model → frame data → recorder/preview bitmaps
mu-sensors     IMU 100 Hz + GNSS 1 Hz
mu-perception  10 Hz emitter (latest frame wins) + 1 Hz housekeeping
mu-recorder    redaction, JPEG encoding, file writes
```

The camera thread never touches storage. If the recorder falls behind, frames are
skipped (counted as `skippedBusy`), never queued.

## Frame rate control

- The camera always delivers ~30 fps, and old frames are dropped, not queued.
- Inference runs at **min(JS target, native thermal cap)**. `setTargetFps` comes from
  the JS governor. **Performance profile:** the full 30 fps from none up to "moderate"
  heat. Only "severe" (15 fps) and "critical" (5 fps) slow it down; at those levels
  Android itself throttles the CPU and may close the camera. A hot phone still slows
  down even if JS stops answering.
- `setTargetFps(0)` pauses the model. Frames still go to JS at 2 Hz, with fresh
  ego, heat and view quality, so the governor can un-pause.

## Bike dynamics (Phase 2, component 1)

`startDynamics({ owner })` runs the IMU + GNSS monitor without the camera, so it works on
every ride. The camera can start and stop independently.

- **Axes:** "up" and the bike's horizontal "forward" (the rear camera direction flattened)
  come from the rotation vector in `SensorHub`. Portrait and landscape mounts both work.
- **Filters:** longitudinal acceleration is low-passed at 2 Hz. Vertical is band-passed
  0.5–12 Hz, so most single-cylinder engine vibration (25–60 Hz) doesn't count as road.
- **Events** (baseline thresholds, to be tuned from your rides):

| Event | Rule |
| --- | --- |
| `hard_brake` | ≤ −3.5 m/s² for ≥ 0.5 s; GNSS speed must fall ≥ 2 m/s (else IMU Δv ≤ −2 m/s); ≤ −6 m/s² = very hard |
| `hard_accel` | ≥ 3 m/s² for ≥ 0.7 s, GNSS speed rising ≥ 2 m/s |
| `jolt` | vertical shock ≥ 7 m/s² while ≥ 3 m/s, placed at the GNSS position of the hit |
| roughness | RMS vertical per 20 m, scaled to 10 m/s: smooth < 1, fair < 2, rough < 3.5, very rough ≥ 3.5 m/s² |

- **Output:** one DynamicsFrame per second (`"dynamics"` event). During a recording,
  every event is also written to `events.csv` as `auto_hard_brake` / `auto_jolt` …,
  so the dataset labels itself.
- **What gets spoken** is decided in JS by `agents/dynamics-agent.js`. Braking tips come only
  after 15 s stopped. A bump warning needs a strong jolt (≥ 12 m/s²) felt at the same spot
  on 2 separate passes.
- **Tested on a JVM:** `perception-jvmtest/GenDynamics.kt` simulates a 3-leg ride at 100 Hz
  (engine vibration, rough stretch, pothole, three hard brakes). The JS tests run its
  frames through the full Master AI.

## Timestamps

- Camera, IMU and GNSS share one clock: `elapsedRealtime` nanoseconds. This holds when
  the camera reports `SENSOR_INFO_TIMESTAMP_SOURCE_REALTIME`; otherwise frame times
  are arrival times, and `meta.json` says so.
- The JSON `t` is epoch milliseconds of the capture.

## Privacy (read this)

Phase 1 redaction is a **placeholder**:

- **Faces:** `android.media.FaceDetector` finds frontal faces only. Small, side-on and
  helmeted faces are missed.
- **Number plates:** not blurred. The dummy model reports no plate boxes.
- **Failures:** a frame whose redaction throws is never saved.

Every session's `meta.json` states this. Keep recordings on the phone or your own
computer. Run full face + plate redaction before anyone else views, uploads or labels them.

## Desk tests

Start with `scenario: "pothole" | "truck" | "mixed"` (recorder page → Developer):

- Frames carry a simulated 10 m/s and **no latitude/longitude**, so nothing reaches the map.
- `mixed` adds a lens smudge, a "pothole" that never gets closer. The JS physics
  check must reject it.
- Never ride with a simulation on.

## Phase 2: plug in LiteRT

1. Put the model in `android/app/src/main/assets/road-v0.tflite`.
2. Add LiteRT to `app/build.gradle`. Check the current versions first; these are examples:
   `implementation "com.google.ai.edge.litert:litert:1.0.1"` and
   `implementation "com.google.ai.edge.litert:litert-gpu:1.0.1"`. For Qualcomm NPUs,
   add the vendor's delegate (QNN). The NNAPI delegate is deprecated from Android 15.
3. Implement `PerceptionModel` and return it from `ModelFactory.create`:

```kotlin
class LiteRtModel(ctx: Context, asset: String) : PerceptionModel {
    override val id = "road"; override val version = "0.1.0"
    override var delegate = "cpu"; private set
    private val interpreter: Interpreter = /* load asset; try NPU delegate → GPU → CPU, set `delegate` */
    private val input = ByteBuffer.allocateDirect(1 * 384 * 640 * 3).order(ByteOrder.nativeOrder())  // allocated once

    override fun infer(input: FrameInput, ego: EgoState): ModelOutput {
        val image = input.native as ImageProxy          // YUV_420_888, still open
        // 1. YUV → RGB, resize/letterbox into `this.input` (rotate by input.rotationDegrees)
        // 2. interpreter.runForMultipleInputsOutputs(arrayOf(this.input), outputs)
        // 3. decode heads → boxes + classes (+ calibrated conf), distance + sigma, lanes, relations
        // 4. track ids across frames (ByteTrack), closing speed + TTC from the track history
        // 5. faces / plates → ModelOutput.privacy (the recorder blurs them)
        return ModelOutput(/* … */)
    }
    override fun close() = interpreter.close()
}
```

Nothing in JS changes as long as the output follows contract v1.

## Verified here (and not)

- **Compiled:** all Kotlin, with Kotlin 2.0.21, against the real Android API 33 jar
  and hand-written stubs of the CameraX / Capacitor signatures. `MainActivity.java`
  compiles against it.
- **Tested on a plain JVM:** `FrameJson` + `DummyModel` + `FrameScheduler` +
  `QualityEstimator`. Their frames pass `contract.js` with zero drops. Fed to
  `confirm.js`, the simulated pothole is confirmed, the lens smudge is rejected, and
  the truck raises a closing warning.
- **Not run yet:** on a phone, nor through a real Gradle build (Google's Maven isn't
  reachable from where this was written). The first `./gradlew assembleDebug` may
  surface a version mismatch. The messages are usually exact, and the setup script
  prints anything it couldn't patch.
