# Advice layer & safety gate (`public/js/advice/`, roadmap step 8)

Decides **what the app is allowed to say while you ride**. It also adds speed advice for the road conditions on top of the posted limit.

Three pieces:

1. **The safety gate.** Every spoken cue passes through it: speed alerts, directions, fuel, convoy, weather. It decides whether the cue is spoken, only shown, or held back, and records why.
2. **Road conditions.** Live weather where you are (Open-Meteo) becomes a condition (dry, wet, drying, heavy rain, fog, storm, ice, gusts) and a speed factor.
3. **The speed-advice badge.** It sits on top of the existing limit sign (`#speed-limit-sign`), e.g. **ADVISED 50 · Wet** on a 60 road, or **OVER BY 12** when you're over the posted limit.

| File | What it does |
|---|---|
| `gate.js` | `MUAdvice.gate`: pure state machine. `classify(opts)` sorts a cue into critical, nav, warning or advice. `createGate()` → `decide(msg, t)`, `mode(t)`, setters, per-ride counters. `heldSummary()` puts those counters in words. |
| `ask.js` | `MUAdvice.ask`: pure. `classifyReply()` reads a Hinglish yes/no (Roman or Devanagari), `promptFor()` picks the question ("Bhai, network ke baare mein ek baat bolun?"), `runAsk()` runs question → answer with the speak/listen pieces `voice.js` provides. |
| `conditions.js` | `MUAdvice.conditions`: pure, strict SI. `classify(weather)`, `createTracker()` (hysteresis), `advise()`, `overlayModel()`, `parseOpenMeteo()`, `createWeather()` (fetch with a 10-minute cache per ~5 km cell). |
| `overlay.js` | `MUAdvice.overlay`: the badge and its details card, which holds the Quiet ride and Weather alerts switches. |
| `advice-app.js` | `MUAdvice.live`: wiring. One gate instance, weather while riding, settings (`#advice-section`), the badge, and `mu:advice` for the HUD. |
| `advice.css` | Styles, scoped under `.adv` and `#advice-section`. |

**The hook:** `js/voice.js` → `voiceAnnounce()` first calls `MUAdvice.live.decide(text, opts)` (or the older `allowVoice`). It's guarded: without this folder the app speaks as before.

## The gate's rules

The cue's level comes from what its caller already passes:

| Level | What counts |
|---|---|
| critical | `priority ≥ 85`, `force`, or `category: "sos"` |
| nav | `category: "nav"` |
| warning | `priority 60–84` |
| advice | everything else |

The first matching rule wins:

1. **Critical cues are always spoken.** Nothing in this folder can mute "far over the limit" or SOS.
2. **Quiet ride:**
   - directions are spoken (unless "keep turn-by-turn directions" is off);
   - warnings show on screen but aren't spoken;
   - tips are held back.
3. **GPS not trusted** (confidence < 0.6): speed and weather cues below critical are held back, because the app can't tell how fast you are.
4. **Busy window:** tips wait for 6 s after a spoken turn prompt or a hard brake (≤ −3.5 m/s² between fixes).
5. **Heavy weather** (heavy rain, fog, storm, ice): tips are held back. Warnings still come through.
6. **Spacing:** at most one spoken tip every 45 s. The rest are shown, not spoken.

Apart from the ask-first question below, the gate only ever removes or demotes cues; it never makes the app louder. The app's own mute and "Spoken alerts" setting still apply after it. Settings show what was held back during the ride and why ("This ride: 3 cues held back: 2 (quiet ride), 1 (right after a turn or hard brake)").

## Ask before tips ("Bhai, ek baat bolun?")

The setting is on by default, under **Ask before tips** in `#advice-section`. With it on, a tip that would be spoken first gets a question:

1. `voice.js` says a one-second question, about the topic when known: "Bhai, petrol ke baare mein ek baat bolun?"
2. The mic opens for 3.5 s. The window is counted from when the mic is really open, and grows by 2.5 s once the rider starts talking.
3. **Yes** ("haan", "bol", "bata", "kya hai", "hmm", "ok", "bol na", "kyun nahi"): the tip is spoken.
4. **No** ("nahi", "na", "mat", "abhi nahi", "baad mein") or **silence / unclear**: the tip is dropped.
   - "Nahi" snoozes that category for 20 min.
   - 3 unanswered questions in a row pause asking for 15 min; tips are then only shown.

What gets asked:

| Cue | Ask before tips on |
|---|---|
| Critical (≥ 85), SOS, replies | Spoken at once, never asked |
| Directions (`nav`) | Never asked |
| Warnings | Spoken at once; **in quiet ride they're asked** instead of only shown |
| Tips (advice) | Asked, after every other rule (quiet ride, busy, storm, spacing) has passed them |

**Safety while asking.** While the mic waits, a warning, a direction or anything critical cuts in: listening stops and that question is dropped. The Master AI offers the tip once more if it's still fresh. Lower cues wait in the queue until the answer is in, so nothing talks into the open mic. Only one question runs at a time; a second tip that arrives mid-question is dropped.

**No mic?** Without speech recognition, with the microphone blocked, in a call or muted, everything behaves as before the setting: tips are spoken, and quiet-ride warnings stay on screen. If the recognizer keeps failing (no network on the web, no audio device), asking pauses for 10 min.

The Master AI (`js/master/output.js`) gets `"ask"` back from `voiceAnnounce()` and the final outcome through `opts.onResult({ spoken, reason: "asked:yes" | "asked:no" | "asked:silence" | … })`. It sends nothing else until the answer is in, and only shows a tip on screen once it's wanted. Settings show the ride's questions: "Asked 4 times this ride: 2 yes, 1 not now, 1 no answer."

## Conditions → advice

Open-Meteo `/v1/forecast` returns the current reading plus the last 2 hours of rain. It is converted to SI once, in `parseOpenMeteo` (mm → m, °C → K, gusts already requested in m/s). Only the position rounded to 0.05° (~5 km) is sent.

| Condition | When | Speed factor |
|---|---|---|
| Wet road | raining now, a drizzle/rain code, or ≥ 0.3 mm in the last 2 h | 0.85 |
| Roads may still be wet | up to 30 min after the rain stopped | 0.9 |
| Strong gusts | gusts ≥ 50 km/h | 0.9 |
| Heavy rain / Fog | codes 65/82 or ≥ 4 mm/h; codes 45/48 | 0.7 |
| Thunderstorm | codes 95/96/99 | 0.7 |
| Ice risk | ≤ 2 °C with wet or freezing signals | 0.6 |

- **Advised speed:** posted limit × factor, rounded down to 5 km/h, never below 10 km/h, and only ever **below** the limit. It's labelled "advised" everywhere and is never presented as a legal limit.
- **Over the limit:** more than 5 % (at least 3 km/h) above it.
- **Over the advice:** more than 5 km/h above it.
- No judgement is made on untrusted GPS.
- **Offline:** the last reading is kept for 20 minutes, then the condition becomes "unknown". Unknown is never treated as dry.
- **When it changes for the worse during a ride:** it's spoken once (a warning, so quiet ride shows it without speaking) and appears on the status island. Riding more than 5 km/h over the advice for 8 s gives one spoken nudge, at advice level, at most every 3 minutes.

## The HUD (`mu:advice`)

`{ advised (m/s | null), text, quiet, condition }`. With it, the HUD:
- clamps its eco band to the advised speed;
- shows an amber "advised" marker next to the red posted-limit line on its speed scale;
- adds a "Wet road · advised 50 km/h" line;
- hides info-level alerts in quiet ride.

The dashboard's Quiet button sends `mu:advice-set { quiet }` back.

## Stored on the phone

`mu.advice.v1`: `{ quiet, keepNav, weather, overlay, askFirst }`. Nothing is sent anywhere except the rounded position to Open-Meteo, and only while riding with weather alerts on.

## Tests

`node --test test/advice/*.test.mjs` (24 tests). `ask.test.mjs` covers reply reading, prompts, `runAsk`, the gate's ask rules, snooze and pause, and `voice.js` end to end in a sandbox with a fake speech engine and mic (yes, no, silence, critical, a direction cutting in, queued cues, no mic, mic blocked). The rest: cue levels, every gate rule, the held-back summary, classification, Open-Meteo parsing, drying and offline hysteresis, advice rounding and grace, the badge model, the fetch cache and offline behaviour, and the HUD scale's advised marker against the posted limit.
