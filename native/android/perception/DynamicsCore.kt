package com.mapunite.app.perception

import kotlin.math.PI
import kotlin.math.abs
import kotlin.math.cos
import kotlin.math.sin
import kotlin.math.sqrt

/*
 * Bike dynamics from the phone's IMU (100 Hz) + GNSS (1 Hz). Pure Kotlin, no Android.
 *
 * Input per accelerometer sample: the raw acceleration in device axes (m/s², gravity
 * included) and two unit vectors in the same device axes: "up" and the bike's
 * horizontal "forward" (SensorHub gets both from the rotation vector, so any mount,
 * portrait or landscape, works). Then:
 *
 *   longitudinal  a · forward, low-passed at 2 Hz (braking and acceleration)
 *   vertical      a · up − g, band-passed 0.5–12 Hz (road shocks; most engine
 *                 vibration and the slow bike pitch are filtered out)
 *
 * Events (baseline thresholds, starting points to tune from recorded rides):
 *   hard_brake   longitudinal ≤ −3.5 m/s² (≈ 0.36 g) for ≥ 0.5 s, confirmed by GNSS
 *                speed falling ≥ 2 m/s around it (or, without GNSS, by the integrated
 *                IMU speed change ≤ −2 m/s); ≤ −6 m/s² (≈ 0.6 g) is "very hard"
 *   hard_accel   ≥ 3 m/s² for ≥ 0.7 s, confirmed by GNSS speed rising ≥ 2 m/s
 *   jolt         vertical shock ≥ 7 m/s² while riding ≥ 3 m/s: a pothole, breaker or
 *                broken patch hit; placed on the map at the GNSS position, projected
 *                to the moment of the hit
 * Road roughness: RMS of the vertical band every 20 m ridden, scaled to a reference
 * speed of 10 m/s (a rough road shakes more the faster you ride):
 *   smooth < 1.0 · fair < 2.0 · rough < 3.5 · very_rough ≥ 3.5 m/s²
 *
 * Nothing here speaks. The JS dynamics agent decides what reaches the rider, through
 * the Master AI (after the ride or when stopped, for braking; ahead of time, for
 * bumps it has met before).
 */
class DynamicsCore(val cfg: Config = Config()) {

    data class Config(
        val brakeOnMs2: Double = 3.5, val brakeOffMs2: Double = 1.5, val brakeMinS: Double = 0.5, val veryHardMs2: Double = 6.0,
        val accelOnMs2: Double = 3.0, val accelOffMs2: Double = 1.2, val accelMinS: Double = 0.7,
        val gnssChangeMs: Double = 2.0, val imuChangeMs: Double = 2.0, val gnssWindowS: Double = 2.0,
        val minMovingMs: Double = 4.0,
        val joltMs2: Double = 7.0, val joltMinSpeedMs: Double = 3.0, val joltDebounceS: Double = 0.4,
        val segmentM: Double = 20.0, val refSpeedMs: Double = 10.0, val roughMinSpeedMs: Double = 3.0,
        val longCutHz: Double = 2.0, val vertLowHz: Double = 0.5, val vertHighHz: Double = 12.0
    )

    data class Event(
        val id: Int, val type: String, val tNs: Long, val durS: Double, val peakMs2: Double,
        val speedFromMs: Double?, val speedToMs: Double?, val dvImuMs: Double,
        val lat: Double?, val lng: Double?, val headingDeg: Double?, val conf: Double, val source: String
    )

    data class Segment(
        val tNs: Long, val distM: Double, val rmsMs2: Double, val refRmsMs2: Double, val cls: String,
        val speedMs: Double, val lat: Double?, val lng: Double?, val headingDeg: Double?
    )

    data class Summary(
        val longMeanMs2: Double, val longMinMs2: Double, val longMaxMs2: Double, val vertRmsMs2: Double,
        val braking: Boolean, val imuHz: Double, val events: List<Event>, val segments: List<Segment>
    )

    private data class Fix(val tNs: Long, val speed: Double?, val lat: Double, val lng: Double, val bearing: Double?)

    private val fixes = ArrayDeque<Fix>()
    private var lastNs = 0L
    private var longF = Double.NaN
    private var vertLp = Double.NaN
    private var vertBase = Double.NaN
    private var nextId = 1

    // braking / acceleration state machines
    private class Run(val tStart: Long) { var peak = 0.0; var dv = 0.0; var tLastOver = 0L }
    private var brake: Run? = null
    private var accel: Run? = null
    private class Pending(val type: String, val run: Run, val tEnd: Long)
    private val pending = ArrayList<Pending>()

    // jolt capture
    private var joltStart = 0L
    private var joltPeak = 0.0
    private var lastJoltNs = Long.MIN_VALUE / 2

    // roughness accumulation
    private var segDist = 0.0
    private var segSq = 0.0
    private var segN = 0
    private var segSpeedSum = 0.0

    // 1-second summary accumulation
    private var sumLong = 0.0; private var minLong = 0.0; private var maxLong = 0.0; private var sumVertSq = 0.0; private var nSum = 0
    private var samplesSinceSummary = 0
    private var lastSummaryNs = 0L

    private val ready = ArrayList<Event>()
    private val segments = ArrayList<Segment>()

    /** One accelerometer sample. [a] device axes incl. gravity; [up], [fwd] unit vectors in device axes. */
    @Synchronized
    fun onImu(tNs: Long, ax: Double, ay: Double, az: Double, up: DoubleArray, fwd: DoubleArray) {
        val dt = if (lastNs == 0L) 0.01 else ((tNs - lastNs) / 1e9).coerceIn(0.0005, 0.1)
        lastNs = tNs
        samplesSinceSummary++
        val long = ax * fwd[0] + ay * fwd[1] + az * fwd[2]
        val vert = ax * up[0] + ay * up[1] + az * up[2] - G

        // filters (exponential, rate-independent)
        longF = ema(longF, long, cfg.longCutHz, dt)
        vertLp = ema(vertLp, vert, cfg.vertHighHz, dt)
        vertBase = ema(vertBase, vertLp, cfg.vertLowHz, dt)
        val hp = vertLp - vertBase

        sumLong += longF; sumVertSq += hp * hp; nSum++
        if (nSum == 1) { minLong = longF; maxLong = longF } else { if (longF < minLong) minLong = longF; if (longF > maxLong) maxLong = longF }

        // ---- hard braking
        val b = brake
        if (b == null) {
            if (longF <= -cfg.brakeOnMs2) brake = Run(tNs).also { it.peak = longF; it.tLastOver = tNs }
        } else {
            b.dv += longF * dt
            if (longF < b.peak) b.peak = longF
            if (longF <= -cfg.brakeOnMs2) b.tLastOver = tNs
            if (longF > -cfg.brakeOffMs2) {
                brake = null
                if ((b.tLastOver - b.tStart) / 1e9 >= cfg.brakeMinS) pending += Pending("hard_brake", b, tNs)
            }
        }
        // ---- hard acceleration
        val a = accel
        if (a == null) {
            if (longF >= cfg.accelOnMs2) accel = Run(tNs).also { it.peak = longF; it.tLastOver = tNs }
        } else {
            a.dv += longF * dt
            if (longF > a.peak) a.peak = longF
            if (longF >= cfg.accelOnMs2) a.tLastOver = tNs
            if (longF < cfg.accelOffMs2) {
                accel = null
                if ((a.tLastOver - a.tStart) / 1e9 >= cfg.accelMinS) pending += Pending("hard_accel", a, tNs)
            }
        }

        val speed = speedAt(tNs)
        // ---- jolts
        if (joltStart != 0L) {
            if (abs(hp) > abs(joltPeak)) joltPeak = hp
            if (tNs - joltStart >= 120_000_000L) {
                val p = positionAt(joltStart)
                ready += Event(nextId++, "jolt", joltStart, (tNs - joltStart) / 1e9, joltPeak, speed, speed, 0.0,
                    p?.first, p?.second, p?.third, conf = 0.7, source = "imu")
                lastJoltNs = joltStart
                joltStart = 0L
            }
        } else if (speed != null && speed >= cfg.joltMinSpeedMs && abs(hp) >= cfg.joltMs2 && (tNs - lastJoltNs) / 1e9 >= cfg.joltDebounceS) {
            joltStart = tNs; joltPeak = hp
        }

        // ---- roughness per 20 m
        if (speed != null && speed >= cfg.roughMinSpeedMs) {
            segDist += speed * dt; segSq += hp * hp; segN++; segSpeedSum += speed
            if (segDist >= cfg.segmentM) {
                val rms = sqrt(segSq / segN)
                val v = segSpeedSum / segN
                val ref = rms * sqrt(cfg.refSpeedMs / maxOf(v, 4.0))
                val p = positionAt(tNs)
                segments += Segment(tNs, segDist, rms, ref, roughClass(ref), v, p?.first, p?.second, p?.third)
                segDist = 0.0; segSq = 0.0; segN = 0; segSpeedSum = 0.0
            }
        } else { segDist = 0.0; segSq = 0.0; segN = 0; segSpeedSum = 0.0 }

        settlePending(tNs)
    }

    /** One GNSS fix. speed null when the receiver doesn't report it. */
    @Synchronized
    fun onGnss(tNs: Long, speedMs: Double?, lat: Double, lng: Double, bearingDeg: Double?) {
        fixes.addLast(Fix(tNs, speedMs, lat, lng, bearingDeg))
        while (fixes.size > 2 && tNs - fixes.first().tNs > 15_000_000_000L) fixes.removeFirst()
        settlePending(lastNs.coerceAtLeast(tNs))
    }

    /** Everything since the last call (call about once a second). */
    @Synchronized
    fun summary(tNs: Long): Summary {
        settlePending(tNs)
        val dtS = if (lastSummaryNs == 0L) 1.0 else ((tNs - lastSummaryNs) / 1e9).coerceAtLeast(0.001)
        val s = Summary(
            longMeanMs2 = if (nSum > 0) sumLong / nSum else 0.0,
            longMinMs2 = if (nSum > 0) minLong else 0.0,
            longMaxMs2 = if (nSum > 0) maxLong else 0.0,
            vertRmsMs2 = if (nSum > 0) sqrt(sumVertSq / nSum) else 0.0,
            braking = brake != null,
            imuHz = samplesSinceSummary / dtS,
            events = ArrayList(ready), segments = ArrayList(segments)
        )
        ready.clear(); segments.clear()
        sumLong = 0.0; sumVertSq = 0.0; nSum = 0; samplesSinceSummary = 0
        lastSummaryNs = tNs
        return s
    }

    // ---------------------------------------------------------------- confirmation

    private fun settlePending(nowNs: Long) {
        if (pending.isEmpty()) return
        val it = pending.iterator()
        while (it.hasNext()) {
            val p = it.next()
            val windowEnd = p.tEnd + (cfg.gnssWindowS * 1e9).toLong()
            val haveLaterFix = fixes.any { f -> f.tNs >= windowEnd && f.speed != null }
            val timedOut = nowNs - windowEnd > 2_000_000_000L
            if (!haveLaterFix && !timedOut) continue
            it.remove()
            confirm(p, windowEnd)?.let { ev -> ready += ev }
        }
    }

    private fun confirm(p: Pending, windowEnd: Long): Event? {
        val braking = p.type == "hard_brake"
        val before = fixes.lastOrNull { it.tNs <= p.run.tStart && it.speed != null && p.run.tStart - it.tNs <= 2_000_000_000L }
            ?: fixes.firstOrNull { it.tNs > p.run.tStart && it.speed != null && it.tNs - p.run.tStart <= 500_000_000L }
        val during = fixes.filter { it.tNs in p.run.tStart..windowEnd && it.speed != null }.map { it.speed!! }
        val from = before?.speed
        val to = if (during.isEmpty()) null else if (braking) during.min() else during.max()
        val dvImu = p.run.dv
        var source: String
        var conf: Double
        if (from != null && to != null) {
            if (braking && from < cfg.minMovingMs) return null                 // not riding: the phone was handled
            val change = if (braking) from - to else to - from
            if (change >= cfg.gnssChangeMs) { source = "imu+gnss"; conf = 0.9 }
            else if (abs(dvImu) >= cfg.imuChangeMs) { source = "imu"; conf = 0.6 }  // GNSS lagging or smoothing
            else return null                                                    // a pitch / bump, not a speed change
        } else {
            if (abs(dvImu) < cfg.imuChangeMs) return null
            source = "imu"; conf = 0.5
        }
        if (braking && p.run.peak <= -cfg.veryHardMs2) conf = minOf(0.95, conf + 0.05)
        val pos = positionAt(p.run.tStart)
        return Event(nextId++, p.type, p.run.tStart, (p.tEnd - p.run.tStart) / 1e9, p.run.peak, from, to, dvImu,
            pos?.first, pos?.second, pos?.third, conf, source)
    }

    // ---------------------------------------------------------------- helpers

    /** Speed from the newest fix, if it's fresh (≤ 3 s). */
    private fun speedAt(tNs: Long): Double? {
        val f = fixes.lastOrNull() ?: return null
        return if (tNs - f.tNs <= 3_000_000_000L) f.speed else null
    }

    /** Position at time t: newest fix at or before t, moved along its bearing at its speed. */
    private fun positionAt(tNs: Long): Triple<Double, Double, Double?>? {
        val f = fixes.lastOrNull { it.tNs <= tNs } ?: fixes.firstOrNull() ?: return null
        val age = (tNs - f.tNs) / 1e9
        if (abs(age) > 3.0) return null
        val b = f.bearing
        val s = f.speed
        if (b == null || s == null || age <= 0) return Triple(f.lat, f.lng, b)
        val d = s * age
        val th = b * PI / 180.0
        val lat = f.lat + d * cos(th) / 111_320.0
        val lng = f.lng + d * sin(th) / (111_320.0 * cos(f.lat * PI / 180.0))
        return Triple(lat, lng, b)
    }

    companion object {
        const val G = 9.80665
        fun roughClass(refRms: Double): String = when {
            refRms < 1.0 -> "smooth"
            refRms < 2.0 -> "fair"
            refRms < 3.5 -> "rough"
            else -> "very_rough"
        }
        /** First-order low-pass with cut-off [hz], for a sample dt seconds after the previous one. */
        fun ema(prev: Double, x: Double, hz: Double, dt: Double): Double {
            if (prev.isNaN()) return x
            val rc = 1.0 / (2.0 * PI * hz)
            return prev + (dt / (rc + dt)) * (x - prev)
        }
    }
}
