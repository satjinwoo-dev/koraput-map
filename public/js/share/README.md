# Post-ride share card: Ride Recap Studio (`public/js/share/`)

When a SmartDrive trip finishes, a share sheet opens with a card the rider can post. It has four styles, drawn by `card-styles.js` (Minimal by `card-render.js`):

- **Bento** (default): an Apple-style bento grid on near-black. A big route tile, then tiles for distance (a huge gradient figure), moving time, an activity-ring eco score, mileage and cost, and the road reports.
- **Glass**: Liquid Glass. Frosted panels (the background blurred inside them, a veil, a hairline, a specular edge) over the rider's photo, or over a vivid mesh gradient with the route as a light trail.
- **Verse**: a comic look. A black band with a lowercase monospace line, then the photo (or the route) posterised, colour-split, halftone-dotted and glitch-sliced, with comic stickers for the figures. The glitches are seeded by the ride's start time, so the same ride always gives the same card.
- **Minimal**: true black, one route line, the distance large.

It also has a caption, and the road reports the rider reviewed or published after that ride (see `js/passport/README.md`). The Classic card shows the route shape, the eco score, distance, mileage, cost, moving time and, when it's real, what they saved compared with their usual riding. The card is drawn on a `<canvas>` on the phone. Nothing is uploaded and no map tiles are used, so the image never includes anyone's street map.

**When it opens:** on `mu:ride-summary` (sent by the HUD), 900 ms after the trip ends, for rides of 1 km or more, unless the rider turned off "Show this after every ride". `#share-ride-btn` in the results panel opens it again later.

| File | What it does |
|---|---|
| `card-model.js` | `MUShare.model`: pure. `buildCard(summary, { privacy })` turns the ride summary into the card's data (SI). Also `trimEnds`, `simplify` (Douglas–Peucker), `project`, `ecoWord`, `rideTitle`, `usualFromLearner`. |
| `basemap.js` | `MUShare.basemap`: the real map behind the route (CARTO tiles, the Dark style's provider), drawn into the card with the route on its own roads (Web Mercator). `mercator`, `fitZoom`, `scaled` and `tilesFor` are pure and tested. |
| `card-styles.js` | `MUShare.styles`: the Bento, Glass and Verse styles. `bentoLayout`, `rng`, `posterize` and `splitChannels` are pure and tested. |
| `card-render.js` | `MUShare.render`: draws the card. `SIZES` (story 1080×1920, post 1080×1350), `layout`, `fitRoute`, `stats` and `bannerText` are pure; `drawCard(canvas, card, opts)` paints. |
| `share-ui.js` | `MUShare.ui`: the sheet: preview, Story / Post switch, three toggles, Share / Save image / Copy. Preferences in `localStorage` `mu.share.v1`. |
| `share-app.js` | `MUShare.app`: wiring. Lazy-loads the files above and `share.css` on the first ride summary, and adds the rider's usual consumption from the fuel learner. |
| `share.css` | Styles for the sheet, scoped under `.sh`. |

## What the card claims, and when

- **Route:** the GPS track, simplified to ≤ 420 points, north up, with a scale bar. With **Hide where I started and finished** (on by default), the first and last 400 m are cut off. A track too short to trim safely isn't drawn at all, rather than drawn with the ends showing.
- **Mileage / energy use:** the trip's figure from the live estimator. If the rider's fill-ups have corrected it, the footnote says "matched to my fill-ups". It says this only when the correction came from the fuel learner.
- **"Saved … vs my usual":** shown only when all of these hold:
  - the bike isn't an EV;
  - the learner has usable full tanks;
  - the ride is at least 2 km;
  - the ride used at least 3 % less fuel per km than the rider's average over those tanks.

  The comparison is with the rider's own tanks, never with a brochure figure. Small amounts are shown in mL rather than as "0.00 L".
- **Cost** follows **Show the cost**. With it off, the banner states litres saved instead of money.
- Otherwise the banner shows smoothness (harsh moments) or the average speed. It never makes up a saving, and **top speed is never shown**.
- **The town** is named only when the rider turns on **Show the town name** (off by default).
- **The photo** is drawn onto the canvas, so the exported PNG carries none of its EXIF (no GPS location).

## Map, start and finish, motion

- **Map behind the route** (on by default): Bento shows the Dark map in its route tile; Glass and Verse use the lighter Voyager map as their background when there's no photo. Only the area of the line the card draws is shown, so with the start and finish hidden, the streets around them aren't on the card. Tiles load with CORS, so the image can always be shared or saved; offline, the service worker's tile cache answers, and without tiles the card falls back to its dotted grid. The attribution is drawn on the card.
- **Start and finish**: with "Hide where I started and finished" on, two sliders set how much of each end is hidden (0–3 km in 100 m steps, 400 m by default). 0 shows the exact point; that's the rider's choice.
- **Motion**: **Play motion** previews about 4 s on the card: the line draws itself, the figures count up, the tiles slide in, and Verse's stickers pop in. **Save motion video** records it (MP4 where the phone's recorder supports it, else WebM) and shares or saves it like the image.

## Export

- **Share:** the phone's share menu (`js/passport/share-out.js`): Android's chooser inside the app, Web Share with a PNG file in a browser that supports it. The button is hidden where neither works.
- **Save image:** downloads a PNG named after the ride, e.g. `mapunite-evening-ride-2026-10-04.png`.
- **Copy:** `ClipboardItem` PNG, where available.

Fonts: before drawing, the card waits up to 1.2 s for Sora and Inter (`document.fonts.load`), so the exported image uses the brand typefaces. If they haven't loaded by then, it uses system fonts.

## Tests

`node --test test/share/` (8 tests): trimming, simplification, projection, the gating rules for "saved", the stats and banner texts (including mL for small savings), and the layouts not overlapping (including the eco word against the banner).
