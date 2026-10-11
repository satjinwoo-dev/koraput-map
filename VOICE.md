# MapUnite voice engine

The Master AI's voice: how it works, how to switch on the premium neural voice, and how to check it on a phone.

## What was wrong, and what fixes it

| Symptom | Cause | Fix |
|---|---|---|
| Robotic Hinglish ("gad-dha", "aage" read as "age") | Roman Hinglish read by an **English** voice | `js/voice/hinglish.js` writes Hindi words in Devanagari and leaves English words in Latin, then sends the line to a **Hindi** neural voice (`hi-IN`). English lines go to an Indian English voice (`en-IN`). |
| First word cut off on the helmet intercom | Bluetooth links (A2DP / LE audio) sleep when silent and wake about 300 ms late | When the output is Bluetooth and has been quiet for more than 2 s, the native plugin plays 350 ms of silence first. |
| Music stops and starts between sentences | Audio focus was grabbed and released for every utterance | Focus is "transient, may duck" (music dips, it doesn't stop), held for the whole turn (question → answer → line) and released 700 ms after the last sound. |
| Voice too quiet, or on the wrong device | Plain media stream | Navigation-guidance audio attributes, the same stream Android gives Maps' voice. |
| Choppy, stalls mid-sentence | WebView `speechSynthesis` on top of a plugin shim, with a watchdog that cut long lines | The native plugin talks to Android's TextToSpeech directly, picks the best installed neural voice, and reports exactly one result per line. |
| Sounds like a different person each time | Default voice changed with the language and the engine | One premium speaker (`GOOGLE_TTS_VOICE` or `ELEVENLABS_VOICE_ID`) for Hindi and English when the cloud voice is on. On the device, the best `hi-IN` and `en-IN` voices from the same engine (Google). |

## The three routes

Each line takes one route, chosen in `js/voice/engine.js`:

1. **Cloud (premium).** `GET /api/tts` on your server returns an MP3 from Google Cloud Text-to-Speech (Chirp 3 HD) or ElevenLabs. The API key stays on the server. The phone caches every line it has played (Cache Storage `mu-tts-v1` plus memory), so a repeated line plays instantly, even offline.
2. **Native.** The `MapUniteVoice` Kotlin plugin uses Android's best installed neural voice. Network voices are used when online and local voices offline. If a network voice fails mid-ride, the line is retried on the local voice.
3. **Web.** On the website, the browser's best voice for the language is used.

**Latency rules.** A late warning is worse than a plainer voice, so the cloud only gets a fixed wait:

| Priority | Examples | Cloud wait |
|---|---|---|
| ≥ 80 | safety, turns | Cloud only if the line is already cached. Otherwise the device voice speaks now and the premium audio downloads for next time. |
| 60–79 | warnings | Up to 700 ms. |
| < 60 | tips and questions | Up to 2.5 s. |

**Other behaviour:**
- After 3 cloud failures in a row, the cloud is skipped for 2 minutes.
- A `503 not-configured` reply switches the cloud off for the session.
- Lines over 400 characters go to the device voice.
- The ask-first questions ("Bhai, ek baat bolun?") are pre-downloaded 4 s after start-up.

## Switching on the premium voice (server)

Pick one provider and set its variables in the server environment, then restart the server.

### Google Cloud Text-to-Speech (recommended for Hinglish)

```
TTS_PROVIDER=google
GOOGLE_TTS_API_KEY=<key>        # Cloud Text-to-Speech API enabled; restrict the key to that API
GOOGLE_TTS_VOICE=Puck           # optional: a Chirp 3 HD voice name, without the locale
GOOGLE_TTS_MARKUP=1             # optional: natural [pause short] between sentences of tips
```

The server asks for `hi-IN-Chirp3-HD-<voice>` and `en-IN-Chirp3-HD-<voice>`, so the same speaker is used for both languages. Listen to a few voices in the Google Cloud console and pick one. Male options include Puck, Charon and Fenrir; female options include Kore, Aoede and Leda.

### ElevenLabs

```
TTS_PROVIDER=elevenlabs
ELEVENLABS_API_KEY=<key>
ELEVENLABS_VOICE_ID=<id of a Hindi / Hinglish voice in your library>
ELEVENLABS_MODEL=eleven_multilingual_v2      # optional
```

### Optional settings (both providers)

```
TTS_CACHE_DIR=./data/tts-cache     # disk cache; the newest 5000 lines are kept
TTS_RATE_LIMIT_MAX=60              # requests per minute per IP
```

**Who can use it.** With a provider configured, `/api/tts` will synthesise any short line (up to 400 characters, Hindi or English) for anyone who can reach your server. The only limit is `TTS_RATE_LIMIT_MAX` per IP. Keep that modest, restrict the Google key to the Text-to-Speech API, and set a budget alert at the provider.

**Cost.** The Master repeats itself a lot, so the server caches each line in memory (32 MB) and on disk, and requests for the same line share one upstream call. Most lines are paid for only once.

**Check it with one request.** The request shapes follow the providers' published APIs, but I couldn't call them from here, so test with your key before a ride:

```
curl -o test.mp3 -D - "https://<your-server>/api/tts?lang=hi-IN&q=%E0%A4%AD%E0%A4%BE%E0%A4%88%2C%20%E0%A4%86%E0%A4%97%E0%A5%87%20%E0%A4%97%E0%A4%A1%E0%A5%8D%E0%A4%A2%E0%A4%BE%20%E0%A4%B9%E0%A5%88."
```

Expected result: `200`, `Content-Type: audio/mpeg`, `X-TTS-Source: upstream`, and a playable `test.mp3` saying "भाई, आगे गड्ढा है." Run the same request again: `X-TTS-Source` should now be `memory`.

**Error responses:**
- `502 upstream-failed`: the server log shows the provider's reply. The usual causes are an API that isn't enabled, a key restricted to other APIs, or a wrong voice name.
- `503 not-configured`: `TTS_PROVIDER` or the key is missing.

The Android app fetches `/api/tts` from `https://localhost`. That origin must be in `CORS_ORIGIN`, as it already is for the rest of the app's API.

## The Android plugin

1. Run `node scripts/setup-perception-android.mjs`. It copies `native/android/voice/*.kt` next to the perception plugin and installs a `MainActivity.java` that registers `VoicePlugin`.
2. Run `npx cap sync android`, then build.
3. `node scripts/check-android.mjs` should now show "MapUniteVoice … registered".

**On the phone, once:**
- **Settings → System → Languages → Text-to-speech output → Preferred engine: Speech Services by Google.**
- **Settings → Install voice data → Hindi (India)**, plus English (India). Hindi lines need this to work offline. Without it they use the network voice when online, or an English voice offline.

**The plugin's methods** (for a settings screen later):
- `voices()`: the installed Hindi and English voices, which one each language uses, and whether Hindi is missing.
- `setVoice({ lang, name })`: chooses a voice by name; `name: null` goes back to automatic.
- `installVoices()`: opens Android's voice-data installer.

## Files

| File | What |
|---|---|
| `public/js/voice/hinglish.js` | Roman Hinglish → Devanagari, chooses `hi-IN` / `en-IN`, adds pause markup |
| `public/js/voice/engine.js` | route choice, latency budgets, cache, circuit breaker, players |
| `public/js/voice.js` | VoiceAssistant (queue, pre-emption, ask-first) now speaks through the engine |
| `lib/tts.js`, `server.js` | `/api/tts`: Google / ElevenLabs, caches, validation, CORS, rate limit |
| `native/android/voice/` | `VoicePlugin` (Capacitor), `NativeVoice` (TTS, focus, pre-roll, MP3 playback), `VoiceSelect` (best voice) |
| `test/voice/voice-engine.test.mjs` | 21 tests: Hinglish coverage of every desi phrase, routes, budgets, cancel, breaker, server, voice.js on the engine |
| `native/android/perception-jvmtest/VoiceSelectCheck.kt` | JVM check of voice selection |
