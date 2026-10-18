# Navigation camera (`public/js/navcam/`)

When a drive starts, the map switches to a car-navigator view, like Google Maps' navigation:
- **Heading-up:** the map turns so the direction of travel always points up the screen.
- **3D tilt, close in, map to the top edge:** the map is tilted up to 50° so the road ahead recedes into the distance, and it always fills the screen to its top edge, under the glass turn banner: no horizon, no dark sky. On a tall screen the tilt is lowered (not below 30°) so the map reaching 1500 map-px ahead still fills it (`fitPitch()` in `navcam-core.js`); drawing further would cost tiles fast. The zoom is 18 up to 30 km/h, 17 up to 60 km/h, and 16 above that.
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
- **No horizon:** the map reaches the screen's top edge (the tilt is fitted to it), so the top of the screen is road, not a dark band. A sky band is kept only as a fallback if even a 30° tilt couldn't fill the screen; the map's own background is ground-coloured, not black.

## Motion: like a car navigator, every frame

GPS fixes come about once a second. Between them (`navmotion-core.js`, `navmotion.js`):
- **The arrow is held to the road.** A fix within 35 m of the route is on it; the arrow sits on the route line, not on the fix (GPS error isn't the rider leaving the road). Off the route, it follows the fixes.
- **It glides every frame** at the rider's speed: to where the last fix said, then on at the same speed for up to 2 s until the next fix, catching up smoothly (time constant 250 ms). It never slides back for GPS shimmer; a jump back of 40 m or more is real and taken. Without a speed from the phone, it uses the speed the fixes show along the road.
- **It points the way the road goes** (5 m behind to 15 m ahead, so a corner turns it smoothly), and lies flat on the map, tilted with it. Grey without GPS (dead reckoning).
- **The camera moves with it**, frame by frame (`NavCamera.frame`): a sub-pixel pan, no once-a-second glide, so arrow and map never drift apart.
- **The route ahead starts at the arrow:** what's behind it goes. A blue line on a darker casing. The map's own "you are here" dot, its accuracy ring and the history trail are hidden while the arrow shows the rider.
- **Near a turn** (12 s of riding, 150–400 m) the camera zooms in to 18, and a white arrow is drawn on the road through the turn (40 m before to 30 m after at zoom 18, longer further out); after it, back out.
- **A new instruction slides into the turn banner.**

| File | What it does |
|---|---|
| `navmotion-core.js` | The motion maths, pure and `// @ts-check`: the route index, the nearest point, the arrow's glide, zoom near a turn, the turn arrow. |
| `navmotion.js` | `NavMotion.start / fix / reroute / stop`: the arrow, the route cut at it, the camera and the turn arrow, every frame. |
| `navcam-core.js` | The maths, pure and `// @ts-check` (in `npm run ui:typecheck`): which way is ahead, turning smoothly, zoom by speed, the anchor and size, the transform. |
| `navcam.js` | `NavCamera.start / follow / frame / stop`, plus the compass, Re-centre and the sky band. `js/navigation.js` calls it. |
| `navcam.css` | Upright markers, the direction chevron on the rider's marker, the buttons. |

`NavCamera.state()` in the console shows the bearing, the course, the zoom and the geometry.

**Tests:** `node --test test/navcam/*.test.mjs` (part of `npm test`) covers:
- angles, choosing the course, smooth turning and zoom hysteresis;
- the route's direction round a corner;
- that the drawn square covers every visible screen point at any bearing;
- the wiring: script order, the offline precache, navigation's calls, and the Maps tag left untouched;
- the motion: held to the road, gliding between fixes, never back for shimmer, off-route glide, no-speed phones, the corner, zoom near a turn, the turn arrow (`navmotion-core.test.mjs`).
