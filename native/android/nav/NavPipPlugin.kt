package com.mapunite.app.nav

import android.app.Activity
import android.app.PictureInPictureParams
import android.content.pm.PackageManager
import android.os.Build
import android.util.Rational
import com.getcapacitor.JSObject
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.CapacitorPlugin
import java.lang.ref.WeakReference

/*
 * MapUniteNavPip: navigation, minimized, like a car navigator
 * (public/js/navpip/navpip.js is the web side).
 *
 *   start(card)   navigation started: the live notification (NavService, a foreground
 *                 service) and, on Android 12+, picture-in-picture that opens by itself
 *                 when the rider leaves the app (setAutoEnterEnabled: the smooth system
 *                 animation with gesture navigation)
 *   update(card)  the next turn changed: the notification follows
 *   stop()        navigation ended: notification gone, no picture-in-picture
 *   enterPip()    the ⧉ button: minimize now → { entered }
 *   supported()   → { pip, notifications }
 *
 *   card = { distance: "200 m", instruction: "Turn left onto NH-26", then, eta: "5:19 PM",
 *            left: "12 km · 18 min", turn: "left"|"slight-right"|…|"uturn"|"arrive",
 *            rotation, progress: 0..1|null }   (made by public/js/navpip/navpip-core.js)
 *
 * Events:  "pip"    { active }          the app went into / out of the small window
 *          "action" { action: "stop" }  "Stop" in the notification
 *
 * MainActivity forwards onUserLeaveHint() (Android 8–11: enter the window there) and
 * onPictureInPictureModeChanged(). The manifest needs android:supportsPictureInPicture
 * on MainActivity and the NavService declaration (scripts/setup-perception-android.mjs
 * adds both; ANDROID.md says how by hand).
 *
 * Register in MainActivity: registerPlugin(com.mapunite.app.nav.NavPipPlugin.class);
 */
@CapacitorPlugin(name = "MapUniteNavPip")
class NavPipPlugin : Plugin() {

    override fun load() { instance = WeakReference(this) }

    @PluginMethod
    fun start(call: PluginCall) {
        navigating = true
        NavService.show(context, call.data)
        setAutoEnter(activity, true)
        call.resolve()
    }

    @PluginMethod
    fun update(call: PluginCall) {
        if (navigating) NavService.show(context, call.data)
        call.resolve()
    }

    @PluginMethod
    fun stop(call: PluginCall) {
        navigating = false
        NavService.hide(context)
        setAutoEnter(activity, false)
        call.resolve()
    }

    @PluginMethod
    fun enterPip(call: PluginCall) {
        val ret = JSObject()
        ret.put("entered", enter(activity))
        call.resolve(ret)
    }

    @PluginMethod
    fun supported(call: PluginCall) {
        val ret = JSObject()
        ret.put("pip", pipSupported(activity))
        ret.put("notifications", true)
        call.resolve(ret)
    }

    /** From NavService: a button in the notification. (Instance methods: notifyListeners is protected.) */
    fun onAction(action: String) {
        val e = JSObject()
        e.put("action", action)
        notifyListeners("action", e, true)
    }

    fun onPip(active: Boolean) {
        val e = JSObject()
        e.put("active", active)
        notifyListeners("pip", e, true)
    }

    companion object {
        @Volatile private var navigating = false
        private var instance: WeakReference<NavPipPlugin>? = null
        /** Portrait-ish, like a navigator's small window; Android allows 1:2.39 to 2.39:1. */
        private val RATIO = Rational(3, 4)

        private fun pipSupported(a: Activity?): Boolean =
            a != null && Build.VERSION.SDK_INT >= Build.VERSION_CODES.O &&
                a.packageManager.hasSystemFeature(PackageManager.FEATURE_PICTURE_IN_PICTURE)

        private fun params(auto: Boolean): PictureInPictureParams? {
            if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return null
            val b = PictureInPictureParams.Builder().setAspectRatio(RATIO)
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) b.setAutoEnterEnabled(auto).setSeamlessResizeEnabled(false)
            return b.build()
        }

        private fun setAutoEnter(a: Activity?, on: Boolean) {
            if (a == null || !pipSupported(a) || Build.VERSION.SDK_INT < Build.VERSION_CODES.S) return
            a.runOnUiThread { try { params(on)?.let { a.setPictureInPictureParams(it) } } catch (e: Exception) { /* not allowed on this device */ } }
        }

        private fun enter(a: Activity?): Boolean {
            if (a == null || !pipSupported(a)) return false
            return try { params(navigating)?.let { a.enterPictureInPictureMode(it) } ?: false } catch (e: Exception) { false }
        }

        /** MainActivity.onUserLeaveHint(): Android 8–11 have no auto-enter, so enter here while navigating. */
        @JvmStatic
        fun onUserLeaveHint(a: Activity) {
            if (navigating && Build.VERSION.SDK_INT < Build.VERSION_CODES.S) enter(a)
        }

        /** MainActivity's Back with nothing open in the page: while navigating, shrink to the small window. */
        @JvmStatic
        fun onBack(a: Activity): Boolean = navigating && enter(a)

        /** MainActivity.onPictureInPictureModeChanged(). */
        @JvmStatic
        fun onPipChanged(active: Boolean) {
            instance?.get()?.onPip(active)
        }

        /** NavService: "Stop" was tapped in the notification. */
        @JvmStatic
        fun onNotificationAction(action: String) { instance?.get()?.onAction(action) }
    }
}
