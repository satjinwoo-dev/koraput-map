# RoadPulse pilot scorecard

RoadPulse launches as **one dense pilot corridor or district** (for example Koraput–Araku, or around Rourkela), not all of India. Expand to a second corridor only when **every gate below has been green for 4 weeks in a row**.

**The gate values are proposals.** The team must agree on them before the pilot starts. None of these numbers may be used as a public claim.

## The gates

| # | Metric | How it's measured | Proposed gate |
|---|---|---|---|
| 1 | Impact precision at the public threshold | Ground-truth rides (a second phone or action camera, same clock), labelled; **leave-one-bike-out / leave-one-phone-out / leave-one-rider-out**, never events of one ride split across train and test | ≥ 0.80 |
| 2 | Impact recall, severity 3 | Same | ≥ 0.70 |
| 3 | Rough-road precision | Same | ≥ 0.75 |
| 4 | Normal/false events wrongly called impacts | Same, per 100 km | report it; must fall release over release |
| 5 | Event-location error | Detected point vs camera-marked point (metres) | median ≤ 5 m, p90 ≤ 12 m |
| 6 | False voice alerts | Pilot riders flag them; ride-log audit | ≤ 1 per 100 km |
| 7 | Post-ride review completion | Rides with detections where the review was done (opt-in pilot telemetry) | ≥ 40% |
| 8 | Independently confirmed hazards | **server**: `scorecard().independentlyConfirmed` | ≥ 100 in the corridor in 8 weeks |
| 9 | Time to independent confirmation | **server**: `daysToIndependentConfirmation` | median ≤ 7 days |
| 10 | Votes with passage evidence | **server**: `votes.withPassage / votes.current` | ≥ 80% |
| 11 | Corridor freshness | km of the corridor with a confirmation < 30 days old | ≥ 60% |
| 12 | Battery | S24 FE-class phone: ride mode vs navigation-only baseline, 1 h rides | extra ≤ 3% per hour |
| 13 | Distraction / unsafe alerts | Survey + incident reports | zero "sudden braking" incidents; annoyance ≤ 5% of riders |
| 14 | Privacy audit | External review + a re-identification red-team on pilot data | pass; zero re-identifications |

The server part (gates 8–10, plus hazards by state, hazards needing re-snap, and reporters in the last 30 days):

```
node scripts/roadpulse-scorecard.mjs [path/to/mapunite.db]
```

## Assumptions to test before any public claim

1. A handlebar phone separates pothole/hump impacts from normal vibration across bikes, mounts, phones and tyre pressures.
2. The rear wheel's second hit shows up on most bikes and speed bands.
3. Location error can reach median ≤ 5 m on Indian roads (trees, ghats, towns).
4. GNSS fix latency per chipset is stable enough to calibrate (`fixLatencyMs`), and the handlebar offset (`phoneBehindAxleM`) per bike class is right.
5. Riders complete the review.
6. Riders' "not found" is honest and attentive.
7. Speed-aware calm alerts help and don't distract, and the alert-distance formula works in the field.
8. One corridor reaches enough rider density.
9. Day buckets, delayed publishing, low-traffic holds and private places prevent re-identification.
10. Passage-attestation plausibility checks catch fakes well enough.
11. Battery use stays acceptable.
12. Badges reward accurate reporting, not spam.
13. The OSM extract is good enough for road snapping in the pilot district.
14. Hazard lifetimes (pothole 30 d, rough 90 d, speed breaker 365 d) match how the roads change.

Until these are tested, MapUnite may say:

> "Riders report road conditions; here's how many confirmed each one."

It must not say "accurate", "detects all potholes", "X m precision", "safer", "real-time", or "100% anonymous" (it's pseudonymous).

## Build now / validate in the pilot / later research

| Built (this branch) | Validate in the pilot | Later research |
|---|---|---|
| Detector v2 + unknown class, mount-moved rejection, handlebar offset, latency hook | Every threshold (all `basis: prior`) | 1D-CNN (only with enough diverse labels) |
| Post-ride review, manual add / correct, consent flow | Review completion | Ride Story |
| Agreement, lifecycle, freshness, review audit + passage attestation | False alerts per 100 km | Fuel / wind / wind microphone |
| Speed-aware, speech-time-aware alerts; turn prompts first | Alert formula in the field | OBD / ECU |
| Badges from independent confirmation; validated reviews; thanks | Badge thresholds | Speed-camera layer |
| Route privacy (day buckets, low-traffic holds, private places, anonymous answers) | Re-identification red-team | Developer API business |
| Road-aware merge + OSM re-snap (needs the pilot's road extract) | Merge tolerances, snapping quality | LLM features |
| Data-source registry, PostGIS schema | ODbL / contributor-terms legal review | Ghat Guardian (needs a DEM tag) |
| GBDT classifier: **next**, once labelled pilot rides exist | Leave-one-bike/phone/rider-out accuracy | |
