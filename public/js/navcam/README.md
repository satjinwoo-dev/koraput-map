# Navigation camera (`public/js/navcam/`)

When a drive starts, the map switches to a car-navigator view, like Google Maps' navigation:
- **Heading-up:** the map turns so the direction of travel always points up the screen.
- **3D tilt, close in:** the map is tilted 50° so the road ahead recedes into the distance. The zoom is 18 up to 30 km/h, 17 up to 60 km/h, and 16 above that.
- **Rider in the lower third:** you sit two-thirds of the way down the *visible* map, between the turn banner and the speed dial, so most of the screen shows what's coming. On this app's drive layout that's the visible area; the bottom third of the whole screen would be under the drive panel.

## Controls

- **Compass** (top right): switches between heading-up 3D and north-up 2D. The choice is remembered on the phone (`localStorage` `mu.navcam.v1`).
- **Touching the map** hands it back to you: it goes flat and north-up at once, so a drag moves the map under your finger.
- **Re-centre** (above the speed dial) brings the camera back.

## How it works

Leaflet only draws flat, north-up maps, so no plugin is used. While the camera is on:
1. `#map` becomes a square around the rider's spot on screen, big enough that the turned, tilted map always covers the screen. Leaflet loads tiles for all of it.
2. The square is turned by one CSS transform about that spot: `perspective(P) rotateX(pitch) rotateZ(-bearing)`.
3. Markers' content is turned back and stretched by 1/cos(pitch), so avatars and labels stand upright.
4. Tooltips and popups are hidden while the camera is on, because they would lie sideways.

**Which way is "ahead":**
- The GPS course, while moving at 2.5 m/s or more.
- Otherwise, the route's direction 30 m ahead of where you are on it.
- Otherwise, your last 8 m of movement.
- The map turns toward that direction smoothly: a 0.6 s time constant, at most 90°/s, and changes under 2° are ignored.

**No black horizon:** a tilted map needs many more tiles than a flat one, and a phone fetches only a few at a time, nearest first, so the far road at the top of the screen used to show the dark background until its tiles arrived. Now:
- **Underlay:** a low-resolution copy of the base map (zoom 15, scaled up) sits under the sharp tiles. 1–4 tiles cover the whole tilted view at once, so a gap is a slightly blurry patch for a moment, never black. In Chromium with sharp tiles slowed to 2.5–4 s, the map area was 0 % background 1.2 s after Start.
- **Heading-fitted drawn area:** `#map` is only what the camera sees for the current heading, re-measured when the heading leaves its 15° band (`box()` in `navcam-core.js`). On a 390 × 844 phone that's 42 % of the old every-heading square heading N/S/E/W and 57 % on average; a drive loaded about half the sharp tiles. Its centre is ahead of the rider, so Leaflet loads the road ahead first.
- **Wider tile ring:** the sharp layer keeps `keepBuffer` 4 while the camera is on, so turning doesn't throw away what's loaded. Both changes are undone on Stop.
- **Beyond the horizon:** a sky band fades the far edge, and the map's own background is ground-coloured, not black.

| File | What it does |
|---|---|
| `navcam-core.js` | The maths, pure and `// @ts-check` (in `npm run ui:typecheck`): which way is ahead, turning smoothly, zoom by speed, the anchor and size, the transform. |
| `navcam.js` | `NavCamera.start / follow / stop`, plus the compass, Re-centre and the sky band. `js/navigation.js` calls it. |
| `navcam.css` | Upright markers, the direction chevron on the rider's marker, the buttons. |

`NavCamera.state()` in the console shows the bearing, the course, the zoom and the geometry.

**Tests:** `node --test test/navcam/*.test.mjs` (part of `npm test`) covers:
- angles, choosing the course, smooth turning and zoom hysteresis;
- the route's direction round a corner;
- that the drawn square covers every visible screen point at any bearing;
- the wiring: script order, the offline precache, navigation's calls, and the Maps tag left untouched.
