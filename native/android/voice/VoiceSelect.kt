package com.mapunite.app.voice

/*
 * Picks the best installed Android TTS voice for a language (pure Kotlin, JVM-tested).
 *
 * Android exposes voices with a locale, a quality (100 … 500), a latency (100 … 500),
 * whether they need the network, and whether their data is installed. Google's TTS
 * engine ships local voices and higher-quality "network" voices for hi-IN and en-IN.
 *
 *   exclude   other languages, voices whose data isn't installed, network voices when
 *             offline, and the "-language" alias entries (they just point at a default)
 *   prefer    exact locale (hi-IN over hi), higher quality, network voices when online
 *             (better prosody), then lower latency
 *   override  a voice the rider chose by name, if it's usable right now
 */
object VoiceSelect {

    data class VoiceInfo(
        val name: String,
        val language: String,      // ISO 639, e.g. "hi"
        val country: String,       // ISO 3166, e.g. "IN" ("" when none)
        val quality: Int,          // Voice.QUALITY_*: 100 very low … 500 very high
        val latency: Int,          // Voice.LATENCY_*: 100 very low … 500 very high
        val network: Boolean,
        val installed: Boolean
    )

    /** @param lang BCP-47 like "hi-IN"; @param preferred a voice name the rider picked, or null */
    fun pick(voices: List<VoiceInfo>, lang: String, online: Boolean, preferred: String? = null): VoiceInfo? {
        val parts = lang.split('-', '_')
        val wantLang = parts[0].lowercase()
        val wantCountry = parts.getOrNull(1)?.uppercase() ?: ""
        val usable = voices.filter { v ->
            v.language.lowercase() == wantLang && v.installed && (online || !v.network) && !v.name.endsWith("-language")
        }
        if (usable.isEmpty()) return null
        if (preferred != null) usable.firstOrNull { it.name == preferred }?.let { return it }
        return usable.maxByOrNull { score(it, wantCountry, online) }
    }

    fun score(v: VoiceInfo, wantCountry: String, online: Boolean): Double {
        var s = 0.0
        if (wantCountry.isNotEmpty() && v.country.uppercase() == wantCountry) s += 50
        s += v.quality / 100.0 * 4                     // very high quality: +20
        if (online && v.network) s += 6                // network voices sound more natural
        s -= v.latency / 100.0                         // a fast start matters for warnings
        return s
    }
}
