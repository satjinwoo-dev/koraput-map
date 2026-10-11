package com.mapunite.app.perception

import kotlin.math.PI
import kotlin.math.floor
import kotlin.math.sin
import kotlin.math.tan

/*
 * The model slot. Phase 1 ships a DUMMY model; Phase 2 drops a LiteRT (TensorFlow
 * Lite) model in behind the same interface and nothing else changes.
 *
 *   interface PerceptionModel
 *     infer(input, ego) → ModelOutput     called on the camera thread, one frame at a time
 *
 * A real model reads pixels from input.native (the CameraX ImageProxy, YUV_420_888,
 * still open; the caller closes it after infer returns). README.md ("Phase 2: plug in LiteRT") has the
 * LiteRT version of this class, with the NPU delegate and GPU/CPU fallback.
 */

/** One camera frame handed to the model. native = the platform image (CameraX ImageProxy on Android). */
class FrameInput(
    val width: Int,
    val height: Int,
    val rotationDegrees: Int,
    val captureNs: Long,
    val native: Any?
)

interface PerceptionModel {
    val id: String
    val version: String
    /** Where inference runs: "npu", "gpu" or "cpu". */
    val delegate: String
    fun infer(input: FrameInput, ego: EgoState): ModelOutput
    fun close() {}
}

/**
 * Stand-in for the real network.
 *
 *   scenario "none"    (default) detects nothing. Use this for dataset rides: the camera,
 *                      sensors, emitter and recorder all run for real, and no fake
 *                      hazard can ever be spoken.
 *   scenario "pothole" a simulated pothole approaching at a simulated 10 m/s, every 9 s.
 *   scenario "truck"   a simulated truck closing in our lane at 5 m/s, every 9 s.
 *   scenario "mixed"   pothole + truck + a lens smudge (a "pothole" that never gets
 *                      closer, which the JS physics check must reject).
 *
 * Simulated scenarios set ModelOutput.simulatedEgo, so frames carry the simulated
 * speed and NO latitude/longitude: simulated hazards can never reach the real map.
 * They are for testing the chain on a desk, never for a real ride.
 */
class DummyModel(private val scenario: String = "none") : PerceptionModel {
    override val id: String = if (scenario == "none") "dummy" else "dummy-sim-$scenario"
    override val version: String = "0.1.0"
    override val delegate: String = "cpu"

    // A rough pinhole camera on a handlebar, only to draw believable boxes.
    private val camHeightM = 1.1
    private val horizonY = 0.45
    private val fy = 1.0 / (2.0 * tan(50.0 / 2.0 * PI / 180.0))  // vertical FOV ≈ 50°
    private val fx = 1.0 / (2.0 * tan(65.0 / 2.0 * PI / 180.0))  // horizontal FOV ≈ 65°
    private val cycleS = 9.0
    private val simSpeed = 10.0
    private var startNs = -1L

    override fun infer(input: FrameInput, ego: EgoState): ModelOutput {
        if (scenario == "none") return ModelOutput.EMPTY
        if (startNs < 0) startNs = input.captureNs
        val tS = (input.captureNs - startNs) / 1e9
        val cycle = floor(tS / cycleS).toInt()
        val t = tS - cycle * cycleS
        val wobble = sin(tS * 3.1)                       // deterministic "noise"
        val simEgo = EgoState(
            speedMs = simSpeed + 0.2 * wobble, speedSigma = 0.3, headingDeg = 0.0,
            pitchDeg = ego.pitchDeg, rollDeg = ego.rollDeg, yawRateDps = 0.0
        )
        val hazards = ArrayList<HazardDet>(2)
        val objects = ArrayList<ObjectDet>(1)

        if (scenario == "pothole" || scenario == "mixed") {
            val d = 75.0 - simSpeed * t
            if (d in 5.0..75.0) hazards += hazard(id = 1000 + cycle, cls = "pothole", d = d, lateral = 0.4, size = 0.6, conf = 0.8 + 0.06 * wobble)
        }
        if (scenario == "mixed" && t < 4.0) {
            // a smudge on the lens: same image position, same "distance", frame after frame
            hazards += hazard(id = 5000 + cycle, cls = "pothole", d = 18.0 + 0.3 * wobble, lateral = -0.2, size = 0.5, conf = 0.72)
        }
        if (scenario == "truck" || scenario == "mixed") {
            val closing = 5.0
            val d = 30.0 - closing * t
            if (d in 4.0..30.0) {
                val w = 2.5 * fx / d
                val h = 3.0 * fy / d
                val bottom = horizonY + fy * camHeightM / d
                objects += ObjectDet(
                    id = 2000 + cycle, cls = "truck", conf = 0.86 + 0.04 * wobble,
                    box = Box(0.5 - w / 2, bottom - h, w, h).clamped(),
                    distM = d, distSigma = 0.1 * d + 0.3, closingMs = closing + 0.2 * wobble, closingSigma = 0.6,
                    ttcS = d / closing, lane = "ego"
                )
            }
        }
        return ModelOutput(objects = objects, hazards = hazards, simulatedEgo = simEgo)
    }

    private fun hazard(id: Int, cls: String, d: Double, lateral: Double, size: Double, conf: Double): HazardDet {
        val w = size * fx / d
        val h = 0.35 * w
        val cx = 0.5 + fx * lateral / d
        val bottom = horizonY + fy * camHeightM / d
        return HazardDet(
            id = id, cls = cls, conf = conf.coerceIn(0.0, 1.0),
            box = Box(cx - w / 2, bottom - h, w, h).clamped(),
            distM = d, distSigma = 0.08 * d + 0.3, lateralM = lateral, lateralSigma = 0.3, sizeM = size
        )
    }
}

/** Picks the model. Phase 2: return LiteRtModel(context, "road-v0.tflite") here when the file exists. */
object ModelFactory {
    val SCENARIOS = listOf("none", "pothole", "truck", "mixed")
    fun create(scenario: String?): PerceptionModel = DummyModel(if (scenario in SCENARIOS) scenario!! else "none")
}
