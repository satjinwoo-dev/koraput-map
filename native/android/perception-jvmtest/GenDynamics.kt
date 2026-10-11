// JVM check of DynamicsCore (no Android needed): a scripted ride at 100 Hz through the
// real core, printed as DynamicsFrame v1 JSONL (1 per second). Regenerates
// test/master/fixtures/kotlin-dynamics-ride.jsonl, which the JS tests run through the
// dynamics agent and the Master AI:
//
//   P=native/android/perception
//   kotlinc $P/PerceptionTypes.kt $P/DynamicsCore.kt $P/DynamicsJson.kt \
//           native/android/perception-jvmtest/GenDynamics.kt -d /tmp/mu-dyn
//   kotlin -cp /tmp/mu-dyn GenDynamicsKt > test/master/fixtures/kotlin-dynamics-ride.jsonl
//
// The ride (straight road along a line of latitude, out and back):
//   leg 1  east 0 → 500 m at 12 m/s; rough stretch at 100–200 m; pothole at 300 m; stop 20 s
//   leg 2  west 500 → 0 m; hard brake 5 m/s² at 350 m, very hard 7 m/s² at 200 m; stop 20 s
//   leg 3  east 0 → 500 m; hard brake 4.5 m/s² at 420 m; stop 25 s
// Always: single-cylinder engine vibration (35 Hz riding, 20 Hz idle), sensor noise,
// GNSS at 1 Hz with speed noise. Deterministic (fixed seed).
import com.mapunite.app.perception.*
import java.util.Random
import kotlin.math.PI
import kotlin.math.abs
import kotlin.math.cos
import kotlin.math.sin
import kotlin.math.sqrt

private class Brake(val atX: Double, val decel: Double, val toV: Double)
private class Leg(val dir: Int, val fromX: Double, val toX: Double, val brakes: List<Brake>, val stopS: Double)

fun main() {
    val rnd = Random(42)
    val core = DynamicsCore()
    val lat0 = 18.5204; val lng0 = 73.8567
    val mPerDegLng = 111_320.0 * cos(lat0 * PI / 180.0)
    val legs = listOf(
        Leg(+1, 0.0, 500.0, emptyList(), 20.0),
        Leg(-1, 500.0, 0.0, listOf(Brake(350.0, 5.0, 3.0), Brake(200.0, 7.0, 2.0)), 20.0),
        Leg(+1, 0.0, 500.0, listOf(Brake(420.0, 4.5, 4.0)), 25.0)
    )
    val dt = 0.01
    val dtNs = 10_000_000L
    val t0Epoch = 1_791_700_000_000L
    var tNs = 1_000_000_000L
    var nextFixNs = tNs
    var nextFrameNs = tNs + 1_000_000_000L
    var seq = 0L
    // portrait handlebar mount: up = device +y, forward = device −z
    val up = doubleArrayOf(0.0, 1.0, 0.0)
    val fwd = doubleArrayOf(0.0, 0.0, -1.0)
    var lastFix: Triple<Double, Double, Double?>? = null
    var lastFixSpeed = 0.0
    var roughState = 0.0

    fun emitFrame() {
        val ego = if (lastFix == null) EgoState.UNKNOWN else EgoState(
            speedMs = lastFixSpeed, speedSigma = 0.4, headingDeg = lastFix!!.third, pitchDeg = 0.0, rollDeg = 0.0,
            lat = lastFix!!.first, lng = lastFix!!.second, posSigmaM = 4.0
        )
        val s = core.summary(tNs)
        println(DynamicsJson.encode(t0Epoch + tNs / 1_000_000, ++seq, ego, s) { ns -> t0Epoch + ns / 1_000_000 })
    }

    for (leg in legs) {
        var x = leg.fromX
        var v = 0.0
        var brakeIdx = 0
        var mode = "accel"          // accel, cruise, brake, end
        var target = 12.0
        var decel = 0.0
        val heading = if (leg.dir > 0) 90.0 else 270.0
        var stoppedFor = 0.0
        var potholeHit = false
        while (true) {
            // --- motion script
            val remaining = abs(leg.toX - x)
            var a = 0.0
            if (mode != "end" && v * v / (2 * 1.5) >= remaining - 1.0 && v > 0.5) mode = "end"
            when (mode) {
                "accel" -> { a = 2.0; if (v >= target) { v = target; a = 0.0; mode = "cruise" } }
                "cruise" -> {
                    val b = leg.brakes.getOrNull(brakeIdx)
                    if (b != null && (if (leg.dir > 0) x >= b.atX else x <= b.atX)) { mode = "brake"; decel = b.decel; target = b.toV; brakeIdx++ }
                }
                "brake" -> { a = -decel; if (v <= target) { v = target; a = 0.0; target = 12.0; mode = "accel" } }
                "end" -> { a = if (v > 0.0) -1.5 else 0.0 }
            }
            v = (v + a * dt).coerceAtLeast(0.0)
            x += leg.dir * v * dt
            if (mode == "end" && v == 0.0) stoppedFor += dt
            if (stoppedFor >= leg.stopS) break

            // --- what the phone feels
            val moving = v > 0.5
            val engine = if (moving) 2.5 * sin(2 * PI * 35.0 * tNs / 1e9) else 1.5 * sin(2 * PI * 20.0 * tNs / 1e9)
            var vert = engine + rnd.nextGaussian() * 0.15
            val inRough = moving && ((if (leg.dir > 0) x else x) in 100.0..200.0)
            roughState = 0.9 * roughState + 0.1 * rnd.nextGaussian() * (if (inRough) 14.0 else 0.0)
            vert += roughState
            // pothole at 300 m: a 40 ms half-sine shock of 25 m/s²
            val dToPothole = abs(x - 300.0)
            if (moving && dToPothole < v * 0.04 && !potholeHit) potholeHit = true
            if (potholeHit && dToPothole < v * 0.04) vert += 25.0 * sin(PI * (1 - dToPothole / (v * 0.04)) / 2)
            val long = a + rnd.nextGaussian() * 0.2 + 0.3 * engine
            // device axes: a = up*(g + vert) + fwd*long
            val ax = up[0] * (DynamicsCore.G + vert) + fwd[0] * long
            val ay = up[1] * (DynamicsCore.G + vert) + fwd[1] * long
            val az = up[2] * (DynamicsCore.G + vert) + fwd[2] * long
            core.onImu(tNs, ax, ay, az, up, fwd)

            if (tNs >= nextFixNs) {
                val lat = lat0
                val lng = lng0 + x / mPerDegLng
                val sp = (v + rnd.nextGaussian() * 0.25).coerceAtLeast(0.0)
                lastFix = Triple(lat, lng, if (moving) heading else lastFix?.third)
                lastFixSpeed = sp
                core.onGnss(tNs, sp, lat, lng, if (moving) heading else null)
                nextFixNs += 1_000_000_000L
            }
            if (tNs >= nextFrameNs) { emitFrame(); nextFrameNs += 1_000_000_000L }
            tNs += dtNs
        }
    }
    System.err.println("ride: ${seq} s, final speed ${sqrt(lastFixSpeed * lastFixSpeed)}")
}
