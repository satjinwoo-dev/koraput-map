# Rider Passport, place sharing, and the share menu (`public/js/passport/`)

| File | What it does |
|---|---|
| `share-out.js` | `MUShareOut.text / image`: the phone's own share menu. In the Android app it's the `MapUniteNative.share()` plugin method (Android's chooser: WhatsApp, Telegram, Instagram, … no app-specific API or key); in a browser, Web Share where it exists, else copy (text) or save (image). |
| `place-share.js` | Share a place: a sheet with the name, kind (fuel, repair, viewpoint, food, stay, hospital, other), an optional note, "Add coordinates" (off unless the place has no name) and a **preview of exactly what's sent**, then Share or Copy. Entry points: the **Share place** button in map place popups and the searched destination's popup, and a long-press on the map ("This spot", never during a drive). A shared link (`/?place=lat,lng&n=…&c=…&note=…`) opens in the app as a pin with the name and note. `MUPlaceShareCore` (compose, parseLink) is pure. |
| `passport-model.js` | `MUPassportModel`: pure. The three kinds of line (self-reported / recorded on this phone / confirmed by other riders), visibility, badges with their reasons, and what goes on the card. |
| `passport-app.js` | The Passport screen (Smart Drive Settings → Rider Passport) and its card image in four looks the rider picks: **Lens** (thin type in refractive liquid glass), **Gauge** (the headline figure, distance ridden when it's on the card, in a glass dial, the rest in glass pills), **Poster** (the rider's first name huge and condensed, a monospace ledger) from `js/share/card-liquid.js`, and **Bento** tiles (also the fallback). The rider can put their own photo behind Lens, Gauge and Poster: it's kept in memory for the preview only, never stored, and redrawn onto the card so no EXIF/GPS leaves the phone. The chosen look is remembered, plus the per-ride tally of road reports from the post-ride review (`mu:roadpulse-reviewed`). |
| `passport.css` | Styles. |

## What the Passport says, and where it comes from

- **Self-reported** (the rider types it): riding since, usual bike, a line about themselves. Always labelled "self-reported".
- **Recorded on this phone**: distance, rides, riding time and towns from the ride log (rides under 200 m never count); places shared; road reports **detected by the phone / reviewed by the rider / published**, one tally per reviewed ride (reviewing a ride again replaces its tally, never adds to it).
- **Confirmed by other riders**: only from the RoadPulse server (`/roadsense/me`), whose rule is independent evidence: another contributor **and** another device, 2 h or more later, one report per hazard and epoch. The rider's own approval never confirms a report; thank-yous are shown as helpfulness and never count as evidence. With Community road reports off, this section says nothing is claimed.

## Badges

For the quality of contributions, never distance, speed or count alone. Each shows why it was earned or what's missing.

| Badge | Rule | Source |
|---|---|---|
| Road Scout (Rasta Scout) | 5 reports confirmed by other riders, accuracy ≥ 70 % | server |
| Reliable Reporter (Pakka Scout) | 25 confirmed, ≥ 80 %, over 3+ months | server |
| Road Guardian (Sadak Prahari) | 100 confirmed, ≥ 85 %, 20 answers borne out later | server |
| Local Route Expert (Ilaake ka Ustaad) | 20 confirmed in one ~25 km area over 3+ months | server |
| Route Helper | 10 thank-yous **and** at least 3 confirmed reports | computed here from server numbers |
| Local Guide | shared places confirmed by other riders | **not awarded**: nothing collects place confirmations yet |

Thresholds are design priors (`BADGES` in `passport-model.js`, `RULES` in `lib/master/roadpulse-reputation.js`), to be tuned in the pilot.

## Privacy

- Everything is kept on the phone (`localStorage` `mu.passport.v1`). MapUnite has no public profile page.
- Each line is **Only me** or **On my card**. Towns and riding time start as Only me.
- The card image leaves the phone only when the rider shares it.
- Place shares carry a place, never the rider's live location, and MapUnite doesn't send them anywhere itself.

## Ride Recap Studio

The post-ride share sheet (`js/share/`) is the recap: Lens (refractive liquid glass), Gauge, Poster, Bento, Glass, Verse and Minimal styles; a photo picked on the phone, redrawn onto the card (so the exported PNG has no EXIF or GPS); a caption; "Hide where I started and finished" (on), "Show the town name" (off), "Show the cost"; the road reports reviewed and published after that ride (counts only, never "confirmed"). Top speed is never drawn. Nothing is posted until the rider taps Share or Save.

## Tests

`node --test test/passport/` covers the line sources, independent confirmation only, the badges and their reasons, the card's visibility, the card looks (headline and rows only from the lines marked On my card, the poster word), the place message (coordinates only when needed, link fallback), link parsing, and the wiring (native share, preview, no long-press sharing while driving, no uploads, no top speed). The recap templates are tested in `test/share/`.
