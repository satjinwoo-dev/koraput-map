// JVM check of VoiceSelect (no Android needed). Exits non-zero on failure.
//
//   kotlinc native/android/voice/VoiceSelect.kt native/android/perception-jvmtest/VoiceSelectCheck.kt -d /tmp/mu-vs
//   kotlin -cp /tmp/mu-vs VoiceSelectCheckKt
//
// The voice list mirrors what Google's TTS engine reports on a typical Android 14 phone
// (names like hi-in-x-hid-local / hi-in-x-hie-network, quality 400, latency 200/300).
import com.mapunite.app.voice.VoiceSelect
import com.mapunite.app.voice.VoiceSelect.VoiceInfo
import kotlin.system.exitProcess

private var failures = 0
private fun check(ok: Boolean, what: String) { if (!ok) { failures++; println("FAIL  $what") } else println("ok    $what") }

fun main() {
    val voices = listOf(
        VoiceInfo("hi-in-x-hia-local", "hi", "IN", 400, 200, network = false, installed = true),
        VoiceInfo("hi-in-x-hie-network", "hi", "IN", 400, 300, network = true, installed = true),
        VoiceInfo("hi-IN-language", "hi", "IN", 500, 100, network = false, installed = true),
        VoiceInfo("hi-in-x-hid-local", "hi", "IN", 300, 200, network = false, installed = true),
        VoiceInfo("en-in-x-ene-local", "en", "IN", 400, 200, network = false, installed = true),
        VoiceInfo("en-in-x-end-network", "en", "IN", 400, 300, network = true, installed = true),
        VoiceInfo("en-us-x-sfg-local", "en", "US", 500, 200, network = false, installed = true),
        VoiceInfo("en-gb-x-gbb-local", "en", "GB", 400, 200, network = false, installed = false)
    )

    check(VoiceSelect.pick(voices, "hi-IN", online = true)?.name == "hi-in-x-hie-network", "online Hindi → the network neural voice")
    check(VoiceSelect.pick(voices, "hi-IN", online = false)?.name == "hi-in-x-hia-local", "offline Hindi → best local voice")
    check(VoiceSelect.pick(voices, "en-IN", online = false)?.name == "en-in-x-ene-local", "Indian English beats a higher-quality US voice")
    check(VoiceSelect.pick(voices, "en-IN", online = true)?.name == "en-in-x-end-network", "online Indian English → network voice")
    check(VoiceSelect.pick(voices, "hi_IN", online = false)?.name == "hi-in-x-hia-local", "underscore locale tags work")
    check(VoiceSelect.pick(voices, "hi-IN", online = true, preferred = "hi-in-x-hid-local")?.name == "hi-in-x-hid-local", "the rider's choice wins")
    check(VoiceSelect.pick(voices, "hi-IN", online = false, preferred = "hi-in-x-hie-network")?.name == "hi-in-x-hia-local", "a chosen network voice is skipped offline")
    check(voices.none { VoiceSelect.pick(voices, "hi-IN", it.network)?.name == "hi-IN-language" }, "the -language alias is never picked")
    check(VoiceSelect.pick(voices, "ta-IN", online = true) == null, "no Tamil voice → null (caller falls back)")
    check(VoiceSelect.pick(voices.filter { it.language == "en" }, "en-AU", online = false)?.name == "en-us-x-sfg-local", "no exact country → best of the language")
    check(VoiceSelect.pick(listOf(voices[7]), "en-GB", online = true) == null, "voices without installed data are skipped")

    if (failures > 0) { println("$failures failure(s)"); exitProcess(1) }
    println("all voice selection checks passed")
}
