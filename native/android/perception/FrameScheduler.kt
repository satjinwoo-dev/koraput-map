package com.mapunite.app.perception

/*
 * Which camera frames get which work (pure Kotlin).
 *
 * The camera always delivers ~30 fps (STRATEGY_KEEP_ONLY_LATEST: if we are busy,
 * old frames are dropped, never queued). For each frame this decides:
 *   infer    run the model (rate = min(JS target fps, native thermal cap))
 *   quality  measure the view (every inferred frame; 2 Hz while inference is paused,
 *            so JS keeps getting fresh frames and its governor can un-pause)
 *   record   the recorder wants a frame (2 fps, its own clock)
 * Frames needing nothing are closed at once.
 *
 * The thermal cap is a native safety net under the JS governor: even if JS stops
 * answering, a hot phone slows itself down.
 */
class FrameScheduler(
    @Volatile var targetFps: Int = 30,
    private val pausedQualityPeriodNs: Long = 500_000_000L
) {
    @Volatile var thermalCapFps: Int = 30
    private var lastInferNs = Long.MIN_VALUE / 2
    private var lastQualityNs = Long.MIN_VALUE / 2

    data class Decision(val infer: Boolean, val quality: Boolean)

    val effectiveFps: Int get() = minOf(targetFps, thermalCapFps).coerceIn(0, 60)

    fun decide(tNs: Long): Decision {
        val fps = effectiveFps
        var infer = false
        if (fps > 0) {
            val period = 1_000_000_000L / fps
            // 15 % tolerance: a 30 fps camera's frames arrive 33 ms ± jitter apart
            if (tNs - lastInferNs >= period * 85 / 100) { infer = true; lastInferNs = tNs }
        }
        var quality = infer
        if (!infer && fps == 0 && tNs - lastQualityNs >= pausedQualityPeriodNs) quality = true
        if (quality) lastQualityNs = tNs
        return Decision(infer, quality)
    }

    companion object {
        /**
         * Native frame-rate ceiling per Android thermal status. Performance profile: full 30 fps up to
         * "moderate" (airflow on the handlebar keeps most rides there); only "severe" and "critical",
         * where Android itself throttles the CPU and may shut the camera, slow it down.
         */
        fun thermalCap(thermal: String): Int = when (thermal) {
            "severe" -> 15
            "critical" -> 5
            else -> 30
        }
    }
}

/** Exponentially weighted moving average (for fps and latency in perf { … }). */
class Ewma(private val alpha: Double = 0.1) {
    var value: Double = Double.NaN
        private set
    fun add(x: Double): Double {
        if (!x.isFinite()) return value
        value = if (value.isNaN()) x else value + alpha * (x - value)
        return value
    }
    fun reset() { value = Double.NaN }
}

/** Measures a rate (events per second) from event timestamps. */
class RateMeter(alpha: Double = 0.15) {
    private val ewma = Ewma(alpha)
    private var lastNs = Long.MIN_VALUE
    fun tick(tNs: Long) {
        if (lastNs != Long.MIN_VALUE && tNs > lastNs) ewma.add(1e9 / (tNs - lastNs))
        lastNs = tNs
    }
    val rate: Double get() = if (ewma.value.isNaN()) 0.0 else ewma.value
    fun reset() { ewma.reset(); lastNs = Long.MIN_VALUE }
}
