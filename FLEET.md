# Fleet calibration — "learning in the cloud" (roadmap Step 11)

Riders who opt in share their full-to-full tanks anonymously. The server fits, per vehicle class, how the physics priors should move so the physics predicts those tanks. A curator reviews the result as an ordinary data diff, and the next catalogue build ships it in the bundles. Nothing changes riders' numbers without that reviewed diff.

This page is the contract for the app (sending tanks) and for the Fuel Learner dashboard (showing fits). The parts:

| Part | File |
|---|---|
| Tank store (server DB), validation, privacy | `lib/bikedb/fleet.js` |
| The fit (MAP, Student-t, rider cap, Laplace, rider cross-validation) | `lib/bikedb/calibration.js` |
| HTTP routes | `lib/bikedb/http-api.js` (`/api/bikes/fillups`, `/api/bikes/calibration`) |
| Fit + write proposals (operator) | `scripts/bikedb/calibrate.mjs` (`npm run bikes:calibrate`) |
| Proposal file format, apply in the build | `scripts/bikedb/calibration-file.mjs`, `data/bikes/calibration/<class-key>.json` |
| Phone: records to send | `FuelCurve.fleetTanks()` in `public/js/smartdrive.js` |
| Phone: using a shipped calibration | `buildFuelBaseline(…, { calibration })` in `public/js/garage/fuel-baseline.js` |
| Tests | `test/fleet/*.test.mjs` (synthetic fleets with known true parameters) |

## 1. What a phone sends, and what it never sends

One record per full-to-full tank interval that SmartDrive's fill-up learner already uses:

```jsonc
{
  "bundle": "9f2c1a0b7d3e4f51",     // the bundle hash the phone used (16 hex)
  "bike": "royal-enfield-hunter-350-metro-in", // the bike's id; a typical bike sends "classKey" instead
  "fuelCode": "E20",
  "massKg": 80,                      // rider + pillion + luggage, rounded to 5 kg
  "litres": 9.84,                    // pumped, scaled by the share of the odometer distance the app recorded
  "km": 312.4,                       // recorded distance
  "idleH": 1.25,                     // engine-on hours at standstill
  "hist": [0.8, 2.1, …]              // 40 numbers: km in each 5 km/h speed bin, 0–200 km/h (sum ≈ km)
}
```

- **Never sent or stored:** location, routes, ride times or dates, odometer readings, device ids, names or IP addresses.
- **Who sent it:** the only link between one rider's tanks is a random token the app makes for this purpose only (32–64 lowercase hex). It can be reset. The server stores an HMAC of it under `SERVER_SECRET`, never the token itself.
- **What the token is for:** capping one rider's weight in a fit (10 tanks), and deleting everything on request.
- **Retention:** the server keeps the day a record arrived, nothing finer. Records are purged after 730 days.

`FuelCurve.fleetTanks()` builds the list. It only includes tanks the fleet model describes exactly:
- the current petrol bike, with both fills logged with it;
- stock gearing and tyre;
- every drive in the tank has its speed bins;
- odometer readings at both fills, with the recorded distance within ±15% of the odometer distance.

**The consent screen is the caller's.** Send only after the rider opted in, and send the consent string with every request.

On the phone, `MURides.app` (roadmap Step 10, `public/js/rides/`) does the sending:

- **`optIn()`:** call it after the consent screen. It makes the random token, then sends the tanks.
- **When tanks are sent:** after every ride, when the phone comes back online, and at start-up, at most every 10 minutes.
- **`optOut()`:** erases the shared tanks on the server and forgets the token. If the phone is offline, the erasure is retried until the server confirms it.
- **"Clear my history":** does the same as `optOut()`.
- **`status()` and `mine()`:** for the consent and "your contribution" screens.

## 2. HTTP routes

All routes are under `/api/bikes`. The Android origin `https://localhost` gets CORS, preflight included. Other origins get 403 on the writing routes. The writing routes need JSON (else 415) and accept a body of at most 64 KB (else 413).

| Route | Body | Answer |
|---|---|---|
| `POST /fillups` | `{"consent": "fleet-calibration-v1", "contributor": "<token>", "tanks": [1–20 records]}` | **202** `{"ok": true, "stored", "duplicates", "rejected": [{"index", "field", "message"}]}`. A resent tank counts as a duplicate, never twice. **400** `consent-required`, `invalid` (the field at fault), or every tank rejected. |
| `POST /fillups/mine` | `{"contributor": "<token>"}` | `{"ok": true, "classes": [{"classKey", "tanks"}]}`, `no-store`. This is the rider's "your contribution". |
| `DELETE /fillups` | `{"contributor": "<token>"}` | `{"ok": true, "deleted": n}`. Erases everything that token sent. |
| `GET /calibration` | — | `{"ok": true, "classes": [{"classKey", "tanks", "riders", "km", "fit": {"fittedDay", "catalogVersion", "proposed", "reason", "overhead", "cv", "tanks"} \| null}]}`. Cached 5 min. |
| `GET /calibration/<class-key>` | — | `{"ok": true, "classKey", "data": {"tanks", "riders", "km"}, "fit": <full fit, below> \| null, "shipped": <bundle.calibration> \| null}`. **400** bad key, **404** no data. |

- **Rate limits per IP:** fill-ups 30 per hour, calibration reads 120 per minute.
- **Without `SERVER_SECRET`:** the server always has one, from the env or generated into the DB. A server built without it answers **503** `fleet-unavailable`.

A tank is rejected (`rejected[].field`) for any of these:
- an unknown bike (`bundle`);
- an electric bike (`bundle`; EVs calibrate from charging data, not fill-ups);
- a class or id that contradicts the bundle (`classKey`, `bike`);
- an unknown fuel (`fuelCode`);
- a mass outside 40–400 kg;
- km outside 5–3000, or litres outside 0.2–60;
- an implausible km/L (outside 2–120);
- idle hours outside 0–48;
- speed bins that don't add up to the distance within ±10% (`hist`).

A bundle hash that an older catalogue build shipped is still accepted when `bike` (or `classKey`, for a typical bike) names a current bike. A shipped calibration changes every bundle hash in its class.

### The fit, as the dashboard receives it (`fit` above)

Every number is SI (m2, 1, Pa) except the tank evidence, which is in litres and km.

```jsonc
{
  "fittedDay": "2026-10-03", "catalogVersion": "4846c4f6e6f418b7",   // the curated catalogue it started from
  "classKey": "ice_manual.commuter", "classDefault": "default-ice-manual-commuter",
  "proposed": true, "reason": null,          // or why not: "needs 30 tanks (has 12)", "doesn't predict held-out riders better (…)", "… would leave its plausible range"
  "basedOn": { "bundle": "<hash>", "priors": { "cda": { "mean", "sigma", "u", "conf" }, … } },   // today's priors
  "priors":  { "cda": { "mean", "sigma", "u", "conf", "informed" }, "crr": …, "indicatedEfficiency": …, "fmepA": … },
  "overhead": { "mean": 1.17, "sigma": 0.16, "u": "1" },   // real riding vs steady flat-road physics
  "correlation": { "names": ["cda", "crr", "indicatedEfficiency", "fmepA", "overhead"], "matrix": [[…]] },
  "evidence": { "tanks", "riders", "km", "litres" },
  "noise": 0.062,                            // robust scale of log(litres) residuals
  "cv": { "folds": 5, "prior": 0.22, "posterior": 0.048 },     // held-out riders' mean |error|, rider-balanced
  "inSample": { "prior", "posterior" },
  "bands": [ { "band": "under 40", "share": 0.40, "biasPrior": -0.21, "biasPosterior": 0.0002 }, … ],  // by speed band, km-weighted
  "iterations": 12
}
```

What the dashboard can show:
- **Prior → posterior with ±σ:** `basedOn.priors` → `priors`. `informed` (0–1) is the share of the prior's uncertainty the fleet removed.
- **Real-riding overhead:** `overhead`.
- **Model quality:** `cv.prior` → `cv.posterior` (the gate needs an improvement of at least 1 point).
- **Bias by speed band:** `bands[].biasPrior` → `bands[].biasPosterior`.
- **What riders currently get:** `shipped` (`{date, tanks, riders, overhead}` from the live bundle).
- **Whether a proposal is waiting for review:** `proposed`, compared with `shipped`.

## 3. The model, in short

```
litres_t = λ · Σ_b km_tb · f(v_b; θ) + idleH_t · idle(θ)        f, idle: the physics core (lib/…/physics)
θ = class priors with cda, crr, indicatedEfficiency, fmepA each × exp(φ_k)
φ_k ~ N(0, (σ_k/μ_k)²) from the class default's prior;  log λ ~ N(0, 0.3²)
log litres_obs − log litres_t ~ Student-t(ν = 4, s)
```

- **The overhead λ:** fitted on its own, so stops, hills, wind and warm-up don't show up as more drag or a worse engine. The trip card models stops itself.
- **The fit:** MAP by Gauss–Newton, reweighted for the Student-t residuals. The noise scale s is the median absolute deviation (MAD), floored at 3%.
- **One rider's weight:** all of a rider's tanks together weigh at most 10 tanks.
- **Uncertainty:** each new ±σ and the correlations come from the Laplace approximation of the posterior.
- **Gates before a proposal:** at least 30 tanks from at least 5 riders. Held-out riders (5 folds) must be predicted at least 1 point better. Every new mean must stay inside the contract's plausible range.
- **Tested on synthetic fleets** with known truth (`test/fleet/calibration.test.mjs`):
  - the truth lands inside the posterior;
  - held-out error drops from 22% to 5%, and every speed band ends unbiased;
  - 5% of tanks with litres ×3 barely move the fit;
  - one rider with 300 biased tanks shifts the honest riders' estimate by less than 1%, against more than 10% without the cap;
  - when today's priors are already right, nothing is proposed.

## 4. From fit to riders (operator and curator)

```bash
DB_PATH=/srv/mapunite/data/mapunite.db npm run bikes:calibrate            # fit every class, store fits (dashboard), print a summary
DB_PATH=… npm run bikes:calibrate -- --write                                # also write data/bikes/calibration/<class-key>.json where proposed
git diff data/bikes/calibration/                                            # review: basedOn → priors, evidence, cv
npm run bikes:build && git commit …                                         # the build applies it; deploy as usual
```

- **Always from the curated priors:** every fit starts from `data/bikes` without `data/bikes/calibration/`. A re-fit replaces the class's proposal, so the same tanks are never counted twice.
- **Run it from a checkout of the deployed commit.**
- **What the build does with a proposal:**
  - writes the new priors into the class default with `src: "fleet-calibration"` and a note "(was X ± Y)";
  - adds a `derived` source with the evidence;
  - puts `calibration: {date, tanks, riders, overhead}` into every petrol bundle of that class.
- **Stale proposals:** if a curator changed the class default's priors since the fit, the proposal is skipped with a warning (stale). A malformed one stops the build.
- **On the phone:** `BikeFuel` passes the bundle's `calibration` to `buildFuelBaseline`. The physics km/L is divided by λ, idle stays as it is, and λ's uncertainty is added to ±σ. Settings then reads "…in everyday riding (physics, calibrated on N riders' fill-ups)". Without a calibration, the baseline is exactly as in Step 7.
- **Fuel safety:** tanks are measurements, never advice. A calibration changes priors only; the fuel advice rule (manufacturer-certified fuels only) is unaffected.
