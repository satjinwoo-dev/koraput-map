# Advice layer & safety gate (`public/js/advice/`, roadmap step 8)

Decides **what the app is allowed to say while you ride**. It also adds speed advice for the road conditions on top of the posted limit.

Four pieces:

1. **The safety gate** (`advice.js` + `advice-app.js`, `MUAdvice.core` / `MUAdvice.app`). It decides when an **economy tip** may be given at all: on a steady road, never in a corner, after hard braking, on a wet road, near a turn or on weak GPS.
2. **The cue rules every spoken cue passes** (`gate.js`, one instance in `advice-ui.js`, `MUAdvice.live.decide`). `voiceAnnounce()` asks them about each cue: critical, directions, warning or advice (from the cue's priority and category). Advice-level cues (tips, fuel stops, convoy chatter, the Master AI's suggestions) are held in quiet ride, on weak GPS for speed cues, for 6 s after a turn or hard brake, in heavy weather, and spaced 45 s apart. **Warnings, directions and critical cues are always spoken, quiet ride included.** The instance is fed from the same signals as the gate above (the one quiet-ride setting, the badge's road condition, GPS confidence, hard braking), so there's no second quiet setting or weather source.
3. **Ask before tips** (`ask.js`, on by default). An advice-level cue that would be spoken starts with a one-second question ("Bhai, ek baat bolun?"); the mic listens for about 3.5 s, and the tip is spoken only after a yes. "Nahi" snoozes that kind of tip for 20 minutes; 3 unanswered questions pause asking for 15 minutes. Warnings, directions and critical cues are never asked. Without a mic (or during a call, or muted) tips are spoken as before. The machinery is in `voice.js` (`VoiceAssistant.askThenSay`, `listenOnce`).
4. **Road conditions.** Live weather where you are (Open-Meteo) becomes a condition (dry, wet, drying, heavy rain, fog, storm, ice, gusts) and a speed factor. The condition is handed to the gate, so a wet road holds tips there too.
5. **The speed-advice badge.** It sits on top of the existing limit sign (`#speed-limit-sign`), e.g. **ADVISED 50 · Wet** on a 60 road, or **OVER BY 12** when you're over the posted limit.

| File | What it does |
|---|---|
| `advice.js` | `MUAdvice.core`: pure, strict SI. The gate state machine (`evaluateGate`: off, quiet, hold with reasons, cooldown, ready) and the economy advice, capped by the posted limit. |
| `advice-app.js` | `MUAdvice.app`: the one gate instance. Fed by SmartDrive's hooks; speaks a tip through `voiceAnnounce` at priority 30 with `dropIfBusy`. `setQuiet`, `setRoadCondition`, `mode()`, `heldSummary()`. |
| `conditions.js` | `MUAdvice.conditions`: pure, strict SI. `classify(weather)`, `createTracker()` (hysteresis), `advise()`, `overlayModel()`, `parseOpenMeteo()`, `createWeather()` (fetch with a 10-minute cache per ~5 km cell). |
| `overlay.js` | `MUAdvice.overlay`: the badge and its details card, which holds the Quiet ride and Weather alerts switches. |
| `advice-ui.js` | `MUAdvice.live`: the UI wiring. Weather while riding, settings (`#advice-section`), the badge, and `mu:advice` for the HUD. It has no gate of its own: quiet ride and the wet-road hold are the gate's. |
| `gate.js` | `MUAdvice.gate`: the cue rules, pure (`classify`, `createGate` → `decide`, `noteAnswer`, `mode`, `heldSummary`, `askSummary`). `quietMutesWarnings: true` would show warnings on screen in quiet ride instead; the app keeps it off. |
| `ask.js` | `MUAdvice.ask`: pure. `classifyReply` (Hinglish yes/no, Roman or Devanagari; "no" wins), `promptFor`, `runAsk`. |
| `advice.css` | Styles, scoped under `.adv` and `#advice-section`. |

`js/voice.js` asks `MUAdvice.live.decide()` before each cue and runs the ask-first question; without this folder it speaks as before.

## The gate's rules

While riding, the gate is in one of these states (first match wins):

| State | When | Tips |
|---|---|---|
| quiet | the rider switched on Quiet ride (settings, the badge's card, or the HUD's button: one setting) | none |
| hold | cornering (gyro, GPS heading or v²·κ on the route, +6 s); a bend under 200 m radius within max(150 m, 8 s); braking ≥ 3 m/s² (+30 s); a wet road (+30 min after the last report); speed unsteady (σ > 1.5 m/s over 20 s); a turn within 500 m; GPS untrusted (> 25 m); under 15 km/h | none |
| cooldown | a tip in the last 3 min (the same tip: 10 min) | none |
| ready | none of the above | one tip, at priority 30, dropped if the voice is busy |

**Wet road:** the badge's road condition (wet, drying, heavy rain, storm, ice) is preferred over the raw weather code. Dry clears it. Unknown (offline) leaves the weather code to decide. Never "dry" by default.

The gate only ever holds tips back; it never makes the app louder. The app's own mute and "Spoken alerts" setting still apply. Settings show what was held back during the ride and why ("This ride: 3 tips held back: 2 (quiet ride), 1 (a wet road)"). A reason is counted at most once a minute, and only when there was a tip to give.

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
- **When it changes for the worse during a ride:** it's spoken once (a safety warning, so quiet ride doesn't mute it) and appears on the status island. Riding more than 5 km/h over the advice for 8 s gives one spoken nudge, at most every 3 minutes. That nudge is advice, so a quiet ride never hears it.

## The HUD (`mu:advice`)

`{ advised (m/s | null), text, quiet, condition }`. With it, the HUD:
- clamps its eco band to the advised speed;
- shows an amber "advised" marker next to the red posted-limit line on its speed scale;
- adds a "Wet road · advised 50 km/h" line;
- hides info-level alerts in quiet ride.

The dashboard's Quiet button sends `mu:advice-set { quiet }` back. It goes to the gate's `setQuiet`, and the gate announces every change as `mu:advice-quiet`, so the settings switch, the badge and the HUD always agree.

## Stored on the phone

- `mu.advice.v1`: `{ weather, overlay, askFirst }`, the badge's own switches and "Ask before tips".
- Quiet ride is the gate's setting, kept by `advice-app.js`.

Nothing is sent anywhere except the rounded position to Open-Meteo, and only while riding with weather alerts on.

## Tests

- `node --test test/advice/`: the gate (every hold, cooldowns, the limit cap, the voice priority) and its UI: classification, Open-Meteo parsing, drying and offline hysteresis, advice rounding and grace, the badge model, the fetch cache, and the HUD scale's advised marker against the posted limit.
- A sandboxed run of the advice scripts proves there's one quiet-ride setting and one road condition for the tip gate and the cue rules alike. In quiet ride a tip is held and a warning still spoken; heavy rain holds tips in both; the ask switch is stored.
- `test/advice/ask.test.mjs`: replies, prompts, the ask bookkeeping, and `voice.js` end to end in a vm with a fake speech engine and mic (yes, no, silence, a direction cutting in, no mic, a mic blocked mid-question).
