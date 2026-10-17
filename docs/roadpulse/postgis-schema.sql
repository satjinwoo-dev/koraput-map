-- MapUnite RoadPulse: the PostgreSQL + PostGIS schema for the public launch.
-- The pilot runs on SQLite (lib/master/roadsense.js); this is the same model with real
-- spatial types. Checked against PostgreSQL 16 + PostGIS 3.4 (test/server/postgis-schema.test.mjs,
-- run with ROADPULSE_PG set).
--
-- RULES
--  * Every metre threshold is applied to GEOGRAPHY (or to a UTM projection: EPSG:32644 west of
--    84°E, EPSG:32645 east of it, for Odisha). Never compare metres against raw EPSG:4326
--    degrees: ST_DWithin(geometry_4326, geometry_4326, 15) means 15 DEGREES (~1,600 km).
--  * A "sensor candidate" never reaches this database: it lives on the phone until the rider
--    reviews it after the ride.
--  * Rider testimony (report, review_*) and sensor evidence (sensor_evidence) are separate
--    tables; agreement is computed from review_current WHERE counts only.
--  * No names, no routes, no IP addresses; contributor and device ids are keyed hashes.

CREATE EXTENSION IF NOT EXISTS postgis;

-- ---------------------------------------------------------------- identity
CREATE TABLE contributor (
  id          text PRIMARY KEY,                 -- HMAC(server secret, the phone's random contributor token)
  created_at  timestamptz NOT NULL DEFAULT now(),
  trust_tier  smallint NOT NULL DEFAULT 0,
  status      text NOT NULL DEFAULT 'active' CHECK (status IN ('active','suspended','deleted'))
);
CREATE TABLE contributor_alias (                -- what the public may see, if the rider chose a nickname
  contributor_id text NOT NULL REFERENCES contributor ON DELETE CASCADE,
  alias          text NOT NULL,
  kind           text NOT NULL CHECK (kind IN ('nickname','rotating')),
  valid_from     timestamptz NOT NULL DEFAULT now(),
  valid_to       timestamptz
);

-- ---------------------------------------------------------------- hazards
-- Identity = the PHYSICAL point (+ bearing). road_ref is a re-derivable cache of the map match.
CREATE TABLE hazard (
  id               text PRIMARY KEY,               -- 'h' + 16 hex
  public_type      text NOT NULL CHECK (public_type IN ('impact','rough')),
  internal_type    text NOT NULL CHECK (internal_type IN ('pothole','speed_breaker','bump','broken_patch','rough')),
  severity         smallint NOT NULL CHECK (severity BETWEEN 1 AND 3),
  geom             geography(Point, 4326) NOT NULL,
  sigma_m          real,
  bearing_deg      real CHECK (bearing_deg IS NULL OR (bearing_deg >= 0 AND bearing_deg < 360)),
  both_ways        boolean NOT NULL DEFAULT false,
  road_ref         jsonb,                          -- { wayId, version, alongM, lateralM, dir, carriageway, snapLat, snapLng }
  road_status      text NOT NULL DEFAULT 'none' CHECK (road_status IN ('none','ok','needs_resnap','unmatched')),
  state            text NOT NULL CHECK (state IN ('reviewed_report','community_confirmed','disputed','possibly_repaired','archived')),
  archived_reason  text CHECK (archived_reason IS NULL OR archived_reason IN ('repaired','expired')),
  epoch            integer NOT NULL DEFAULT 0,
  first_reported_at timestamptz NOT NULL,
  reporter         text,                           -- the epoch's first reporter (independence checks)
  reporter_device  text,
  fixed_at         timestamptz,                    -- official repair data
  updated_at       timestamptz NOT NULL DEFAULT now(),
  CHECK ((state = 'archived') = (archived_reason IS NOT NULL))
);
CREATE INDEX hazard_geom ON hazard USING gist (geom);
CREATE INDEX hazard_state ON hazard (state);

CREATE TABLE hazard_state_log (
  hazard_id  text NOT NULL REFERENCES hazard ON DELETE CASCADE,
  epoch      integer NOT NULL,
  from_state text, to_state text NOT NULL, reason text, at timestamptz NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------- rider testimony
CREATE TABLE report (                              -- a hazard the rider reviewed and published
  id            text PRIMARY KEY,                  -- made on the phone: uploads are idempotent
  hazard_id     text NOT NULL REFERENCES hazard ON DELETE CASCADE,
  epoch         integer NOT NULL,
  contributor   text NOT NULL REFERENCES contributor,
  device        text,
  internal_type text NOT NULL,
  severity      smallint NOT NULL CHECK (severity BETWEEN 1 AND 3),
  geom          geography(Point, 4326) NOT NULL,
  sigma_m       real,
  bearing_deg   real,
  road          jsonb,
  source        text NOT NULL CHECK (source IN ('sensor','manual')),
  event_at      timestamptz NOT NULL,              -- the hour; rounded to the day after 30 days
  received_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX report_hazard ON report (hazard_id, epoch);
CREATE INDEX report_contributor ON report (contributor, received_at);

CREATE TABLE review_history (                      -- append-only: the audit
  id          bigserial PRIMARY KEY,
  hazard_id   text NOT NULL REFERENCES hazard ON DELETE CASCADE,
  epoch       integer NOT NULL,
  voter       text NOT NULL,                       -- contributor id, or an anonymous per-hazard key
  device      text,
  verdict     text NOT NULL CHECK (verdict IN ('found','not_found','unsure')),
  severity    smallint,
  passage     jsonb,                               -- { passed, quality, felt }: no coordinates, no times
  counts      boolean NOT NULL,
  anon        boolean NOT NULL DEFAULT false,
  event_at    timestamptz NOT NULL,
  received_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX review_history_hazard ON review_history (hazard_id, epoch);

CREATE TABLE review_current (                      -- one row per rider and hazard epoch: the agreement
  hazard_id   text NOT NULL REFERENCES hazard ON DELETE CASCADE,
  epoch       integer NOT NULL,
  voter       text NOT NULL,
  device      text,
  verdict     text NOT NULL CHECK (verdict IN ('found','not_found','unsure')),
  severity    smallint,
  counts      boolean NOT NULL,                    -- false: no passage evidence, outside the agreement
  anon        boolean NOT NULL DEFAULT false,
  event_at    timestamptz NOT NULL,
  received_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (hazard_id, epoch, voter)
);

-- ---------------------------------------------------------------- sensor evidence (apart)
CREATE TABLE sensor_evidence (
  hazard_id text NOT NULL REFERENCES hazard ON DELETE CASCADE,
  epoch     integer NOT NULL,
  day       date NOT NULL,
  felt      integer NOT NULL DEFAULT 0,            -- "felt by sensors on N rides"
  clean     integer NOT NULL DEFAULT 0,            -- passed with a good fix, nothing felt (never "not found")
  PRIMARY KEY (hazard_id, epoch, day)
);

-- ---------------------------------------------------------------- community thanks (never accuracy)
CREATE TABLE thanks (
  hazard_id text NOT NULL REFERENCES hazard ON DELETE CASCADE,
  voter     text NOT NULL,
  at        timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (hazard_id, voter)
);

-- ---------------------------------------------------------------- data provenance (data/sources.json)
CREATE TABLE data_source (
  id              text PRIMARY KEY,
  name            text NOT NULL,
  licence         text NOT NULL,
  licence_version text,
  attribution     text,
  commercial_use  text NOT NULL CHECK (commercial_use IN ('yes','no','unclear','by_agreement')),
  access_method   text NOT NULL,
  fetched_at      timestamptz,
  source_version  text,
  legal_review    text NOT NULL DEFAULT 'pending' CHECK (legal_review IN ('pending','approved','rejected')),
  notes           text
);
CREATE TABLE hazard_source (
  hazard_id      text NOT NULL REFERENCES hazard ON DELETE CASCADE,
  data_source_id text NOT NULL REFERENCES data_source
);

-- ---------------------------------------------------------------- metre-safe queries
-- Hazards within radius_m metres of a point (geography: metres on the spheroid).
CREATE FUNCTION hazards_near(lat double precision, lng double precision, radius_m double precision)
RETURNS SETOF hazard LANGUAGE sql STABLE AS $$
  SELECT * FROM hazard
  WHERE ST_DWithin(geom, ST_SetSRID(ST_MakePoint(lng, lat), 4326)::geography, radius_m)
$$;

-- What riders said about each hazard's current epoch: only rows that count, never anonymous-only confirmation.
CREATE VIEW hazard_agreement AS
SELECT h.id, h.epoch,
       count(*) FILTER (WHERE rc.verdict = 'found' AND rc.counts)      AS found,
       count(*) FILTER (WHERE rc.verdict = 'not_found' AND rc.counts)  AS not_found,
       count(*) FILTER (WHERE rc.verdict = 'unsure' AND rc.counts)     AS unsure,
       CASE WHEN count(*) FILTER (WHERE rc.verdict IN ('found','not_found') AND rc.counts) >= 3
            THEN round(100.0 * count(*) FILTER (WHERE rc.verdict = 'found' AND rc.counts)
                 / count(*) FILTER (WHERE rc.verdict IN ('found','not_found') AND rc.counts))
       END AS agreement_pct
FROM hazard h LEFT JOIN review_current rc ON rc.hazard_id = h.id AND rc.epoch = h.epoch
GROUP BY h.id, h.epoch;
