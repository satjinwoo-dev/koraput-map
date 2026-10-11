package com.mapunite.app.perception

import android.Manifest
import android.content.Context
import android.content.pm.PackageManager
import android.hardware.Sensor
import android.hardware.SensorEvent
import android.hardware.SensorEventListener
import android.hardware.SensorManager
import android.location.Location
import android.location.LocationListener
import android.location.LocationManager
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.HandlerThread
import android.os.SystemClock
import kotlin.math.abs
import kotlin.math.asin
import kotlin.math.atan2
import kotlin.math.sqrt

/*
 * IMU + GNSS for the road model (Phase 1: logging + a simple ego estimate).
 *
 *   accelerometer       100 Hz   raw, logged; gravity for calibration
 *   gyroscope           100 Hz   raw, logged; yaw rate (heading between GNSS fixes)
 *   game rotation vec.  100 Hz   camera pitch / roll (Android's own gyro+accel fusion)
 *   GNSS                  1 Hz   position, speed, bearing, each with its accuracy
 *
 * All timestamps are elapsedRealtime nanoseconds, the same clock as the camera
 * frames (when the camera reports a realtime timestamp source), so the recorder's
 * imu.csv, gnss.csv and frames.csv line up without guessing.
 *
 * Ego estimate (Phase 1, no EKF yet):
 *   speed   = GNSS speed; its sigma = reported speed accuracy, growing 1.5 m/s per
 *             second once the newest fix is older than 1.5 s (no fix: 0 ± 30 m/s,
 *             i.e. "don't trust me")
 *   heading = GNSS bearing while moving > 2 m/s, carried between fixes by the gyro
 *   pitch / roll = camera attitude relative to the calibrated mount
 * Phase 5 replaces this with the error-state Kalman filter (IMU + GNSS + visual odometry).
 *
 * Bike note: on a leaning motorcycle the accelerometer points along the bike, not
 * to the ground (a coordinated turn), so roll comes from the rotation vector, and
 * it can lag in long sweeping turns. Treat rollDeg as approximate until the EKF.
 */
class SensorHub(private val ctx: Context) {

    /** Receives raw samples while the recorder runs. Called on the sensor thread: keep it short. */
    interface Sink {
        /** type: 'a' accelerometer (m/s²), 'g' gyroscope (rad/s), 'r' game rotation vector (quaternion x, y, z). */
        fun onImu(type: Char, tNs: Long, x: Float, y: Float, z: Float)
        fun onGnss(tNs: Long, loc: Location)
    }

    data class Calibration(val id: String, val pitchDeg: Double, val rollDeg: Double, val mountHeightM: Double?)

    data class StartReport(val accelerometer: Boolean, val gyroscope: Boolean, val rotation: Boolean, val gnss: Boolean, val gnssWhy: String?)

    @Volatile var sink: Sink? = null
    @Volatile var calibration: Calibration? = null
    /** Bike dynamics (hard braking, jolts, roughness): fed every accelerometer sample and GNSS fix while set. */
    @Volatile var dynamics: DynamicsCore? = null

    private val sm = ctx.getSystemService(Context.SENSOR_SERVICE) as SensorManager
    private val lm = ctx.getSystemService(Context.LOCATION_SERVICE) as LocationManager
    private var thread: HandlerThread? = null
    private var handler: Handler? = null
    private var running = false

    // state touched on the sensor thread, read elsewhere through @Volatile snapshots
    private val gravity = FloatArray(3)
    private var gravityInit = false
    private val rot = FloatArray(9)
    @Volatile private var hasRotation = false
    @Volatile private var pitchRaw = 0.0
    @Volatile private var rollRaw = 0.0
    @Volatile private var yawRateRad = 0.0
    @Volatile private var gyroMag = 0.0
    @Volatile private var lastLoc: Location? = null
    @Volatile private var lastLocNs = 0L
    @Volatile private var headingDeg: Double? = null
    private var lastGyroNs = 0L
    @Volatile var imuSamples = 0L; private set
    @Volatile var gnssFixes = 0L; private set

    // mount-moved: camera pitch far from the calibrated pitch for a while
    @Volatile private var pitchOffSinceNs = 0L

    private val sensorListener = object : SensorEventListener {
        override fun onSensorChanged(e: SensorEvent) {
            val t = e.timestamp
            imuSamples++
            when (e.sensor.type) {
                Sensor.TYPE_ACCELEROMETER -> {
                    if (!gravityInit) { e.values.copyInto(gravity, 0, 0, 3); gravityInit = true }
                    else for (i in 0..2) gravity[i] += 0.05f * (e.values[i] - gravity[i])  // low-pass ≈ 0.3 s
                    if (!hasRotation) attitudeFromGravity()
                    sink?.onImu('a', t, e.values[0], e.values[1], e.values[2])
                    dynamics?.let { d -> if (bikeAxes()) d.onImu(t, e.values[0].toDouble(), e.values[1].toDouble(), e.values[2].toDouble(), upDev, fwdDev) }
                }
                Sensor.TYPE_GYROSCOPE -> {
                    val gx = e.values[0].toDouble(); val gy = e.values[1].toDouble(); val gz = e.values[2].toDouble()
                    gyroMag = sqrt(gx * gx + gy * gy + gz * gz)
                    // yaw rate = rotation about "up" (gravity direction, in device axes)
                    val gn = sqrt((gravity[0] * gravity[0] + gravity[1] * gravity[1] + gravity[2] * gravity[2]).toDouble())
                    if (gn > 1.0) yawRateRad = (gx * gravity[0] + gy * gravity[1] + gz * gravity[2]) / gn
                    if (lastGyroNs != 0L) {
                        val dt = (t - lastGyroNs) / 1e9
                        val h = headingDeg
                        if (h != null && dt in 0.0..0.5) headingDeg = norm360(h - Math.toDegrees(yawRateRad) * dt)  // left turn = heading decreases
                    }
                    lastGyroNs = t
                    sink?.onImu('g', t, e.values[0], e.values[1], e.values[2])
                }
                Sensor.TYPE_GAME_ROTATION_VECTOR -> {
                    SensorManager.getRotationMatrixFromVector(rot, e.values)
                    hasRotation = true
                    attitudeFromRotation()
                    sink?.onImu('r', t, e.values[0], e.values[1], e.values[2])
                }
            }
            checkMount(t)
        }
        override fun onAccuracyChanged(sensor: Sensor, accuracy: Int) {}
    }

    // All four methods: on Android < 11 the framework still calls the old abstract ones.
    private val locationListener = object : LocationListener {
        override fun onLocationChanged(loc: Location) {
            val t = if (Build.VERSION.SDK_INT >= 17) loc.elapsedRealtimeNanos else SystemClock.elapsedRealtimeNanos()
            lastLoc = loc
            lastLocNs = t
            gnssFixes++
            if (loc.hasBearing() && loc.hasSpeed() && loc.speed > 2f) headingDeg = loc.bearing.toDouble()
            sink?.onGnss(t, loc)
            dynamics?.onGnss(t, if (loc.hasSpeed()) loc.speed.toDouble() else null, loc.latitude, loc.longitude,
                if (loc.hasBearing() && loc.hasSpeed() && loc.speed > 2f) loc.bearing.toDouble() else null)
        }
        override fun onProviderEnabled(provider: String) {}
        override fun onProviderDisabled(provider: String) {}
        @Deprecated("Deprecated in Java")
        @Suppress("DEPRECATION")
        override fun onStatusChanged(provider: String?, status: Int, extras: Bundle?) {}
    }

    fun start(): StartReport {
        if (running) return report(null)
        running = true
        val th = HandlerThread("mu-sensors").also { it.start() }
        thread = th
        val h = Handler(th.looper)
        handler = h
        val periodUs = 10_000  // 100 Hz (above 200 Hz Android 12+ needs HIGH_SAMPLING_RATE_SENSORS)
        for (type in intArrayOf(Sensor.TYPE_ACCELEROMETER, Sensor.TYPE_GYROSCOPE, Sensor.TYPE_GAME_ROTATION_VECTOR)) {
            sm.getDefaultSensor(type)?.let { sm.registerListener(sensorListener, it, periodUs, h) }
        }
        var gnssWhy: String? = null
        val fine = ctx.checkSelfPermission(Manifest.permission.ACCESS_FINE_LOCATION) == PackageManager.PERMISSION_GRANTED
        if (!fine) gnssWhy = "location permission not granted"
        else if (!lm.isProviderEnabled(LocationManager.GPS_PROVIDER)) gnssWhy = "GPS is switched off"
        else {
            try { lm.requestLocationUpdates(LocationManager.GPS_PROVIDER, 1000L, 0f, locationListener, th.looper) }
            catch (e: SecurityException) { gnssWhy = "location permission not granted" }
            catch (e: IllegalArgumentException) { gnssWhy = "no GPS on this phone" }
        }
        return report(gnssWhy)
    }

    private fun report(gnssWhy: String?) = StartReport(
        accelerometer = sm.getDefaultSensor(Sensor.TYPE_ACCELEROMETER) != null,
        gyroscope = sm.getDefaultSensor(Sensor.TYPE_GYROSCOPE) != null,
        rotation = sm.getDefaultSensor(Sensor.TYPE_GAME_ROTATION_VECTOR) != null,
        gnss = gnssWhy == null, gnssWhy = gnssWhy
    )

    fun stop() {
        if (!running) return
        running = false
        sm.unregisterListener(sensorListener)
        try { lm.removeUpdates(locationListener) } catch (e: SecurityException) { /* never granted */ }
        thread?.quitSafely()
        thread = null; handler = null
    }

    /** Our motion right now (any thread). */
    fun ego(nowNs: Long = SystemClock.elapsedRealtimeNanos()): EgoState {
        val loc = lastLoc
        val cal = calibration
        val pitch = pitchRaw - (cal?.pitchDeg ?: 0.0)
        val roll = rollRaw - (cal?.rollDeg ?: 0.0)
        val yawDps = Math.toDegrees(yawRateRad)
        if (loc == null) return EgoState.UNKNOWN.copy(pitchDeg = pitch, rollDeg = roll, headingDeg = headingDeg, yawRateDps = yawDps)
        val ageS = (nowNs - lastLocNs) / 1e9
        val speed = if (loc.hasSpeed()) loc.speed.toDouble() else 0.0
        var sigma = if (Build.VERSION.SDK_INT >= 26 && loc.hasSpeedAccuracy()) loc.speedAccuracyMetersPerSecond.toDouble() else 1.0
        if (!loc.hasSpeed()) sigma = 30.0
        if (ageS > 1.5) sigma += 1.5 * (ageS - 1.5)
        return EgoState(
            speedMs = speed, speedSigma = sigma.coerceAtMost(30.0), headingDeg = headingDeg,
            pitchDeg = pitch, rollDeg = roll,
            lat = loc.latitude, lng = loc.longitude,
            posSigmaM = if (loc.hasAccuracy()) loc.accuracy.toDouble() else null,
            gnssAgeMs = (ageS * 1000).toLong(), yawRateDps = yawDps
        )
    }

    /** True once the camera pitch has been > 12° off the calibrated mount for 3 s. */
    fun mountMoved(nowNs: Long = SystemClock.elapsedRealtimeNanos()): Boolean =
        pitchOffSinceNs != 0L && nowNs - pitchOffSinceNs > 3_000_000_000L

    /** Gyro magnitude, rad/s (≈ 0 when the phone is still). */
    fun rotationRate(): Double = gyroMag

    /** Raw camera attitude (before subtracting the calibration), for calibrate(). */
    fun rawAttitude(): Pair<Double, Double> = Pair(pitchRaw, rollRaw)

    // ---------------------------------------------------------------- attitude

    /**
     * Camera pitch (positive = camera looks down at the road) and roll (positive = right side down),
     * from the rotation matrix (device → world, world z = up). Works for portrait and landscape mounts:
     * the "rider's right" axis is picked from which device axis gravity runs along.
     */
    private fun attitudeFromRotation() {
        // rear camera looks along device -z
        val fz = -rot[8]
        pitchRaw = Math.toDegrees(asin((-fz).coerceIn(-1f, 1f).toDouble()))
        val r = riderRightAxis()
        val rz = rot[6] * r[0] + rot[7] * r[1] + rot[8] * r[2]
        rollRaw = Math.toDegrees(asin((-rz).coerceIn(-1f, 1f).toDouble()))
    }

    /** Fallback without a rotation-vector sensor: attitude from the low-passed accelerometer. */
    private fun attitudeFromGravity() {
        val r = riderRightAxis()
        val up = upAxis()
        val aUp = gravity[0] * up[0] + gravity[1] * up[1] + gravity[2] * up[2]
        val aRight = gravity[0] * r[0] + gravity[1] * r[1] + gravity[2] * r[2]
        pitchRaw = Math.toDegrees(atan2(gravity[2].toDouble(), aUp.toDouble()))
        rollRaw = Math.toDegrees(atan2(-aRight.toDouble(), aUp.toDouble()))
    }

    /** Device axis that points up in the mount (by where gravity runs). */
    private fun upAxis(): FloatArray = when {
        abs(gravity[0]) > abs(gravity[1]) -> if (gravity[0] > 0) floatArrayOf(1f, 0f, 0f) else floatArrayOf(-1f, 0f, 0f)
        gravity[1] >= 0 -> floatArrayOf(0f, 1f, 0f)
        else -> floatArrayOf(0f, -1f, 0f)
    }

    /** Device axis pointing to the rider's right, for the same mount. */
    private fun riderRightAxis(): FloatArray = when {
        abs(gravity[0]) > abs(gravity[1]) -> if (gravity[0] > 0) floatArrayOf(0f, -1f, 0f) else floatArrayOf(0f, 1f, 0f)
        gravity[1] >= 0 -> floatArrayOf(1f, 0f, 0f)
        else -> floatArrayOf(-1f, 0f, 0f)
    }

    // bike axes in device coordinates, reused (sensor thread only, no allocation at 100 Hz)
    private val upDev = DoubleArray(3)
    private val fwdDev = DoubleArray(3)

    /**
     * Fills upDev (unit, pointing up) and fwdDev (unit, the bike's horizontal forward = the rear
     * camera's direction flattened onto the ground), in device axes. False when the camera points
     * nearly straight up or down (forward undefined: the phone isn't in a handlebar mount).
     */
    private fun bikeAxes(): Boolean {
        if (hasRotation) {
            upDev[0] = rot[6].toDouble(); upDev[1] = rot[7].toDouble(); upDev[2] = rot[8].toDouble()
            // camera forward in world axes (device −z), flattened
            var fx = -rot[2].toDouble(); var fy = -rot[5].toDouble()
            val n = sqrt(fx * fx + fy * fy)
            if (n < 0.3) return false
            fx /= n; fy /= n
            fwdDev[0] = rot[0] * fx + rot[3] * fy; fwdDev[1] = rot[1] * fx + rot[4] * fy; fwdDev[2] = rot[2] * fx + rot[5] * fy
            return true
        }
        val gn = sqrt((gravity[0] * gravity[0] + gravity[1] * gravity[1] + gravity[2] * gravity[2]).toDouble())
        if (gn < 5.0) return false
        upDev[0] = gravity[0] / gn; upDev[1] = gravity[1] / gn; upDev[2] = gravity[2] / gn
        // device −z minus its vertical part
        val dot = -upDev[2]
        var x = -dot * upDev[0]; var y = -dot * upDev[1]; var z = -1.0 - dot * upDev[2]
        val n = sqrt(x * x + y * y + z * z)
        if (n < 0.3) return false
        x /= n; y /= n; z /= n
        fwdDev[0] = x; fwdDev[1] = y; fwdDev[2] = z
        return true
    }

    private fun checkMount(t: Long) {
        val cal = calibration ?: run { pitchOffSinceNs = 0L; return }
        val off = abs(pitchRaw - cal.pitchDeg) > 12.0
        pitchOffSinceNs = if (!off) 0L else if (pitchOffSinceNs == 0L) t else pitchOffSinceNs
    }

    private fun norm360(d: Double): Double { var x = d % 360.0; if (x < 0) x += 360.0; return x }
}
