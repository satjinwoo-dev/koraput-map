# MapUnite bike catalogue (`data/bikes/`)

Reviewable source data for the Smart Bike & Engine Dynamics Analyzer. One JSON file per bike. The build step (Step 3) compiles these into SQLite, the offline search catalogue and per-bike bundles. **Edit these files, never the compiled outputs.**

```
data/bikes/
  variants/          one file per real bike variant           (25 seed variants — shipped)
  class-defaults/    one file per powertrain × segment class  (10 — the fallback for any unknown bike)
  pending/           researched bikes blocked by a rule       (2 — validated, never shipped)
  calibration/       reviewed fleet calibrations, one per class (Step 8 — none yet; see FLEET.md)
  reference/
    fuel-grades.json         E0 / E10 / E20 / E85 / E100: energy per litre, density, RON
    emission-standards.json  BS4, BS6-P1, BS6-P2 and the OBD stages (OBD-1, OBD-2A, OBD-2B)
lib/bikedb/bundle.schema.json        JSON Schema (generated — editor autocomplete and structural checks)
lib/bikedb/schema.sql                SQLite schema of bikes.sqlite (normalised, STRICT tables, FTS5)
public/js/bikedb/bundle-contract.js  the contract + validator (browser, app and Node)
public/js/bikedb/catalog-search.js   tokeniser + in-memory search, shared by app, website and server
scripts/bikedb/validate.mjs          validate everything
scripts/bikedb/gen-schema.mjs        regenerate the JSON Schema
scripts/build-bike-catalog.mjs       build catalog.json, the bundles and bikes.sqlite
scripts/bikedb/bench-search.mjs      search benchmark on a synthetic 20,000-variant catalogue
scripts/bikedb/requests.mjs          the queue of rider requests for missing bikes (npm run bikes:requests)
lib/bikedb/catalog-db.js             the server's read-only view of bikes.sqlite: search, bundles, hot reload
lib/bikedb/request-queue.js          requests for missing bikes, stored in the server's database
lib/bikedb/http-api.js               /api/bikes routes (search, bundles, requests, fill-ups, calibration, status), CORS for the app
lib/bikedb/fleet.js                  anonymous fill-ups from riders who opted in (Step 8), stored in the server's database
lib/bikedb/calibration.js            the class-level fleet fit (Bayesian MAP, robust, cross-validated by rider)
scripts/bikedb/calibrate.mjs         fit the fleet, write proposals to calibration/ (npm run bikes:calibrate)
scripts/bikedb/calibration-file.mjs  the proposal format; applies reviewed proposals in the build
public/js/bikedb/bike-api.js         client for the website and the app: server first, offline fallback
test/bikedb/                         node --test test/bikedb/*.test.mjs

Build outputs (generated, git-ignored — never edit):
public/bikedb/catalog.json           compact search catalogue for the app and website (offline)
public/bikedb/bundles/<hash>.json    one self-contained bundle per bike; the name is its content hash
build/bikedb/bikes.sqlite            database + FTS5 search for the server
```

## Commands

```bash
node scripts/bikedb/validate.mjs                 # must end with "0 errors"
node scripts/bikedb/format.mjs                   # canonical one-value-per-line formatting (CI runs --check)
node --test test/bikedb/*.test.mjs               # contract, catalogue, format, schema, build and search tests
node --test test/server/*.test.mjs               # server API: FTS5 parity with the app, bundles, requests, CORS, server.js end to end
node scripts/bikedb/gen-schema.mjs               # after changing FIELDS in bundle-contract.js
tsc -p tsconfig.bikedb.json                      # type-check the contract and the search module (JSDoc + @ts-check)
node scripts/build-bike-catalog.mjs              # build the outputs (after any data change, and on deploy)
node scripts/build-bike-catalog.mjs --check      # exit 1 if the outputs are missing or out of date
node scripts/bikedb/bench-search.mjs             # search speed and catalogue size at 20,000 variants
```

Suggested `package.json` scripts:

```json
"bikes:validate": "node scripts/bikedb/validate.mjs",
"bikes:build": "node scripts/build-bike-catalog.mjs",
"bikes:test": "node --test test/bikedb/*.test.mjs",
"bikes:bench": "node scripts/bikedb/bench-search.mjs",
"prestart": "node scripts/build-bike-catalog.mjs --quiet"
```

## The build (Step 3)

`node scripts/build-bike-catalog.mjs` validates everything first and **writes nothing if any file fails**. Bikes in `pending/` are never built. Then:

| Output | What it is | Who uses it |
|---|---|---|
| `public/bikedb/bundles/<hash>.json` | Everything one bike needs, in one file, in **strict SI** (`"units": "SI"`): its values with sources and the published figures beside them, `image_url`, the full prior set (inherited priors are marked `"inherited": true`, and their sources are listed under `classDefault.sources`), `fuelAdvice.advisable` (decided once, by `isFuelAdvisable()`), and the fuel-grade and emission reference rows. The name is the first 16 hex characters of the SHA-256 of the bytes. | The app, after a bike is picked. Cache forever: changed data means a new file name. |
| `public/bikedb/catalog.json` | One column per field (id, make, model, variant, years, class, size in SI (m3, or J for EVs; `formatSize()` turns it into "349 cc" / "2.9 kWh" for display), aliases, `image_url`, bundle hash), the class list with each class default's bundle, and a `version` that is the hash of the rest. Build fails above **300 KB gzipped**. | The bike picker: `new BikeCatalogSearch.CatalogIndex(catalog)` searches it in memory, offline. |
| `build/bikedb/bikes.sqlite` | The normalised database from `lib/bikedb/schema.sql`, strict SI with `published_*` columns for review: values, priors (inheritance resolved by the `v_resolved_prior` view), fuel approvals with the `advisable` flag, reference tables, the served bundle bytes, and the FTS5 `bundle_search` table. | The server, read-only (`lib/bikedb/catalog-db.js`): `/api/bikes/search`, `/api/bikes/bundles/<hash or id>`, `/api/bikes/status` (see DEPLOY.md). A rebuilt file is picked up without a restart. |

**Same input, same output.** The bundles and `catalog.json` are canonical JSON (sorted keys, no whitespace, no timestamps), so they are byte-identical on every build and every machine, whatever the key order in the source files. `bikes.sqlite` is byte-identical for the same SQLite version. Its `meta` table records the input fingerprint, which is what `--check` compares. Changing one bike changes only that bike's bundle file and the catalogue version.

**Search.** The app and the server use one tokeniser (`catalog-search.js`): case, accents and punctuation are ignored, letters and digits are split ("mt15" = "MT-15", "ns 200" = "NS200"), "H'ness", "hness" and "h ness" are the same, "+" reads as "plus", every word is a prefix and all words must match, and "cc" is ignored. The FTS5 columns hold that tokeniser's output and queries are built with `toFtsQuery()`, so the server and the phone match exactly the same bikes; the tests check this on the real catalogue and on synthetic ones. Class defaults aren't searchable by name: the picker offers them by class.

**Benchmark** (`bench-search.mjs`, 20,000 synthetic variants, 1,000 type-ahead queries, this build machine):

| | p50 | p95 | p99 | max |
|---|---|---|---|---|
| FTS5, ranked top 20 (better-sqlite3) | 0.16 ms | 0.77 ms | 1.42 ms | 2.45 ms |
| In-memory index, ranked top 20 | 0.03 ms | 0.46 ms | 1.87 ms | 4.97 ms |

Building the in-memory index for 20,000 variants takes about 90 ms, once, on the first search. On the synthetic data, which gives half the bikes a full image URL, `catalog.json` stays under the 300 KB gzip budget up to about 9,500 variants (today's real catalogue: 2.4 KB). Past that, split the catalogue by make before raising the budget.

**SQLite driver.** The build uses `better-sqlite3` (already a server dependency) or, if that isn't installed, Node 22.5+'s built-in `node:sqlite`. Force one with `--driver` or `BIKEDB_SQLITE_DRIVER`. `--skip-sqlite` builds only the public files. `scripts/build-native.mjs` rebuilds `public/bikedb/` by itself before it packages the Android app.

## The contract in one page

Every technical value carries its **unit**, its **source** and a **confidence**:

```jsonc
"peakTorque": { "v": 27, "u": "N*m", "src": "re-classic-site", "conf": 0.95 }        // quantity
"cooling":    { "v": "air_oil", "src": "re-classic-site", "conf": 0.95 }             // categorical
"cda":        { "mean": 0.62, "sigma": 0.12, "u": "m2", "src": "class-prior-physics", "conf": 0.35 }  // prior (uncertain parameter)
```

Optional keys: `tol` (± tolerance printed in a manual, e.g. idle `1050 ± 100`) and `note` (conversions, conflicts, caveats).

**Sources** are listed once per file in `sources[]` and referenced by `src`:

| kind | needs | confidence cap |
|---|---|---|
| `manufacturer`, `owners_manual`, `service_manual`, `homologation` | `url` | — |
| `licensed_db` | — | — |
| `aggregator`, `press` | `url` | 0.8 |
| `regulation` | `url` | — |
| `community` | `note` | 0.6 |
| `derived` (computed from other sourced values) | `note` with the method | — |
| `estimated` | `note` with the method | 0.6 |
| `class_prior` (class defaults only) | `note` | 0.5 |

A source can't be more certain than its kind allows. The validator rejects a press figure marked 0.95.

**Confidence guide:** 0.9–0.95 for a current manufacturer spec sheet; 0.75–0.85 for a current owner's manual; 0.5–0.7 for an older manual, another market's manual or a single press source; ≤ 0.45 when only an aggregator has it, or sources conflict.

### Units: published in the files, strict SI everywhere else

**Strict SI only** for everything a program reads: `bikes.sqlite`, the runtime bundles, `catalog.json` and the physics core. The data files keep each value **as published** (rpm, cm3, kW …), so a reviewer can check it against the brochure or manual. The build converts every number with `SI_UNITS` / `toSI()` in `bundle-contract.js`, the one place conversions live. A unit with no conversion stops the build. Power-of-ten conversions are exact decimal shifts (349.34 cm3 → 0.00034934 m3); rpm, km/h, kWh and the friction terms use exact ratios.

In the data files, each field takes exactly one published unit; anything else is rejected. Convert when you enter the data and say so in `note`, e.g. *"Published as 46 PS; converted at 0.7355 kW/PS"*.

| Field | In the data files | SI (database, bundles, physics) |
|---|---|---|
| displacement, fuel tank | `cm3`, `L` | `m3` |
| bore, stroke | `mm` | `m` |
| range | `km` | `m` |
| power (engine, motor) | `kW` | `W` |
| engine speed (idle, peaks, redline) | `rpm` | `rad/s` |
| top speed | `km/h` | `m/s` |
| battery energy | `kWh` | `J` |
| torque | `N*m` | `N*m` |
| mass, rider mass | `kg` | `kg` |
| drag area | `m2` | `m2` |
| voltage | `V` | `V` |
| ratios, counts, efficiencies, Crr, octane (`RON`) | `1`, `RON` | `1` |
| friction MEP A, B, C | `kPa`, `kPa/krpm`, `kPa/krpm2` | `Pa`, `Pa*s/rad`, `Pa*s2/rad2` |
| fuel energy, fuel density (reference table) | `MJ/L`, `kg/L` | `J/m3`, `kg/m3` |

In a bundle, a converted value looks like `{ "v": 14870, "u": "W", "src": …, "conf": …, "published": { "v": 14.87, "u": "kW" } }`: read `v`/`u`, and show `published` to people. In `bikes.sqlite`, `value`, `vals`, `tol`, `mean`, `sigma` and the ranges are SI. The figures as printed are in the `published_*` columns, and `field.unit` / `field.published_unit` / `field.si_factor` describe each field. The server reads `v_spec_si`, `v_resolved_prior` and `v_variant`, which are SI only.

### Picture (`image_url`)

Every runtime bundle, every catalogue row and every class entry has an `image_url`: an https URL for the bike picker, or `null` until a picture is sourced, in which case the picker shows a class silhouette. To add one, give the data file an optional top-level `image`. It needs a source like any other value, and a credit if the publisher asks for one:

```json
"image": { "url": "https://…/hunter-350.webp", "src": "re-hunter-spec-2026", "credit": "Royal Enfield" }
```

The validator rejects an http URL (an http image is blocked inside the app, whose pages are https), a `src` that isn't in `sources[]`, and unknown keys. Manufacturer photos are usually copyrighted: use pictures you're licensed to use, ideally hosted on your own CDN.

### What the validator rejects

- Unknown keys anywhere, so typos fail loudly instead of being ignored.
- A wrong or missing unit; a missing `src`, an unknown `src`, or a missing `conf`; a confidence above the cap for that source kind.
- **Physically impossible values:**
  - values outside the plausible range (negative mass or displacement, a 6000 rpm idle);
  - redline at or below idle, or below the torque peak;
  - idle above the torque or power peak;
  - a limiter below redline;
  - gear ratios that don't strictly decrease, or don't match the gear count;
  - sprockets that contradict the final ratio;
  - CVT minimum ratio above its maximum;
  - usable battery above installed capacity, or rated power above peak power;
  - a hub motor with a reduction ratio other than 1.
- **Cross-checks that catch typos:**
  - bore × stroke × cylinders must equal displacement within 2 %;
  - peak torque × its rpm can't exceed peak power, and peak power ÷ its rpm can't need more than the peak torque;
  - specific power must be plausible.
- **Fuel safety:**
  - a petrol bike approved for no fuel at all;
  - a petrol bike with **no manufacturer certification** (`no_certified_fuel`): it needs at least one fuel with status `certified`, from an authoritative source (`manufacturer`, `owners_manual`, `service_manual`, `homologation`, `licensed_db`), at confidence ≥ 0.5 (`CERT_MIN_CONF`). "Compatible" entries, press quotes, aggregators and other markets' manuals don't count. Such a bike goes in `pending/`;
  - a class default marked `certified` for any fuel; only a real bike can be certified;
  - E85 or E100 approved for an engine not certified as flex-fuel;
  - a "compatible" blend derived upward in ethanol from a certification;
  - a real bike's approval resting on an estimate;
  - fuel data on an electric vehicle.
- **Wrong blocks for the powertrain:** engine, fuel or emission blocks on an EV; motor or battery blocks on a petrol bike; a transmission that doesn't match the powertrain; an unsupported class (e.g. a CVT cruiser).
- **Catalogue-level:** a duplicate id; a file not named `<id>.json`; a missing or duplicate class default; a variant whose priors don't resolve through its class default.

It **warns**, without failing, about:
- a dry-mass figure;
- a published top speed that doesn't agree with the gearing and tyre (the check works out engine rpm at top speed);
- unused sources;
- an alias shared by two different models (variants of the same model may share one, e.g. "Hunter 350");
- a petrol bike certified for a fuel, but with nothing that reaches the advice threshold (`no_advisable_fuel`, see below). The bike ships; the app tells the rider to check the owner's manual.
- an emission standard that's superseded while the bike is marked as still on sale.

## Fuel advice rule

Two thresholds, both in `bundle-contract.js`:

| Threshold | Value | What it controls | If no fuel meets it |
|---|---|---|---|
| `CERT_MIN_CONF` | 0.5 | whether the bike can ship at all | **error** `no_certified_fuel`, so the bike stays in `pending/` |
| `ADVISE_MIN_CONF` | 0.7 | whether the app *recommends* a fuel | **warning** `no_advisable_fuel`; the app says "check your owner's manual" |

The fuel matrix records what each source says. The app only **recommends** a fuel when `isFuelAdvisable()` returns true:

- the fuel's status is `certified` or `compatible`;
- its source is authoritative (`manufacturer`, `owners_manual`, `service_manual`, `homologation`, `licensed_db`);
- its confidence is ≥ 0.7;
- it is never a flex blend (E85/E100) unless `engine.flexFuel` is `true`.

Lower blends listed through the `lower-blend-rule` source (E10/E0 beneath a certified E20) are recorded as `compatible` with a `derived` source. They are shown as "compatible per the E20 certification", not advised on their own.

Everything else shows as **"not confirmed by the manufacturer"**. In the seed data:

| Bike | E20 advised? | Why |
|---|---|---|
| Splendor+, Shine 125, Raider 125, Pulsar 150, Pulsar N160, Pulsar NS200, XPulse 200 4V, Classic 350, Bullet 350, Meteor 350, Hunter 350, H'ness CB350, Himalayan 450, MT-15 V2, R15 V4, Apache RTR 160 4V, Jupiter 110 | Yes | Manufacturer page or owner's manual |
| Activa 110 | No (ships with a warning) | Certified E10 in the 2020 manual (0.6). E20 only via a press quote of Honda |
| Access 125 | *pending* | Aggregator only; Suzuki's E20 page couldn't be reached |
| KTM 390 Duke R | *pending* | Only the EU owner's manual (0.35); no India ethanol statement found |

### `pending/`

A bundle in `pending/` was researched but is blocked by a rule, usually `no_certified_fuel`. It is held to the same format, but it is not part of the catalogue: it is never compiled or shipped.

- `validate.mjs` validates each one and lists its blockers ("blocked by …").
- Its first `notes` entry starts with `PENDING (<date>):` and says what is missing.
- When a pending bundle passes every rule, `validate.mjs` fails with `pending_ready`. Move it to `variants/`; it can't sit in `pending/` once it's ready.

## Class defaults

Every powertrain × segment class has one default, so a search never comes back with nothing:

| powertrain | segments |
|---|---|
| `ice_manual` | commuter, naked, sport, adventure, cruiser |
| `ice_cvt` | scooter, maxi_scooter |
| `ev` | scooter, commuter, sport |

- Defaults use `class_prior` sources (confidence ≤ 0.5) and carry the **full prior set**: drag area, rolling resistance, drivetrain and engine efficiency, friction terms, redline factor, and EV motor and regeneration efficiency.
- Variants inherit any prior they don't set (`resolvePriors()`).
- Defaults are never used for fuel advice.

## Fleet calibrations (`calibration/`, Step 8)

`npm run bikes:calibrate -- --write` writes `calibration/<class-key>.json` for a petrol class when riders' shared fill-ups predict their tanks better than today's priors. Review it like any other data change:

- **`basedOn`**: the class default's priors the fit started from. If you edit those priors, the proposal goes stale: the build skips it with a warning until the fleet is re-fitted.
- **`priors`**: the proposed drag area, rolling resistance, indicated efficiency and friction MEP A, in the files' units, with their new ±σ and confidence.
- **`overhead`**: everyday riding versus steady flat-road physics. It ships in the bundles (`calibration.overhead`) and SmartDrive's baseline uses it.
- **`evidence`**: tanks, riders, km, litres, the noise, and the held-out riders' error before and after.

The build writes the proposal into the class default with `src: "fleet-calibration"` and a note giving the old value, and adds a `derived` source with the evidence. It never edits the class-default file itself. To undo a calibration, delete its file and rebuild. The source id `fleet-calibration` is reserved for this. Calibrations change priors only; the fuel advice rule below is unaffected.

## Adding a bike

1. Copy the closest file in `variants/` and rename it to the new id. Ids are lowercase slugs ending in the market, e.g. `bajaj-pulsar-ns200-in`.
2. List every document in `sources[]` with its URL and the date you read it. Prefer the manufacturer's spec page, then the owner's or service manual.
3. Enter only values you read on a page. Convert to canonical units and note the conversion. Put conflicts between sources in `note` or `notes`.
4. **Missing is fine; guessed is not.** Leave a value out if it isn't published (gear ratios, redline): the class default covers the physics and the app shows the lower confidence. Two cases:
   - **Gear ratios:** without primary, gear and final ratios, gear advice stays off for that bike.
   - **Emission stage:** when the maker doesn't state it, use the shared `regulatory-inference` source. A bike sold new after 2023-04-01 is BS6-P2; one built after 2025-04-01 is OBD-2B.
5. If the validator reports `no_certified_fuel` and you can't find a manufacturer certification, move the file to `pending/` and start `notes` with `PENDING (<date>): <what is missing>`. Never raise a confidence or relabel a source to get past it.
6. Run `node scripts/bikedb/format.mjs`, then `node scripts/bikedb/validate.mjs` until it reports 0 errors, then run the tests and `node scripts/build-bike-catalog.mjs`.

## Seed data provenance (2026-10-02)

All values were read from the cited pages on 2026-10-02 through a web text extractor; direct PDF downloads were blocked by the network, so quotes could not be checked byte-for-byte against the printed documents. Values that depend on that are marked with lower confidence.

Known gaps:
- **No gear ratios:** Shine 125 and Pulsar N160 (not in any manual found). MT-15 V2 has gear ratios but no primary or final ratio.
- **No CVT ratios:** Access 125 (no 2025 manual).
- **No redline published by any manufacturer;** physics uses `redlineFactor`.
- **Misprints to verify against printed manuals:** TVS 2025–26 manuals print a minimum of "RON 98" (Raider, Jupiter, Apache). Kept at RON 91 from the earlier manuals, with `fuel.minRon` confidence at 0.45–0.5 and the conflict in `note`.

## Seed data update (2026-10-03)

A second, independent research pass covered 13 of the same bikes. It agreed with the 2026-10-02 values, apart from the Apache's mass (a different variant was read) and how tyre sizes were written.

**Added (6):**

| Id | Notes |
|---|---|
| `bajaj-pulsar-150-single-disc-in` | Outgoing generation, `yearTo` 2026; Bajaj announced a new-generation Pulsar 150 for August 2026 |
| `bajaj-pulsar-ns200-dual-abs-in` | |
| `royal-enfield-bullet-350-dual-abs-in` | |
| `honda-hness-cb350-dlx-in` | |
| `ather-450x-2-9kwh-2025-in` | Sits alongside the 3.7 kWh variant |
| `bajaj-chetak-c3501-in` | |

**Corrected:**
- **Hunter 350:** E20 is now certified from Royal Enfield's 2025 owner's manual (RAM01202/A, 3 April 2025, conf 0.85). Previously the only E20 source was a press article, which has been removed.
- **Jupiter 110, Raider 125:** `fuel.minRon` confidence lowered to 0.45 (the "RON 98" conflict above).
- **Apache RTR 160 4V:** `gearRatios` confidence lowered to 0.5. The ratios found are identical to the Raider 125's, which is unlikely, so they need checking against the service manual.

**Moved to `pending/`:** KTM 390 Duke R and Access 125. Both passed under the old rule (any non-estimate "compatible" entry counted) and fail the stricter `no_certified_fuel` rule.
