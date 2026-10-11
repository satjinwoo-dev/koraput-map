// JVM check of the plugin's pure-Kotlin core (no Android needed).
// Regenerates test/master/fixtures/kotlin-dummy-mixed.jsonl, which the JS tests
// validate against contract.js and run through the road agent:
//
//   P=native/android/perception
//   kotlinc $P/PerceptionTypes.kt $P/FrameJson.kt $P/PerceptionModel.kt $P/QualityEstimator.kt \
//           $P/FrameScheduler.kt native/android/perception-jvmtest/GenFrames.kt -d /tmp/mu-core
//   kotlin -cp /tmp/mu-core GenFramesKt mixed 30 > test/master/fixtures/kotlin-dummy-mixed.jsonl
//
// Output is deterministic (fixed start time, simulated 30 fps camera, 10 Hz emitter).
import com.mapunite.app.perception.*
import java.nio.ByteBuffer

// Emits PerceptionFrames as JSONL the way the engine does: camera 30 fps, emitter 10 Hz.
fun main(args: Array<String>) {
    val scenario = args.getOrElse(0) { "mixed" }
    val seconds = args.getOrElse(1) { "30" }.toInt()
    val model = ModelFactory.create(scenario)
    val sched = FrameScheduler(30)
    // a synthetic 1280x720 Y plane: gradient + texture, so quality is "usable"
    val w = 1280; val h = 720
    val y = ByteBuffer.allocate(w * h)
    for (r in 0 until h) for (c in 0 until w) y.put(r * w + c, ((60 + (r / 4) % 80 + ((c * 7 + r * 13) % 37))).toByte())
    val q = QualityEstimator.classify(QualityEstimator.measure(y, w, 1, w, h), false)
    System.err.println("quality: $q")
    val t0Epoch = 1_791_650_000_000L
    var seq = 0L; var lastEmitNs = Long.MIN_VALUE / 2
    val frameNs = 33_333_333L
    var tNs = 0L
    while (tNs < seconds * 1_000_000_000L) {
        val d = sched.decide(tNs)
        if (d.infer) {
            val out = model.infer(FrameInput(w, h, 90, tNs, null), EgoState.UNKNOWN)
            seq++
            val fd = FrameData(t0Epoch + tNs / 1_000_000, seq, ModelInfo(model.id, model.version, "uncalibrated"),
                PerfState(30.0, 6.0, "none", model.delegate), EgoState.UNKNOWN, q, out)
            if (tNs - lastEmitNs >= 100_000_000L) { println(FrameJson.encode(fd)); lastEmitNs = tNs }
        }
        tNs += frameNs
    }
    // edge cases: NaN, unknown class, tiny box
    val weird = FrameData(t0Epoch, 1, ModelInfo("x\"y", "1", "c"), PerfState(Double.NaN, Double.POSITIVE_INFINITY, "hot", "cpu"),
        EgoState(Double.NaN, 1.0, Double.NaN, 0.0, 0.0, lat = 19.0, lng = 72.8, posSigmaM = Double.NaN),
        ViewQuality(1.7, listOf("night", "bogus")),
        ModelOutput(hazards = listOf(HazardDet(1, "pothole", 0.9, Box(0.99999, 1.2, 0.0, 0.0), 10.0, 1.0, 0.0, 0.3), HazardDet(2, "alien", 0.9, Box(0.1,0.1,0.1,0.1), 10.0, 1.0, 0.0, 0.3)),
            objects = listOf(ObjectDet(7, "car", 1.4, Box(0.2,0.2,0.1,0.1), 12.0, 1.0, 2.0, 0.5, null, "sideways")),
            relations = listOf(RelationDet(7, "cutting_in", "ego", 0.8), RelationDet(99, "wrong_side", null, 0.8))))
    System.err.println("WEIRD " + FrameJson.encode(weird))
}
