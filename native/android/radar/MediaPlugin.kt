package com.mapunite.app.radar

import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.media.MediaMetadata
import android.media.session.MediaController
import android.media.session.MediaSessionManager
import android.media.session.PlaybackState
import android.os.Handler
import android.os.Looper
import android.provider.Settings
import androidx.core.app.NotificationManagerCompat
import com.getcapacitor.JSObject
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.CapacitorPlugin
import org.json.JSONObject

/*
 * MapUniteMedia: what's playing in any music app, for the Master AI's mood
 * agent (public/js/master/agents/mood-agent.js, provider in providers.js).
 *
 *   status()                → { access: boolean }     notification access granted?
 *   openAccessSettings()    → {}                      Android's Notification access screen
 *   nowPlaying()            → Track | {}              the playing (else the latest) session
 *   control({ action })     → {}                      "next" | "previous" | "pause" | "play"
 *   event "track"           → Track                   on a new track or play/pause
 *
 * Track = { title, artist, album, package, playing, durationMs }
 *
 * ACCESS. Android lets an app see other apps' media sessions only through an
 * enabled NotificationListenerService (MediaListenerService.kt). No app can
 * enable that for itself; the rider does it once in system settings. Until
 * then every method works but reports nothing.
 * Only the title, artist, album, duration and app package leave this file.
 *
 * Register in MainActivity: registerPlugin(com.mapunite.app.radar.MediaPlugin.class);
 */
@CapacitorPlugin(name = "MapUniteMedia")
class MediaPlugin : Plugin() {

    private val main = Handler(Looper.getMainLooper())
    private var msm: MediaSessionManager? = null
    private val callbacks = mutableMapOf<MediaController, MediaController.Callback>()
    private var lastSent = ""
    private var sessionsListener: MediaSessionManager.OnActiveSessionsChangedListener? = null

    private val component get() = ComponentName(context, MediaListenerService::class.java)
    private fun hasAccess() = NotificationManagerCompat.getEnabledListenerPackages(context).contains(context.packageName)

    override fun load() {
        msm = context.getSystemService(Context.MEDIA_SESSION_SERVICE) as MediaSessionManager
        attach()
    }

    /** Listen to session changes (needs access; retried by status()). */
    private fun attach() {
        if (sessionsListener != null || !hasAccess()) return
        val m = msm ?: return
        val l = MediaSessionManager.OnActiveSessionsChangedListener { list -> main.post { watch(list ?: emptyList()) } }
        try {
            m.addOnActiveSessionsChangedListener(l, component, main)
            sessionsListener = l
            watch(m.getActiveSessions(component))
        } catch (e: SecurityException) { sessionsListener = null }
    }

    private fun watch(list: List<MediaController>) {
        for ((c, cb) in callbacks.toMap()) if (list.none { it.sessionToken == c.sessionToken }) { c.unregisterCallback(cb); callbacks.remove(c) }
        for (c in list) if (callbacks.keys.none { it.sessionToken == c.sessionToken }) {
            val cb = object : MediaController.Callback() {
                override fun onMetadataChanged(metadata: MediaMetadata?) = emit()
                override fun onPlaybackStateChanged(state: PlaybackState?) = emit()
            }
            c.registerCallback(cb, main)
            callbacks[c] = cb
        }
        emit()
    }

    private fun current(): MediaController? {
        val list = try { msm?.getActiveSessions(component) } catch (e: SecurityException) { null } ?: return null
        return list.firstOrNull { it.playbackState?.state == PlaybackState.STATE_PLAYING } ?: list.firstOrNull()
    }

    private fun track(c: MediaController?): JSObject {
        val o = JSObject()
        val md = c?.metadata ?: return o
        val title = md.getString(MediaMetadata.METADATA_KEY_TITLE) ?: md.getString(MediaMetadata.METADATA_KEY_DISPLAY_TITLE) ?: return o
        o.put("title", title.take(120))
        o.put("artist", (md.getString(MediaMetadata.METADATA_KEY_ARTIST) ?: md.getString(MediaMetadata.METADATA_KEY_ALBUM_ARTIST) ?: "").take(120))
        o.put("album", (md.getString(MediaMetadata.METADATA_KEY_ALBUM) ?: "").take(120))
        o.put("package", c.packageName)
        o.put("playing", c.playbackState?.state == PlaybackState.STATE_PLAYING)
        val d = md.getLong(MediaMetadata.METADATA_KEY_DURATION)
        o.put("durationMs", if (d > 0) d else JSONObject.NULL)
        return o
    }

    private fun emit() {
        val t = track(current())
        val sig = "${t.optString("package")}|${t.optString("artist")}|${t.optString("title")}|${t.optBoolean("playing")}"
        if (sig == lastSent || !t.has("title")) return
        lastSent = sig
        notifyListeners("track", t)
    }

    @PluginMethod
    fun status(call: PluginCall) {
        val ok = hasAccess()
        if (ok) attach()
        call.resolve(JSObject().put("access", ok))
    }

    @PluginMethod
    fun openAccessSettings(call: PluginCall) {
        try {
            activity.startActivity(Intent(Settings.ACTION_NOTIFICATION_LISTENER_SETTINGS).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
            call.resolve()
        } catch (e: Exception) { call.reject("no notification access settings on this phone") }
    }

    @PluginMethod
    fun nowPlaying(call: PluginCall) { call.resolve(if (hasAccess()) track(current()) else JSObject()) }

    @PluginMethod
    fun control(call: PluginCall) {
        val c = current() ?: return call.reject("nothing is playing")
        val tc = c.transportControls
        when (call.getString("action")) {
            "next" -> tc.skipToNext()
            "previous" -> tc.skipToPrevious()
            "pause" -> tc.pause()
            "play" -> tc.play()
            else -> return call.reject("unknown action")
        }
        call.resolve()
    }

    override fun handleOnDestroy() {
        sessionsListener?.let { msm?.removeOnActiveSessionsChangedListener(it) }
        for ((c, cb) in callbacks) c.unregisterCallback(cb)
        callbacks.clear()
        super.handleOnDestroy()
    }
}
