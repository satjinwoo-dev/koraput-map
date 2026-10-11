package com.mapunite.app.voice

import android.content.ActivityNotFoundException
import android.content.Intent
import android.speech.tts.TextToSpeech
import android.util.Base64
import com.getcapacitor.JSObject
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.CapacitorPlugin

/*
 * MapUniteVoice: the Master AI's voice on Android (see NativeVoice for what it fixes).
 *
 *   speak({ text, lang = "hi-IN", rate = 1.0, id })   → { result: "ended" | "cancelled" | "failed" }
 *       best installed neural voice for lang; Hinglish arrives in Devanagari (js/voice/hinglish.js)
 *   playAudio({ base64, mime, id })                   → { result }      premium MP3 from /api/tts
 *   stop()                                            → {}              stops either, reports "cancelled"
 *   voices()                                          → { engine, online, hindi, english, hindiMissing, voices[] }
 *   setVoice({ lang, name | null })                   → voices()        the rider's choice (null = automatic)
 *   installVoices()                                   → {}              opens Android's "install voice data"
 *
 * Register in MainActivity: registerPlugin(com.mapunite.app.voice.VoicePlugin.class);
 */
@CapacitorPlugin(name = "MapUniteVoice")
class VoicePlugin : Plugin() {

    private var voice: NativeVoice? = null

    override fun load() { voice = NativeVoice(context) }

    @PluginMethod
    fun speak(call: PluginCall) {
        val v = voice ?: return call.reject("voice not ready")
        val text = (call.getString("text") ?: "").trim()
        if (text.isEmpty()) return call.resolve(JSObject().put("result", "ended"))
        if (text.length > 1000) return call.reject("text too long")
        val lang = call.getString("lang", "hi-IN") ?: "hi-IN"
        val rate = (call.getDouble("rate", 1.0) ?: 1.0).toFloat()
        val id = call.getString("id", System.nanoTime().toString()) ?: System.nanoTime().toString()
        v.speak(text, lang, rate, id) { r -> call.resolve(JSObject().put("result", r)) }
    }

    @PluginMethod
    fun playAudio(call: PluginCall) {
        val v = voice ?: return call.reject("voice not ready")
        val b64 = call.getString("base64") ?: return call.reject("base64 is required")
        val bytes = try { Base64.decode(b64, Base64.DEFAULT) } catch (e: IllegalArgumentException) { return call.reject("bad base64") }
        if (bytes.size < 200 || bytes.size > 4 * 1024 * 1024) return call.reject("audio size out of range")
        val id = call.getString("id", System.nanoTime().toString()) ?: System.nanoTime().toString()
        v.play(bytes, id) { r -> call.resolve(JSObject().put("result", r)) }
    }

    @PluginMethod
    fun stop(call: PluginCall) { voice?.stop(); call.resolve() }

    @PluginMethod
    fun voices(call: PluginCall) {
        val v = voice ?: return call.reject("voice not ready")
        call.resolve(JSObject(v.describe().toString()))
    }

    @PluginMethod
    fun setVoice(call: PluginCall) {
        val v = voice ?: return call.reject("voice not ready")
        val lang = call.getString("lang") ?: return call.reject("lang is required")
        v.prefer(lang, call.getString("name"))
        call.resolve(JSObject(v.describe().toString()))
    }

    @PluginMethod
    fun installVoices(call: PluginCall) {
        try {
            activity.startActivity(Intent(TextToSpeech.Engine.ACTION_INSTALL_TTS_DATA).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
            call.resolve()
        } catch (e: ActivityNotFoundException) {
            call.reject("no TTS settings on this phone")
        }
    }

    override fun handleOnDestroy() { voice?.shutdown(); voice = null }
}
