# Master AI vision: the break-time fatigue check (`public/js/master/vision/`)

When the Ride agent says a break is due, the **Vision agent** waits for the bike to stop and offers a 10-second fatigue check. The check reads the rider's face with the front camera and MediaPipe Face Landmarker, entirely on the phone. The Master then gives desi advice, through the "ek baat bolun?" gate like every other tip.

```
ride.break-due ─▶ vision agent (armed) ─▶ bike stopped ≥ 15 s ─▶ report vision.offer ─▶ brain ─▶ ask gate
   ─▶ rider said yes (or it was shown) ─▶ card "Start · Abhi nahi" ─▶ tap Start
   ─▶ face-scan: camera + MediaPipe on the phone ─▶ fatigue.js ─▶ report fatigue.high / moderate / low / retry
   ─▶ persona (desi) ─▶ gate ─▶ voice, plus a result sheet on screen
```

| File | What it does |
|---|---|
| `fatigue.js` | Pure maths (tested in node). `frameFromResult()` turns a MediaPipe result into eye closure, jaw opening and head angles. `analyzeSession()` gives PERCLOS, blinks, long closures, yawns and nods, then a score, level and confidence. `analyzeSnapshot()` handles a single photo. `signalWords()` puts the signs into desi or plain words. |
| `landmarker.js` | Loads MediaPipe Tasks Vision 0.10.14 and the `face_landmarker` model only when a check starts. It tries your override, then `/vendor/mediapipe/`, then the CDN. GPU first, CPU as fallback; the model is closed after each check. |
| `face-scan.js` | The `face-scan` capability: the offer card, the check screen (live front camera in a circle, a progress ring around it, a big countdown, a "Face detected" chip, tips) and the result sheet (score gauge, level pill, advice, "What the check saw", key numbers). All on-screen text is English. It asks `guard()` every frame and closes the camera the moment the bike moves. |
| `vision.css` | Styles, scoped under `.mu-fc`. |
| `../agents/vision-agent.js` | When to offer and when to check, the stillness rule, the reports, the history. |

## Language

- **Screen:** always plain English. That covers the offer card, the check screen, the result sheet and the Master's status island.
- **Voice:** follows the persona style, desi Hinglish by default.

The agent sends the spoken detail ("aankh 1.3 second tak band rahi") in `data.detail` and the English one in `data.screen.detail` ("Your eyes stayed shut for 1.3 seconds"). The persona uses the plain pack for every screen title and subtitle.

## The safety rule: only while the bike stands still

- **Offer:** only when `state.ride` says stopped for at least 15 s **and** the freshest GPS speed is ≤ 0.8 m/s (≈ 3 km/h, which allows for GPS jitter at rest). While riding with no GPS fix, there's no proof the bike has stopped, so there's no offer.
- **The card** closes as soon as the bike moves. The check never starts by itself: the rider taps **Start**.
- **During the check:** speed above 1.5 m/s, or the Ride agent saying "moving", turns the camera off at once and drops the check. Nothing is said about it.
- **Outside a ride** (parked, app open), a manual check is allowed: `MUMaster.live.delegate("fatigue-check")`.

## What it measures in 10 seconds

| Sign | How |
|---|---|
| Eye closure | `eyeBlinkLeft/Right` blendshapes (the eye aspect ratio from landmarks if they're missing). The "shut" line is 0.3 above the rider's own open-eye level, so heavy-lidded eyes aren't read as sleepy. |
| PERCLOS | Share of time the eyes are shut. 8 % adds nothing; 30 % is the full weight. |
| Long closures | Over 500 ms. Two of them, or one of 1 s or more (microsleep-like), make the result **high** whatever else. |
| Blinks | ≤ 500 ms: slow blinks (≥ 300 ms) and a high rate (≥ 35/min). |
| Yawn | `jawOpen` ≥ 0.55 for ≥ 1.2 s. |
| Nod / droop | Head ≥ 14° away from its own starting angle for 0.25–2.5 s, or hanging > 8° in the second half. |

- **Score:** 85 % face signs (weights: PERCLOS 0.3, long closures 0.25, blink length 0.15, yawns 0.15, nods 0.1, blink rate 0.05) and 15 % riding time.
- **Levels:** high ≥ 55, moderate ≥ 30.
- **Confidence:** "good" needs ≥ 6 s of face in view and ≥ 70 % of frames with a face. "poor" asks for a retry ("Face the light, lift your visor…").

**Photo fallback:** if the WebView has no live camera, and the `@capacitor/camera` plugin is bundled, one front photo is taken. It shows eyes and mouth only, so confidence is always "low", and it never says "high" on eyes alone.

**Not a medical test,** and the result sheet says so. A low score never says "fit to ride": the advice keeps the break and says to stop if sleepy.

## Reports to the Master

| Kind | Severity | Example (desi) |
|---|---|---|
| `vision.offer` | advice (asked) | "Bhai, ruke ho toh ek 10 second ka fatigue check kar lein? Screen pe Start dabao…" |
| `fatigue.high` | warning | "Bhai, aankh 1.3 second tak band rahi aur ubaasi aa rahi hai. Abhi aage mat badh. Bees minute aaram kar…" |
| `fatigue.moderate` | advice | "Thodi thakaan dikh rahi hai… das-pandrah minute aur ruk ja, paani pi…" |
| `fatigue.low` | advice | "Check mein zyada thakaan nahi dikhi. Phir bhi 1 ghante 30 minute se chala raha hai, paani pi ke hi nikalna. Neend aaye toh ruk jaana." |
| `fatigue.retry` / `vision.unavailable` | advice | Face not seen / the model or camera didn't work. |

The agent also shares `state.fatigue = { at, score, level, confidence, mode }`. It doesn't nag: one offer per break-due; "nahi", silence or "Abhi nahi" ends it; one check per 45 min at most.

**Privacy:** frames are analysed in memory and dropped, and a fallback photo is dropped after analysis. Only the last 20 scores (no images) stay on the phone, under `mu.master.vision.history`.

## Setup

1. **The model, for offline use and the Android app:** run `node scripts/fetch-mediapipe.mjs`. It puts about 12 MB into `public/vendor/mediapipe/`, which build-native copies into the app. Without it, the first check downloads the model from the CDN, which needs a connection.
2. **CSP** (`server.js`): `'wasm-unsafe-eval'` was added to `script-src`. It allows WebAssembly only, not `eval`. `cdn.jsdelivr.net` and `storage.googleapis.com` were added to `connect-src`, and `blob:` to `worker-src`.
3. **Android:** `CAMERA` was already in `native/android/AndroidManifest.additions.xml`; `camera.front` was added, optional. The live camera works through the WebView, and Capacitor asks for the permission the first time.
4. **Optional photo fallback:** `npm install @capacitor/camera@^8`. build-native bundles it when present.

## Tests

`node --test test/master/vision.test.mjs` (10 tests):
- synthetic alert and drowsy faces;
- the adaptive "shut" line;
- a face that isn't seen;
- the photo rules;
- MediaPipe result parsing (blendshapes, the EAR fallback, head pose);
- the agent with the real Ride agent and Master:
  - nothing while moving;
  - an offer only after 15 s stopped;
  - card → check → desi warning;
  - the card closing and the check aborting on movement;
  - "nahi" ending it;
  - no offer without GPS;
  - the 45-min gap;
  - a manual check refused while moving;
  - a retry after a poor scan;
  - camera denied;
- the face-scan provider with a fake camera and model.

It was also run in Chromium with a fake camera stream and a stand-in model, because MediaPipe itself couldn't be downloaded in the build sandbox. Before relying on the real model, check it on a phone (see "Before you ride with it").

## Before you ride with it

- Run one real check with the downloaded model on a phone: look normal for 10 s, then close your eyes for 2 s. The second one should come out **high**.
- Blendshape values vary by phone and lighting. If an alert face scores moderate, raise `THRESHOLDS.closedAbove` in `fatigue.js` a little.
