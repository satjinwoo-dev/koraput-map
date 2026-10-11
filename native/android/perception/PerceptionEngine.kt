package com.mapunite.app.perception

import android.content.Context
import android.graphics.Bitmap
import android.graphics.Matrix
import android.os.Handler
import android.os.HandlerThread
import android.os.SystemClock
import android.util.Base64
import androidx.camera.core.ImageProxy
import androidx.lifecycle.LifecycleOwner
import org.json.JSONArray
import org.json.JSONObject
import java.io.ByteArrayOutputStream
import java.util.concurrent.ExecutorService
import java.util.concurrent.Executors
import java.util.concurrent.atomic.AtomicLong
import java.util.concurrent.atomic.AtomicReference

/*
 * The perception engine: camera + model + sensors + thermal + recorder + emitter,
 * independent of Capacitor (the plugin is a thin shell around it).
 *
 * Threads
 *   main          camera binding (CameraX needs it), start/stop
 *   mu-camera     every camera frame: schedule → quality → model → frame data →
 *                 recorder/preview bitmaps. Never blocks on I/O.
 *   mu-sensors    IMU 100 Hz + GNSS 1 Hz (SensorHub)
 *   mu-perception the 10 Hz emitter (latest frame wins) and 1 Hz housekeeping
 *                 (thermal poll, recorder flush, stall check, calibration sampling)
 *   mu-recorder   redaction, JPEG, file writes (DatasetRecorder)
 *
 * Owners: start/stop take an owner name ("app" for the road agent, "recorder" for
 * the recorder page). The camera runs while at least one owner holds it, so the
 * road agent ending a ride never cuts a recording, and vice versa.
 */
class PerceptionEngine(
    private val ctx: Context,
    /** (eventName, data) to JS. "state" events carry { state, … }. */
    private val emitState: (JSONObject) -> Unit,
    /** One PerceptionFrame v1 as JSON text. */
    private val emitFrame: (String) -> Unit,
    /** One DynamicsFrame v1 as JSON text (1 per second while dynamics runs). */
    private val emitDynamics: (String) -> Unit = {}
) {
    data class Options(val targetFps: Int = 30, val emitHz: Int = 10, val scenario: String = "none")

    private val camera = CameraPipeline(ctx)
    val sensors = SensorHub(ctx)
    private val thermal = ThermalMonitor(ctx)
    private val scheduler = FrameScheduler()
    private val recorder = DatasetRecorder(ctx, PlaceholderRedactor()) { reason -> post { stopRecording(reason) } }
    private var model: PerceptionModel = ModelFactory.create("none")
    private val prefs = ctx.getSharedPreferences("mu_perception", Context.MODE_PRIVATE)

    private var cameraExec: ExecutorService? = null
    private var loop: HandlerThread? = null
    private var handler: Handler? = null

    private val owners = LinkedHashSet<String>()
    private val dynamicsOwners = LinkedHashSet<String>()
    @Volatile private var dynamicsCore: DynamicsCore? = null
    private var dynSeq = 0L
    private var sensorsOn = false
    @Volatile var running = false; private set
    @Volatile private var cameraReady = false
    @Volatile private var paused = false
    private var options = Options()
    private var sensorReport: SensorHub.StartReport? = null

    private val latest = AtomicReference<FrameData?>(null)
    private var lastSentSeq = -1L
    private val seq = AtomicLong(0)
    private val inputRate = RateMeter()
    private val inferRate = RateMeter()
    private val latency = Ewma(0.1)
    @Volatile private var lastQuality = ViewQuality.UNKNOWN
    @Volatile private var lastImageAtMs = 0L
    @Volatile private var framesIn = 0L
    @Volatile private var framesInferred = 0L
    @Volatile private var errors = 0L
    @Volatile private var lastErrorAtMs = 0L
    @Volatile private var stalledSaid = false
    private val previewWaiters = java.util.concurrent.ConcurrentLinkedQueue<(String?, String?) -> Unit>()

    init { loadCalibration() }

    // ======================================================================= lifecycle

    /** Main thread. [onReady] gets the status once frames flow; [onError] a readable reason. */
    fun start(owner: String, lifecycle: LifecycleOwner, opts: Options, onReady: (JSONObject) -> Unit, onError: (String) -> Unit) {
        owners += owner
        if (running) {
            // another owner already started it; a new target fps from the road agent still applies
            if (owner == "app") scheduler.targetFps = opts.targetFps.coerceIn(0, 30)
            onReady(status()); return
        }
        running = true
        options = opts.copy(targetFps = opts.targetFps.coerceIn(0, 30), emitHz = opts.emitHz.coerceIn(1, 15))
        scheduler.targetFps = options.targetFps
        model.close()
        model = ModelFactory.create(options.scenario)
        seq.set(0); lastSentSeq = -1L; latest.set(null)
        inputRate.reset(); inferRate.reset(); latency.reset()
        framesIn = 0; framesInferred = 0; errors = 0; stalledSaid = false

        ensureLoop()
        cameraExec = Executors.newSingleThreadExecutor { r -> Thread(r, "mu-camera") }
        ensureSensors()
        thermal.start({ r -> handler?.post(r) }) { level ->
            scheduler.thermalCapFps = FrameScheduler.thermalCap(level)
            emitState(JSONObject().put("state", "thermal").put("thermal", level).put("capFps", scheduler.thermalCapFps))
        }
        scheduler.thermalCapFps = FrameScheduler.thermalCap(thermal.thermal)

        emitState(JSONObject().put("state", "starting").put("backend", "native").put("model", model.id))
        camera.start(lifecycle, cameraExec!!, ::onImage, { _ ->
            cameraReady = true
            lastImageAtMs = System.currentTimeMillis()
            scheduleEmitter()
            scheduleHousekeeping()
            emitState(JSONObject().put("state", "running").put("backend", "native").put("model", model.id))
            onReady(status())
        }, { why ->
            stopAll()
            emitState(JSONObject().put("state", "error").put("message", why))
            onError(why)
        })
    }

    /** Main thread. Releases [owner]; everything stops when no owner is left. @return true if fully stopped */
    fun stop(owner: String): Boolean {
        owners -= owner
        if (owners.isNotEmpty()) return false
        if (!running) return true
        stopAll()
        emitState(JSONObject().put("state", "stopped"))
        return true
    }

    private fun stopAll() {
        if (recorder.active) recorder.stop()
        running = false
        cameraReady = false
        owners.clear()
        camera.stop()
        thermal.stop()
        cameraExec?.shutdown(); cameraExec = null
        while (true) { val w = previewWaiters.poll() ?: break; w(null, "stopped") }
        releaseIfIdle()
    }

    fun setTargetFps(fps: Int) {
        scheduler.targetFps = fps.coerceIn(0, 30)
    }

    fun onPause() { if (running) { paused = true; emitState(JSONObject().put("state", "paused").put("message", "camera pauses while the app is in the background")) } }
    fun onResume() { if (running && paused) { paused = false; lastImageAtMs = System.currentTimeMillis(); emitState(JSONObject().put("state", "running").put("backend", "native").put("model", model.id)) } }
    fun destroy() {
        if (running) stopAll()
        dynamicsOwners.clear()
        sensors.dynamics = null
        dynamicsCore = null
        releaseIfIdle()
    }

    // ======================================================================= shared sensors + loop

    private fun ensureLoop() {
        if (loop != null) return
        val th = HandlerThread("mu-perception").also { it.start() }
        loop = th
        handler = Handler(th.looper)
    }

    private fun ensureSensors() {
        if (sensorsOn) return
        sensorReport = sensors.start()
        sensorsOn = true
    }

    /** Sensors and the loop stop only when neither the camera nor dynamics needs them. */
    private fun releaseIfIdle() {
        if (running || dynamicsOwners.isNotEmpty()) return
        if (sensorsOn) { sensors.stop(); sensorsOn = false }
        loop?.quitSafely(); loop = null; handler = null
    }

    // ======================================================================= bike dynamics (IMU 100 Hz + GNSS)

    /** Main thread. Starts the dynamics monitor for [owner] (camera not needed). */
    fun startDynamics(owner: String): JSONObject {
        dynamicsOwners += owner
        if (dynamicsCore == null) {
            ensureLoop()
            ensureSensors()
            val core = DynamicsCore()
            dynamicsCore = core
            dynSeq = 0
            sensors.dynamics = core
            emitState(JSONObject().put("state", "dynamics-running"))
            scheduleDynamics(core)
        }
        return dynamicsStatus()
    }

    /** Main thread. @return true when dynamics fully stopped (no owner left) */
    fun stopDynamics(owner: String): Boolean {
        dynamicsOwners -= owner
        if (dynamicsOwners.isNotEmpty()) return false
        if (dynamicsCore == null) return true
        sensors.dynamics = null
        dynamicsCore = null
        emitState(JSONObject().put("state", "dynamics-stopped"))
        releaseIfIdle()
        return true
    }

    private fun scheduleDynamics(core: DynamicsCore) {
        val h = handler ?: return
        h.postDelayed(object : Runnable {
            override fun run() {
                if (dynamicsCore !== core) return            // stopped or restarted
                val now = SystemClock.elapsedRealtimeNanos()
                val ego = sensors.ego(now)
                val s = core.summary(now)
                // every event is also a label in an active recording (auto marks for the dataset)
                if (recorder.active) for (e in s.events) recorder.mark("auto_${e.type}", e.tNs, epochOf(e.tNs), ego)
                try { emitDynamics(DynamicsJson.encode(epochOf(now), ++dynSeq, ego, s, ::epochOf)) } catch (e: Exception) { errors++ }
                handler?.postDelayed(this, 1000)
            }
        }, 1000)
    }

    fun dynamicsStatus(): JSONObject = JSONObject()
        .put("running", dynamicsCore != null).put("owners", JSONArray(dynamicsOwners.toList()))
        .put("thresholds", JSONObject().put("hardBrakeMs2", DynamicsCore.Config().brakeOnMs2).put("veryHardBrakeMs2", DynamicsCore.Config().veryHardMs2)
            .put("hardAccelMs2", DynamicsCore.Config().accelOnMs2).put("joltMs2", DynamicsCore.Config().joltMs2))

    // ======================================================================= camera thread

    private fun onImage(image: ImageProxy) {
        val nowNs = SystemClock.elapsedRealtimeNanos()
        val captureNs = if (camera.timestampRealtime) image.imageInfo.timestamp else nowNs
        framesIn++
        lastImageAtMs = System.currentTimeMillis()
        inputRate.tick(captureNs)
        try {
            val d = scheduler.decide(captureNs)
            val wantRec = recorder.wantsFrame(captureNs)
            val wantPreview = previewWaiters.isNotEmpty()
            if (!d.infer && !d.quality && !wantRec && !wantPreview) return

            val ego = sensors.ego(nowNs)
            var q = lastQuality
            if (d.quality || wantRec) {
                val y = image.planes[0]
                q = QualityEstimator.classify(
                    QualityEstimator.measure(y.buffer, y.rowStride, y.pixelStride, image.width, image.height),
                    sensors.mountMoved(nowNs)
                )
                lastQuality = q
            }
            var out = ModelOutput.EMPTY
            if (d.infer) {
                val t0 = System.nanoTime()
                out = model.infer(FrameInput(image.width, image.height, image.imageInfo.rotationDegrees, captureNs, image), ego)
                latency.add((System.nanoTime() - t0) / 1e6)
                inferRate.tick(captureNs)
                framesInferred++
            }
            val epochMs = epochOf(captureNs)
            if (d.infer || d.quality) {
                val fps = if (scheduler.effectiveFps == 0) 0.0 else inferRate.rate
                latest.set(FrameData(
                    tEpochMs = epochMs, seq = seq.incrementAndGet(),
                    model = ModelInfo(model.id, model.version, sensors.calibration?.id ?: "uncalibrated"),
                    perf = PerfState(fps, if (latency.value.isNaN()) 0.0 else latency.value, thermal.thermal, model.delegate),
                    ego = ego, quality = q, output = out
                ))
            }
            if (wantRec || wantPreview) {
                val bmp = uprightBitmap(image)
                if (wantPreview) answerPreview(bmp)
                if (wantRec) recorder.submit(bmp, captureNs, epochMs, ego, q, out.privacy) else bmp.recycle()
            }
        } catch (e: Throwable) {
            errors++
            val now = System.currentTimeMillis()
            if (now - lastErrorAtMs > 10_000) {                // at most one error event per 10 s
                lastErrorAtMs = now
                emitState(JSONObject().put("state", "frame-error").put("message", "${e.javaClass.simpleName}: ${e.message}"))
            }
        } finally {
            image.close()
        }
    }

    private fun uprightBitmap(image: ImageProxy): Bitmap {
        val src = image.toBitmap()
        val rot = image.imageInfo.rotationDegrees
        val upright = if (rot == 0) src else {
            val m = Matrix().apply { postRotate(rot.toFloat()) }
            Bitmap.createBitmap(src, 0, 0, src.width, src.height, m, true).also { if (it !== src) src.recycle() }
        }
        return if (upright.isMutable && upright.config == Bitmap.Config.ARGB_8888) upright
        else upright.copy(Bitmap.Config.ARGB_8888, true).also { upright.recycle() }
    }

    private fun answerPreview(bmp: Bitmap) {
        val w = 480
        val h = (bmp.height * w.toDouble() / bmp.width).toInt().coerceAtLeast(1)
        val small = Bitmap.createScaledBitmap(bmp, w, h, true)
        val out = ByteArrayOutputStream()
        small.compress(Bitmap.CompressFormat.JPEG, 70, out)
        if (small !== bmp) small.recycle()
        val b64 = Base64.encodeToString(out.toByteArray(), Base64.NO_WRAP)
        while (true) { val cb = previewWaiters.poll() ?: break; cb(b64, null) }
    }

    // ======================================================================= emitter + housekeeping

    private fun scheduleEmitter() {
        val h = handler ?: return
        val period = 1000L / options.emitHz
        h.postDelayed(object : Runnable {
            override fun run() {
                if (!running) return
                val f = latest.get()
                if (f != null && f.seq != lastSentSeq) {
                    lastSentSeq = f.seq
                    try { emitFrame(FrameJson.encode(f)) } catch (e: Exception) { errors++ }
                }
                handler?.postDelayed(this, period)
            }
        }, period)
    }

    private fun scheduleHousekeeping() {
        val h = handler ?: return
        h.postDelayed(object : Runnable {
            override fun run() {
                if (!running) return
                val now = System.currentTimeMillis()
                thermal.poll(now)
                scheduler.thermalCapFps = FrameScheduler.thermalCap(thermal.thermal)
                recorder.flush()
                val silentMs = now - lastImageAtMs
                if (!paused && cameraReady && silentMs > 3000 && !stalledSaid) {
                    stalledSaid = true
                    emitState(JSONObject().put("state", "stalled").put("message", "no camera frames for ${silentMs / 1000} s (another app may be using the camera)"))
                } else if (silentMs < 1000 && stalledSaid) {
                    stalledSaid = false
                    emitState(JSONObject().put("state", "running").put("backend", "native").put("model", model.id))
                }
                handler?.postDelayed(this, 1000)
            }
        }, 1000)
    }

    private fun post(r: () -> Unit) { handler?.post(r) ?: r() }

    // ======================================================================= preview, calibration, recording

    /** Next camera frame as a small JPEG (base64), for aiming the mount. Any thread. */
    fun preview(cb: (String?, String?) -> Unit) {
        if (!running || !cameraReady) { cb(null, "camera is not running"); return }
        previewWaiters += cb
        handler?.postDelayed({ if (previewWaiters.remove(cb)) cb(null, "no camera frame in 3 s") }, 3000)
    }

    /**
     * Samples the mount attitude for 2 s while the bike stands still and stores it
     * (camera pitch/roll at rest + the mount height you measured, if given).
     */
    fun calibrate(mountHeightM: Double?, cb: (JSONObject?, String?) -> Unit) {
        val h = handler
        if (!running || h == null) { cb(null, "start the camera first"); return }
        val pitches = ArrayList<Double>(); val rolls = ArrayList<Double>()
        var maxRot = 0.0
        val t0 = SystemClock.elapsedRealtime()
        h.post(object : Runnable {
            override fun run() {
                val (p, r) = sensors.rawAttitude()
                pitches += p; rolls += r
                maxRot = maxOf(maxRot, sensors.rotationRate())
                if (SystemClock.elapsedRealtime() - t0 < 2000) { h.postDelayed(this, 50); return }
                if (maxRot > 0.15) { cb(null, "the phone moved during calibration: put the bike on its stand and keep still for 2 seconds"); return }
                val cal = SensorHub.Calibration(
                    id = "cal-${System.currentTimeMillis()}",
                    pitchDeg = pitches.average(), rollDeg = rolls.average(),
                    mountHeightM = mountHeightM?.takeIf { it in 0.3..2.5 }
                )
                sensors.calibration = cal
                prefs.edit().putString("calibration", calJson(cal).toString()).apply()
                cb(calJson(cal), null)
            }
        })
    }

    /** @return the session folder */
    fun startRecording(intervalMs: Long, info: JSONObject): String {
        if (!running) throw IllegalStateException("start the camera first")
        recorder.intervalMs = intervalMs.coerceIn(200, 5000)
        val meta = JSONObject(info.toString())
        camera.report?.let { r ->
            meta.put("camera", JSONObject().put("width", r.width).put("height", r.height).put("fpsRange", r.fpsRange).put("focus", r.focus)
                .put("timestampSource", if (r.timestampRealtime) "realtime" else "unknown (frame times = arrival times)")
                .put("focalLengthMm", r.focalLengthMm ?: JSONObject.NULL).put("hfovDeg", r.hfovDeg ?: JSONObject.NULL)
                .put("vfovDeg", r.vfovDeg ?: JSONObject.NULL).put("cameraId", r.cameraId ?: JSONObject.NULL))
        }
        meta.put("calibration", sensors.calibration?.let { calJson(it) } ?: JSONObject.NULL)
        meta.put("model", JSONObject().put("id", model.id).put("version", model.version))
        val dir = recorder.start(meta)
        sensors.sink = recorder
        emitState(JSONObject().put("state", "recording").put("dir", dir.absolutePath))
        return dir.absolutePath
    }

    fun stopRecording(reason: String = "stopped"): JSONObject {
        sensors.sink = null
        val s = recorder.stop()
        val j = summaryJson(s).put("reason", reason)
        emitState(JSONObject().put("state", "recording-stopped").put("reason", reason).put("summary", j))
        return j
    }

    fun mark(label: String): Boolean {
        if (!recorder.active) return false
        val ns = SystemClock.elapsedRealtimeNanos()
        recorder.mark(label, ns, epochOf(ns), sensors.ego(ns))
        return true
    }

    // ======================================================================= status

    fun status(): JSONObject {
        val ego = sensors.ego()
        val cr = camera.report
        return JSONObject()
            .put("running", running).put("paused", paused).put("owners", JSONArray(owners.toList()))
            .put("model", JSONObject().put("id", model.id).put("version", model.version).put("delegate", model.delegate))
            .put("targetFps", scheduler.targetFps).put("thermalCapFps", scheduler.thermalCapFps).put("effectiveFps", scheduler.effectiveFps)
            .put("cameraFps", r1(inputRate.rate)).put("inferFps", r1(inferRate.rate)).put("latencyMs", r1(latency.value))
            .put("framesIn", framesIn).put("framesInferred", framesInferred).put("errors", errors)
            .put("thermal", thermal.thermal).put("headroom", if (thermal.headroom.isFinite()) r1(thermal.headroom) else JSONObject.NULL)
            .put("batteryPct", thermal.batteryPct).put("charging", thermal.charging)
            .put("camera", if (cr == null) JSONObject.NULL else JSONObject().put("width", cr.width).put("height", cr.height)
                .put("fpsRange", cr.fpsRange).put("focus", cr.focus).put("timestampRealtime", cr.timestampRealtime)
                .put("hfovDeg", cr.hfovDeg?.let { r1(it) } ?: JSONObject.NULL))
            .put("sensors", JSONObject()
                .put("imu", sensorReport?.let { it.accelerometer && it.gyroscope } ?: false)
                .put("rotationVector", sensorReport?.rotation ?: false)
                .put("gnss", sensorReport?.gnss ?: false).put("gnssWhy", sensorReport?.gnssWhy ?: JSONObject.NULL)
                .put("gnssFixes", sensors.gnssFixes).put("gnssAgeMs", ego.gnssAgeMs ?: JSONObject.NULL)
                .put("speedMs", r1(ego.speedMs)).put("speedSigma", r1(ego.speedSigma))
                .put("pitchDeg", r1(ego.pitchDeg)).put("rollDeg", r1(ego.rollDeg)))
            .put("quality", JSONObject().put("usable", lastQuality.usable).put("reasons", JSONArray(lastQuality.reasons))
                .put("meanLuma", r1(lastQuality.meanLuma)).put("sharpness", r1(lastQuality.sharpness)))
            .put("calibration", sensors.calibration?.let { calJson(it) } ?: JSONObject.NULL)
            .put("recording", summaryJson(recorder.summary()))
            .put("dynamics", dynamicsStatus())
    }

    // ======================================================================= helpers

    private fun epochOf(ns: Long): Long = System.currentTimeMillis() - (SystemClock.elapsedRealtimeNanos() - ns) / 1_000_000

    private fun loadCalibration() {
        val s = prefs.getString("calibration", null) ?: return
        try {
            val j = JSONObject(s)
            sensors.calibration = SensorHub.Calibration(
                id = j.getString("id"), pitchDeg = j.getDouble("pitchDeg"), rollDeg = j.getDouble("rollDeg"),
                mountHeightM = if (j.isNull("mountHeightM")) null else j.getDouble("mountHeightM")
            )
        } catch (e: Exception) { prefs.edit().remove("calibration").apply() }
    }

    private fun calJson(c: SensorHub.Calibration) = JSONObject().put("id", c.id).put("pitchDeg", r1(c.pitchDeg)).put("rollDeg", r1(c.rollDeg))
        .put("mountHeightM", c.mountHeightM ?: JSONObject.NULL)

    private fun summaryJson(s: DatasetRecorder.Summary) = JSONObject()
        .put("active", s.active).put("dir", s.dir ?: JSONObject.NULL).put("frames", s.frames).put("bytes", s.bytes)
        .put("imuRows", s.imuRows).put("gnssRows", s.gnssRows).put("events", s.events)
        .put("facesBlurred", s.facesBlurred).put("platesBlurred", s.platesBlurred)
        .put("redactionFailures", s.redactionFailures).put("skippedBusy", s.skippedBusy)
        .put("startedAtMs", s.startedAtMs ?: JSONObject.NULL).put("freeMB", s.freeMB ?: JSONObject.NULL)

    private fun r1(v: Double): Any = if (v.isFinite()) Math.round(v * 10) / 10.0 else JSONObject.NULL
}
