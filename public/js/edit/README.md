# Ride Edit: the editing agent (`public/js/edit/`)

The rider gives it photos and videos from a ride. It watches them, picks the best moments, and cuts a reel to a beat, with the ride in it. Everything happens on the phone: nothing is uploaded.

**Where:** the ride recap (after a ride, or "Share ride") → **🎬 Edit a video with my clips**. The recap's own card goes in, so the start and finish stay hidden as the rider chose, and only real figures appear.

| File | What it does |
|---|---|
| `edit-core.js` | The agent's decisions, pure and tested. `pickMoments` (the best windows in each clip and each photo), `chooseStyle` (and why), `storyLines` (the ride's title and real figures: distance, moving time, eco score; nothing made up), `plan` (the timeline on a beat grid), `frameAt` (what to draw at a time). |
| `edit-engine.js` | Watching and drawing. `analyze(file)` measures a clip about twice a second (light, colour, sharpness, motion). `createPlayer` draws the plan with its look and makes the music, then `play()` previews and `record()` makes the video in real time. The video is H.264 MP4 where the phone can, else WebM. |
| `edit-app.js` | The screen: add media, look, length, format, music, words, the agent's steps, preview, Save / Share / Another take. Choices in `localStorage` `mu.edit.v1`. |
| `edit.css` | Styles. |

## The three looks (from the reference reels)

| Look | Tempo | What it does |
|---|---|---|
| **Cinematic** | 124 BPM | Teal-and-orange grade and a vignette. A held opening, then cuts on every beat. White and negative flash frames, one hero shot in a camera viewfinder (REC, timecode, crosshair), and slow motion on the best moving shot. |
| **Mono** | 100 BPM | Black and white with grain and letterbox bars. Long held shots that shrink into a small window and vanish, bursts of quarter-beat cuts, and negative flashes. |
| **Kinetic** | 128 BPM | Punchy colour. Big words land one per beat, in red bold and white italic (the rider's own words, or a line of the agent's). Glitch strips and split panels. |

**Agent's pick:** Mono when the shots are low in colour; Cinematic when there are many moving clips; otherwise Kinetic. It says why.

## What every edit has
- an opening title (the ride's name and date);
- the ride's figures counting up;
- the route drawing itself, with the distance;
- an end card.

**Music:** the agent's own beat (kick, hats and bass, made in the browser, so there's no licensed track), the rider's own song, or none.

**Another take:** a new seed, so the same clips get different cuts.

## Tested
`test/edit/edit-core.test.mjs` covers:
- the best moments come first;
- the look and its reason;
- figures appear only when the ride has them;
- every look stays on its beat grid, at about the asked length, with title, figures, route and end;
- the frames themselves: zoom, flash, shrink, words, slow motion.

The browser check rendered all three looks from real clips and recorded them.
