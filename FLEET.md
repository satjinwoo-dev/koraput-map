# FLEET.md: anonymous tank telemetry, contract v1

**Schema:** `mapunite-fleet/1`. **Consent version:** `2026-10-04`.

**Implementations:**
- Client: `public/js/rides/fleet.js` (`MUFleet`).
- Consent screen: `public/js/rides/consent-ui.js`.
- Reference server: `lib/fleet.js`.

The validation rules below are in one place, `MUFleet.contract`, which both the phone and the server run.

This document is the agreement between the app, the server and the rider. If code and this file disagree, this file wins and the code is a bug.

## 1. What it is for

The fuel learner (`FuelCurve` in `js/smartdrive.js`) turns a rider's full-to-full fill-ups into a real km/L for each speed band. One rider learns slowly, and only about their own bike. With **opt-in** consent, the phone sends those tank results, and nothing else, so the server can learn a real-world curve for each bike model and correct the physics prior for everyone who rides one. This matches the locked decision: *physics on the phone, learning in the cloud.*

## 2. Principles

1. **Off by default; asked once.** The consent screen appears after the first *usable* tank, never during a ride. "Not now" means not again for 60 days. The two buttons have equal weight, and nothing is pre-ticked.
2. **Only tanks.** A tank is the result of one full-to-full fill-up interval that the learner marked usable. No GPS, no routes, no places, no timestamps finer than a month, no device identifiers, no prices, no name, phone number or friends.
3. **Strict SI.** Metres, cubic metres and seconds, as everywhere in the physics core and the database.
4. **Coarsened before it leaves the phone.** This makes it hard to fingerprint a rider from their numbers (see §4).
5. **Revocable.** Turning sharing off deletes everything sent under that ID on the server immediately. Turning it on again later starts a new, unrelated ID.
6. **No server identity.** The contributor ID is 128 random bits made on the phone. It is never shown or linked to the rider's MapUnite account or device token. The server stores only `SHA-256(contributor)`.
7. **k-anonymity for output.** Nothing derived from fleet data is published for a bike model with fewer than **5 contributors**.

## 3. Endpoints

All requests and responses are JSON. Authorization is `Authorization: Fleet <contributor>`, where `<contributor>` is 22 base64url characters (128 bits).

### `POST /api/fleet/v1/tanks`

```json
{
  "schema": "mapunite-fleet/1",
  "consent": "2026-10-04",
  "app": "mu-2026-10-04.3",
  "bike": { "id": "royal-enfield-hunter-350-metro-in", "classKey": "ice_manual.cruiser", "powertrain": "ice" },
  "tanks": [
    {
      "id": "3f9a0c1d2e4b5a69",
      "month": "2026-09",
      "distance": 412300,
      "fuel": 0.011450,
      "odoDistance": 418000,
      "coverage": 0.99,
      "bandShare": [0.18, 0.47, 0.29, 0.06],
      "idleTime": 2580,
      "trips": 14
    }
  ]
}
```

| Field | Unit | Rule |
|---|---|---|
| `bike.id` | — | Catalogue bundle id, or `null` for a "typical bike" estimate. |
| `bike.classKey` | — | `powertrain.segment`, e.g. `ice_manual.commuter`. |
| `bike.powertrain` | — | `ice` only in v1. Batteries have no fill-ups. |
| `tanks` | — | 1–20 per request. |
| `id` | — | 16 hex digits, the first 64 bits of `SHA-256(contributor + ":" + fromTs + ":" + toTs)`. Opaque, stable, used for de-duplication. |
| `month` | — | `YYYY-MM` of the fill-up that closed the tank (rider's local time). Not in the future, not before 2024-01. |
| `distance` | m | Distance the app recorded in the tank, rounded to 100 m. 5 km–2 000 km. |
| `fuel` | m³ | Litres pumped to refill (all fills in the interval), rounded to 1 mL (1e-6 m³). 0.1 L–60 L. |
| `odoDistance` | m \| null | Odometer difference if the rider logged both readings, rounded to 100 m. |
| `coverage` | — \| null | `distance / odoDistance`, rounded to 0.01, 0.6–1.25. Below 0.6 the learner already rejects the tank. |
| `bandShare` | — | Share of `distance` driven below 40, 40–60, 60–80 and above 80 km/h. Each rounded to 0.01; the sum is 0.98–1.02. |
| `idleTime` | s | Engine-on time while stopped, rounded to 60 s, ≤ 48 h. |
| `trips` | — | Number of recorded drives in the tank, 1–500. |

The plausibility check runs on both sides: implied economy `distance / fuel` (after coverage) must be 2–90 km/L, i.e. 2e6–9e7 m/m³.

**Responses:**
- `200 { "ok": true, "accepted": n, "duplicates": m }`. A tank id already stored counts as a duplicate, not an error.
- `400 { "ok": false, "error": "…", "rejected": [{ "id", "error" }] }`. The whole request is rejected if the envelope is wrong. Individual bad tanks are listed and the rest accepted.
- `401`: missing or malformed authorization.
- `413`: more than 20 tanks, or a body over 32 kB.
- `429`: more than 200 tanks from one contributor in a UTC day, or the per-IP rate limit.

### `DELETE /api/fleet/v1/contributor`

Deletes every tank stored under this contributor, plus the contributor row. It is idempotent: an unknown ID returns `200 { "ok": true, "deleted": 0 }`.

### `GET /api/fleet/v1/bikes/:id/summary`

Returns this, or `404 { "ok": false, "error": "not enough contributors" }` below k = 5:

```json
{ "ok": true, "bike": "…", "contributors": 12, "tanks": 61, "metresPerCubicMetre": { "p25": 3.4e7, "median": 3.8e7, "p75": 4.1e7 } }
```

## 4. Coarsening and fingerprinting

| Field | Rounded to | Why |
|---|---|---|
| `month` | month | No date, no time of day. |
| `distance` / `odoDistance` | 100 m | Exact distances could match a known commute. |
| `fuel` | 1 mL | Below what the pump shows. |
| `bandShare` | 0.01 | |
| `idleTime` | 60 s | |
| Bike | model only | No year, no settings, no tyre or load figures. |

Tank ids are salted with the contributor secret, so the same tank can't be recognised across contributors or after a re-opt-in.

## 5. Client behaviour (`MUFleet.createFleetClient`)

**Local state** (`localStorage` `mu.fleet.v1`):
```
{ consent: { version, choice: "yes"|"no", at }, contributor, sent: [id…], queue: [Tank…], pendingDelete, nextTryAt, lastSentAt, lastError, askedAt }
```

**When it uploads:**
- right after opt-in;
- after each newly usable tank;
- whenever the app starts online.

Batches hold up to 20 tanks. On a network or 5xx error it backs off exponentially, from 2 minutes up to 6 hours. Each tank id is sent once, and `sent` keeps the last 500.

**When the rider opts out:**
- the client sends `DELETE` and then forgets `contributor`, `queue` and `sent`;
- if the network fails, the ID moves to `pendingDelete` and the DELETE is retried at the next start, before anything else;
- consent becomes `{ choice: "no" }`.

**"Delete my history"** (Ride summaries) includes sharing: it runs the opt-out (server delete) when the rider was opted in.

**Re-asking:** only when this file's consent version changes in a way that widens what's sent. A narrower change needs no new consent.

## 6. Server behaviour (`lib/fleet.js`)

**Tables:**
- `fleet_contributors(hash PK, created_at, last_seen, day, day_count)`;
- `fleet_tanks(id PK, contributor_hash, bike_id, class_key, month, distance, fuel, odo_distance, coverage, band0..3, idle_time, trips, consent, app, received_at)`.

**Rules:**
- Validation uses the same `MUFleet.contract.validateTank`.
- Nothing about the request is stored except the tank fields, the consent version and the app version: no IP address, no user agent.
- Retention is 24 months by `received_at`, purged daily (`purgeOld`).
- Aggregates are recomputed from the rows that remain, so deleted data drops out.

## 7. Versioning

- `schema` changes only for incompatible payloads. The server accepts the current and the previous schema for 6 months.
- `consent` is the date of the consent text. The server stores it with every tank, so data can be filtered by what the rider agreed to.
