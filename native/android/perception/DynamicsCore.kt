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
 *   jolt         a road impact (pothole, breaker, broken patch), detector v2:
 *                1. trigger: vertical shock ≥ 4 m/s² while riding ≥ 3 m/s (cheap, high recall)
 *                2. wait 1 s, then read the IMU ring buffer around it (−1.6 s … +1 s)
 *                3. features: the first peak scaled to 10 m/s like roughness (peakRef),
 *                   its contrast with the road around it (a rough road is rough, not a
 *                   pothole: random road vibration peaks at ~3–4× its RMS, so a hazard must
 *                   stand out more than that), the rear wheel's second hit wheelbase / speed later
 *                   (doubleHit: a real road feature hits both wheels; the rider's hand or
 *                   the mount doesn't), and the shape (a drop before the hit: pothole; a
 *                   long rise, often after slowing down: speed breaker)
 *                4. class (cls):
 *                     ignored  below minorMs2, or low contrast: normal vibration, a rough road,
 *                              the small unevenness the old fixed 7 m/s² threshold reported
 *                     minor    below impactMs2: a small bump (the rider's review, collapsed)
 *                     unknown  strong but single-hit below severeMs2: something hit, but not
 *                              both wheels (a stone, the rider's hand, a one-wheel edge?)
 *                     impact   an actionable hazard, severity 2, or 3 from severeMs2
 *                   minor and unknown never become road events, warnings or public reports on
 *                   their own: only the rider's review can confirm them
 *                   A window in which the MOUNT MOVED is discarded: the bike's forward
 *                   direction in the phone's axes turned > 12° within a fraction of a second
 *                   (a slip, a knock, a hand). "Forward" (not "up") because it stays put when
 *                   the bike leans into a corner or turns; only pitching the phone moves it
 *                   (slopes change it slowly, which the slow filter follows)
 *                5. time: the ONSET of the first (front-wheel) hit from the sensor
 *                   timestamps, never the time the analysis ran
 *                6. place: the GNSS fixes before and after that onset, interpolated
 *                   (cubic Hermite on their speeds and bearings), so the mark is where the
 *                   wheel met the hole, not where the bike was when it was detected;
 *                   moved forward by phoneBehindAxleM (the phone sits behind the front axle),
 *                   and read fixLatencyMs later (a chipset whose fixes are stamped late:
 *                   measured per phone on a calibration ride over a known marker; 0 until then)
 *                The thresholds are design priors (basis: prior), to be fitted on labelled
 *                rides (docs/MapUnite-RoadPulse-Blueprint.pdf, section 6)
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
        val triggerMs2: Double = 4.0, val joltMinSpeedMs: Double = 3.0,
        val minorMs2: Double = 5.0, val impactMs2: Double = 9.0, val severeMs2: Double = 14.0, val minContrast: Double = 4.0,
        val wheelbaseM: Double = 1.3, val preS: Double = 1.6, val postS: Double = 1.0, val fixWaitS: Double = 2.5,
        val phoneBehindAxleM: Double = 0.4, val fixLatencyMs: Double = 0.0, val mountMoveDeg: Double = 12.0,
        val segmentM: Double = 20.0, val refSpeedMs: Double = 10.0, val roughMinSpeedMs: Double = 3.0,
        val longCutHz: Double = 2.0, val vertLowHz: Double = 0.5, val vertHighHz: Double = 12.0
    )

    data class Event(
        val id: Int, val type: String, val tNs: Long, val durS: Double, val peakMs2: Double,
        val speedFromMs: Double?, val speedToMs: Double?, val dvImuMs: Double,
        val lat: Double?, val lng: Double?, val headingDeg: Double?, val conf: Double, val source: String,
        /** jolts only: what it looks like, how bad, and the evidence behind it */
        val impact: Impact? = null
    )

    /**
     * A jolt's analysis. hazard: "pothole" | "speed_breaker" | "bump" (can't tell); cls: "impact" | "unknown" |
     * "minor"; severity 1 (not an impact), 2, 3; minor = cls != impact (review only); posSigmaM: how far off the
     * mark may be (the fixes' spread and the time between them).
     */
    data class Impact(
        val hazard: String, val severity: Int, val minor: Boolean, val peakRefMs2: Double, val contrast: Double,
        val doubleHit: Boolean, val posSigmaM: Double?, val cls: String = if (minor) "minor" else "impact"
    )

    data class Segment(
        val tNs: Long, val distM: Double, val rmsMs2: Double, val refRmsMs2: Double, val cls: String,
        val speedMs: Double, val lat: Double?, val lng: Double?, val headingDeg: Double?
    )

    data class Summary(
        val longMeanMs2: Double, val longMinMs2: Double, val longMaxMs2: Double, val vertRmsMs2: Double,
        val braking: Boolean, val imuHz: Double, val events: List<Event>, val segments: List<Segment>
    )

    private data class Fix(val tNs: Long, val speed: Double?, val lat: Double, val lng: Double, val bearing: Double?, val accM: Double?)

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

    // jolt capture: the vertical band of the last ~5 s (no allocation per sample), one trigger at a time
    private val ringT = LongArray(RING)
    private val ringV = DoubleArray(RING)
    private var ringN = 0L
    private var trigNs = 0L
    private var trigSpeed = 0.0
    private var quietUntilNs = Long.MIN_VALUE / 2
    // the mount: the bike's forward direction in device axes, fast and slow; apart by > mountMoveDeg = the phone moved
    private val fwdFast = doubleArrayOf(Double.NaN, 0.0, 0.0)
    private val fwdSlow = doubleArrayOf(Double.NaN, 0.0, 0.0)
    private var mountMovedNs = Long.MIN_VALUE / 2
    /** windows discarded because the mount moved (for tuning) */
    var mountRejected = 0
        private set
    /** analysed jolts waiting for the GNSS fix after their onset (to interpolate their place) */
    private class Jolt(val onsetNs: Long, val durS: Double, val peak: Double, val speed: Double, val impact: Impact)
    private val joltsWaiting = ArrayList<Jolt>()

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
        val first = fwdFast[0].isNaN()
        for (k in 0..2) { fwdFast[k] = if (first) fwd[k] else ema(fwdFast[k], fwd[k], 2.0, dt); fwdSlow[k] = if (first) fwd[k] else ema(fwdSlow[k], fwd[k], 0.2, dt) }
        if (angleDeg(fwdFast, fwdSlow) > cfg.mountMoveDeg) mountMovedNs = tNs
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
        // ---- jolts (detector v2): trigger, then analyse the window once it's complete
        val ri = (ringN % RING).toInt()
        ringT[ri] = tNs; ringV[ri] = hp; ringN++
        if (trigNs != 0L) {
            if (tNs - trigNs >= (cfg.postS * 1e9).toLong()) {
                analyse(trigNs, trigSpeed)?.let { joltsWaiting += it }
                quietUntilNs = tNs                     // the rear wheel and the rebound belong to this jolt
                trigNs = 0L
            }
        } else if (speed != null && speed >= cfg.joltMinSpeedMs && abs(hp) >= cfg.triggerMs2 && tNs > quietUntilNs) {
            trigNs = tNs; trigSpeed = speed
        }
        settleJolts(tNs)

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
    fun onGnss(tNs: Long, speedMs: Double?, lat: Double, lng: Double, bearingDeg: Double?, accuracyM: Double? = null) {
        fixes.addLast(Fix(tNs, speedMs, lat, lng, bearingDeg, accuracyM))
        while (fixes.size > 2 && tNs - fixes.first().tNs > 15_000_000_000L) fixes.removeFirst()
        settlePending(lastNs.coerceAtLeast(tNs))
        settleJolts(lastNs.coerceAtLeast(tNs))
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

    // ---------------------------------------------------------------- jolts (detector v2)

    /** The samples of the ring between [fromNs] and [toNs], oldest first. */
    private fun window(fromNs: Long, toNs: Long): Pair<LongArray, DoubleArray> {
        val n = minOf(ringN, RING.toLong()).toInt()
        val ts = ArrayList<Long>(n); val vs = ArrayList<Double>(n)
        for (k in 0 until n) {
            val i = ((ringN - n + k) % RING).toInt()
            if (ringT[i] in fromNs..toNs) { ts += ringT[i]; vs += ringV[i] }
        }
        return Pair(ts.toLongArray(), vs.toDoubleArray())
    }

    /** One triggered window → a jolt to place, or null (ignored: too small, or just a rough road). */
    private fun analyse(trig: Long, speed: Double): Jolt? {
        // the phone moved on its mount around this jolt: its axes (and maybe the jolt itself) aren't the road's
        if (mountMovedNs >= trig - ((cfg.preS + 1.0) * 1e9).toLong() && mountMovedNs <= trig + (cfg.postS * 1e9).toLong()) { mountRejected++; return null }
        val (ts, vs) = window(trig - (cfg.preS * 1e9).toLong(), trig + (cfg.postS * 1e9).toLong())
        if (ts.size < 20) return null
        // the first peak: the strongest sample in the 150 ms after the trigger
        var i1 = -1
        for (i in ts.indices) if (ts[i] in trig..(trig + 150_000_000L) && (i1 < 0 || abs(vs[i]) > abs(vs[i1]))) i1 = i
        if (i1 < 0) return null
        val p1 = vs[i1]; val a1 = abs(p1)
        // onset: back from the peak while the signal stays above a quarter of it (a pothole's drop is part of it)
        var i0 = i1
        while (i0 > 0 && abs(vs[i0 - 1]) >= 0.25 * a1 && ts[i1] - ts[i0 - 1] <= 300_000_000L) i0--
        var iEnd = i1
        while (iEnd < ts.size - 1 && abs(vs[iEnd + 1]) >= 0.25 * a1) iEnd++
        val onset = ts[i0]
        val durS = (ts[iEnd] - ts[i0]) / 1e9
        // the rear wheel: wheelbase / speed after the front, at least a third as strong
        val gapNs = (cfg.wheelbaseM / maxOf(speed, 1.0) * 1e9).toLong()
        var a2 = 0.0
        for (i in ts.indices) if (ts[i] in (ts[i1] + gapNs * 6 / 10)..(ts[i1] + gapNs * 14 / 10)) a2 = maxOf(a2, abs(vs[i]))
        val doubleHit = a2 >= 0.35 * a1
        // the road around it: before the onset, and after the rear wheel's hit has settled
        var sq = 0.0; var n = 0
        val afterNs = ts[i1] + gapNs * 14 / 10 + 250_000_000L
        for (i in ts.indices) if (ts[i] <= onset - 150_000_000L || ts[i] >= afterNs) { sq += vs[i] * vs[i]; n++ }
        val bg = if (n >= 10) sqrt(sq / n) else 0.0
        val contrast = a1 / maxOf(bg, 0.3)
        val peakRef = a1 * sqrt(cfg.refSpeedMs / maxOf(speed, 4.0))
        if (peakRef < cfg.minorMs2 || contrast < cfg.minContrast) return null
        val cls = when {
            peakRef < cfg.impactMs2 -> "minor"
            !doubleHit && peakRef < cfg.severeMs2 -> "unknown"
            else -> "impact"
        }
        val minor = cls != "impact"
        val severity = if (minor) 1 else if (peakRef >= cfg.severeMs2) 3 else 2
        // shape: a drop just before a positive hit is a hole; a long first rise, or slowing down before it, a breaker
        var dip = 0.0
        for (i in ts.indices) if (ts[i] in (ts[i1] - 150_000_000L)..ts[i1]) dip = minOf(dip, vs[i])
        val firstUp = vs[i0] > 0
        val slowed = speedChangeBefore(onset)?.let { it <= -1.5 } ?: false
        val hazard = when {
            p1 > 0 && dip <= -0.3 * a1 -> "pothole"
            firstUp && (durS >= 0.12 || slowed) -> "speed_breaker"
            else -> "bump"
        }
        return Jolt(onset, durS, p1, speed, Impact(hazard, severity, minor, peakRef, contrast, doubleHit, null, cls))
    }

    /** Places the analysed jolts once a fix after their onset exists (or gives up waiting and extrapolates). */
    private fun settleJolts(nowNs: Long) {
        if (joltsWaiting.isEmpty()) return
        val it = joltsWaiting.iterator()
        while (it.hasNext()) {
            val j = it.next()
            val haveAfter = fixes.any { f -> f.tNs > j.onsetNs }
            if (!haveAfter && nowNs - j.onsetNs < (cfg.fixWaitS * 1e9).toLong()) continue
            it.remove()
            // the fixes' clock may run late on this chipset; then the wheel is ahead of the phone
            val p = interpolateAt(j.onsetNs + (cfg.fixLatencyMs * 1e6).toLong())?.let { ahead(it, cfg.phoneBehindAxleM) }
            val im = j.impact
            var conf = if (im.minor) 0.3 else 0.6
            if (!im.minor && im.doubleHit) conf += 0.15
            if (!im.minor && im.contrast >= 4.0) conf += 0.1
            ready += Event(nextId++, "jolt", j.onsetNs, j.durS, j.peak, j.speed, j.speed, 0.0,
                p?.lat, p?.lng, p?.bearing, conf = minOf(conf, 0.9), source = "imu", impact = im.copy(posSigmaM = p?.sigmaM))
        }
    }

    private class Place(val lat: Double, val lng: Double, val bearing: Double?, val sigmaM: Double?)

    /** [p] moved [m] metres along its bearing (unchanged without one). */
    private fun ahead(p: Place, m: Double): Place {
        val b = p.bearing ?: return p
        if (m == 0.0) return p
        val th = b * PI / 180.0
        return Place(p.lat + m * cos(th) / 111_320.0, p.lng + m * sin(th) / (111_320.0 * cos(p.lat * PI / 180.0)), b, p.sigmaM)
    }

    /**
     * Where the bike was at [tNs]: between the fixes before and after it, a cubic Hermite curve through both
     * with their speeds and bearings as tangents (right on bends too); with only the fix before, moved along its
     * bearing. sigmaM: the larger fix accuracy plus the speed error over the time from the nearer fix.
     */
    private fun interpolateAt(tNs: Long): Place? {
        val f0 = fixes.lastOrNull { it.tNs <= tNs }
        val f1 = fixes.firstOrNull { it.tNs > tNs }
        if (f0 == null || f1 == null || (f1.tNs - f0.tNs) > 3_000_000_000L) {
            val p = positionAt(tNs) ?: return null
            val f = f0 ?: f1
            val ageS = if (f == null) 0.0 else abs(tNs - f.tNs) / 1e9
            return Place(p.first, p.second, p.third, f?.accM?.let { it + 0.5 * ageS })
        }
        val T = (f1.tNs - f0.tNs) / 1e9
        val s = (tNs - f0.tNs) / 1e9 / T
        val mLng = 111_320.0 * cos(f0.lat * PI / 180.0)
        val n1 = (f1.lat - f0.lat) * 111_320.0
        val e1 = (f1.lng - f0.lng) * mLng
        // tangents (m/s → m over the interval); without speed or bearing, the chord (straight line)
        fun tan(f: Fix): Pair<Double, Double> {
            val b = f.bearing; val v = f.speed
            return if (b == null || v == null) Pair(n1, e1) else Pair(v * T * cos(b * PI / 180.0), v * T * sin(b * PI / 180.0))
        }
        val (tn0, te0) = tan(f0); val (tn1, te1) = tan(f1)
        val h10 = s * s * s - 2 * s * s + s; val h01 = -2 * s * s * s + 3 * s * s; val h11 = s * s * s - s * s
        val n = h10 * tn0 + h01 * n1 + h11 * tn1
        val e = h10 * te0 + h01 * e1 + h11 * te1
        val bearing = f0.bearing ?: f1.bearing
        val acc = listOfNotNull(f0.accM, f1.accM).maxOrNull()
        val nearS = minOf(s, 1 - s) * T
        return Place(f0.lat + n / 111_320.0, f0.lng + e / mLng, bearing, acc?.let { it + 0.5 * nearS })
    }

    /** GNSS speed change over the ~4 s before [tNs] (riders slow down for speed breakers), or null. */
    private fun speedChangeBefore(tNs: Long): Double? {
        val now = fixes.lastOrNull { it.tNs <= tNs && it.speed != null } ?: return null
        val before = fixes.lastOrNull { it.tNs <= tNs - 3_500_000_000L && it.speed != null } ?: return null
        if (tNs - before.tNs > 6_000_000_000L) return null
        return now.speed!! - before.speed!!
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
        /** IMU ring: ~5 s at 100 Hz */
        const val RING = 512
        fun roughClass(refRms: Double): String = when {
            refRms < 1.0 -> "smooth"
            refRms < 2.0 -> "fair"
            refRms < 3.5 -> "rough"
            else -> "very_rough"
        }
        /** Angle between two (roughly unit) vectors, in degrees. */
        fun angleDeg(a: DoubleArray, b: DoubleArray): Double {
            if (a[0].isNaN() || b[0].isNaN()) return 0.0
            val na = sqrt(a[0] * a[0] + a[1] * a[1] + a[2] * a[2]); val nb = sqrt(b[0] * b[0] + b[1] * b[1] + b[2] * b[2])
            if (na == 0.0 || nb == 0.0) return 0.0
            val c = ((a[0] * b[0] + a[1] * b[1] + a[2] * b[2]) / (na * nb)).coerceIn(-1.0, 1.0)
            return Math.toDegrees(kotlin.math.acos(c))
        }
        /** First-order low-pass with cut-off [hz], for a sample dt seconds after the previous one. */
        fun ema(prev: Double, x: Double, hz: Double, dt: Double): Double {
            if (prev.isNaN()) return x
            val rc = 1.0 / (2.0 * PI * hz)
            return prev + (dt / (rc + dt)) * (x - prev)
        }
    }
}
