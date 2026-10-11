package com.mapunite.app.perception

import android.content.Context
import android.hardware.camera2.CameraCharacteristics
import android.hardware.camera2.CameraMetadata
import android.hardware.camera2.CaptureRequest
import android.util.Range
import android.util.Size
import androidx.annotation.OptIn
import androidx.camera.camera2.interop.Camera2CameraInfo
import androidx.camera.camera2.interop.Camera2Interop
import androidx.camera.camera2.interop.ExperimentalCamera2Interop
import androidx.camera.core.CameraSelector
import androidx.camera.core.ImageAnalysis
import androidx.camera.core.ImageProxy
import androidx.camera.core.resolutionselector.ResolutionSelector
import androidx.camera.core.resolutionselector.ResolutionStrategy
import androidx.camera.lifecycle.ProcessCameraProvider
import androidx.core.content.ContextCompat
import androidx.lifecycle.LifecycleOwner
import java.util.concurrent.Executor
import kotlin.math.atan

/*
 * Rear camera → ImageAnalysis (CameraX), set up for a handlebar mount:
 *
 *   rear camera, YUV_420_888, ~1280 × 720 (closest the phone offers)
 *   30 fps       AE target range [30, 30] when the phone offers it (else the best
 *                range ending at 30), so exposure never drops the frame rate in shade
 *   fixed focus  autofocus OFF, lens at the hyperfocal distance (or infinity), so
 *                the focus never hunts on bumps and every frame has the same optics,
 *                which a distance model needs. Fixed-focus lenses are left alone.
 *   no video stabilisation (it crops and shifts the image from frame to frame)
 *   STRATEGY_KEEP_ONLY_LATEST: if analysis is busy, older frames are dropped,
 *                never queued, so the model always sees the newest road.
 *
 * Only ImageAnalysis is bound (no preview surface): the WebView stays the UI.
 * The camera runs while the app is in the foreground (CameraX follows the activity
 * lifecycle), which is also what Android allows without a camera foreground service.
 */
@OptIn(markerClass = [ExperimentalCamera2Interop::class])
class CameraPipeline(private val ctx: Context) {

    data class Report(
        val width: Int, val height: Int,
        val fpsRange: String, val focus: String,
        val timestampRealtime: Boolean,
        val focalLengthMm: Double?, val hfovDeg: Double?, val vfovDeg: Double?,
        val cameraId: String?
    )

    private var provider: ProcessCameraProvider? = null
    private var analysis: ImageAnalysis? = null
    @Volatile var report: Report? = null; private set
    @Volatile var timestampRealtime: Boolean = false; private set

    /**
     * Binds the camera (call on the main thread). Every frame goes to [onFrame] on [executor];
     * onFrame MUST close the image.
     */
    fun start(
        owner: LifecycleOwner,
        executor: Executor,
        onFrame: (ImageProxy) -> Unit,
        onReady: (Report) -> Unit,
        onError: (String) -> Unit
    ) {
        val future = ProcessCameraProvider.getInstance(ctx)
        future.addListener({
            try {
                val p = future.get()
                provider = p
                val backs = CameraSelector.DEFAULT_BACK_CAMERA.filter(p.availableCameraInfos)
                if (backs.isEmpty()) { onError("this phone has no rear camera"); return@addListener }
                val info = backs[0]
                val ch = Camera2CameraInfo.from(info)

                val builder = ImageAnalysis.Builder()
                    .setBackpressureStrategy(ImageAnalysis.STRATEGY_KEEP_ONLY_LATEST)
                    .setOutputImageFormat(ImageAnalysis.OUTPUT_IMAGE_FORMAT_YUV_420_888)
                    .setResolutionSelector(
                        ResolutionSelector.Builder()
                            .setResolutionStrategy(ResolutionStrategy(Size(1280, 720), ResolutionStrategy.FALLBACK_RULE_CLOSEST_HIGHER_THEN_LOWER))
                            .build()
                    )
                val ext = Camera2Interop.Extender(builder)

                // 30 fps
                val ranges = ch.getCameraCharacteristic(CameraCharacteristics.CONTROL_AE_AVAILABLE_TARGET_FPS_RANGES)
                val fps = pickFpsRange(ranges)
                if (fps != null) ext.setCaptureRequestOption(CaptureRequest.CONTROL_AE_TARGET_FPS_RANGE, fps)

                // fixed focus
                val minFocus = ch.getCameraCharacteristic(CameraCharacteristics.LENS_INFO_MINIMUM_FOCUS_DISTANCE) ?: 0f
                val hyper = ch.getCameraCharacteristic(CameraCharacteristics.LENS_INFO_HYPERFOCAL_DISTANCE) ?: 0f
                val focus: String
                if (minFocus > 0f) {
                    val diopters = if (hyper > 0f && hyper <= minFocus) hyper else 0f  // 0 = infinity
                    ext.setCaptureRequestOption(CaptureRequest.CONTROL_AF_MODE, CameraMetadata.CONTROL_AF_MODE_OFF)
                    ext.setCaptureRequestOption(CaptureRequest.LENS_FOCUS_DISTANCE, diopters)
                    focus = if (diopters > 0f) "fixed at hyperfocal (${String.format(java.util.Locale.ROOT, "%.1f", 1f / diopters)} m)" else "fixed at infinity"
                } else focus = "fixed-focus lens"

                ext.setCaptureRequestOption(CaptureRequest.CONTROL_VIDEO_STABILIZATION_MODE, CameraMetadata.CONTROL_VIDEO_STABILIZATION_MODE_OFF)

                val tsSource = ch.getCameraCharacteristic(CameraCharacteristics.SENSOR_INFO_TIMESTAMP_SOURCE)
                timestampRealtime = tsSource == CameraMetadata.SENSOR_INFO_TIMESTAMP_SOURCE_REALTIME

                val a = builder.build()
                a.setAnalyzer(executor) { image -> onFrame(image) }
                analysis?.let { p.unbind(it) }
                analysis = a
                p.bindToLifecycle(owner, CameraSelector.DEFAULT_BACK_CAMERA, a)

                val res = a.resolutionInfo?.resolution
                val (hfov, vfov, focal) = fieldOfView(ch)
                val r = Report(
                    width = res?.width ?: 0, height = res?.height ?: 0,
                    fpsRange = fps?.let { "[${it.lower}, ${it.upper}]" } ?: "phone default",
                    focus = focus, timestampRealtime = timestampRealtime,
                    focalLengthMm = focal, hfovDeg = hfov, vfovDeg = vfov,
                    cameraId = try { ch.cameraId } catch (e: Exception) { null }
                )
                report = r
                onReady(r)
            } catch (e: Exception) {
                onError("camera: ${e.message ?: e.javaClass.simpleName}")
            }
        }, ContextCompat.getMainExecutor(ctx))
    }

    /** Releases the camera (main thread). */
    fun stop() {
        val p = provider ?: return
        analysis?.let { it.clearAnalyzer(); p.unbind(it) }
        analysis = null
    }

    private fun pickFpsRange(ranges: Array<Range<Int>>?): Range<Int>? {
        if (ranges == null || ranges.isEmpty()) return null
        ranges.firstOrNull { it.lower == 30 && it.upper == 30 }?.let { return it }
        return ranges.filter { it.upper == 30 }.maxByOrNull { it.lower }
    }

    /** Horizontal / vertical field of view of the sensor (landscape), from focal length and sensor size. */
    private fun fieldOfView(ch: Camera2CameraInfo): Triple<Double?, Double?, Double?> {
        val focal = ch.getCameraCharacteristic(CameraCharacteristics.LENS_INFO_AVAILABLE_FOCAL_LENGTHS)?.firstOrNull()
        val size = ch.getCameraCharacteristic(CameraCharacteristics.SENSOR_INFO_PHYSICAL_SIZE)
        if (focal == null || size == null || focal <= 0f) return Triple(null, null, focal?.toDouble())
        val h = Math.toDegrees(2 * atan(size.width / (2.0 * focal)))
        val v = Math.toDegrees(2 * atan(size.height / (2.0 * focal)))
        return Triple(h, v, focal.toDouble())
    }
}
