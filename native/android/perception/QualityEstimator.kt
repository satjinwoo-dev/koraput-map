package com.mapunite.app.perception

import java.nio.ByteBuffer

/*
 * How usable is the camera view? (pure Kotlin; reads the Y = brightness plane only)
 *
 * Measured on a coarse grid (~160 × 90 samples, a few hundred microseconds per frame):
 *   meanLuma       average brightness 0..255          → "night" / "low-light"
 *   glareFraction  share of samples at ≥ 250          → "glare" (sun, headlights)
 *   sharpness      variance of the Laplacian on the grid → "blur" (rain, dirt, vibration)
 *   mount-moved    from SensorHub (camera pitch far from the calibrated one)
 *
 * The thresholds are STARTING POINTS. Tune them from recorded rides: the recorder
 * stores these numbers next to every saved frame (frames.csv), so you can look at the
 * frames around each threshold and move it.
 */
object QualityEstimator {

    data class LumaStats(val meanLuma: Double, val glareFraction: Double, val sharpness: Double, val samples: Int)

    // starting thresholds (see above)
    var NIGHT_LUMA = 28.0
    var LOW_LIGHT_LUMA = 55.0
    var GLARE_FRACTION = 0.12
    var BLUR_SHARPNESS = 25.0

    /**
     * @param y the Y plane; rowStride / pixelStride as CameraX reports them (rows may be padded).
     */
    fun measure(y: ByteBuffer, rowStride: Int, pixelStride: Int, width: Int, height: Int, gridCols: Int = 160): LumaStats {
        if (width <= 0 || height <= 0) return LumaStats(Double.NaN, Double.NaN, Double.NaN, 0)
        val step = maxOf(1, width / gridCols)
        val gw = width / step
        val gh = height / step
        if (gw < 3 || gh < 3) return LumaStats(Double.NaN, Double.NaN, Double.NaN, 0)
        val g = IntArray(gw * gh)
        var sum = 0L
        var bright = 0
        val limit = y.limit()
        for (gy in 0 until gh) {
            val row = gy * step * rowStride
            for (gx in 0 until gw) {
                val idx = row + gx * step * pixelStride
                val v = if (idx < limit) (y.get(idx).toInt() and 0xFF) else 0
                g[gy * gw + gx] = v
                sum += v
                if (v >= 250) bright++
            }
        }
        val n = gw * gh
        // variance of the 4-neighbour Laplacian over the inner grid
        var lsum = 0.0
        var lsq = 0.0
        var ln = 0
        for (gy in 1 until gh - 1) for (gx in 1 until gw - 1) {
            val c = g[gy * gw + gx]
            val lap = (4 * c - g[gy * gw + gx - 1] - g[gy * gw + gx + 1] - g[(gy - 1) * gw + gx] - g[(gy + 1) * gw + gx]).toDouble()
            lsum += lap; lsq += lap * lap; ln++
        }
        val lmean = lsum / ln
        return LumaStats(sum.toDouble() / n, bright.toDouble() / n, lsq / ln - lmean * lmean, n)
    }

    /** Stats + sensor flags → usable 0..1 with reasons (contract QUALITY words only). */
    fun classify(s: LumaStats, mountMoved: Boolean): ViewQuality {
        if (s.samples == 0 || !s.meanLuma.isFinite()) return ViewQuality(0.0, listOf("occluded"))
        val reasons = ArrayList<String>(3)
        var usable = 1.0
        when {
            s.meanLuma < NIGHT_LUMA -> { reasons += "night"; usable -= 0.5 }
            s.meanLuma < LOW_LIGHT_LUMA -> { reasons += "low-light"; usable -= 0.2 }
        }
        if (s.glareFraction > GLARE_FRACTION) { reasons += "glare"; usable -= 0.3 }
        if (s.sharpness < BLUR_SHARPNESS) { reasons += "blur"; usable -= 0.35 }
        if (mountMoved) { reasons += "mount-moved"; usable -= 0.6 }
        return ViewQuality(usable.coerceIn(0.0, 1.0), reasons, s.meanLuma, s.sharpness, s.glareFraction)
    }
}
