# Ride Story (`public/js/story/`)

The whole ride as a moving dashboard: where it started and ended, who rode and who sat behind, the bike and its weight, the tank before and after, fuel and money, where the petrol went (air, tyres, climbing, speeding up, idling), the weather and the wind, riding behaviour, where the ride burnt more or less or was eco, potholes and rough road, hard braking, stops, rest and non-stop riding.

| File | What it does |
|---|---|
| `journal.js` | `MUStory.journal.createJournal(physics, model)`: runs next to the HUD's live estimator (`js/hud/live.js`) during a ride and keeps the shape of the ride. It records ~250 m stretches (fuel, the best the bike could do there, climb, time above the eco band, idling), stops, hard moments with their place and speed, the work at the wheel split into air, rolling, climbing and accelerating, weather samples and the route. It is pure, uses strict SI, and is tested. |
| `story-core.js` | `MUStory.core.build(journal, ctx)`: everything the screen shows, worked out from the journal plus the HUD's totals. It covers time, fuel, the parts, drag and wind, weather, highlights with reasons, behaviour, people and bike, and road. It is pure and tested. |
| `story-app.js` | `RideStory.open(startedAt)`: the screen. It saves the last 12 journals (`localStorage` `mu.story.v1`) and rebuilds the story each time it opens. |
| `story.css` | Styles for the screen. |

## The screen

The screen has five chapters: **Ride · Fuel · Rider · Road · Time**.

- **Card animations.** Cards slide in with a blur as they scroll into view. Numbers count up, the route draws itself coloured by how thirsty each stretch was, the speed / fuel / height chart draws in (drag to read any point), donuts sweep, the eco gauge's knob swings, the tank drains, wind streams past the rider, and the timeline fills.
- **The dock.** A glass dock at the bottom has a sliding, glowing blob that jumps between chapters.
- **▶ Play.** Plays the chapters by itself.
- **Where it opens:**
  - the ride recap: **📊 Full ride story**;
  - **My rides** → a ride → **📊 Ride story**;
  - the **Ride story** button by *Share ride*.
- **Deleting.** Deleting a ride, or *Delete my history* → rides, deletes its story too.

## Where each number comes from

| Shown | Source |
|---|---|
| Fuel, cost, eco score, hard braking / pick-ups | The HUD's estimator: the physics model × the learned correction from your fill-ups. The stretches add up to the same fuel. |
| Hard braking / pick-up | Below −3.5 m/s² or above 2.5 m/s², held for 1 s. The estimator decides this; the journal adds where it happened and from what speed. |
| Where the petrol went (≈) | Road-load physics with the bike's own CdA and Crr and the real masses. Each force's share of the work at the wheel is applied to the fuel burnt while moving; idling is counted on its own. The screen says this is an estimate. |
| Wind | Open-Meteo wind at 10 m. It is brought down to rider height with the log-law (z₀ = 0.1 m → × 0.5) and resolved along your heading. The fuel it cost or saved is the difference in air drag against still air. |
| Weather | Open-Meteo (keyless), fetched every 10 minutes while riding. When offline there is none, and the screen says so. |
| Burnt the most / most eco / lightest | A stretch's eco score is the best fuel the bike could use there (its eco band on that grade) ÷ what it used. Eco is ≥ 0.8 and thirsty is < 0.55. The reasons (uphill, faster than the eco speed, hard pick-ups, idling, slow traffic, downhill, steady) come from that stretch's own numbers. |
| Behaviour | Fixed rules on the eco score, hard moments per 100 km, time above the eco band and time over the posted limit. |
| Stops | Halts of 10 s or more. A halt under 2 minutes is traffic; 2 minutes or more is a break. "Longest non-stop riding" runs between breaks. |
| Potholes, speed breakers, rough road | This phone's road sensor for this ride (`mu.master.dynamics.review.ride`, the Android app's DynamicsCore). Without it the card says the sensor was off and never shows a made-up zero. |
| Rider / pillion weights | From My bike. When none is entered, the class's typical rider (72 kg) is used and labelled *typical*. When the phone is paired as the rider (`js/pin/pillion.js`) or the trip card says *Pillion*, the HUD now adds the pillion to the physics as well. |
| Tank | The level at the start (the pitstop plan / your last full fill-up) minus the fuel burnt. |
| Start / finish names | Looked up once when the story opens online (`fetchCity`, the same lookup the app already uses). |

Nothing here leaves the phone.
