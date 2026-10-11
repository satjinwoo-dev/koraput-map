package com.mapunite.app.perception

import android.graphics.Bitmap
import android.graphics.Canvas
import android.graphics.PointF
import android.graphics.Rect
import android.media.FaceDetector
import kotlin.math.max
import kotlin.math.min
import kotlin.math.roundToInt

/*
 * Privacy redaction for saved dataset frames: faces and number plates are
 * pixelated ON THE PHONE before a frame is written to storage.
 *
 * PHASE 1 IS A PLACEHOLDER, and says so in every session's meta.json:
 *   faces   android.media.FaceDetector (built into Android, no download). It finds
 *           frontal faces of a reasonable size; side-on, small, helmeted or distant
 *           faces are MISSED.
 *   plates  blurred only where the model reports a "plate" privacy box. The dummy
 *           model reports none, so plates are NOT blurred in Phase 1.
 *
 * Until a real face + plate detector runs here (Phase 2: a small detector head in
 * the same multitask model, or ML Kit face detection), treat every saved frame as
 * personal data: keep sessions on the phone or your own machine, and run full
 * face + plate redaction before anyone else views or labels them.
 */
interface PrivacyRedactor {
    /** How faces / plates are found, written into meta.json. */
    val faceMethod: String
    val plateMethod: String

    data class Result(val faces: Int, val plates: Int)

    /** Pixelates faces and plates in place. [bmp] must be mutable ARGB_8888, upright. */
    fun redact(bmp: Bitmap, hints: List<PrivacyBox>): Result
}

class PlaceholderRedactor : PrivacyRedactor {
    override val faceMethod = "placeholder: android.media.FaceDetector (frontal faces only; small, side-on and helmeted faces are missed)"
    override val plateMethod = "placeholder: model privacy boxes only (none from the Phase 1 dummy model, so plates are NOT blurred)"

    override fun redact(bmp: Bitmap, hints: List<PrivacyBox>): PrivacyRedactor.Result {
        var faces = 0
        var plates = 0
        // 1. model hints (faces or plates the network found)
        for (h in hints) {
            val r = toRect(h.box, bmp.width, bmp.height, grow = 0.15)
            if (r.width() < 2 || r.height() < 2) continue
            Pixelate.region(bmp, r)
            if (h.kind == "plate") plates++ else faces++
        }
        // 2. built-in frontal face finder on a downscaled copy
        for (r in findFaces(bmp)) { Pixelate.region(bmp, r); faces++ }
        return PrivacyRedactor.Result(faces, plates)
    }

    private fun findFaces(bmp: Bitmap): List<Rect> {
        val scale = min(1.0, 640.0 / bmp.width)
        var w = (bmp.width * scale).roundToInt()
        if (w % 2 == 1) w -= 1                                  // FaceDetector needs an even width
        val h = (bmp.height * scale).roundToInt()
        if (w < 32 || h < 32) return emptyList()
        val small = Bitmap.createScaledBitmap(bmp, w, h, true)
        val rgb565 = small.copy(Bitmap.Config.RGB_565, false)
        if (small !== bmp) small.recycle()
        val out = ArrayList<Rect>()
        try {
            val found = arrayOfNulls<FaceDetector.Face>(8)
            val n = FaceDetector(w, h, found.size).findFaces(rgb565, found)
            val mid = PointF()
            for (i in 0 until n) {
                val f = found[i] ?: continue
                if (f.confidence() < FaceDetector.Face.CONFIDENCE_THRESHOLD) continue
                f.getMidPoint(mid)
                val e = f.eyesDistance()
                // a face is about 2.2 eye-distances wide and 3 tall around the eye midpoint
                val cx = mid.x / scale; val cy = mid.y / scale; val ee = e / scale
                out += Rect((cx - 1.4 * ee).toInt(), (cy - 1.6 * ee).toInt(), (cx + 1.4 * ee).toInt(), (cy + 2.2 * ee).toInt())
            }
        } catch (e: Exception) {
            // a detector failure must never save an unredacted frame silently: the caller marks the frame
            throw IllegalStateException("face redaction failed: ${e.message}", e)
        } finally {
            rgb565.recycle()
        }
        return out
    }

    private fun toRect(b: Box, w: Int, h: Int, grow: Double): Rect {
        val gx = b.w * grow; val gy = b.h * grow
        return Rect(((b.x - gx) * w).toInt(), ((b.y - gy) * h).toInt(), ((b.x + b.w + gx) * w).toInt(), ((b.y + b.h + gy) * h).toInt())
    }
}

/** Strong pixelation: a region becomes blocks ~1/8 of its smaller side (at least 12 px). */
object Pixelate {
    fun region(bmp: Bitmap, r0: Rect) {
        val r = Rect(max(0, r0.left), max(0, r0.top), min(bmp.width, r0.right), min(bmp.height, r0.bottom))
        if (r.width() < 2 || r.height() < 2) return
        val block = max(12, min(r.width(), r.height()) / 8)
        val sw = max(1, r.width() / block)
        val sh = max(1, r.height() / block)
        val crop = Bitmap.createBitmap(bmp, r.left, r.top, r.width(), r.height())
        val tiny = Bitmap.createScaledBitmap(crop, sw, sh, true)
        val blocks = Bitmap.createScaledBitmap(tiny, r.width(), r.height(), false)
        Canvas(bmp).drawBitmap(blocks, r.left.toFloat(), r.top.toFloat(), null)
        if (crop !== bmp) crop.recycle()
        tiny.recycle()
        blocks.recycle()
    }
}
