# The Master AI avatar (`public/js/ai/`)

The Master AI's face: a holographic bust of light dust (`ai-particle-core.js`) on the map screen.

- **Corner view (default).** A small floating window on the left of the map, under the search bar.
  - During a drive it sits under the turn banner and above the speed dial.
  - Drag it to the other side or up and down; it remembers where you put it.
  - Tap it, or the **Master AI** button in the map tools, to open the full screen.
- **Full screen.** The map is hidden and the face and body take the whole screen, with the particle mountain range behind (`avatar-ridges.js`). It shows:
  - the line being said, in English like the status island;
  - a **Talk** button (the app's push-to-talk);
  - during a drive, the speed and the next turn.

  **Map**, the phone's back button or Esc go back. **On map** turns the corner view off; the map-tools button still opens the full screen.

The app's status island, toasts and the SOS button stay above the full screen, so warnings are never hidden.

## What the face shows, and when

`avatar-state.js` decides; `avatar-app.js` only listens. Each row lists the face's mode and what puts it there:

| Mode | When |
|---|---|
| `alert` (red shift, shockwaves) | The Master delivered a **critical** report (held 6 s) or a **warning** (2.5 s). Delivered means the `master.decision` action is spoken, shown, held or asking, not dropped. It's also alert while a line of priority ≥ 85 is spoken (speed danger, SOS). |
| `speaking` | `VoiceAssistant` is playing a line (`mu:voice-state`). The brain throbs to a speech rhythm. Neither the native voice nor speechSynthesis reports loudness, so this is a visual rhythm, not a measurement. |
| `listening` | The mic is open for an answer ("Bhai, ek baat bolun?") or a push-to-talk command (`mu:mic-state`). The ride-long hands-free listening isn't shown, or the face would listen all ride. |
| `thinking` | A delegated task is running (`master.delegated` → `master.task-done`: Deep Search, nearest place, emergency…), for at most 20 s. Also while the premium voice is still downloading for the line about to be spoken. |
| `idle` | Otherwise. |

A shockwave **pulse** fires once per delivered hazard. The same hazard kind doesn't pulse again within 20 s, so a radar re-confirming it every second doesn't strobe. The core also pulses on its own when it enters `thinking` or `alert`.

## Files

| File | What it does |
|---|---|
| `ai-particle-core.js` | The architect's Three.js particle core, **unchanged**: bust, brain core, aura, veins, halo rings, the five modes, `pulse()`, `setLevel()`, `addLayer()`. |
| `avatar-state.js` | Pure (UMD, `// @ts-check`, in `npm run master:typecheck`). Events in → mode, pulses, the next timed change; `speechLevel()`. |
| `avatar-ridges.js` | The mountain range behind the bust, as a core layer. Seeded, procedural, no textures. It reacts to the voice level, the beat and alert, fades in on full screen only, and hides behind the bust's silhouette. |
| `avatar-app.js` | The ES module that wires it all up: creates the core (16 000 particles on phones, 30 000 on bigger screens, as in the demo), the corner view and full screen, dragging, the caption, the drive strip, and the listeners. `MUAvatar.live` in the console. |
| `avatar.css` | Everything under `#mu-avatar`. |

**Three.js:** the import map in `index.html`'s `<head>` points to `three@0.169.0` on jsDelivr, as the architect's demo does.
- The service worker precaches `three.module.js`, so the face works offline after the first visit.
- `server.js` allows the inline import map in the CSP by its exact SHA-256, computed from `index.html` at start-up (`lib/csp-inline.js`).
- Without WebGL the face simply doesn't appear, and its button is hidden.

**Hooks added elsewhere (additive):**
- `js/voice.js`: `VoiceAssistant.emitState()` sends `mu:voice-state` (`{ phase: "start", priority, route }` / `{ phase: "end" }`) and `mu:mic-state` (`{ on, mode }`).
- `js/master/brain.js`: `delegate()` closes every task with `master.task-done` (`{ task, ok, ms }`).

**Settings:** stored on the phone only, in localStorage `mu.avatar.v1` (corner view on/off, side, height).

## Console

```js
MUAvatar.live.open(); MUAvatar.live.close()
MUAvatar.live.core.setMode("thinking"); MUAvatar.live.core.pulse(1)
MUAvatar.live.state.snapshot()
MUMaster.live.debug.simulate("blackspot.ahead", { severity: "critical", data: { distanceM: 400 } })   // → alert + pulse
```

`/ai-master-demo.html` is the architect's test page: mode buttons, pulse, and loading a `.glb`. Try `?model=./models/test-bust.glb`.

## Tests

`node --test test/ai/*.test.mjs` (part of `npm test`) covers:
- the state rules, run against the real brain;
- the import map coming before every module script;
- script order and ids;
- the Maps tag left as it was;
- the CSP hash;
- the offline precache.
