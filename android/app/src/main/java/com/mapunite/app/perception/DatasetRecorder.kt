package com.mapunite.app.perception

import android.content.Context
import android.graphics.Bitmap
import android.location.Location
import android.os.Build
import android.os.SystemClock
import org.json.JSONObject
import java.io.BufferedWriter
import java.io.File
import java.io.FileOutputStream
import java.io.FileWriter
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale
import java.util.concurrent.ExecutorService
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicInteger
import java.util.concurrent.atomic.AtomicLong

/*
 * Dataset recorder: your own Indian bike-mount dataset, collected on rides.
 *
 * One folder per session, in the app's own storage (no storage permission needed):
 *   /sdcard/Android/data/com.mapunite.app/files/perception-datasets/<yyyyMMdd-HHmmss>/
 *     meta.json     device, camera (resolution, focal length, field of view, fps range,
 *                   focus, timestamp source), mount calibration, clock pair, privacy method
 *     frames/       000001.jpg …  upright, faces (and plates, when known) pixelated first
 *     frames.csv    one row per saved frame: time, ego motion, view quality, redaction counts
 *     imu.csv       accelerometer, gyroscope, rotation vector at 100 Hz
 *     gnss.csv      fixes at 1 Hz with their accuracies
 *     events.csv    marks the rider made ("pothole here")
 * Copy a session to your computer:
 *   adb pull /sdcard/Android/data/com.mapunite.app/files/perception-datasets
 *
 * Every time column is t_ns = elapsedRealtime nanoseconds (one clock for camera, IMU,
 * GNSS); meta.json has a (elapsedRealtime, epoch) pair to convert.
 *
 * Rates and sizes: 2 frames per second; a 1280 × 720 JPEG at quality 85 is roughly
 * 100–200 KB, so about 0.7–1.4 GB per hour of riding. Recording stops by itself when
 * less than 500 MB of storage is left.
 *
 * Threads: frames arrive from the camera thread already converted and rotated;
 * redaction, JPEG encoding and all file writes happen on the recorder's own thread.
 * At most 2 frames wait; more are skipped (counted in skippedBusy), never queued.
 */
class DatasetRecorder(
    private val ctx: Context,
    private val redactor: PrivacyRedactor,
    private val onAutoStop: (reason: String) -> Unit
) : SensorHub.Sink {

    data class Summary(
        val active: Boolean, val dir: String?, val frames: Long, val bytes: Long,
        val imuRows: Long, val gnssRows: Long, val events: Long,
        val facesBlurred: Long, val platesBlurred: Long, val redactionFailures: Long, val skippedBusy: Long,
        val startedAtMs: Long?, val freeMB: Long?
    )

    @Volatile var active = false; private set
    var intervalMs = 500L
    var jpegQuality = 85
    var minFreeBytes = 500L * 1024 * 1024

    private var exec: ExecutorService? = null
    private var dir: File? = null
    private var framesDir: File? = null
    private var framesCsv: BufferedWriter? = null
    private var imuCsv: BufferedWriter? = null
    private var gnssCsv: BufferedWriter? = null
    private var eventsCsv: BufferedWriter? = null
    private var meta: JSONObject? = null
    private var startedAtMs: Long? = null

    private val pending = AtomicInteger(0)
    @Volatile private var lastFrameNs = Long.MIN_VALUE / 2
    private val frames = AtomicLong(0)
    private val bytes = AtomicLong(0)
    private val imuRows = AtomicLong(0)
    private val gnssRows = AtomicLong(0)
    private val events = AtomicLong(0)
    private val faces = AtomicLong(0)
    private val plates = AtomicLong(0)
    private val redactionFailures = AtomicLong(0)
    private val skippedBusy = AtomicLong(0)

    private val bufLock = Any()
    private var imuBuf = StringBuilder(64 * 1024)
    private var gnssBuf = StringBuilder(4 * 1024)

    /**
     * Opens a new session folder. [info] goes into meta.json (camera report, calibration …).
     * @return the session folder
     */
    @Synchronized
    fun start(info: JSONObject): File {
        if (active) return dir!!
        val root = File(ctx.getExternalFilesDir(null) ?: ctx.filesDir, "perception-datasets")
        val stamp = SimpleDateFormat("yyyyMMdd-HHmmss", Locale.ROOT).format(Date())
        val d = File(root, stamp)
        val fd = File(d, "frames")
        if (!fd.mkdirs() && !fd.isDirectory) throw IllegalStateException("can't create ${fd.absolutePath}")
        if (d.usableSpace < minFreeBytes) throw IllegalStateException("less than ${minFreeBytes / 1048576} MB of storage free")
        dir = d; framesDir = fd
        resetCounters()
        framesCsv = writer(File(d, "frames.csv"), "index,t_ns,t_epoch_ms,file,width,height,speed_ms,speed_sigma,heading_deg,pitch_deg,roll_deg,lat,lng,pos_sigma_m,usable,quality_reasons,mean_luma,sharpness,glare,faces_blurred,plates_blurred,redaction")
        imuCsv = writer(File(d, "imu.csv"), "type,t_ns,x,y,z")
        gnssCsv = writer(File(d, "gnss.csv"), "t_ns,t_epoch_ms,lat,lng,alt_m,acc_m,speed_ms,speed_acc_ms,bearing_deg,bearing_acc_deg")
        eventsCsv = writer(File(d, "events.csv"), "t_ns,t_epoch_ms,label,lat,lng,speed_ms")
        val now = System.currentTimeMillis()
        startedAtMs = now
        meta = JSONObject().apply {
            put("schema", "mapunite-ride-dataset/1")
            put("createdAt", now)
            put("clock", JSONObject().put("elapsedRealtimeNs", SystemClock.elapsedRealtimeNanos()).put("epochMs", now)
                .put("note", "t_ns columns use elapsedRealtime; epoch = epochMs + (t_ns - elapsedRealtimeNs) / 1e6"))
            put("device", JSONObject().put("manufacturer", Build.MANUFACTURER).put("model", Build.MODEL).put("sdk", Build.VERSION.SDK_INT))
            put("recorder", JSONObject().put("intervalMs", intervalMs).put("jpegQuality", jpegQuality).put("imuHz", 100).put("gnssHz", 1))
            put("privacy", JSONObject()
                .put("faces", redactor.faceMethod)
                .put("plates", redactor.plateMethod)
                .put("rule", "Placeholder redaction. Run full face + number-plate redaction before anyone else views, uploads or labels these frames."))
            val keys = info.keys()
            while (keys.hasNext()) { val k = keys.next(); put(k, info.get(k)) }
        }
        writeMeta()
        exec = Executors.newSingleThreadExecutor { r -> Thread(r, "mu-recorder").apply { priority = Thread.NORM_PRIORITY - 1 } }
        lastFrameNs = Long.MIN_VALUE / 2
        active = true
        return d
    }

    /** True when the camera thread should convert this frame and hand it over (2 fps, and not busy). */
    fun wantsFrame(tNs: Long): Boolean {
        if (!active) return false
        if (tNs - lastFrameNs < intervalMs * 900_000L) return false   // 10 % early is fine
        if (pending.get() >= 2) { skippedBusy.incrementAndGet(); lastFrameNs = tNs; return false }
        return true
    }

    /** Takes ownership of [bmp] (upright, mutable ARGB_8888) and saves it after redaction. */
    fun submit(bmp: Bitmap, tNs: Long, epochMs: Long, ego: EgoState, q: ViewQuality, hints: List<PrivacyBox>) {
        val ex = exec
        if (!active || ex == null) { bmp.recycle(); return }
        lastFrameNs = tNs
        pending.incrementAndGet()
        ex.execute {
            try {
                if (!active) return@execute
                val idx = frames.incrementAndGet()
                val name = String.format(Locale.ROOT, "%06d.jpg", idx)
                var redaction = "ok"
                var res = PrivacyRedactor.Result(0, 0)
                try { res = redactor.redact(bmp, hints) }
                catch (e: Exception) { redaction = "failed"; redactionFailures.incrementAndGet() }
                if (redaction == "failed") {
                    // never store a frame whose redaction failed
                    frames.decrementAndGet()
                    return@execute
                }
                faces.addAndGet(res.faces.toLong()); plates.addAndGet(res.plates.toLong())
                val f = File(framesDir, name)
                FileOutputStream(f).use { out -> bmp.compress(Bitmap.CompressFormat.JPEG, jpegQuality, out) }
                bytes.addAndGet(f.length())
                framesCsv?.apply {
                    write(listOf(idx, tNs, epochMs, "frames/$name", bmp.width, bmp.height,
                        r(ego.speedMs, 2), r(ego.speedSigma, 2), ego.headingDeg?.let { r(it, 1) } ?: "", r(ego.pitchDeg, 1), r(ego.rollDeg, 1),
                        ego.lat ?: "", ego.lng ?: "", ego.posSigmaM?.let { r(it, 1) } ?: "",
                        r(q.usable, 3), q.reasons.joinToString("|"), r(q.meanLuma, 1), r(q.sharpness, 1), r(q.glareFraction, 4),
                        res.faces, res.plates, redaction).joinToString(","))
                    newLine()
                }
            } catch (e: Exception) {
                frames.decrementAndGet()
            } finally {
                bmp.recycle()
                pending.decrementAndGet()
            }
        }
    }

    /** A rider mark ("pothole", "water", "breaker", "other"): written at once with position and speed. */
    fun mark(label: String, tNs: Long, epochMs: Long, ego: EgoState) {
        val ex = exec ?: return
        if (!active) return
        val safe = label.replace(Regex("[^A-Za-z0-9_\\- ]"), "").take(40).ifBlank { "mark" }
        events.incrementAndGet()
        ex.execute {
            eventsCsv?.apply { write("$tNs,$epochMs,$safe,${ego.lat ?: ""},${ego.lng ?: ""},${r(ego.speedMs, 2)}"); newLine(); flush() }
        }
    }

    // ---------------------------------------------------------------- SensorHub.Sink (sensor thread)

    override fun onImu(type: Char, tNs: Long, x: Float, y: Float, z: Float) {
        if (!active) return
        synchronized(bufLock) { imuBuf.append(type).append(',').append(tNs).append(',').append(x).append(',').append(y).append(',').append(z).append('\n') }
        imuRows.incrementAndGet()
    }

    override fun onGnss(tNs: Long, loc: Location) {
        if (!active) return
        val sa = if (Build.VERSION.SDK_INT >= 26 && loc.hasSpeedAccuracy()) loc.speedAccuracyMetersPerSecond.toString() else ""
        val ba = if (Build.VERSION.SDK_INT >= 26 && loc.hasBearingAccuracy()) loc.bearingAccuracyDegrees.toString() else ""
        val line = "$tNs,${loc.time},${loc.latitude},${loc.longitude},${if (loc.hasAltitude()) loc.altitude else ""}," +
            "${if (loc.hasAccuracy()) loc.accuracy else ""},${if (loc.hasSpeed()) loc.speed else ""},$sa,${if (loc.hasBearing()) loc.bearing else ""},$ba\n"
        synchronized(bufLock) { gnssBuf.append(line) }
        gnssRows.incrementAndGet()
    }

    /** Call about once a second: writes buffered sensor rows, checks free space. */
    fun flush() {
        val ex = exec ?: return
        if (!active) return
        val (imu, gnss) = synchronized(bufLock) {
            val a = imuBuf; val b = gnssBuf
            imuBuf = StringBuilder(64 * 1024); gnssBuf = StringBuilder(4 * 1024)
            Pair(a, b)
        }
        ex.execute {
            try {
                imuCsv?.apply { write(imu.toString()); flush() }
                gnssCsv?.apply { write(gnss.toString()); flush() }
                framesCsv?.flush()
            } catch (e: Exception) { /* reported through the summary counts */ }
            val d = dir
            if (d != null && d.usableSpace < minFreeBytes) onAutoStop("storage")
        }
    }

    /** Closes the session; returns its summary. Safe to call twice. */
    @Synchronized
    fun stop(): Summary {
        if (!active) return summary()
        active = false
        flushNowUnsafe()
        val ex = exec
        exec = null
        ex?.shutdown()
        try { ex?.awaitTermination(3, TimeUnit.SECONDS) } catch (e: InterruptedException) { /* closing anyway */ }
        meta?.apply {
            put("endedAt", System.currentTimeMillis())
            put("counts", JSONObject().put("frames", frames.get()).put("imuRows", imuRows.get()).put("gnssRows", gnssRows.get())
                .put("events", events.get()).put("facesBlurred", faces.get()).put("platesBlurred", plates.get())
                .put("redactionFailures", redactionFailures.get()).put("skippedBusy", skippedBusy.get()))
        }
        writeMeta()
        for (w in listOf(framesCsv, imuCsv, gnssCsv, eventsCsv)) try { w?.close() } catch (e: Exception) { /* closing */ }
        framesCsv = null; imuCsv = null; gnssCsv = null; eventsCsv = null
        return summary()
    }

    fun summary(): Summary {
        val d = dir
        return Summary(
            active = active, dir = d?.absolutePath, frames = frames.get(), bytes = bytes.get(),
            imuRows = imuRows.get(), gnssRows = gnssRows.get(), events = events.get(),
            facesBlurred = faces.get(), platesBlurred = plates.get(), redactionFailures = redactionFailures.get(),
            skippedBusy = skippedBusy.get(), startedAtMs = startedAtMs,
            freeMB = d?.let { it.usableSpace / (1024 * 1024) }
        )
    }

    // ---------------------------------------------------------------- helpers

    /** On stop: whatever is still buffered goes to the files (executor already draining). */
    private fun flushNowUnsafe() {
        val (imu, gnss) = synchronized(bufLock) { Pair(imuBuf.toString(), gnssBuf.toString()).also { imuBuf.setLength(0); gnssBuf.setLength(0) } }
        exec?.execute {
            try { imuCsv?.write(imu); gnssCsv?.write(gnss) } catch (e: Exception) { /* closing */ }
        }
    }

    private fun writeMeta() {
        val d = dir ?: return
        try { File(d, "meta.json").writeText(meta?.toString(2) ?: "{}") } catch (e: Exception) { /* best effort */ }
    }

    private fun writer(f: File, header: String): BufferedWriter = BufferedWriter(FileWriter(f), 64 * 1024).apply { write(header); newLine() }

    private fun resetCounters() {
        for (c in listOf(frames, bytes, imuRows, gnssRows, events, faces, plates, redactionFailures, skippedBusy)) c.set(0)
        synchronized(bufLock) { imuBuf.setLength(0); gnssBuf.setLength(0) }
        pending.set(0)
    }

    private fun r(v: Double, digits: Int): String {
        if (!v.isFinite()) return ""
        var p = 1.0
        repeat(digits) { p *= 10.0 }
        return (Math.round(v * p) / p).toString()
    }
}
