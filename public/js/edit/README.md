# Ride Edit: the editing agent "Summit Cut" (`public/js/edit/`)

The rider gives it photos and videos from a ride. It listens to the music, watches the clips, cuts a reel on the beat with a story arc, checks its own work, and takes feedback ("faster", "less effects", "drop this shot"). The planning and drawing happen on the phone, and the phone uploads no photo, frame or sound.

**Where:** the ride recap (after a ride, or "Share ride") → **🎬 Edit a video with my clips**.

## How the work is split

The Summit Cut system prompt (`lib/master/prompts/summit-cut.md`) only plans an edit. The analysis and rendering need tools, and here each tool runs on the phone with no paid service:

| The prompt needs | Usual desktop tool | Here (on the phone) |
|---|---|---|
| Beat, downbeat and drop times | librosa / madmom | `beats.js`: spectral flux in 24 log bands, a comb search for tempo and phase (70–180 BPM), downbeats from low-band energy, drops from 1 s energy |
| The person cut out | SAM 2 / RobustVideoMatting | `segment.js`: MediaPipe selfie segmenter (tasks-vision 0.10.21, GPU then CPU) |
| Moving photos (2.5D) | Depth Anything | A clean plate (the photo with the person filled from a blur of the area around them) moves behind the cut-out person |
| Smooth slow motion | RIFE | Real frames only: slow motion is used only on clips shot at ≥ 50 fps (60 fps → 0.5×, 120 fps → 0.25×), so no frame is duplicated |
| Rendering the timeline | FFmpeg / MoviePy | `edit-engine.js`: Canvas 2D + MediaRecorder (MP4 where the phone can, else WebM) |

## Files

| File | What it does |
|---|---|
| `beats.js` | `MUEditBeats.analyze(pcm, sampleRate)` → bpm, beats, downbeats, drops, energy. `synthetic(bpm, duration)` makes a grid for the app's own track. |
| `summit.js` | The agent's decisions, pure and tested. `plan(input)` makes the Edit Decision List in the JSON of the prompt's §12. `qc(edl)` runs the §13 self-check, `repair(edl, input)` fixes an EDL from the AI director against the real beats and clips, `feedback(brief, ask)` applies the §14 changes, and `frameAt(edl, t)` says what to draw at a time. |
| `segment.js` | The person model: `load()`, `mask(src)`, `cutout(src, mask)` (a feathered edge). |
| `edit-engine.js` | Watching and drawing. `analyze(file)` measures each clip: its real frame rate, light, colour, sharpness, motion, share of sky and red earth, black bars, and the person (mask, cut-out and clean plate). `createPlayer` draws the EDL with its grade, effects, transitions and words. `play()` previews and `record()` makes the video in real time. |
| `edit-app.js` | The screen: media, Look / Length / Format / Music / Director chips, a "find the person" switch, the agent's steps, the QC result, feedback chips, a timeline strip (tap a shot to drop or pin it), Save / Share / EDL JSON. Choices are stored in `localStorage` `mu.edit.v2`. |
| `edit.css` | Styles. |

The person model files come from `node scripts/fetch-mediapipe.mjs`, which puts them in `public/vendor/mediapipe/` (about 20 MB; gitignored). Without them the page uses the CDN copy of the same version when online, and without the model the effects that need a cut-out are skipped.

## The three presets (from the reference reels)

| Preset | Tempo | What it does |
|---|---|---|
| **A · Cinematic Summit** | 124 BPM | A teal-and-orange grade. A held hook, then a build on beats and half-beats. Speed ramps on high-fps clips, whip pans, a white flash at the peak, one monochrome shot, a lens flare, and text behind the rider. |
| **B · Monochrome Ritual** | 100 BPM | Black and white with grain. A jump-cut ritual hook, frames that shrink, rotate and vanish to black, a fade to white, and negative flashes. |
| **C · Kinetic Glitch Story** | 128 BPM | Punchy colour. The rider's words build word by word (white sans with a red serif keyword). Glitch strips with RGB split, box panels, ghost silhouettes and clones of the rider. |

When the rider leaves the look on Auto, the agent picks: B for low-colour footage, A for sky and summit footage with motion, otherwise C. It says why.

## The rules it keeps (prompt §4–§13)
- Every cut lands on a beat or half-beat, and the edit ends on a bar.
- The sections are hook (first ~12 %), build, peak (~80 %), resolve. The hero shot is held ≥ 2 s.
- The pace follows the footage (distinct moments) times the rider's "faster / slower".
- No effect goes over its maximum count (`MAX` in `summit.js`).
- Only real ride figures appear (distance, top speed, place). A sign-off line is drawn over the closing fade.
- QC reports the share of cuts on the beat, effect counts, the hero hold and the end. A failing EDL is repaired before it plays.

## AI director (optional)
**Director: AI** sends only the numbers (clip measurements and beat times, never media) to `POST /api/master/edit-direct` (`lib/master/edit-director.js`). The server uses the Summit Cut prompt verbatim as the system prompt, plus a note on what this renderer can do, and asks the free reasoning engines (Gemini → Groq → local Ollama). The phone repairs the answer and falls back to its own plan when no engine is configured or the answer is unusable.

## Tested
- `test/edit/beats.test.mjs`: tempo, phase, downbeats and drops on synthetic songs.
- `test/edit/summit.test.mjs`: each preset passes the self-check in the §12 schema; the hook and the hero; cuts speed up at the peak; slow motion only on high-fps clips; B's jump cuts and collapsing frame; C's words on the beat in the safe zone; no person model; too little footage; the rider's own song; repair of a messy EDL; feedback; frameAt.
- `test/master/edit-director.test.mjs`: input cleaning, JSON parsing, the prompt reaching the engine.

A browser check rendered all three presets from real clips with the person model, and recorded them.
