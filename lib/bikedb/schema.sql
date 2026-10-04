-- ============================================================================
-- MapUnite bike catalogue — SQLite schema v1 (lib/bikedb/schema.sql)
-- ============================================================================
-- bikes.sqlite is a BUILD OUTPUT. scripts/build-bike-catalog.mjs creates it
-- from the reviewable JSON files in data/bikes/ (the source of truth); nobody
-- edits it by hand. The server uses it for search (FTS5) and to serve bundles.
-- Phones and the website never open it: they get catalog.json and
-- bundles/<hash>.json, written by the same build.
--
-- Design:
--   * Strict SI. Every number a program reads (value, vals, tol, mean, sigma,
--     omega_*, scale, ranges) is SI: rad/s not rpm, m3 not cm3/L, J not kWh,
--     W not kW, m/s not km/h, Pa not kPa. The figures as published (rpm, cm3,
--     kW …) are kept only in published_* columns, for human review against the
--     source documents. Conversions come from SI_UNITS in bundle-contract.js.
--     The server and the physics core read the SI columns, or the v_*_si views.
--   * Normalised. A unit lives once, in `field`; a make once, in `make`.
--     Values reference their source and carry a confidence, exactly like the
--     JSON contract (public/js/bikedb/bundle-contract.js).
--   * Priors are stored only where a file states them. A variant inherits the
--     rest from its class default, resolved by the v_resolved_prior view
--     rather than copied.
--   * `advisable` in fuel_compat is computed by the contract's
--     isFuelAdvisable() at build time, so the server never re-implements the
--     fuel-safety rule.
--   * `bundle.body` holds the runtime bundle byte-for-byte as written to
--     bundles/<hash>.json, so the server can serve it without the files.
--   * STRICT tables (SQLite ≥ 3.37): a wrong type is an error, not a silent
--     conversion.
--
-- Version: PRAGMA user_version. Bump it (and meta 'db_format') on any change
-- to this file.
-- ============================================================================

PRAGMA user_version = 2;
PRAGMA application_id = 1297433163;          -- 0x4D55424B, "MUBK": identifies the file as a MapUnite bike DB

-- ---------------------------------------------------------------------------
-- Build metadata: db_format, schema_version (contract), catalog_version,
-- input_hash, sqlite_version. No timestamps, so the same input gives the same file.
-- ---------------------------------------------------------------------------
CREATE TABLE meta (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
) STRICT, WITHOUT ROWID;

-- ---------------------------------------------------------------------------
-- The contract's FIELDS table: every technical field, its canonical unit and
-- plausible range. spec_value and prior reference it.
-- ---------------------------------------------------------------------------
CREATE TABLE field (
    path           TEXT PRIMARY KEY,                              -- 'engine.peakPower'
    grp            TEXT NOT NULL CHECK (grp IN ('engine', 'motor', 'battery', 'transmission', 'chassis', 'emission', 'fuel', 'priors')),
    value_type     TEXT NOT NULL CHECK (value_type IN ('q', 'qa', 'c', 'p')),   -- quantity, quantity array, categorical, prior
    unit           TEXT,                                          -- SI unit ('W', 'rad/s', 'm3' …); NULL for categorical fields
    published_unit TEXT,                                          -- unit the data files use ('kW', 'rpm', 'cm3' …)
    si_factor      REAL,                                          -- SI value = published value × si_factor
    range_min      REAL,                                          -- plausible range, SI
    range_max      REAL,
    doc            TEXT NOT NULL,
    CHECK (path = grp || '.' || substr(path, length(grp) + 2)),
    CHECK ((value_type = 'c') = (unit IS NULL)),
    CHECK ((unit IS NULL) = (published_unit IS NULL) AND (unit IS NULL) = (si_factor IS NULL)),
    CHECK (si_factor IS NULL OR si_factor > 0),
    CHECK (range_min IS NULL OR range_max IS NULL OR range_min <= range_max)
) STRICT, WITHOUT ROWID;

-- ---------------------------------------------------------------------------
-- Identity
-- ---------------------------------------------------------------------------
CREATE TABLE make (
    make_id INTEGER PRIMARY KEY,
    name    TEXT NOT NULL UNIQUE CHECK (length(name) BETWEEN 1 AND 60)
) STRICT;

CREATE TABLE model (
    model_id INTEGER PRIMARY KEY,
    make_id  INTEGER NOT NULL REFERENCES make (make_id),
    name     TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 60),
    UNIQUE (make_id, name)
) STRICT;
CREATE INDEX model_by_make ON model (make_id);

-- Valid powertrain × segment combinations (the contract's CLASS_MATRIX).
CREATE TABLE vehicle_class (
    class_key  TEXT PRIMARY KEY,
    powertrain TEXT NOT NULL CHECK (powertrain IN ('ice_manual', 'ice_cvt', 'ev')),
    segment    TEXT NOT NULL CHECK (segment IN ('commuter', 'naked', 'sport', 'adventure', 'cruiser', 'scooter', 'maxi_scooter')),
    UNIQUE (powertrain, segment),
    CHECK (class_key = powertrain || '.' || segment)
) STRICT, WITHOUT ROWID;

-- One row per file in data/bikes/variants/ and data/bikes/class-defaults/.
-- Files in data/bikes/pending/ are never built.
CREATE TABLE bundle (
    bundle_id      INTEGER PRIMARY KEY,
    slug           TEXT NOT NULL UNIQUE CHECK (length(slug) BETWEEN 1 AND 80),     -- the file id, e.g. 'royal-enfield-hunter-350-metro-in'
    kind           TEXT NOT NULL CHECK (kind IN ('variant', 'class_default')),
    class_key      TEXT NOT NULL REFERENCES vehicle_class (class_key),
    model_id       INTEGER REFERENCES model (model_id),                            -- NULL for class defaults
    variant_name   TEXT,
    title          TEXT NOT NULL,                                                  -- display name: make, model and variant
    market         TEXT NOT NULL CHECK (length(market) = 2 AND market = upper(market)),
    year_from      INTEGER NOT NULL CHECK (year_from BETWEEN 1950 AND 2100),
    year_to        INTEGER CHECK (year_to IS NULL OR year_to BETWEEN year_from AND 2100),   -- NULL = on sale
    schema_version TEXT NOT NULL,
    image_url      TEXT CHECK (image_url IS NULL OR (image_url GLOB 'https://?*' AND length(image_url) <= 500)),   -- bike picker picture; NULL until sourced
    hash           TEXT NOT NULL UNIQUE CHECK (length(hash) = 16 AND hash NOT GLOB '*[^0-9a-f]*'),
    body           TEXT NOT NULL CHECK (json_valid(body)),                         -- the runtime bundle, as served
    CHECK ((kind = 'variant') = (model_id IS NOT NULL)),
    UNIQUE (bundle_id, class_key, kind)                                            -- target of class_default's FK
) STRICT;
CREATE INDEX bundle_by_model ON bundle (model_id);
CREATE INDEX bundle_by_class ON bundle (class_key, kind);

-- Exactly one class default per class. The composite FK guarantees the row it
-- points at really is a class default OF THAT CLASS.
CREATE TABLE class_default (
    class_key TEXT PRIMARY KEY REFERENCES vehicle_class (class_key),
    bundle_id INTEGER NOT NULL UNIQUE,
    kind      TEXT NOT NULL DEFAULT 'class_default' CHECK (kind = 'class_default'),
    FOREIGN KEY (bundle_id, class_key, kind) REFERENCES bundle (bundle_id, class_key, kind)
) STRICT, WITHOUT ROWID;

CREATE TABLE alias (
    bundle_id INTEGER NOT NULL REFERENCES bundle (bundle_id),
    ord       INTEGER NOT NULL CHECK (ord >= 0),
    alias     TEXT NOT NULL CHECK (length(alias) BETWEEN 1 AND 60),
    PRIMARY KEY (bundle_id, ord)
) STRICT, WITHOUT ROWID;

-- ---------------------------------------------------------------------------
-- Provenance. Source ids are scoped to their file, as in the JSON.
-- ---------------------------------------------------------------------------
CREATE TABLE source (
    bundle_id  INTEGER NOT NULL REFERENCES bundle (bundle_id),
    source_key TEXT NOT NULL,                                                      -- the id inside the file
    ord        INTEGER NOT NULL CHECK (ord >= 0),
    kind       TEXT NOT NULL CHECK (kind IN ('manufacturer', 'owners_manual', 'service_manual', 'homologation', 'licensed_db',
                                             'aggregator', 'press', 'community', 'regulation', 'derived', 'estimated', 'class_prior')),
    title      TEXT NOT NULL,
    url        TEXT CHECK (url IS NULL OR url GLOB 'http*://*'),
    publisher  TEXT,
    retrieved  TEXT NOT NULL CHECK (retrieved GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
    note       TEXT,
    PRIMARY KEY (bundle_id, source_key),
    UNIQUE (bundle_id, ord)
) STRICT, WITHOUT ROWID;

-- ---------------------------------------------------------------------------
-- Technical values (everything except priors, fuel approvals and curves).
-- Exactly one of value / vals / txt / flag is set:
--   value  quantity, SI (unit in field.unit)    vals  quantity array, SI, JSON
--   txt    categorical string                   flag  categorical boolean (0/1)
-- tol is SI too. published_value / published_vals / published_tol keep the
-- figure as printed (unit in field.published_unit) for human review only.
-- qualifier holds the field's extra attribute: chassis.mass basis,
-- motor.peakTorque at, battery.certifiedRange cycle.
-- ---------------------------------------------------------------------------
CREATE TABLE spec_value (
    bundle_id        INTEGER NOT NULL REFERENCES bundle (bundle_id),
    path             TEXT NOT NULL REFERENCES field (path),
    value            REAL,
    vals             TEXT CHECK (vals IS NULL OR (json_valid(vals) AND json_type(vals) = 'array')),
    txt              TEXT,
    flag             INTEGER CHECK (flag IS NULL OR flag IN (0, 1)),
    tol              REAL CHECK (tol IS NULL OR tol >= 0),
    qualifier        TEXT,
    source_key       TEXT NOT NULL,
    conf             REAL NOT NULL CHECK (conf BETWEEN 0 AND 1),
    note             TEXT,
    published_value  REAL,
    published_vals   TEXT CHECK (published_vals IS NULL OR (json_valid(published_vals) AND json_type(published_vals) = 'array')),
    published_tol    REAL,
    PRIMARY KEY (bundle_id, path),
    FOREIGN KEY (bundle_id, source_key) REFERENCES source (bundle_id, source_key),
    CHECK ((value IS NOT NULL) + (vals IS NOT NULL) + (txt IS NOT NULL) + (flag IS NOT NULL) = 1),
    CHECK ((value IS NULL) = (published_value IS NULL)),
    CHECK ((vals IS NULL) = (published_vals IS NULL)),
    CHECK ((tol IS NULL) = (published_tol IS NULL)),
    CHECK (path NOT LIKE 'priors.%')
) STRICT, WITHOUT ROWID;
CREATE INDEX spec_value_by_path ON spec_value (path, value);

-- Uncertain model parameters, only where a file states them. mean and sigma are SI.
CREATE TABLE prior (
    bundle_id        INTEGER NOT NULL REFERENCES bundle (bundle_id),
    path             TEXT NOT NULL REFERENCES field (path),
    mean             REAL NOT NULL,
    sigma            REAL NOT NULL CHECK (sigma > 0),                              -- a prior with no uncertainty would be a claim of exactness
    source_key       TEXT NOT NULL,
    conf             REAL NOT NULL CHECK (conf BETWEEN 0 AND 1),
    note             TEXT,
    published_mean   REAL NOT NULL,
    published_sigma  REAL NOT NULL,
    PRIMARY KEY (bundle_id, path),
    FOREIGN KEY (bundle_id, source_key) REFERENCES source (bundle_id, source_key),
    CHECK (path LIKE 'priors.%'),
    CHECK (mean = 0 OR sigma < abs(mean))
) STRICT, WITHOUT ROWID;

-- Digitised torque / power curves: value at omega_start + i·omega_step = data[i] × scale (SI).
CREATE TABLE curve (
    bundle_id           INTEGER NOT NULL REFERENCES bundle (bundle_id),
    kind                TEXT NOT NULL CHECK (kind IN ('torque', 'power')),
    omega_start         REAL NOT NULL CHECK (omega_start >= 0),                    -- rad/s
    omega_step          REAL NOT NULL CHECK (omega_step > 0),                      -- rad/s
    scale               REAL NOT NULL CHECK (scale > 0),                           -- SI per data unit
    unit                TEXT NOT NULL CHECK (unit IN ('N*m', 'W')),
    published_rpm_start INTEGER NOT NULL CHECK (published_rpm_start BETWEEN 0 AND 15000),
    published_rpm_step  INTEGER NOT NULL CHECK (published_rpm_step BETWEEN 50 AND 2000),
    published_scale     REAL NOT NULL CHECK (published_scale > 0),
    published_unit      TEXT NOT NULL CHECK (published_unit IN ('N*m', 'kW')),
    data                TEXT NOT NULL CHECK (json_valid(data) AND json_type(data) = 'array'),
    method     TEXT NOT NULL CHECK (method IN ('manufacturer', 'digitized_dyno', 'measured', 'synthesized')),
    source_key TEXT NOT NULL,
    conf       REAL NOT NULL CHECK (conf BETWEEN 0 AND 1),
    note       TEXT,
    PRIMARY KEY (bundle_id, kind),
    FOREIGN KEY (bundle_id, source_key) REFERENCES source (bundle_id, source_key)
) STRICT, WITHOUT ROWID;

CREATE TABLE note (
    bundle_id INTEGER NOT NULL REFERENCES bundle (bundle_id),
    ord       INTEGER NOT NULL CHECK (ord >= 0),
    text      TEXT NOT NULL,
    PRIMARY KEY (bundle_id, ord)
) STRICT, WITHOUT ROWID;

-- ---------------------------------------------------------------------------
-- Reference tables (data/bikes/reference/), with their own sources.
-- ---------------------------------------------------------------------------
CREATE TABLE ref_source (
    ref_table  TEXT NOT NULL CHECK (ref_table IN ('fuel-grades', 'emission-standards')),
    source_key TEXT NOT NULL,
    ord        INTEGER NOT NULL CHECK (ord >= 0),
    kind       TEXT NOT NULL,
    title      TEXT NOT NULL,
    url        TEXT,
    publisher  TEXT,
    retrieved  TEXT NOT NULL,
    note       TEXT,
    PRIMARY KEY (ref_table, source_key)
) STRICT, WITHOUT ROWID;

CREATE TABLE fuel_grade (
    code                 TEXT PRIMARY KEY CHECK (code GLOB 'E[0-9]*' AND substr(code, 2) NOT GLOB '*[^0-9]*'),
    ord                  INTEGER NOT NULL UNIQUE,
    ethanol_vol_fraction REAL NOT NULL CHECK (ethanol_vol_fraction BETWEEN 0 AND 1),
    flex_fuel_blend      INTEGER NOT NULL CHECK (flex_fuel_blend IN (0, 1)),
    CHECK (flex_fuel_blend = (ethanol_vol_fraction >= 0.5))
) STRICT, WITHOUT ROWID;

CREATE TABLE fuel_grade_property (
    code            TEXT NOT NULL REFERENCES fuel_grade (code),
    property        TEXT NOT NULL CHECK (property IN ('lhv', 'density', 'typicalRon')),
    value           REAL NOT NULL,                                                 -- SI: J/m3, kg/m3, 1
    unit            TEXT NOT NULL,
    published_value REAL NOT NULL,                                                 -- as published: MJ/L, kg/L, RON
    published_unit  TEXT NOT NULL,
    ref_table  TEXT NOT NULL DEFAULT 'fuel-grades' CHECK (ref_table = 'fuel-grades'),
    source_key TEXT NOT NULL,
    conf       REAL NOT NULL CHECK (conf BETWEEN 0 AND 1),
    note       TEXT,
    PRIMARY KEY (code, property),
    FOREIGN KEY (ref_table, source_key) REFERENCES ref_source (ref_table, source_key),
    CHECK ((property = 'lhv' AND unit = 'J/m3' AND published_unit = 'MJ/L') OR (property = 'density' AND unit = 'kg/m3' AND published_unit = 'kg/L')
        OR (property = 'typicalRon' AND unit = '1' AND published_unit = 'RON'))
) STRICT, WITHOUT ROWID;

CREATE TABLE obd_level (
    code           TEXT PRIMARY KEY,
    name           TEXT NOT NULL,
    effective_from TEXT NOT NULL CHECK (effective_from GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
    ref_table      TEXT NOT NULL DEFAULT 'emission-standards' CHECK (ref_table = 'emission-standards'),
    source_key     TEXT NOT NULL,
    conf           REAL NOT NULL CHECK (conf BETWEEN 0 AND 1),
    note           TEXT,
    FOREIGN KEY (ref_table, source_key) REFERENCES ref_source (ref_table, source_key)
) STRICT, WITHOUT ROWID;

CREATE TABLE emission_standard (
    code            TEXT PRIMARY KEY,
    name            TEXT NOT NULL,
    region          TEXT NOT NULL,
    effective_from  TEXT NOT NULL CHECK (effective_from GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
    superseded_from TEXT CHECK (superseded_from IS NULL OR superseded_from > effective_from),
    obd_at_intro    TEXT REFERENCES obd_level (code),
    ref_table       TEXT NOT NULL DEFAULT 'emission-standards' CHECK (ref_table = 'emission-standards'),
    source_key      TEXT NOT NULL,
    conf            REAL NOT NULL CHECK (conf BETWEEN 0 AND 1),
    note            TEXT,
    FOREIGN KEY (ref_table, source_key) REFERENCES ref_source (ref_table, source_key)
) STRICT, WITHOUT ROWID;

-- ---------------------------------------------------------------------------
-- Fuel approvals, as the sources state them. `advisable` = the contract's
-- isFuelAdvisable(): the only column the app or server may use to RECOMMEND a fuel.
-- ---------------------------------------------------------------------------
CREATE TABLE fuel_compat (
    bundle_id  INTEGER NOT NULL REFERENCES bundle (bundle_id),
    fuel_code  TEXT NOT NULL REFERENCES fuel_grade (code),
    ord        INTEGER NOT NULL CHECK (ord >= 0),
    status     TEXT NOT NULL CHECK (status IN ('certified', 'compatible', 'not_approved', 'unknown')),
    source_key TEXT NOT NULL,
    conf       REAL NOT NULL CHECK (conf BETWEEN 0 AND 1),
    note       TEXT,
    advisable  INTEGER NOT NULL CHECK (advisable IN (0, 1)),
    PRIMARY KEY (bundle_id, fuel_code),
    UNIQUE (bundle_id, ord),
    FOREIGN KEY (bundle_id, source_key) REFERENCES source (bundle_id, source_key),
    CHECK (advisable = 0 OR status IN ('certified', 'compatible'))
) STRICT, WITHOUT ROWID;
CREATE INDEX fuel_compat_by_fuel ON fuel_compat (fuel_code, advisable);

-- ---------------------------------------------------------------------------
-- Full-text search over variants (class defaults are offered by class, not by
-- name). Contentless: it stores only the index, and rowid = bundle.bundle_id.
-- The columns hold tokens already normalised by indexTokens() in
-- public/js/bikedb/catalog-search.js, and queries are built by toFtsQuery() from
-- the same file, so the server and the in-app index match the same bikes.
-- ---------------------------------------------------------------------------
CREATE VIRTUAL TABLE bundle_search USING fts5(
    make, model, variant, aliases,
    content = '',
    tokenize = 'unicode61 remove_diacritics 2',
    prefix = '1 2 3'
);

-- ---------------------------------------------------------------------------
-- Views
-- ---------------------------------------------------------------------------
-- One row per searchable variant: what a search result needs.
CREATE VIEW v_variant AS
SELECT b.bundle_id,
       b.slug,
       mk.name       AS make,
       md.name       AS model,
       b.variant_name,
       b.title,
       b.market,
       b.year_from,
       b.year_to,
       b.class_key,
       vc.powertrain,
       vc.segment,
       b.hash,
       b.image_url,
       disp.value    AS displacement_m3,
       batt.value    AS battery_gross_j
FROM bundle b
JOIN model md          ON md.model_id = b.model_id
JOIN make mk           ON mk.make_id = md.make_id
JOIN vehicle_class vc  ON vc.class_key = b.class_key
LEFT JOIN spec_value disp ON disp.bundle_id = b.bundle_id AND disp.path = 'engine.displacement'
LEFT JOIN spec_value batt ON batt.bundle_id = b.bundle_id AND batt.path = 'battery.grossCapacity'
WHERE b.kind = 'variant';

-- Every technical value in SI, with its SI unit: what the server and the physics read.
CREATE VIEW v_spec_si AS
SELECT sv.bundle_id,
       sv.path,
       sv.value,
       sv.vals,
       f.unit,
       sv.txt,
       sv.flag,
       sv.tol,
       sv.qualifier,
       sv.source_key,
       sv.conf
FROM spec_value sv
JOIN field f ON f.path = sv.path;

-- Every prior a bundle uses, in SI: its own, else its class default's.
-- source_bundle_id says whose sources[] the source_key belongs to.
CREATE VIEW v_resolved_prior AS
SELECT b.bundle_id,
       f.path,
       COALESCE(own.mean, dflt.mean)             AS mean,
       COALESCE(own.sigma, dflt.sigma)           AS sigma,
       f.unit,
       COALESCE(own.source_key, dflt.source_key) AS source_key,
       COALESCE(own.conf, dflt.conf)             AS conf,
       CASE WHEN own.bundle_id IS NULL THEN dflt.note ELSE own.note END AS note,
       CASE WHEN own.bundle_id IS NULL THEN 1 ELSE 0 END                AS inherited,
       CASE WHEN own.bundle_id IS NULL THEN cd.bundle_id ELSE b.bundle_id END AS source_bundle_id
FROM bundle b
JOIN class_default cd ON cd.class_key = b.class_key
JOIN field f          ON f.grp = 'priors'
LEFT JOIN prior own   ON own.bundle_id = b.bundle_id AND own.path = f.path
LEFT JOIN prior dflt  ON dflt.bundle_id = cd.bundle_id AND dflt.path = f.path
WHERE own.bundle_id IS NOT NULL OR dflt.bundle_id IS NOT NULL;

-- Fuel approvals with the source behind each, for the server and for review.
CREATE VIEW v_fuel_advice AS
SELECT b.slug,
       fc.fuel_code,
       fc.status,
       fc.conf,
       s.kind  AS source_kind,
       s.title AS source_title,
       fc.advisable
FROM fuel_compat fc
JOIN bundle b ON b.bundle_id = fc.bundle_id
JOIN source s ON s.bundle_id = fc.bundle_id AND s.source_key = fc.source_key;
