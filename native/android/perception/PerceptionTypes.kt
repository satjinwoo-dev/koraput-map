package com.mapunite.app.perception

/*
 * MapUnite road perception: shared types (pure Kotlin, no Android imports).
 *
 * These mirror PerceptionFrame contract v1 (public/js/master/perception/contract.js).
 * Every distance and speed carries its sigma (1-standard-deviation uncertainty),
 * because the JS side decides on value + uncertainty + persistence, never on one frame.
 *
 * Units: SI everywhere. Metres, metres per second, seconds, degrees for angles
 * shown to people. Times: nanoseconds on the elapsedRealtime clock inside the app
 * (one clock for camera, IMU and GNSS), epoch milliseconds only in the JSON "t".
 */

/** Contract version emitted. JS rejects frames whose version it doesn't know. */
const val CONTRACT_VERSION = 1

/** Class lists, in the same order as contract.js (= the model's class index). */
object Classes {
    val OBJECTS = listOf(
        "two_wheeler", "auto_rickshaw", "e_rickshaw", "car", "suv", "bus", "truck", "tractor", "lcv",
        "cyclist", "pedestrian", "handcart", "cattle", "dog", "other_animal"
    )
    val HAZARDS = listOf(
        "pothole", "waterlogging", "speed_breaker_marked", "speed_breaker_unmarked", "rumble_strip",
        "gravel_sand", "road_work", "open_manhole", "debris", "broken_edge", "wet_patch", "oil_or_mud"
    )
    val RELATIONS = listOf(
        "cutting_in", "wrong_side", "overtaking_ego", "braking_hard", "door_opening", "crossing_path",
        "stopped_in_lane", "reversing", "following_ego"
    )
    val THERMAL = listOf("none", "light", "moderate", "severe", "critical")
    val LANES = listOf("ego", "left", "right", "oncoming", "unknown")
    val QUALITY = listOf("night", "rain-on-lens", "glare", "blur", "occluded", "mount-moved", "low-light", "fog")
}

/** Normalised box in the upright image: x, y = top-left, w, h; all 0..1. */
data class Box(val x: Double, val y: Double, val w: Double, val h: Double) {
    /** Inside the image, at least 0.001 wide and tall (the contract rejects empty boxes). */
    fun clamped(): Box {
        val cx = x.coerceIn(0.0, 0.999)
        val cy = y.coerceIn(0.0, 0.999)
        return Box(cx, cy, w.coerceAtMost(1.0 - cx).coerceAtLeast(0.001), h.coerceAtMost(1.0 - cy).coerceAtLeast(0.001))
    }
}

/** A road user, tracked across frames (id stays the same for the same vehicle). */
data class ObjectDet(
    val id: Int,
    val cls: String,
    val conf: Double,
    val box: Box,
    val distM: Double,
    val distSigma: Double,
    /** Positive = getting closer to us. */
    val closingMs: Double,
    val closingSigma: Double,
    /** Time to collision in seconds, or null when not closing. */
    val ttcS: Double?,
    val lane: String = "unknown"
)

/** A road-surface hazard (pothole, waterlogging, unmarked breaker …), tracked across frames. */
data class HazardDet(
    val id: Int,
    val cls: String,
    val conf: Double,
    val box: Box,
    val distM: Double,
    val distSigma: Double,
    /** Positive = to our right. */
    val lateralM: Double,
    val lateralSigma: Double,
    val sizeM: Double? = null
)

/** Traffic behaviour between road users (never identity). obj = another object id, "ego", or null. */
data class RelationDet(val subj: Int, val rel: String, val obj: String?, val conf: Double)

/**
 * Areas to blur before a frame is saved (faces, number plates). Never sent to JS,
 * never stored: they only drive the recorder's privacy redaction.
 */
data class PrivacyBox(val kind: String, val box: Box, val conf: Double)

/** Everything the model says about one camera frame. */
data class ModelOutput(
    val objects: List<ObjectDet> = emptyList(),
    val hazards: List<HazardDet> = emptyList(),
    val relations: List<RelationDet> = emptyList(),
    val privacy: List<PrivacyBox> = emptyList(),
    /**
     * Set by simulation models only: the ego motion the simulated world assumes.
     * The emitter then drops lat/lng from the frame, so simulated hazards are never
     * placed on the real map.
     */
    val simulatedEgo: EgoState? = null
) {
    companion object { val EMPTY = ModelOutput() }
}

/** Our own motion: speed, heading and attitude, with uncertainties. */
data class EgoState(
    val speedMs: Double,
    val speedSigma: Double,
    val headingDeg: Double?,
    val pitchDeg: Double,
    val rollDeg: Double,
    val lat: Double? = null,
    val lng: Double? = null,
    val posSigmaM: Double? = null,
    /** Age of the newest GNSS fix in ms (null = no fix yet). Not part of the contract; for status. */
    val gnssAgeMs: Long? = null,
    /** Rotation rate about the vertical axis, degrees per second (positive = turning left). */
    val yawRateDps: Double = 0.0
) {
    companion object {
        /** Nothing known yet: zero speed with a huge uncertainty, so nothing downstream trusts it. */
        val UNKNOWN = EgoState(speedMs = 0.0, speedSigma = 30.0, headingDeg = null, pitchDeg = 0.0, rollDeg = 0.0)
    }
}

/** How usable the camera view is right now (0..1) and why not. */
data class ViewQuality(
    val usable: Double,
    val reasons: List<String>,
    val meanLuma: Double = Double.NaN,
    val sharpness: Double = Double.NaN,
    val glareFraction: Double = Double.NaN
) {
    companion object { val UNKNOWN = ViewQuality(0.0, listOf("occluded")) }
}

/** Runtime performance numbers for perf { … } in the frame. */
data class PerfState(val fps: Double, val latencyMs: Double, val thermal: String, val delegate: String)

/** Which weights and which camera calibration produced a frame. */
data class ModelInfo(val id: String, val version: String, val calib: String)

/** One analysed camera frame, before it is serialised. Built at camera rate, serialised only when emitted. */
data class FrameData(
    val tEpochMs: Long,
    val seq: Long,
    val model: ModelInfo,
    val perf: PerfState,
    val ego: EgoState,
    val quality: ViewQuality,
    val output: ModelOutput
)
