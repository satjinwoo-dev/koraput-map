// The PostGIS schema for the public launch (docs/roadpulse/postgis-schema.sql), checked against a real PostgreSQL +
// PostGIS when ROADPULSE_PG names one (a libpq connection string or "host=/socket/dir port=…"); skipped otherwise.
//   ROADPULSE_PG="host=/tmp/pg port=55432 user=postgres" npm test
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const PG = process.env.ROADPULSE_PG;
const SCHEMA = fileURLToPath(new URL("../../docs/roadpulse/postgis-schema.sql", import.meta.url));
const DB = `rp_test_${process.pid}`;
const psql = (sql, db = "postgres", extra = []) => execFileSync("psql", [`${PG} dbname=${db}`, "-v", "ON_ERROR_STOP=1", "-qAt", ...extra, ...(sql === null ? [] : ["-c", sql])], { encoding: "utf8" }).trim();

test("PostGIS schema: applies; metres are metres (geography), never degrees; agreement only from what counts", { skip: !PG && "set ROADPULSE_PG to run against PostgreSQL + PostGIS" }, () => {
    psql(`CREATE DATABASE ${DB}`);
    try {
        psql(null, DB, ["-f", SCHEMA]);
        // two hazards near Koraput: 10 m and 100 m east of a point
        const lat = 18.81, lng = 82.71, m = 1 / (111320 * Math.cos(lat * Math.PI / 180));
        psql(`INSERT INTO contributor (id) VALUES ('cA'), ('cB'), ('cC'), ('cD');
              INSERT INTO hazard (id, public_type, internal_type, severity, geom, state, first_reported_at, reporter) VALUES
                ('h1', 'impact', 'pothole', 2, ST_SetSRID(ST_MakePoint(${lng + 10 * m}, ${lat}), 4326)::geography, 'reviewed_report', now(), 'cA'),
                ('h2', 'impact', 'pothole', 2, ST_SetSRID(ST_MakePoint(${lng + 100 * m}, ${lat}), 4326)::geography, 'reviewed_report', now(), 'cA');`, DB);
        assert.equal(psql(`SELECT string_agg(id, ',' ORDER BY id) FROM hazards_near(${lat}, ${lng}, 15)`, DB), "h1", "15 m: only the one 10 m away");
        assert.equal(psql(`SELECT count(*) FROM hazards_near(${lat}, ${lng}, 150)`, DB), "2");
        // the pitfall the schema avoids: on raw EPSG:4326 geometry, 15 means 15 DEGREES
        assert.equal(psql(`SELECT count(*) FROM hazard WHERE ST_DWithin(geom::geometry, ST_SetSRID(ST_MakePoint(${lng}, ${lat}), 4326), 15)`, DB), "2", "degrees: both (wrong)");
        // agreement: only rows that count; under 3 reviewers no percentage
        psql(`INSERT INTO review_current (hazard_id, epoch, voter, verdict, counts, event_at) VALUES
                ('h1', 0, 'cA', 'found', true, now()), ('h1', 0, 'cB', 'found', true, now()), ('h1', 0, 'cC', 'not_found', true, now()),
                ('h1', 0, 'cD', 'not_found', false, now()), ('h2', 0, 'cA', 'found', true, now());`, DB);
        assert.equal(psql(`SELECT found || '/' || not_found || '/' || coalesce(agreement_pct::text, '-') FROM hazard_agreement WHERE id = 'h1'`, DB), "2/1/67", "the vote without passage evidence doesn't count");
        assert.equal(psql(`SELECT coalesce(agreement_pct::text, '-') FROM hazard_agreement WHERE id = 'h2'`, DB), "-");
        // constraints: an archived hazard says why; states and verdicts are closed lists
        assert.throws(() => psql(`UPDATE hazard SET state = 'archived' WHERE id = 'h1'`, DB));
        psql(`UPDATE hazard SET state = 'archived', archived_reason = 'repaired' WHERE id = 'h1'`, DB);
        assert.throws(() => psql(`UPDATE hazard SET state = 'active' WHERE id = 'h2'`, DB));
        assert.throws(() => psql(`INSERT INTO review_current (hazard_id, epoch, voter, verdict, counts, event_at) VALUES ('h2', 0, 'cB', 'maybe', true, now())`, DB));
    } finally {
        psql(`DROP DATABASE IF EXISTS ${DB}`);
    }
});
