package com.mapunite.app.perception

import android.Manifest
import android.view.WindowManager
import com.getcapacitor.JSObject
import com.getcapacitor.PermissionState
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.CapacitorPlugin
import com.getcapacitor.annotation.Permission
import com.getcapacitor.annotation.PermissionCallback
import org.json.JSONObject

/*
 * MapUnitePerception: the road camera + road model, as a Capacitor plugin.
 * Phase 1: real camera, sensors, thermal, emitter and dataset recorder around a
 * DUMMY model. Phase 2 swaps the model; this API stays.
 *
 * Methods (all return Promises in JS; see public/js/master/perception/native.js)
 *   start({ targetFps = 30, emitHz = 10, scenario = "none", owner = "app" })  → status
 *   stop({ owner = "app" })                                → { stopped }   (camera off when no owner is left)
 *   setTargetFps({ fps })                                  → {}            (0 = pause the model, camera stays warm)
 *   status()                                               → status
 *   preview()                                              → { jpeg (base64), mime }  for aiming the mount
 *   calibrate({ mountHeightM? })                           → calibration   (bike on its stand, 2 s still)
 *   startRecording({ intervalMs = 500, note? })            → { dir }
 *   stopRecording()                                        → summary
 *   mark({ label })                                        → { ok }        ("pothole here", saved with the recording)
 *   startDynamics({ owner = "app" })                       → dynamics status   (IMU 100 Hz + GNSS; camera not needed)
 *   stopDynamics({ owner = "app" })                        → { stopped }
 * Events
 *   "frame"  { frame: "<PerceptionFrame v1 JSON>" }        ~10 per second
 *   "dynamics" { dynamics: "<DynamicsFrame v1 JSON>" }     1 per second (hard_brake / hard_accel / jolt events, roughness)
 *   "state"  { state: starting | running | paused | stalled | thermal | recording | recording-stopped | frame-error | error | stopped, … }
 *
 * Register it in MainActivity:  registerPlugin(com.mapunite.app.perception.PerceptionPlugin.class);
 * Needs CameraX + Kotlin in app/build.gradle (scripts/setup-perception-android.mjs adds them).
 */
@CapacitorPlugin(
    name = "MapUnitePerception",
    permissions = [
        Permission(alias = "camera", strings = [Manifest.permission.CAMERA]),
        Permission(alias = "location", strings = [Manifest.permission.ACCESS_FINE_LOCATION, Manifest.permission.ACCESS_COARSE_LOCATION])
    ]
)
class PerceptionPlugin : Plugin() {

    private var engine: PerceptionEngine? = null
    private var screenWasOn = false
    private var screenHeld = false

    override fun load() {
        engine = PerceptionEngine(
            context,
            emitState = { s -> notifyListeners("state", toJs(s)) },
            emitFrame = { json -> notifyListeners("frame", JSObject().put("frame", json)) },
            emitDynamics = { json -> notifyListeners("dynamics", JSObject().put("dynamics", json)) }
        )
    }

    // ------------------------------------------------------------------ start / stop

    @PluginMethod
    fun start(call: PluginCall) {
        if (getPermissionState("camera") != PermissionState.GRANTED || getPermissionState("location") == PermissionState.PROMPT) {
            requestPermissionForAliases(arrayOf("camera", "location"), call, "afterPermissions")
            return
        }
        doStart(call)
    }

    @PermissionCallback
    private fun afterPermissions(call: PluginCall) {
        if (getPermissionState("camera") != PermissionState.GRANTED) {
            call.reject("The road camera needs the camera permission. Allow it in Android settings → Apps → MapUnite → Permissions.", "PERMISSION_DENIED")
            return
        }
        doStart(call)   // without location the camera still runs; frames carry "speed unknown"
    }

    private fun doStart(call: PluginCall) {
        val e = engine ?: return call.reject("plugin not loaded")
        val opts = PerceptionEngine.Options(
            targetFps = call.getInt("targetFps", 30) ?: 30,
            emitHz = call.getInt("emitHz", 10) ?: 10,
            scenario = call.getString("scenario", "none") ?: "none"
        )
        val owner = ownerOf(call)
        activity.runOnUiThread {
            e.start(owner, activity, opts,
                { st -> holdScreen(true); call.resolve(toJs(st)) },
                { why -> call.reject(why, "CAMERA_ERROR") })
        }
    }

    @PluginMethod
    fun stop(call: PluginCall) {
        val e = engine ?: return call.reject("plugin not loaded")
        val owner = ownerOf(call)
        activity.runOnUiThread {
            val stopped = e.stop(owner)
            if (stopped) holdScreen(false)
            call.resolve(JSObject().put("stopped", stopped))
        }
    }

    @PluginMethod
    fun setTargetFps(call: PluginCall) {
        val fps = call.getInt("fps") ?: return call.reject("fps is required")
        engine?.setTargetFps(fps)
        call.resolve()
    }

    @PluginMethod
    fun status(call: PluginCall) {
        val e = engine ?: return call.reject("plugin not loaded")
        call.resolve(toJs(e.status()))
    }

    // ------------------------------------------------------------------ mount, calibration

    @PluginMethod
    fun preview(call: PluginCall) {
        val e = engine ?: return call.reject("plugin not loaded")
        e.preview { jpeg, err ->
            if (jpeg == null) call.reject(err ?: "no frame") else call.resolve(JSObject().put("jpeg", jpeg).put("mime", "image/jpeg"))
        }
    }

    @PluginMethod
    fun calibrate(call: PluginCall) {
        val e = engine ?: return call.reject("plugin not loaded")
        e.calibrate(call.getDouble("mountHeightM")) { cal, err ->
            if (cal == null) call.reject(err ?: "calibration failed", "NOT_STILL") else call.resolve(toJs(cal))
        }
    }

    // ------------------------------------------------------------------ dataset recorder

    @PluginMethod
    fun startRecording(call: PluginCall) {
        val e = engine ?: return call.reject("plugin not loaded")
        try {
            val info = JSONObject().put("note", (call.getString("note", "") ?: "").take(200))
            val dir = e.startRecording((call.getInt("intervalMs", 500) ?: 500).toLong(), info)
            call.resolve(JSObject().put("dir", dir))
        } catch (ex: Exception) {
            call.reject(ex.message ?: "could not start recording", "RECORDER_ERROR")
        }
    }

    @PluginMethod
    fun stopRecording(call: PluginCall) {
        val e = engine ?: return call.reject("plugin not loaded")
        call.resolve(toJs(e.stopRecording()))
    }

    @PluginMethod
    fun mark(call: PluginCall) {
        val e = engine ?: return call.reject("plugin not loaded")
        call.resolve(JSObject().put("ok", e.mark(call.getString("label", "mark") ?: "mark")))
    }

    // ------------------------------------------------------------------ bike dynamics (no camera needed)

    @PluginMethod
    fun startDynamics(call: PluginCall) {
        if (getPermissionState("location") == PermissionState.PROMPT) {
            requestPermissionForAlias("location", call, "afterLocationForDynamics")
            return
        }
        doStartDynamics(call)
    }

    @PermissionCallback
    private fun afterLocationForDynamics(call: PluginCall) {
        doStartDynamics(call)   // without location: IMU-only events (lower confidence), no map positions
    }

    private fun doStartDynamics(call: PluginCall) {
        val e = engine ?: return call.reject("plugin not loaded")
        val owner = ownerOf(call)
        activity.runOnUiThread { call.resolve(toJs(e.startDynamics(owner))) }
    }

    @PluginMethod
    fun stopDynamics(call: PluginCall) {
        val e = engine ?: return call.reject("plugin not loaded")
        val owner = ownerOf(call)
        activity.runOnUiThread { call.resolve(JSObject().put("stopped", e.stopDynamics(owner))) }
    }

    // ------------------------------------------------------------------ lifecycle

    override fun handleOnPause() { engine?.onPause() }
    override fun handleOnResume() { engine?.onResume() }
    override fun handleOnDestroy() { engine?.destroy() }

    // ------------------------------------------------------------------ helpers

    private fun ownerOf(call: PluginCall): String = (call.getString("owner", "app") ?: "app").take(20)

    private fun toJs(j: JSONObject): JSObject = JSObject(j.toString())

    /** Keeps the screen on while the camera runs; restores the previous state after (MapUniteNative's keepAwake may own it too). */
    private fun holdScreen(on: Boolean) {
        activity.runOnUiThread {
            val w = activity.window
            if (on && !screenHeld) {
                screenWasOn = (w.attributes.flags and WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON) != 0
                w.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
                screenHeld = true
            } else if (!on && screenHeld) {
                if (!screenWasOn) w.clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
                screenHeld = false
            }
        }
    }
}
