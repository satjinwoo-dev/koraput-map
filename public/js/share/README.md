# Post-ride share card (`public/js/share/`)

When a SmartDrive trip finishes, a share sheet opens with a card the rider can post: the route shape, the eco score, distance, mileage, cost, moving time and, when it's real, what they saved compared with their usual riding. The card is drawn on a `<canvas>` on the phone. Nothing is uploaded and no map tiles are used, so the image never includes anyone's street map.

**When it opens:** on `mu:ride-summary` (sent by the HUD), 900 ms after the trip ends, for rides of 1 km or more, unless the rider turned off "Show this after every ride". `#share-ride-btn` in the results panel opens it again later.

| File | What it does |
|---|---|
| `card-model.js` | `MUShare.model`: pure. `buildCard(summary, { privacy })` turns the ride summary into the card's data (SI). Also `trimEnds`, `simplify` (Douglas–Peucker), `project`, `ecoWord`, `rideTitle`, `usualFromLearner`. |
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
- Otherwise the banner shows smoothness (harsh moments) or speeds. It never makes up a saving.

## Export

- **Share:** Web Share with a PNG file, where the browser supports sharing files (Android Chrome, iOS Safari). The button is hidden where it doesn't work.
- **Save image:** downloads a PNG named after the ride, e.g. `mapunite-evening-ride-2026-10-04.png`.
- **Copy:** `ClipboardItem` PNG, where available.

Fonts: before drawing, the card waits up to 1.2 s for Sora and Inter (`document.fonts.load`), so the exported image uses the brand typefaces. If they haven't loaded by then, it uses system fonts.

## Tests

`node --test test/share/` (8 tests): trimming, simplification, projection, the gating rules for "saved", the stats and banner texts (including mL for small savings), and the layouts not overlapping (including the eco word against the banner).
