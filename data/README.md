# MapUnite bike database — data contracts (schema 1.0.0)

One reviewable JSON file per bike variant, compiled later (step 3) into
`bikes.sqlite`, `catalog.json` and per-bike bundles. Everything here is
checked by **`public/js/bikedb/validate.js`**, which runs unchanged in
the app, on the website and in Node.

```
data/
  schema/bundle.schema.json            JSON Schema 2020-12, generated — do not edit
  schema/fuel_grade.schema.json
  schema/emission_standard.schema.json
  bikes/<id>.json                      one variant per file (file name = id)
  class-defaults/class.<pt>.<seg>.json one fallback per powertrain x segment
  lookups/fuel_grade.json              E0, E10, E20, E85, E100
  lookups/emission_standard.json       BS4, BS6-P1, BS6-P2
```

```sh
npm run bikes:validate             # every file + cross-file rules; exit 1 on any error
npm run bikes:validate -- --debt   # also list low-confidence inputs (sourcing debt)
npm test                           # validator + schema-agreement tests
npm run bikes:schema               # regenerate data/schema/*.json from the validator
npm run bikes:typecheck            # tsc --noEmit over the JSDoc-typed validator
```

## SI units

Every quantity names its unit as a UCUM code, and each field accepts exactly
one SI-coherent unit. Anything else is rejected, and the error gives the
converted value (`7500 rpm = 785.398 rad/s`). Convert the brochure figure and
keep the original text in `published` (see below).

| Quantity | Unit | Brochure → SI |
|---|---|---|
| mass | `kg` | |
| length (bore, stroke, rolling radius, range) | `m` | 58.7 mm = 0.0587 m; 145 km = 145000 m |
| displacement, tank | `m3` | 155 cc = 1.55e-4 m3; 10 L = 0.01 m3 |
| drag area CdA | `m2` | |
| power | `W` | 1 PS = 735.49875 W; 1 bhp = 745.7 W; 1 kW = 1000 W |
| torque | `N.m` | |
| engine / motor / axis speed | `rad/s` | 1 rpm = 2π/60 rad/s |
| road speed | `m/s` | 1 km/h = 1/3.6 m/s |
| energy (battery) | `J` | 1 kWh = 3.6e6 J |
| heating value | `J/kg`, `J/m3` | 1 MJ/kg = 1e6 J/kg |
| density | `kg/m3` | |
| pressure (friction mep) | `Pa` | 1 bar = 1e5 Pa |
| voltage | `V` | |
| emission limit | `kg/m` | 1 g/km = 1e-6 kg/m |
| ratios, counts, Crr, efficiencies, RON | `1` | 20 % = 0.2 |

## Every value carries provenance and confidence

A number is `{ value, unit, source, confidence, method, published?, note?, uncertainty? }`;
a category, text or yes/no is the same without `unit`. Rules (all enforced):

- `source` is the id of an entry in the file's `sources`. Web sources need
  `url` + `accessed`; books and standards need `citation`; an
  `engineering_estimate` states its `rationale`; a `class_default` source
  names the class-default bundle in `class_ref`.
- `confidence` is 0–1. `method` is one of `published`, `measured`, `derived`,
  `estimated`, `class_default`, `calibrated`.
- `published` values quote the published text verbatim, before conversion,
  so a reviewer can check the arithmetic. They can't cite an estimate.
- `estimated` and `class_default` values must give an `uncertainty`
  (`normal` sd, `lognormal` sigma_ln, or `uniform` min/max) and can't claim
  more than 0.6 / 0.5 confidence.
- Priors (`cda`, `crr`, `mass`, drivetrain and Willans terms) always carry an
  uncertainty: they are starting points for cloud calibration.
- Drag is a **CdA prior** in m². A `cd`, `drag_coefficient` or
  `frontal_area` field is rejected.

## Physics checks

Beyond units and ranges the validator rejects, among others: redline at or
below idle; peak torque below idle, after the power peak, or past the
redline; peak power that needs more torque than the peak torque
(P ≤ T·ω, 3 % rounding allowance); bore × stroke that misses the
displacement by over 3 %; BMEP, specific power or mean piston speed beyond
any production engine; gear ratios that don't strictly fall; a top speed the
gearing can't reach at redline; a rolling radius that doesn't fit the tyre
code; an EV whose rated power exceeds its peak, whose usable energy exceeds
its gross energy, or whose claimed range beats the rolling-resistance floor;
a mass prior more than 30 % from the kerb mass. A contradiction that rests on
an estimate is a warning rather than an error.

## Fuel safety

- A variant's fuel `compatibility` lists grades with status `certified`,
  `not_certified` or `unverified`. **Only `certified` may ever be suggested.**
- `certified` must be the manufacturer's published statement
  (`method: "published"`, confidence ≥ 0.6).
- An engine must be certified for at least one grade, or it is rejected.
- Blends above E20 can only be certified when `flex_fuel` is true (see
  `hero.splendor-plus-flex-fuel.2026`, certified E20–E85).
- `reference_grade` is the fuel the energy figures assume; on a variant it
  must be a certified grade.
- An EV has `fuel.required: false`, no tank, and certifies nothing.
- A class default describes a class, not a vehicle: it certifies no fuel, so
  advice for an unknown bike never names one.

## Class defaults

`class-defaults/` holds one complete bundle for every powertrain
(`ice_manual`, `ice_cvt`, `ev`) × segment (`commuter`, `scooter`, `cruiser`,
`naked`, `sport`, `adventure`), so a search for an unknown bike always
returns something, labelled as an estimate. The catalog check fails if one
is missing. Where seed variants exist the defaults are their rounded
medians; elsewhere they are engineering estimates with wide uncertainty.
Variants take their priors, unpublished CVT ratios and unpublished gearing
(when the gear count matches) from their class default, with
`method: "class_default"`.

## Adding a variant

1. Copy the closest file in `bikes/`; name it `<make>.<model>.<year>.json`
   and set `id` to match.
2. Cite every source you read. Enter manufacturer figures as `published`,
   converted to SI, with the verbatim text.
3. Keep estimates honest: `estimated` + an uncertainty + a note on how.
4. Fuel: copy the manufacturer's E20 / flex-fuel statement as `published`;
   anything you can't find is `unverified`.
5. `npm run bikes:validate -- --debt` and `npm test` must pass. When someone
   has checked every figure against its source, set
   `record.review_status: "reviewed"` and `record.reviewed_by`.

## Status of the seed data (2026-10-03)

21 variants and 18 class defaults, all `unreviewed`. The manufacturer and
press pages were read through web-search extracts rather than opened
directly, so each source carries a note to confirm its figures against the
page before review. Values no manufacturer publishes (idle and redline
speeds, most gear ratios and sprockets, CVT ratios, EV reductions, usable
battery energy) are estimates. `--debt` lists all 112 of them; they are what
calibration and future sourcing should replace first.
