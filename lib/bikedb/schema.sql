-- ============================================================================
-- MapUnite bike database — lib/bikedb/schema.sql            (schema format 1)
-- ============================================================================
-- Compiled by scripts/build-bike-catalog.mjs from the reviewed JSON in
-- data/bikes/. Never edit bikes.sqlite by hand: change the JSON and rebuild.
--
-- Conventions
--   * Strict SI throughout: m, m3, kg, W, N*m, rad/s, m/s, J, Pa, J/m3, kg/m3.
--     Each value also keeps the figure as published (source_value), in the
--     source unit named by `field.source_unit`, so a reviewer can trace it.
--   * Every value row carries provenance: source_pk (-> source) and conf
--     (0..1). There is no value without both.
--   * Units depend only on the field, so they live once in `field`, not on
--     every row (3NF). Array values (gear ratios) are split into one row per
--     element under a single provenance header (measure -> measure_value).
--   * STRICT tables: SQLite rejects a value of the wrong type instead of
--     coercing it. Needs SQLite >= 3.37 (Node's node:sqlite, better-sqlite3 11).
--   * Fuel safety is enforced here too, as triggers, so no tool writing to
--     this file can mark a class default as certified or advise a fuel the
--     contract wouldn't (public/js/bikedb/bundle-contract.js is the source of
--     the rules; its thresholds are copied into `meta` by the build).
-- ============================================================================

PRAGMA foreign_keys = ON;

-- ---------------------------------------------------------------------------
-- Build metadata: schema/contract versions, catalog version, unit system and
-- the fuel thresholds the triggers read (so they are never duplicated in SQL).
-- ---------------------------------------------------------------------------
CREATE TABLE meta (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
) STRICT, WITHOUT ROWID;

-- ---------------------------------------------------------------------------
-- Provenance
-- ---------------------------------------------------------------------------
-- One row per distinct document, shared by every bundle that cites it.
CREATE TABLE source (
    source_pk     INTEGER PRIMARY KEY,
    kind          TEXT    NOT NULL CHECK (kind IN (
                      'manufacturer', 'owners_manual', 'service_manual', 'homologation', 'licensed_db',
                      'aggregator', 'press', 'community', 'regulation', 'derived', 'estimated', 'class_prior')),
    title         TEXT    NOT NULL CHECK (length(title) >= 3),
    url           TEXT    CHECK (url IS NULL OR url GLOB 'http://*' OR url GLOB 'https://*'),
    publisher     TEXT,
    retrieved     TEXT    NOT NULL CHECK (retrieved GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
    note          TEXT,
    -- Only these kinds can back a fuel recommendation (contract AUTHORITATIVE_KINDS).
    authoritative INTEGER GENERATED ALWAYS AS (
                      kind IN ('manufacturer', 'owners_manual', 'service_manual', 'homologation', 'licensed_db')) VIRTUAL
) STRICT;
CREATE UNIQUE INDEX source_identity ON source (
    kind, title, ifnull(url, ''), ifnull(publisher, ''), retrieved, ifnull(note, ''));

-- ---------------------------------------------------------------------------
-- Field registry: every value path, its type and its units
-- ---------------------------------------------------------------------------
CREATE TABLE field (
    path        TEXT PRIMARY KEY,                    -- e.g. 'engine.peakPowerRpm', 'fuel_grade.lhv'
    value_type  TEXT NOT NULL CHECK (value_type IN ('q', 'qa', 'c', 'p')),  -- quantity, quantity array, categorical, prior
    si_unit     TEXT,                                -- unit of every stored value, e.g. 'rad/s'
    source_unit TEXT,                                -- unit of source_value, e.g. 'rpm'
    qualifier   TEXT,                                -- name of the qualifier column's meaning, e.g. 'basis', 'at', 'cycle'
    doc         TEXT NOT NULL,
    CHECK ((value_type = 'c') = (si_unit IS NULL)),
    CHECK ((si_unit IS NULL) = (source_unit IS NULL))
) STRICT, WITHOUT ROWID;

-- ---------------------------------------------------------------------------
-- Taxonomy
-- ---------------------------------------------------------------------------
CREATE TABLE make (
    make_pk INTEGER PRIMARY KEY,
    name    TEXT NOT NULL UNIQUE COLLATE NOCASE
) STRICT;

CREATE TABLE model (
    model_pk INTEGER PRIMARY KEY,
    make_pk  INTEGER NOT NULL REFERENCES make (make_pk),
    name     TEXT    NOT NULL COLLATE NOCASE,
    UNIQUE (make_pk, name)
) STRICT;

CREATE TABLE vehicle_class (
    class_key  TEXT PRIMARY KEY,
    powertrain TEXT NOT NULL CHECK (powertrain IN ('ice_manual', 'ice_cvt', 'ev')),
    segment    TEXT NOT NULL CHECK (segment IN ('commuter', 'naked', 'sport', 'adventure', 'cruiser', 'scooter', 'maxi_scooter')),
    UNIQUE (powertrain, segment),
    CHECK (class_key = powertrain || '.' || segment)
) STRICT, WITHOUT ROWID;

-- ---------------------------------------------------------------------------
-- Bundles: one per variant and one class default per vehicle_class
-- ---------------------------------------------------------------------------
CREATE TABLE bundle (
    bundle_id       TEXT    PRIMARY KEY CHECK (bundle_id NOT GLOB '*[^a-z0-9-]*' AND length(bundle_id) BETWEEN 1 AND 80),
    kind            TEXT    NOT NULL CHECK (kind IN ('variant', 'class_default')),
    class_key       TEXT    NOT NULL REFERENCES vehicle_class (class_key),
    model_pk        INTEGER REFERENCES model (model_pk),          -- variants only
    variant_name    TEXT,                                         -- e.g. 'STD / DLX (Aug 2025 update)'
    class_label     TEXT,                                         -- class defaults only, e.g. '110–125 cc commuter motorcycle'
    market          TEXT    NOT NULL CHECK (length(market) = 2 AND market NOT GLOB '*[^A-Z]*'),
    year_from       INTEGER NOT NULL CHECK (year_from BETWEEN 1950 AND 2100),
    year_to         INTEGER CHECK (year_to IS NULL OR year_to BETWEEN year_from AND 2100),
    -- Picture for the bike picker. NULL until one is sourced (never guessed);
    -- the app then shows the segment silhouette.
    image_url       TEXT    CHECK (image_url IS NULL OR image_url GLOB 'https://*'),
    image_source_pk INTEGER REFERENCES source (source_pk),
    image_conf      REAL    CHECK (image_conf IS NULL OR image_conf BETWEEN 0 AND 1),
    content_hash    TEXT    NOT NULL UNIQUE CHECK (length(content_hash) = 16 AND content_hash NOT GLOB '*[^0-9a-f]*'),
    schema_version  TEXT    NOT NULL,
    CHECK ((kind = 'variant') = (model_pk IS NOT NULL)),
    CHECK ((kind = 'class_default') = (class_label IS NOT NULL)),
    CHECK ((image_url IS NULL) = (image_source_pk IS NULL) AND (image_url IS NULL) = (image_conf IS NULL))
) STRICT, WITHOUT ROWID;
CREATE UNIQUE INDEX bundle_one_default_per_class ON bundle (class_key) WHERE kind = 'class_default';
CREATE INDEX bundle_by_class ON bundle (class_key, kind);
CREATE INDEX bundle_by_model ON bundle (model_pk);

-- A bundle's own source ids (as written in its JSON) -> the shared source row.
CREATE TABLE bundle_source (
    bundle_id TEXT    NOT NULL REFERENCES bundle (bundle_id) ON DELETE CASCADE,
    local_id  TEXT    NOT NULL,
    source_pk INTEGER NOT NULL REFERENCES source (source_pk),
    PRIMARY KEY (bundle_id, local_id)
) STRICT, WITHOUT ROWID;
CREATE INDEX bundle_source_by_source ON bundle_source (source_pk);

CREATE TABLE alias (
    bundle_id TEXT NOT NULL REFERENCES bundle (bundle_id) ON DELETE CASCADE,
    alias     TEXT NOT NULL COLLATE NOCASE,
    PRIMARY KEY (bundle_id, alias)
) STRICT, WITHOUT ROWID;
CREATE INDEX alias_by_name ON alias (alias);

CREATE TABLE bundle_note (
    bundle_id TEXT    NOT NULL REFERENCES bundle (bundle_id) ON DELETE CASCADE,
    seq       INTEGER NOT NULL CHECK (seq >= 0),
    text      TEXT    NOT NULL,
    PRIMARY KEY (bundle_id, seq)
) STRICT, WITHOUT ROWID;

-- ---------------------------------------------------------------------------
-- Values
-- ---------------------------------------------------------------------------
-- Numeric values (field types 'q' and 'qa'): provenance header ...
CREATE TABLE measure (
    bundle_id TEXT    NOT NULL REFERENCES bundle (bundle_id) ON DELETE CASCADE,
    path      TEXT    NOT NULL REFERENCES field (path),
    tol       REAL    CHECK (tol IS NULL OR tol >= 0),            -- ± tolerance, SI
    qualifier TEXT,                                               -- e.g. mass basis 'kerb', torque at 'wheel', range cycle 'IDC'
    source_pk INTEGER NOT NULL REFERENCES source (source_pk),
    conf      REAL    NOT NULL CHECK (conf BETWEEN 0 AND 1),
    note      TEXT,
    PRIMARY KEY (bundle_id, path)
) STRICT, WITHOUT ROWID;
CREATE INDEX measure_by_path ON measure (path);

-- ... and its value(s): idx 0 for a scalar, 0..n-1 for an array (1st gear = 0).
CREATE TABLE measure_value (
    bundle_id    TEXT    NOT NULL,
    path         TEXT    NOT NULL,
    idx          INTEGER NOT NULL CHECK (idx >= 0),
    value        REAL    NOT NULL,                                -- SI (field.si_unit)
    source_value REAL    NOT NULL,                                -- as published (field.source_unit)
    PRIMARY KEY (bundle_id, path, idx),
    FOREIGN KEY (bundle_id, path) REFERENCES measure (bundle_id, path) ON DELETE CASCADE
) STRICT, WITHOUT ROWID;

-- Categorical values (cooling, motor type, tyre size, emission standard, image ...).
CREATE TABLE categorical (
    bundle_id TEXT    NOT NULL REFERENCES bundle (bundle_id) ON DELETE CASCADE,
    path      TEXT    NOT NULL REFERENCES field (path),
    value     TEXT    NOT NULL,                                   -- booleans as 'true' / 'false'
    source_pk INTEGER NOT NULL REFERENCES source (source_pk),
    conf      REAL    NOT NULL CHECK (conf BETWEEN 0 AND 1),
    note      TEXT,
    PRIMARY KEY (bundle_id, path)
) STRICT, WITHOUT ROWID;

-- Priors: uncertain model parameters (normal: mean ± sigma), SI. A variant
-- stores only the priors it overrides; resolved_prior fills in the rest from
-- its class default.
CREATE TABLE prior (
    bundle_id TEXT    NOT NULL REFERENCES bundle (bundle_id) ON DELETE CASCADE,
    path      TEXT    NOT NULL REFERENCES field (path),
    mean      REAL    NOT NULL,
    sigma     REAL    NOT NULL CHECK (sigma > 0 AND (mean = 0 OR sigma < abs(mean))),
    source_mean  REAL NOT NULL,
    source_sigma REAL NOT NULL,
    source_pk INTEGER NOT NULL REFERENCES source (source_pk),
    conf      REAL    NOT NULL CHECK (conf BETWEEN 0 AND 1),
    note      TEXT,
    PRIMARY KEY (bundle_id, path)
) STRICT, WITHOUT ROWID;

-- Quantised curves (torque N*m / power W over engine speed rad/s).
-- samples: little-endian int16 BLOB; value_i = int16_i * scale.
CREATE TABLE curve (
    bundle_id    TEXT    NOT NULL REFERENCES bundle (bundle_id) ON DELETE CASCADE,
    kind         TEXT    NOT NULL CHECK (kind IN ('torque', 'power')),
    axis_start   REAL    NOT NULL CHECK (axis_start >= 0),        -- rad/s
    axis_step    REAL    NOT NULL CHECK (axis_step > 0),          -- rad/s
    scale        REAL    NOT NULL CHECK (scale > 0),              -- SI units per count
    sample_count INTEGER NOT NULL CHECK (sample_count BETWEEN 4 AND 64),
    samples      BLOB    NOT NULL CHECK (length(samples) = 2 * sample_count),
    method       TEXT    NOT NULL CHECK (method IN ('manufacturer', 'digitized_dyno', 'measured', 'synthesized')),
    source_pk    INTEGER NOT NULL REFERENCES source (source_pk),
    conf         REAL    NOT NULL CHECK (conf BETWEEN 0 AND 1),
    note         TEXT,
    PRIMARY KEY (bundle_id, kind)
) STRICT, WITHOUT ROWID;

-- ---------------------------------------------------------------------------
-- Reference tables
-- ---------------------------------------------------------------------------
CREATE TABLE fuel_grade (
    code                 TEXT    PRIMARY KEY CHECK (code GLOB 'E[0-9]*'),
    ethanol_vol_fraction REAL    NOT NULL CHECK (ethanol_vol_fraction BETWEEN 0 AND 1),
    flex_fuel_blend      INTEGER NOT NULL CHECK (flex_fuel_blend IN (0, 1))
) STRICT, WITHOUT ROWID;

-- lhv (J/m3), density (kg/m3), typical RON — units in `field` ('fuel_grade.*').
CREATE TABLE fuel_grade_property (
    code         TEXT    NOT NULL REFERENCES fuel_grade (code),
    path         TEXT    NOT NULL REFERENCES field (path),
    value        REAL    NOT NULL,
    source_value REAL    NOT NULL,
    source_pk    INTEGER NOT NULL REFERENCES source (source_pk),
    conf         REAL    NOT NULL CHECK (conf BETWEEN 0 AND 1),
    note         TEXT,
    PRIMARY KEY (code, path)
) STRICT, WITHOUT ROWID;

CREATE TABLE obd_level (
    code           TEXT    PRIMARY KEY,
    name           TEXT    NOT NULL,
    effective_from TEXT    NOT NULL CHECK (effective_from GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
    source_pk      INTEGER NOT NULL REFERENCES source (source_pk),
    conf           REAL    NOT NULL CHECK (conf BETWEEN 0 AND 1),
    note           TEXT
) STRICT, WITHOUT ROWID;

CREATE TABLE emission_standard (
    code            TEXT    PRIMARY KEY,
    name            TEXT    NOT NULL,
    region          TEXT    NOT NULL,
    effective_from  TEXT    NOT NULL CHECK (effective_from GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
    superseded_from TEXT    CHECK (superseded_from IS NULL OR superseded_from > effective_from),
    obd_at_intro    TEXT    REFERENCES obd_level (code),
    source_pk       INTEGER NOT NULL REFERENCES source (source_pk),
    conf            REAL    NOT NULL CHECK (conf BETWEEN 0 AND 1),
    note            TEXT
) STRICT, WITHOUT ROWID;

-- ---------------------------------------------------------------------------
-- Fuel compatibility (the safety-critical table)
-- ---------------------------------------------------------------------------
-- status is what the cited source says. `advisable` is computed by the
-- contract's isFuelAdvisable() at build time — the ONLY flag the app may use
-- to recommend a fuel. The triggers below re-check it independently.
CREATE TABLE fuel_compat (
    bundle_id TEXT    NOT NULL REFERENCES bundle (bundle_id) ON DELETE CASCADE,
    fuel_code TEXT    NOT NULL REFERENCES fuel_grade (code),
    status    TEXT    NOT NULL CHECK (status IN ('certified', 'compatible', 'not_approved', 'unknown')),
    source_pk INTEGER NOT NULL REFERENCES source (source_pk),
    conf      REAL    NOT NULL CHECK (conf BETWEEN 0 AND 1),
    note      TEXT,
    advisable INTEGER NOT NULL CHECK (advisable IN (0, 1)),
    CHECK (advisable = 0 OR status IN ('certified', 'compatible')),
    PRIMARY KEY (bundle_id, fuel_code)
) STRICT, WITHOUT ROWID;
CREATE INDEX fuel_compat_by_fuel ON fuel_compat (fuel_code, advisable);

-- Raised for any write that would break a fuel-safety rule.
CREATE VIEW fuel_compat_violation AS
SELECT fc.bundle_id, fc.fuel_code,
       CASE
           WHEN b.kind = 'class_default' AND fc.status = 'certified'
               THEN 'a class default cannot be certified for a fuel'
           WHEN b.kind = 'class_default' AND fc.advisable = 1
               THEN 'a class default can never be advised a fuel'
           WHEN fc.advisable = 1 AND s.authoritative = 0
               THEN 'advice needs a manufacturer, manual, homologation or licensed source'
           WHEN fc.advisable = 1 AND fc.conf < (SELECT CAST(value AS REAL) FROM meta WHERE key = 'advise_min_conf')
               THEN 'advice needs confidence >= advise_min_conf'
           WHEN fc.advisable = 1 AND g.flex_fuel_blend = 1 AND NOT EXISTS (
                    SELECT 1 FROM categorical c
                    WHERE c.bundle_id = fc.bundle_id AND c.path = 'engine.flexFuel' AND c.value = 'true')
               THEN 'a flex-fuel blend can only be advised for a certified flex-fuel engine'
       END AS problem
FROM fuel_compat fc
JOIN bundle b     ON b.bundle_id = fc.bundle_id
JOIN source s     ON s.source_pk = fc.source_pk
JOIN fuel_grade g ON g.code = fc.fuel_code;

CREATE TRIGGER fuel_compat_safety_insert AFTER INSERT ON fuel_compat
WHEN (SELECT problem FROM fuel_compat_violation
      WHERE bundle_id = NEW.bundle_id AND fuel_code = NEW.fuel_code) IS NOT NULL
BEGIN
    SELECT RAISE(ABORT, 'fuel safety: rejected fuel_compat row');
END;

CREATE TRIGGER fuel_compat_safety_update AFTER UPDATE ON fuel_compat
WHEN (SELECT problem FROM fuel_compat_violation
      WHERE bundle_id = NEW.bundle_id AND fuel_code = NEW.fuel_code) IS NOT NULL
BEGIN
    SELECT RAISE(ABORT, 'fuel safety: rejected fuel_compat row');
END;

-- Clearing a flex-fuel certification must not leave an E85/E100 advice behind.
CREATE TRIGGER flex_fuel_guard AFTER DELETE ON categorical
WHEN OLD.path = 'engine.flexFuel' AND EXISTS (
    SELECT 1 FROM fuel_compat fc JOIN fuel_grade g ON g.code = fc.fuel_code
    WHERE fc.bundle_id = OLD.bundle_id AND fc.advisable = 1 AND g.flex_fuel_blend = 1)
BEGIN
    SELECT RAISE(ABORT, 'fuel safety: bundle still advises a flex-fuel blend');
END;

-- ---------------------------------------------------------------------------
-- Views
-- ---------------------------------------------------------------------------
-- A variant's full prior set: its own, else its class default's.
CREATE VIEW resolved_prior AS
SELECT v.bundle_id, p.path, p.mean, p.sigma, p.source_pk, p.conf, 'variant' AS origin
FROM bundle v JOIN prior p ON p.bundle_id = v.bundle_id
WHERE v.kind = 'variant'
UNION ALL
SELECT v.bundle_id, p.path, p.mean, p.sigma, p.source_pk, p.conf, 'class_default' AS origin
FROM bundle v
JOIN bundle d ON d.class_key = v.class_key AND d.kind = 'class_default'
JOIN prior p  ON p.bundle_id = d.bundle_id
WHERE v.kind = 'variant'
  AND NOT EXISTS (SELECT 1 FROM prior o WHERE o.bundle_id = v.bundle_id AND o.path = p.path);

-- What the bike picker lists.
CREATE VIEW picker AS
SELECT b.bundle_id, b.kind, mk.name AS make, md.name AS model, b.variant_name, b.class_label,
       c.powertrain, c.segment, b.class_key, b.year_from, b.year_to, b.image_url, b.content_hash
FROM bundle b
JOIN vehicle_class c ON c.class_key = b.class_key
LEFT JOIN model md   ON md.model_pk = b.model_pk
LEFT JOIN make mk    ON mk.make_pk = md.make_pk;

-- ---------------------------------------------------------------------------
-- Full-text search (FTS5)
-- ---------------------------------------------------------------------------
-- One row per bundle. `keywords` holds the spellings people type that the
-- tokenizer can't derive: run-together ("mt15", "ns200", "rtr1604v") and
-- split at letter/digit boundaries ("ns 200", "450 x"); see
-- public/js/bikedb/search-keys.js, which builds both the rows and the queries.
-- Prefix indexes on 1-4 characters keep "type-ahead" prefix queries index-only.
-- Query with lib/bikedb/search.js (bm25 weights: title > aliases > keywords > make;
-- variants rank above class defaults).
CREATE VIRTUAL TABLE bike_search USING fts5 (
    bundle_id UNINDEXED,
    kind      UNINDEXED,
    title,
    aliases,
    keywords,
    make,
    tokenize = 'unicode61 remove_diacritics 2',
    prefix   = '1 2 3 4'
);
