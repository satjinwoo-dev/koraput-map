package com.mapunite.app.voice

import android.content.Context
import android.content.SharedPreferences
import android.media.AudioAttributes
import android.media.AudioDeviceInfo
import android.media.AudioFocusRequest
import android.media.AudioFormat
import android.media.AudioManager
import android.media.AudioTrack
import android.media.MediaPlayer
import android.net.ConnectivityManager
import android.net.NetworkCapabilities
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.os.SystemClock
import android.speech.tts.TextToSpeech
import android.speech.tts.UtteranceProgressListener
import android.speech.tts.Voice
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.util.Locale
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.Executors

/*
 * The phone side of the Master AI's voice. Fixes what made it choppy and robotic:
 *
 *   wrong voice       picks the best installed NEURAL voice per language (VoiceSelect):
 *                     Google's hi-IN voice for Hinglish (the text arrives in Devanagari),
 *                     en-IN for English; network voices when online, local offline;
 *                     a network voice that fails mid-ride is retried on the local one.
 *   cut first word    Bluetooth (helmet intercom, A2DP / LE audio) sleeps when silent
 *                     and wakes ~300 ms late: when the output is Bluetooth and has been
 *                     quiet > 2 s, 350 ms of silence is played first (pre-roll).
 *   music flapping    audio focus is "transient, may duck" (music dips, doesn't stop) and
 *                     is HELD across a whole turn (question → answer → line), released
 *                     700 ms after the last sound, instead of grabbed per sentence.
 *   wrong stream      navigation-guidance audio attributes: Android routes and mixes it
 *                     like Maps' voice (over music, to the car/helmet, its own volume).
 *   cloud audio       premium MP3s from /api/tts play through MediaPlayer with the same
 *                     attributes, focus and pre-roll, so both routes sound the same.
 *
 * Every speak/play reports exactly once: "ended", "cancelled" or "failed".
 */
class NativeVoice(private val ctx: Context) {

    private val main = Handler(Looper.getMainLooper())
    private val am = ctx.getSystemService(Context.AUDIO_SERVICE) as AudioManager
    private val prefs: SharedPreferences = ctx.getSharedPreferences("mu_voice", Context.MODE_PRIVATE)
    private val io = Executors.newSingleThreadExecutor { r -> Thread(r, "mu-voice-io") }
    private val attrs: AudioAttributes = AudioAttributes.Builder()
        .setUsage(AudioAttributes.USAGE_ASSISTANCE_NAVIGATION_GUIDANCE)
        .setContentType(AudioAttributes.CONTENT_TYPE_SPEECH)
        .build()

    private var tts: TextToSpeech? = null
    @Volatile private var ready = false
    @Volatile var engineName: String = ""; private set
    private val waiting = ArrayList<() -> Unit>()

    private data class Job(val text: String, val lang: String, val rate: Float, val cb: (String) -> Unit, var triedLocal: Boolean = false, var voiceName: String? = null)
    private val jobs = ConcurrentHashMap<String, Job>()
    private var player: MediaPlayer? = null
    private var playerCb: ((String) -> Unit)? = null
    private var pendingCb: ((String) -> Unit)? = null
    @Volatile private var lastSoundEndMs = 0L
    @Volatile private var speaking = 0

    private var focusRequest: AudioFocusRequest? = null
    private var focusHeld = false
    private val releaseFocus = Runnable { abandonFocus() }
    private val focusListener = AudioManager.OnAudioFocusChangeListener { change ->
        // another app took focus for good (a phone call): stop talking
        if (change == AudioManager.AUDIOFOCUS_LOSS || change == AudioManager.AUDIOFOCUS_LOSS_TRANSIENT) main.post { stop() }
    }

    init {
        // Google's engine has the best hi-IN/en-IN neural voices. If it isn't installed,
        // TextToSpeech falls back by itself to the default engine, then the highest-ranked one.
        val google = "com.google.android.tts"
        val listener = TextToSpeech.OnInitListener { status ->
            main.post {
                ready = status == TextToSpeech.SUCCESS
                if (ready) {
                    tts?.setAudioAttributes(attrs)
                    tts?.setOnUtteranceProgressListener(progress)
                    engineName = if (tts?.engines?.any { it.name == google } == true) google else (tts?.defaultEngine ?: "")
                }
                val w = ArrayList(waiting); waiting.clear()
                w.forEach { it() }
            }
        }
        tts = TextToSpeech(ctx, listener, google)
    }

    // ------------------------------------------------------------------ speak (device neural voice)

    /** Speaks [text] in [lang] ("hi-IN" text in Devanagari, or "en-IN"). [cb] gets "ended" | "cancelled" | "failed". */
    fun speak(text: String, lang: String, rate: Float, id: String, cb: (String) -> Unit) {
        main.post {
            if (!ready) {
                if (tts == null) { cb("failed"); return@post }
                waiting += { speak(text, lang, rate, id, cb) }
                return@post
            }
            stopInternal("cancelled")
            val job = Job(text, lang, rate, cb)
            jobs[id] = job
            start(id, job, local = false)
        }
    }

    private fun start(id: String, job: Job, local: Boolean) {
        val t = tts ?: return finish(id, "failed")
        val online = isOnline() && !local
        val choice = VoiceSelect.pick(voiceInfos(), job.lang, online, prefs.getString("voice:${job.lang}", null))
        val chosen = choice?.let { c -> t.voices?.firstOrNull { it.name == c.name } }
        if (chosen != null) { t.voice = chosen; job.voiceName = chosen.name }
        else {
            val r = t.setLanguage(Locale.forLanguageTag(job.lang))
            if (r == TextToSpeech.LANG_MISSING_DATA || r == TextToSpeech.LANG_NOT_SUPPORTED) t.setLanguage(Locale.forLanguageTag("en-IN"))
        }
        t.setSpeechRate(job.rate.coerceIn(0.7f, 1.4f))
        t.setPitch(1.0f)
        holdFocus()
        var queue = TextToSpeech.QUEUE_FLUSH
        if (needsPreroll()) { t.playSilentUtterance(PREROLL_MS, queue, "$id#pre"); queue = TextToSpeech.QUEUE_ADD }
        speaking++
        val res = t.speak(job.text, queue, Bundle(), id)
        if (res != TextToSpeech.SUCCESS) { speaking--; finish(id, "failed") }
    }

    private val progress = object : UtteranceProgressListener() {
        override fun onStart(utteranceId: String) {}
        // Callbacks for an utterance that was already settled (stopped, superseded) are ignored,
        // so a late onStop from the previous line can't release focus under the current one.
        override fun onDone(utteranceId: String) {
            if (utteranceId.endsWith("#pre")) return
            main.post { if (jobs.containsKey(utteranceId)) { soundEnded(); finish(utteranceId, "ended") } }
        }
        @Deprecated("Deprecated in Java")
        override fun onError(utteranceId: String) { onError(utteranceId, TextToSpeech.ERROR) }
        override fun onError(utteranceId: String, errorCode: Int) {
            if (utteranceId.endsWith("#pre")) return
            main.post {
                val job = jobs[utteranceId] ?: return@post
                soundEnded()
                // a network voice that lost the network mid-ride: say it again on the local voice
                val net = errorCode == TextToSpeech.ERROR_NETWORK || errorCode == TextToSpeech.ERROR_NETWORK_TIMEOUT
                if (!job.triedLocal && (net || job.voiceName?.contains("network") == true)) {
                    job.triedLocal = true
                    start(utteranceId, job, local = true)
                } else finish(utteranceId, "failed")
            }
        }
        override fun onStop(utteranceId: String, interrupted: Boolean) {
            if (utteranceId.endsWith("#pre")) return
            main.post { if (jobs.containsKey(utteranceId)) { soundEnded(); finish(utteranceId, "cancelled") } }
        }
    }

    private fun finish(id: String, result: String) {
        val job = jobs.remove(id) ?: return
        try { job.cb(result) } catch (e: Exception) { /* JS side gone */ }
    }

    // ------------------------------------------------------------------ play (premium cloud audio)

    /** Plays MP3 bytes (from /api/tts) with the same attributes, focus and pre-roll. */
    fun play(bytes: ByteArray, id: String, cb: (String) -> Unit) {
        main.post {
            stopInternal("cancelled")
            val f = File(ctx.cacheDir, "mu-voice-${id.replace(Regex("[^A-Za-z0-9_-]"), "_")}.mp3")
            val preroll = needsPreroll()
            holdFocus()
            pendingCb = cb                       // a stop() while the file is written settles it as "cancelled"
            io.execute {
                val ok = try {
                    f.writeBytes(bytes)
                    if (preroll) playSilence(PREROLL_MS.toInt())
                    true
                } catch (e: Exception) { false }
                main.post {
                    if (pendingCb !== cb) { f.delete(); return@post }   // stopped or superseded meanwhile
                    pendingCb = null
                    if (!ok) { f.delete(); scheduleFocusRelease(); cb("failed"); return@post }
                    try {
                        val mp = MediaPlayer()
                        mp.setAudioAttributes(attrs)
                        mp.setDataSource(f.path)
                        player = mp; playerCb = cb
                        speaking++
                        mp.setOnPreparedListener { it.start() }
                        mp.setOnCompletionListener { endPlayer("ended"); f.delete() }
                        mp.setOnErrorListener { _, _, _ -> endPlayer("failed"); f.delete(); true }
                        mp.prepareAsync()
                    } catch (e: Exception) { endPlayer("failed"); f.delete() }
                }
            }
        }
    }

    private fun endPlayer(result: String) {
        val mp = player ?: return
        player = null
        try { mp.release() } catch (e: Exception) { /* released */ }
        soundEnded()
        val cb = playerCb; playerCb = null
        try { cb?.invoke(result) } catch (e: Exception) { /* JS side gone */ }
    }

    /** Silence through the same audio path so a sleeping Bluetooth link is awake when the voice starts. */
    private fun playSilence(ms: Int) {
        val rate = 22050
        val frames = rate * ms / 1000
        val track = AudioTrack.Builder()
            .setAudioAttributes(attrs)
            .setAudioFormat(AudioFormat.Builder().setSampleRate(rate).setEncoding(AudioFormat.ENCODING_PCM_16BIT).setChannelMask(AudioFormat.CHANNEL_OUT_MONO).build())
            .setTransferMode(AudioTrack.MODE_STATIC)
            .setBufferSizeInBytes(frames * 2)
            .build()
        try {
            track.write(ShortArray(frames), 0, frames)
            track.play()
            Thread.sleep(ms.toLong())
        } finally { try { track.stop() } catch (e: Exception) { }; track.release() }
    }

    // ------------------------------------------------------------------ stop, focus, routing

    fun stop() { main.post { stopInternal("cancelled") } }

    private fun stopInternal(result: String) {
        if (jobs.isNotEmpty()) {
            try { tts?.stop() } catch (e: Exception) { }
            val ids = jobs.keys.toList()
            for (id in ids) finish(id, result)
            speaking = 0
        }
        if (player != null) {
            try { player?.stop() } catch (e: Exception) { }
            endPlayer(result)
        }
        pendingCb?.let { cb -> pendingCb = null; try { cb(result) } catch (e: Exception) { } }
        scheduleFocusRelease()
    }

    private fun soundEnded() {
        speaking = (speaking - 1).coerceAtLeast(0)
        lastSoundEndMs = SystemClock.elapsedRealtime()
        if (speaking == 0) scheduleFocusRelease()
    }

    private fun holdFocus() {
        main.removeCallbacks(releaseFocus)
        if (focusHeld) return
        focusHeld = if (Build.VERSION.SDK_INT >= 26) {
            val req = AudioFocusRequest.Builder(AudioManager.AUDIOFOCUS_GAIN_TRANSIENT_MAY_DUCK)
                .setAudioAttributes(attrs).setOnAudioFocusChangeListener(focusListener, main).build()
            focusRequest = req
            am.requestAudioFocus(req) == AudioManager.AUDIOFOCUS_REQUEST_GRANTED
        } else {
            @Suppress("DEPRECATION")
            am.requestAudioFocus(focusListener, AudioManager.STREAM_MUSIC, AudioManager.AUDIOFOCUS_GAIN_TRANSIENT_MAY_DUCK) == AudioManager.AUDIOFOCUS_REQUEST_GRANTED
        }
    }

    /** Keeps focus through the gaps of one turn (question → listening → line); lets go 700 ms after the last sound. */
    private fun scheduleFocusRelease() { main.removeCallbacks(releaseFocus); main.postDelayed(releaseFocus, FOCUS_HOLD_MS) }

    private fun abandonFocus() {
        if (!focusHeld || speaking > 0) return
        if (Build.VERSION.SDK_INT >= 26) focusRequest?.let { am.abandonAudioFocusRequest(it) }
        else { @Suppress("DEPRECATION") am.abandonAudioFocus(focusListener) }
        focusHeld = false
    }

    /** Bluetooth output that has been quiet for a while needs a moment to wake. */
    private fun needsPreroll(): Boolean {
        if (SystemClock.elapsedRealtime() - lastSoundEndMs < 2000) return false
        return am.getDevices(AudioManager.GET_DEVICES_OUTPUTS).any { d ->
            d.type == AudioDeviceInfo.TYPE_BLUETOOTH_A2DP || d.type == AudioDeviceInfo.TYPE_BLUETOOTH_SCO ||
                (Build.VERSION.SDK_INT >= 31 && (d.type == AudioDeviceInfo.TYPE_BLE_HEADSET || d.type == AudioDeviceInfo.TYPE_BLE_SPEAKER))
        }
    }

    private fun isOnline(): Boolean {
        val cm = ctx.getSystemService(Context.CONNECTIVITY_SERVICE) as ConnectivityManager
        val caps = cm.getNetworkCapabilities(cm.activeNetwork) ?: return false
        return caps.hasCapability(NetworkCapabilities.NET_CAPABILITY_VALIDATED)
    }

    // ------------------------------------------------------------------ voices

    private fun voiceInfos(): List<VoiceSelect.VoiceInfo> = (tts?.voices ?: emptySet<Voice>()).map { v ->
        VoiceSelect.VoiceInfo(
            name = v.name, language = v.locale.language, country = v.locale.country,
            quality = v.quality, latency = v.latency, network = v.isNetworkConnectionRequired,
            installed = !v.features.contains(TextToSpeech.Engine.KEY_FEATURE_NOT_INSTALLED)
        )
    }

    /** Installed Hindi and English voices, and which one each language uses now. */
    fun describe(): JSONObject {
        val online = isOnline()
        val all = voiceInfos().filter { it.language == "hi" || it.language == "en" }
        val list = JSONArray()
        for (v in all.sortedWith(compareBy({ it.language }, { -it.quality }))) list.put(JSONObject()
            .put("name", v.name).put("lang", "${v.language}-${v.country}").put("quality", v.quality).put("latency", v.latency)
            .put("network", v.network).put("installed", v.installed))
        val pick = { lang: String -> VoiceSelect.pick(all, lang, online, prefs.getString("voice:$lang", null))?.name }
        return JSONObject().put("ready", ready).put("engine", engineName).put("online", online)
            .put("hindi", pick("hi-IN") ?: JSONObject.NULL).put("english", pick("en-IN") ?: JSONObject.NULL)
            .put("hindiMissing", all.none { it.language == "hi" && it.installed })
            .put("voices", list)
    }

    /** The rider's choice for a language (null = automatic). */
    fun prefer(lang: String, name: String?) {
        prefs.edit().apply { if (name == null) remove("voice:$lang") else putString("voice:$lang", name) }.apply()
    }

    fun shutdown() {
        main.post {
            stopInternal("cancelled")
            try { tts?.shutdown() } catch (e: Exception) { }
            tts = null; ready = false
            abandonFocus()
        }
        io.shutdown()
    }

    companion object {
        const val PREROLL_MS = 350L
        const val FOCUS_HOLD_MS = 700L
    }
}
