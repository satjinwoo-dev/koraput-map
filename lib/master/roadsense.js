// @ts-check
"use strict";
/* ============================================================================
   MapUnite RoadSense Live — the server's half of the sync (/api/master/roadsense/*)
   ==============================================================================
     POST /roadsense/upload  { v: 1, rider, obs: [...] }   ≤ 200 observations a call
     POST /roadsense/area    { v: 1, tiles: ["y:x", …] }   ≤ 24 tiles of 0.05° (≈ 5.5 km)
     POST /roadsense/cover   { v: 1, cells: [{ cell, t, token }] }  smooth passes: ≤ 500 a call
     POST /roadsense/forget  { v: 1, riders: [...], cover: [...], contributors?: [...] }  delete everything
                                                                those pseudonyms, smooth-pass labels and
                                                                contributors sent
     POST /roadsense/publish { v: 1, contributor, device?, reports: [...], votes: [...] }  RoadPulse: what a
                                                                rider REVIEWED after a ride and chose to publish
     POST /roadsense/me      { v: 1, contributor }              that rider's reputation and badges, computed
                                                                live (lib/master/roadpulse-reputation.js)

   ROADPULSE COMMUNITY REPORTS (Confirmed Decisions 2 + 3): nothing the phone
   detects is public until the rider reviews it after the ride and publishes it.
   Published:
     reports  a hazard the rider confirmed (or added by hand): kind, severity,
              position (1e-5°) with its accuracy, heading, the HOUR only
     votes    "found" / "not found" / "unsure" on a hazard they were warned about
   Each lands on a HAZARD (public/js/master/roadsense/agreement.js, the same
   module the phone runs): a report within 15 m / 2σ, same kind group and
   direction, is a "found" vote on the existing hazard, never a second one.
   The CONTRIBUTOR is a random token the phone made once; stored only as
   HMAC(SERVER_SECRET, token), stable, so one rider is one vote and badges can
   follow accuracy; the device token the same way, so two accounts on one phone
   count once. No name, no route, no IP is stored. /area returns each live
   hazard with its counts, agreement and status, computed from the votes.
   Limits: 100 reports and 300 votes per contributor a day. A report more than
   30 m inaccurate may confirm a hazard but never create one.

   TWO EVIDENCE PIPELINES, never mixed:
     rider testimony  reports and votes → agreement (agreement.js)
     sensor evidence  "felt by sensors on N rides" / "passed, nothing felt": a tally
                      per hazard and day (roadsense_sensor) from sensor-origin reports
                      and each vote's passage; shown apart, never in the agreement
   VOTES keep an append-only history (roadsense_vote_history: the audit) and one
   current row per rider and hazard (roadsense_vote: the agreement). A vote counts
   only with PASSAGE evidence from the phone: { passed, quality, felt }, worked out
   on the phone from the ride it keeps (passed the spot, right direction, moving,
   a usable fix); no coordinates or times of the ride are sent. Without it the vote
   is kept in the history, outside the agreement. A non-response is nothing at all.
   ROAD-AWARE MERGING (lib/master/roadpulse-roads.js, when a road index is loaded from
   data/roads): a report is snapped to its road (way, direction, along-road metres,
   lateral offset) and matches a hazard only on the same road and direction, within
   the combined GPS tolerance along it; two well-placed potholes clearly apart are two
   hazards even within 15 m; a divided road's carriageways are separate roads. Without
   a road index (or off any mapped road) it falls back to distance + direction.
   maintain() (daily, and after the road data changes): re-snaps every hazard from its
   PHYSICAL point (an OSM way id changing never deletes a hazard: one that can't be
   re-snapped is "needs_resnap" and quiet until riders confirm it again), splits a
   hazard whose reports form two groups along the road, and merges two hazards that
   turned out to be one.
   ROUTE PRIVACY beyond "no traces": what /area shows of a hazard is
     - its time as a bucket only (today / yesterday / this week / earlier, India time),
       never the hour; stored hours become days after 30 days;
     - on LOW-TRAFFIC roads (fewer than 5 different riders reported or answered in the
       tile in 30 days, where one report can point at one person): a new hazard is held
       back until a second rider confirms it or 48 h have passed, and its counts are
       shown as "a few riders" while they're under 3.
   ANONYMOUS votes (anonymous: true): each vote carries a per-hazard token the phone
   derives from its own secret, so the server can stop double votes but can't join
   one rider's votes; they count, never alone confirm a hazard, earn no reputation,
   and are limited per network address (in memory). New hazards need a contributor.

   SMOOTH PASSES ("ridden, nothing found"): a ≈ 220 m cell ridden with the motion
   sensor working and nothing felt. Stored per cell as label = SHA-256(token), where
   the phone made token = SHA-256(daily pseudonym | cell): distinct riders per cell
   can be counted, but one rider's cells can't be joined into a route (each cell
   has its own label), and the phone recognises its own when they come back. Kept
   7 days (RS.COVER.freshMs), only the hour of the pass. One network address counts
   once per cell per day (held in memory only, never stored): many fake "riders"
   from one place can't make a road look clear.

   FEEDS (lib/master/roadsense-feeds.js): official lists and model predictions,
   ingested by the server (ingest()), served with the evidence of each tile and
   judged by the same rules.

   Phones share anonymous OBSERVATIONS (a jolt here, a clean pass there), never
   tracks. What is stored per observation: its random id, kind, time, position
   (rounded to 1e-5° ≈ 1 m), source, present / not there, confidence, shock
   size, and a RIDER LABEL = HMAC(SERVER_SECRET, pseudonym). The pseudonym is a
   random value the phone changes every day; it is never stored, and neither is
   the IP address. The label lets other phones count distinct riders without
   learning who they are; a new day is a new label.

   Trust: anyone can upload, so the server
     - accepts only imu, camera and rider sources (official alerts come from
       their own feeds, never from a phone),
     - only times from 30 days ago to 10 minutes ahead,
     - at most 3000 observations per rider label a day,
   and the phone's rules (public/js/master/roadsense/roadsense.js, the SAME
   module, run here too) count one other rider as at most one piece of
   evidence. /area runs those rules over each tile and returns only the
   evidence of events still alive (candidate or verified), newest first,
   capped, so the phone downloads what matters and decides for itself.

   Retention: each observation is deleted once it is older than its kind's
   maxAge (an animal after 1 hour, a pothole after 120 days), checked hourly.
   ============================================================================ */

const crypto = require("crypto");
const RS = require("../../public/js/master/roadsense/roadsense.js");

const LIMITS = Object.freeze({
    uploadMax: 200,               // observations per upload
    tilesMax: 24,                 // tiles per /area call (a 130 km corridor, one tile wide)
    obsPerTile: 2000,             // newest rows read per tile
    eventsPerTile: 300,           // live events returned per tile
    responseObsMax: 4000,         // observations per /area answer (≈ 0.5 MB of JSON)
    forgetMax: 800,               // pseudonyms per /forget (a phone keeps about 2 years of them)
    perRiderPerDay: 3000,         // observations per rider label per day
    pastMs: 30 * 86400000,        // oldest observation accepted
    futureMs: 10 * 60000,         // clock skew allowed
    purgeEveryMs: 3600000,
    coverMax: 500,                // smooth passes per /cover upload
    coverPerCell: 4,              // the newest labels per cell sent back
    responseCoverMax: 20000,      // smooth passes per /area answer
    forgetCoverMax: 5000,         // smooth-pass labels per /forget
    seenMax: 200000,              // the in-memory "this address already counted for this cell today" set
    publishReportsMax: 50,        // per /publish call
    publishVotesMax: 100,
    reportsPerDay: 100,           // per contributor
    votesPerDay: 300,
    hazardsPerTile: 300,          // live hazards returned per tile
    forgetContributorsMax: 10,
    hazardKeepMs: 30 * 86400000,  // a fixed or expired hazard is deleted this long after its last vote
    hourKeepMs: 30 * 86400000,    // report and vote hours are rounded down to the day after this
    lowTrafficRiders: 5,          // fewer different riders in a tile in 30 days = a low-traffic road
    lowTrafficHoldMs: 48 * 3600000, // a new hazard there waits this long for a second rider before it's shown
    fewBelow: 3                   // counts under this are shown as "a few riders" on a low-traffic road
});
const CELL_RE = /^-?\d{1,6}:-?\d{1,6}$/;
const TOKEN_RE = /^[0-9a-f]{64}$/;
const LABEL_RE = /^[0-9a-f]{16}$/;
const PSEUDONYM_RE = /^[A-Za-z0-9_-]{16,64}$/;
const PHONE_SOURCES = new Set(["imu", "camera", "rider"]);
const REPORT_SOURCES = new Set(["sensor", "manual"]);
const ID_RE = /^[A-Za-z0-9_.-]{6,64}$/;
const HAZARD_RE = /^h[0-9a-f]{16}$/;
const AG = require("../../public/js/master/roadsense/agreement.js");
const REP = require("./roadpulse-reputation.js");
const RD = require("./roadpulse-roads.js");
const fin = (/** @type {any} */ v) => typeof v === "number" && Number.isFinite(v);

/**
 * @param {{ db: () => any, secret: () => string, now?: () => number, limits?: Partial<typeof LIMITS>, roads?: () => any }} o
 *   roads: the road index (roadpulse-roads.js createRoadIndex), if the pilot district's roads are loaded
 */
function createRoadsense(o) {
    const roads = () => (o.roads ? o.roads() : null);
    const now = o.now || Date.now;
    const L = { ...LIMITS, ...(o.limits || {}) };
    /** @type {any} */ let schemaFor = null;
    /** @type {any} */ let q = null;
    let lastPurge = -Infinity;
    const stats = { uploads: 0, accepted: 0, duplicates: 0, rejected: 0, areas: 0, served: 0, forgotten: 0, purged: 0, coverAccepted: 0, coverRepeat: 0, coverServed: 0, feedIngested: 0,
        published: 0, hazardsCreated: 0, reportsMatched: 0, votes: 0, hazardsServed: 0, held: 0 };
    /** @type {Map<string, true>} keyed HMAC(address | cell | day); memory only */ let seen = new Map();
    let seenDay = "";
    /** @type {Map<string, number>} anonymous votes per network address today (memory only) */ let anonSeen = new Map();
    let anonDay = "";

    function ready() {
        const db = o.db();
        if (!db) return null;
        if (schemaFor === db) return q;
        db.exec(`
CREATE TABLE IF NOT EXISTS roadsense_obs (
  id       TEXT PRIMARY KEY,
  tile     TEXT NOT NULL,
  type     TEXT NOT NULL,
  t        INTEGER NOT NULL,
  lat      REAL NOT NULL,
  lng      REAL NOT NULL,
  source   TEXT NOT NULL,
  rider    TEXT NOT NULL,
  present  INTEGER NOT NULL,
  conf     REAL NOT NULL,
  peak     REAL,
  received INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS roadsense_obs_tile ON roadsense_obs (tile, t);
CREATE INDEX IF NOT EXISTS roadsense_obs_rider ON roadsense_obs (rider, received);
CREATE TABLE IF NOT EXISTS roadsense_cover (
  cell   TEXT NOT NULL,
  tile   TEXT NOT NULL,
  label  TEXT NOT NULL,
  t      INTEGER NOT NULL,
  PRIMARY KEY (cell, label)
);
CREATE INDEX IF NOT EXISTS roadsense_cover_tile ON roadsense_cover (tile, t);
CREATE INDEX IF NOT EXISTS roadsense_cover_label ON roadsense_cover (label);
CREATE TABLE IF NOT EXISTS roadsense_feed (
  id          TEXT PRIMARY KEY,
  tile        TEXT NOT NULL,
  type        TEXT NOT NULL,
  source      TEXT NOT NULL,
  ref         TEXT NOT NULL,
  lat         REAL NOT NULL,
  lng         REAL NOT NULL,
  t           INTEGER NOT NULL,
  valid_until INTEGER NOT NULL,
  conf        REAL NOT NULL,
  url         TEXT,
  detail      TEXT
);
CREATE INDEX IF NOT EXISTS roadsense_feed_tile ON roadsense_feed (tile, valid_until);
CREATE TABLE IF NOT EXISTS roadsense_hazard (
  id              TEXT PRIMARY KEY,
  tile            TEXT NOT NULL,
  type            TEXT NOT NULL,
  lat             REAL NOT NULL,
  lng             REAL NOT NULL,
  sigma           REAL,
  heading         REAL,
  both_ways       INTEGER NOT NULL DEFAULT 0,
  severity        INTEGER NOT NULL,
  epoch           INTEGER NOT NULL DEFAULT 0,
  first_t         INTEGER NOT NULL,
  reporter        TEXT NOT NULL,
  reporter_device TEXT,
  fixed_at        INTEGER,
  updated         INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS roadsense_hazard_tile ON roadsense_hazard (tile);
CREATE TABLE IF NOT EXISTS roadsense_report (
  id          TEXT PRIMARY KEY,
  hazard_id   TEXT NOT NULL,
  epoch       INTEGER NOT NULL,
  contributor TEXT NOT NULL,
  device      TEXT,
  type        TEXT NOT NULL,
  severity    INTEGER NOT NULL,
  lat         REAL NOT NULL,
  lng         REAL NOT NULL,
  sigma       REAL,
  heading     REAL,
  t           INTEGER NOT NULL,
  source      TEXT NOT NULL,
  received    INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS roadsense_report_hazard ON roadsense_report (hazard_id, epoch);
CREATE INDEX IF NOT EXISTS roadsense_report_contributor ON roadsense_report (contributor, received);
CREATE TABLE IF NOT EXISTS roadsense_vote (
  hazard_id   TEXT NOT NULL,
  epoch       INTEGER NOT NULL,
  contributor TEXT NOT NULL,
  device      TEXT,
  verdict     TEXT NOT NULL,
  severity    INTEGER,
  t           INTEGER NOT NULL,
  received    INTEGER NOT NULL,
  PRIMARY KEY (hazard_id, epoch, contributor)
);
CREATE INDEX IF NOT EXISTS roadsense_vote_contributor ON roadsense_vote (contributor, received);
CREATE TABLE IF NOT EXISTS roadsense_vote_history (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  hazard_id   TEXT NOT NULL,
  epoch       INTEGER NOT NULL,
  contributor TEXT NOT NULL,
  device      TEXT,
  verdict     TEXT NOT NULL,
  severity    INTEGER,
  passage     TEXT,
  counts      INTEGER NOT NULL,
  anon        INTEGER NOT NULL DEFAULT 0,
  t           INTEGER NOT NULL,
  received    INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS roadsense_vote_history_hazard ON roadsense_vote_history (hazard_id, epoch);
CREATE INDEX IF NOT EXISTS roadsense_vote_history_contributor ON roadsense_vote_history (contributor);
CREATE TABLE IF NOT EXISTS roadsense_thanks (
  hazard_id TEXT NOT NULL,
  voter     TEXT NOT NULL,
  t         INTEGER NOT NULL,
  PRIMARY KEY (hazard_id, voter)
);
CREATE TABLE IF NOT EXISTS roadsense_sensor (
  hazard_id TEXT NOT NULL,
  epoch     INTEGER NOT NULL,
  day       INTEGER NOT NULL,
  felt      INTEGER NOT NULL DEFAULT 0,
  clean     INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (hazard_id, epoch, day)
);
`);
        // columns added after the first RoadPulse tables shipped
        const cols = new Set(db.prepare(`PRAGMA table_info(roadsense_vote)`).all().map((/** @type {any} */ c) => c.name));
        if (!cols.has("counts")) db.exec(`ALTER TABLE roadsense_vote ADD COLUMN counts INTEGER NOT NULL DEFAULT 1`);
        if (!cols.has("anon")) db.exec(`ALTER TABLE roadsense_vote ADD COLUMN anon INTEGER NOT NULL DEFAULT 0`);
        const hcols = new Set(db.prepare(`PRAGMA table_info(roadsense_hazard)`).all().map((/** @type {any} */ c) => c.name));
        if (!hcols.has("road_ref")) db.exec(`ALTER TABLE roadsense_hazard ADD COLUMN road_ref TEXT`);
        if (!hcols.has("road_status")) db.exec(`ALTER TABLE roadsense_hazard ADD COLUMN road_status TEXT NOT NULL DEFAULT 'none'`);
        const rcols = new Set(db.prepare(`PRAGMA table_info(roadsense_report)`).all().map((/** @type {any} */ c) => c.name));
        if (!rcols.has("road")) db.exec(`ALTER TABLE roadsense_report ADD COLUMN road TEXT`);
        q = {
            insert: db.prepare(`INSERT OR IGNORE INTO roadsense_obs (id, tile, type, t, lat, lng, source, rider, present, conf, peak, received) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`),
            countToday: db.prepare(`SELECT COUNT(*) AS n FROM roadsense_obs WHERE rider = ? AND received > ?`),
            tile: db.prepare(`SELECT id, type, t, lat, lng, source, rider, present, conf, peak FROM roadsense_obs WHERE tile = ? AND t > ? ORDER BY t DESC LIMIT ?`),
            forget: db.prepare(`DELETE FROM roadsense_obs WHERE rider = ?`),
            purge: db.prepare(`DELETE FROM roadsense_obs WHERE type = ? AND t < ?`),
            count: db.prepare(`SELECT COUNT(*) AS n FROM roadsense_obs`),
            coverUpsert: db.prepare(`INSERT INTO roadsense_cover (cell, tile, label, t) VALUES (?,?,?,?) ON CONFLICT(cell, label) DO UPDATE SET t = MAX(t, excluded.t)`),
            coverTile: db.prepare(`SELECT cell, label, t FROM roadsense_cover WHERE tile = ? AND t > ? ORDER BY t DESC LIMIT ?`),
            coverForget: db.prepare(`DELETE FROM roadsense_cover WHERE label = ?`),
            coverPurge: db.prepare(`DELETE FROM roadsense_cover WHERE t < ?`),
            coverCount: db.prepare(`SELECT COUNT(*) AS n FROM roadsense_cover`),
            feedUpsert: db.prepare(`INSERT INTO roadsense_feed (id, tile, type, source, ref, lat, lng, t, valid_until, conf, url, detail) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
                ON CONFLICT(id) DO UPDATE SET tile = excluded.tile, type = excluded.type, source = excluded.source, ref = excluded.ref, lat = excluded.lat, lng = excluded.lng,
                t = excluded.t, valid_until = excluded.valid_until, conf = excluded.conf, url = excluded.url, detail = excluded.detail`),
            feedTile: db.prepare(`SELECT id, type, source, ref, lat, lng, t, valid_until, conf FROM roadsense_feed WHERE tile = ? AND valid_until > ?`),
            feedPurge: db.prepare(`DELETE FROM roadsense_feed WHERE valid_until < ?`),
            feedCount: db.prepare(`SELECT COUNT(*) AS n FROM roadsense_feed`),
            hzInsert: db.prepare(`INSERT INTO roadsense_hazard (id, tile, type, lat, lng, sigma, heading, both_ways, severity, epoch, first_t, reporter, reporter_device, fixed_at, updated) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,NULL,?)`),
            hzGet: db.prepare(`SELECT * FROM roadsense_hazard WHERE id = ?`),
            hzNear: db.prepare(`SELECT * FROM roadsense_hazard WHERE lat BETWEEN ? AND ? AND lng BETWEEN ? AND ?`),
            hzTile: db.prepare(`SELECT * FROM roadsense_hazard WHERE tile = ?`),
            hzPlace: db.prepare(`UPDATE roadsense_hazard SET tile = ?, lat = ?, lng = ?, sigma = ?, severity = ?, updated = ? WHERE id = ?`),
            hzEpoch: db.prepare(`UPDATE roadsense_hazard SET epoch = ?, first_t = ?, reporter = ?, reporter_device = ?, fixed_at = NULL, updated = ? WHERE id = ?`),
            hzBoth: db.prepare(`UPDATE roadsense_hazard SET both_ways = 1 WHERE id = ?`),
            hzTouch: db.prepare(`UPDATE roadsense_hazard SET updated = ? WHERE id = ?`),
            hzDelete: db.prepare(`DELETE FROM roadsense_hazard WHERE id = ?`),
            hzRoad: db.prepare(`UPDATE roadsense_hazard SET road_ref = ?, road_status = ? WHERE id = ?`),
            hzAllFull: db.prepare(`SELECT * FROM roadsense_hazard`),
            rpRoad: db.prepare(`UPDATE roadsense_report SET road = ? WHERE id = ?`),
            rpFullOfHazard: db.prepare(`SELECT id, contributor, device, lat, lng, sigma, heading, road, epoch FROM roadsense_report WHERE hazard_id = ? AND epoch = ?`),
            rpMove: db.prepare(`UPDATE roadsense_report SET hazard_id = ? WHERE id = ?`),
            rpMoveAll: db.prepare(`UPDATE roadsense_report SET hazard_id = ? WHERE hazard_id = ?`),
            vtOne: db.prepare(`SELECT * FROM roadsense_vote WHERE hazard_id = ? AND epoch = ? AND contributor = ?`),
            vtMove: db.prepare(`UPDATE roadsense_vote SET hazard_id = ? WHERE hazard_id = ? AND epoch = ? AND contributor = ?`),
            vtDeleteOne: db.prepare(`DELETE FROM roadsense_vote WHERE hazard_id = ? AND epoch = ? AND contributor = ?`),
            vhMoveAll: db.prepare(`UPDATE roadsense_vote_history SET hazard_id = ? WHERE hazard_id = ?`),
            snMoveAll: db.prepare(`INSERT INTO roadsense_sensor (hazard_id, epoch, day, felt, clean) SELECT ?, epoch, day, felt, clean FROM roadsense_sensor WHERE hazard_id = ?
                ON CONFLICT(hazard_id, epoch, day) DO UPDATE SET felt = felt + excluded.felt, clean = clean + excluded.clean`),
            rpCountOf: db.prepare(`SELECT COUNT(*) AS n FROM roadsense_report WHERE hazard_id = ? AND epoch = ?`),
            hzCount: db.prepare(`SELECT COUNT(*) AS n FROM roadsense_hazard`),
            hzAll: db.prepare(`SELECT id, type, fixed_at, updated FROM roadsense_hazard`),
            rpInsert: db.prepare(`INSERT OR IGNORE INTO roadsense_report (id, hazard_id, epoch, contributor, device, type, severity, lat, lng, sigma, heading, t, source, received) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`),
            rpOfHazard: db.prepare(`SELECT lat, lng, sigma, severity FROM roadsense_report WHERE hazard_id = ? AND epoch = ?`),
            rpToday: db.prepare(`SELECT COUNT(*) AS n FROM roadsense_report WHERE contributor = ? AND received > ?`),
            rpOfContributor: db.prepare(`SELECT DISTINCT hazard_id FROM roadsense_report WHERE contributor = ?`),
            rpAllOfContributor: db.prepare(`SELECT hazard_id, epoch, device, t, received, lat, lng FROM roadsense_report WHERE contributor = ? ORDER BY received DESC LIMIT 5000`),
            vtGivenBy: db.prepare(`SELECT COUNT(*) AS n FROM roadsense_vote v WHERE v.contributor = ? AND v.counts = 1 AND NOT EXISTS (SELECT 1 FROM roadsense_report r WHERE r.hazard_id = v.hazard_id AND r.epoch = v.epoch AND r.contributor = v.contributor)`),
            rpForget: db.prepare(`DELETE FROM roadsense_report WHERE contributor = ?`),
            rpDeleteHazard: db.prepare(`DELETE FROM roadsense_report WHERE hazard_id = ?`),
            vtUpsert: db.prepare(`INSERT INTO roadsense_vote (hazard_id, epoch, contributor, device, verdict, severity, t, received, counts, anon) VALUES (?,?,?,?,?,?,?,?,?,?)
                ON CONFLICT(hazard_id, epoch, contributor) DO UPDATE SET device = excluded.device, verdict = excluded.verdict, severity = excluded.severity, t = excluded.t, received = excluded.received,
                counts = excluded.counts, anon = excluded.anon
                WHERE excluded.t >= roadsense_vote.t`),
            vtOfHazard: db.prepare(`SELECT contributor, device, verdict, severity, t, epoch, counts, anon, received FROM roadsense_vote WHERE hazard_id = ?`),
            vhInsert: db.prepare(`INSERT INTO roadsense_vote_history (hazard_id, epoch, contributor, device, verdict, severity, passage, counts, anon, t, received) VALUES (?,?,?,?,?,?,?,?,?,?,?)`),
            vhOfHazard: db.prepare(`SELECT contributor, verdict, counts, anon, t, received FROM roadsense_vote_history WHERE hazard_id = ? ORDER BY id`),
            vhForget: db.prepare(`DELETE FROM roadsense_vote_history WHERE contributor = ?`),
            vhDeleteHazard: db.prepare(`DELETE FROM roadsense_vote_history WHERE hazard_id = ?`),
            snAdd: db.prepare(`INSERT INTO roadsense_sensor (hazard_id, epoch, day, felt, clean) VALUES (?,?,?,?,?)
                ON CONFLICT(hazard_id, epoch, day) DO UPDATE SET felt = felt + excluded.felt, clean = clean + excluded.clean`),
            snOf: db.prepare(`SELECT COALESCE(SUM(felt), 0) AS felt, COALESCE(SUM(clean), 0) AS clean FROM roadsense_sensor WHERE hazard_id = ? AND epoch = ? AND day >= ?`),
            snDeleteHazard: db.prepare(`DELETE FROM roadsense_sensor WHERE hazard_id = ?`),
            thAdd: db.prepare(`INSERT OR IGNORE INTO roadsense_thanks (hazard_id, voter, t) VALUES (?,?,?)`),
            thOf: db.prepare(`SELECT COUNT(*) AS n FROM roadsense_thanks WHERE hazard_id = ?`),
            thReceived: db.prepare(`SELECT COUNT(*) AS n FROM roadsense_thanks th WHERE th.voter != ? AND th.hazard_id IN (SELECT DISTINCT hazard_id FROM roadsense_report WHERE contributor = ?)`),
            thForget: db.prepare(`DELETE FROM roadsense_thanks WHERE voter = ?`),
            thDeleteHazard: db.prepare(`DELETE FROM roadsense_thanks WHERE hazard_id = ?`),
            reviewsOf: db.prepare(`SELECT v.hazard_id, v.epoch, v.device, v.verdict, v.t FROM roadsense_vote v WHERE v.contributor = ? AND v.counts = 1 AND v.anon = 0
                AND NOT EXISTS (SELECT 1 FROM roadsense_report r WHERE r.hazard_id = v.hazard_id AND r.epoch = v.epoch AND r.contributor = v.contributor) LIMIT 5000`),
            vtToday: db.prepare(`SELECT COUNT(*) AS n FROM roadsense_vote WHERE contributor = ? AND received > ?`),
            vtOfContributor: db.prepare(`SELECT DISTINCT hazard_id FROM roadsense_vote WHERE contributor = ?`),
            vtForget: db.prepare(`DELETE FROM roadsense_vote WHERE contributor = ?`),
            vtDeleteHazard: db.prepare(`DELETE FROM roadsense_vote WHERE hazard_id = ?`),
            vtLast: db.prepare(`SELECT MAX(t) AS t FROM roadsense_vote WHERE hazard_id = ?`),
            ridersInTile: db.prepare(`SELECT COUNT(*) AS n FROM (
                SELECT r.contributor AS c FROM roadsense_report r JOIN roadsense_hazard h ON h.id = r.hazard_id WHERE h.tile = ? AND r.received > ? AND r.contributor != ''
                UNION SELECT v.contributor AS c FROM roadsense_vote v JOIN roadsense_hazard h ON h.id = v.hazard_id WHERE h.tile = ? AND v.received > ? AND v.anon = 0 AND v.contributor != '')`),
            dayReports: db.prepare(`UPDATE roadsense_report SET t = (t / 86400000) * 86400000 WHERE received < ? AND t % 86400000 != 0`),
            dayVotes: db.prepare(`UPDATE roadsense_vote SET t = (t / 86400000) * 86400000 WHERE received < ? AND t % 86400000 != 0`),
            dayHistory: db.prepare(`UPDATE roadsense_vote_history SET t = (t / 86400000) * 86400000 WHERE received < ? AND t % 86400000 != 0`),
            tx: (/** @type {Function} */ fn) => db.transaction(fn)
        };
        schemaFor = db;
        return q;
    }

    /** The stored label for a pseudonym: stable for the day it's used, unlinkable to it without the secret. @param {string} pseudonym */
    const labelOf = (pseudonym) => `r${crypto.createHmac("sha256", o.secret()).update(`mu-roadsense-v1|${pseudonym}`).digest("hex").slice(0, 15)}`;
    /** A contributor's stored label: stable (one rider, one vote; badges follow accuracy), unlinkable without the secret. @param {string} token */
    const contributorOf = (token) => `c${crypto.createHmac("sha256", o.secret()).update(`mu-contributor-v1|${token}`).digest("hex").slice(0, 15)}`;
    /** @param {string} token */
    const deviceOf = (token) => `d${crypto.createHmac("sha256", o.secret()).update(`mu-device-v1|${token}`).digest("hex").slice(0, 15)}`;
    const hourOf = (/** @type {number} */ t) => Math.floor(t / 3600000) * 3600000;

    /** A hazard row as agreement.js sees it. @param {any} r */
    const hazardOf = (r) => ({
        id: r.id, type: r.type, lat: r.lat, lng: r.lng, sigmaM: r.sigma, heading: r.heading, bothWays: r.both_ways === 1, severity: r.severity,
        epoch: r.epoch, firstReportedAt: r.first_t, reporter: r.reporter, reporterDevice: r.reporter_device, fixedAt: r.fixed_at,
        road: r.road_ref ? JSON.parse(r.road_ref) : null, roadStatus: r.road_status || "none"
    });
    /** A road ref as stored (the parts merging needs). @param {any} sn */
    const roadRef = (sn) => (sn ? { wayId: sn.wayId, version: sn.version, alongM: sn.alongM, lateralM: sn.lateralM, dir: sn.dir, carriageway: sn.carriageway, snapLat: sn.snapLat, snapLng: sn.snapLng, at: now() } : null);
    /**
     * The hazard a report duplicates: by road when both are snapped (roadpulse-roads.js sameByRoad), else by distance and
     * direction (agreement.js). @param {any} s @param {any[]} near @param {any} rep with .road
     */
    function matchHazard(s, near, rep) {
        /** @type {any} */ let best = null, bestScore = Infinity;
        for (const h of near) {
            if (AG.publicType(h.type) !== AG.publicType(rep.type)) continue;
            let ok, score;
            if (rep.road && h.road && h.roadStatus === "ok") {
                const m = RD.sameByRoad({ road: h.road, sigmaM: h.sigmaM, reports: Number(s.rpCountOf.get(h.id, h.epoch).n || 0), ...{ bothWays: h.bothWays } }, { road: rep.road, sigmaM: rep.sigmaM });
                ok = m.same; score = m.alongM / Math.max(1, m.tolM);
            } else {
                ok = AG.canMatch(h, rep); score = AG.distM(h.lat, h.lng, rep.lat, rep.lng) / AG.POLICY.matchM;
            }
            if (ok && score < bestScore) { best = h; bestScore = score; }
        }
        return best;
    }
    /** @param {any} s @param {any} h @param {number} t */
    const summaryOf = (s, h, t) => AG.summarize(h, s.vtOfHazard.all(h.id).map((/** @type {any} */ v) => ({ ...v, counts: v.counts === 1, anon: v.anon === 1 })), t);
    const dayOf = (/** @type {number} */ t) => Math.floor(t / 86400000);
    /** The sensor tally of a hazard (this epoch, the last 30 days): kept apart from what riders said. @param {any} s @param {any} h @param {number} t */
    const sensorOf = (s, h, t) => { const r = s.snOf.get(h.id, h.epoch, dayOf(t) - 30); return { felt: Number(r.felt || 0), clean: Number(r.clean || 0) }; };
    /**
     * A vote's passage evidence (worked out on the phone): it counts only if the rider passed the spot in its
     * direction with a usable fix. @param {any} p @returns {{ ok: boolean, felt: boolean|null, quality: string|null, json: string|null }}
     */
    const passageOf = (p) => {
        if (!p || typeof p !== "object") return { ok: false, felt: null, quality: null, json: null };
        const quality = ["good", "fair", "poor"].includes(p.quality) ? p.quality : null;
        const felt = typeof p.felt === "boolean" ? p.felt : null;
        return { ok: p.passed === true && (quality === "good" || quality === "fair"), felt, quality, json: JSON.stringify({ passed: p.passed === true, quality, felt }) };
    };
    /** The marker and severity from the current epoch's reports (and the severities "found" votes gave). @param {any} s @param {any} h @param {number} t */
    function replace(s, h, t) {
        const reps = s.rpOfHazard.all(h.id, h.epoch).map((/** @type {any} */ r) => ({ lat: r.lat, lng: r.lng, sigmaM: r.sigma, severity: r.severity }));
        const m = AG.mergePosition(reps);
        const sevs = [...reps.map((/** @type {any} */ r) => r.severity), ...s.vtOfHazard.all(h.id).filter((/** @type {any} */ v) => v.epoch === h.epoch && v.verdict === "found" && fin(v.severity)).map((/** @type {any} */ v) => v.severity)].sort();
        const sev = sevs.length ? sevs[Math.floor(sevs.length / 2)] : h.severity;
        if (m) s.hzPlace.run(RS.tileOf(m.lat, m.lng), Math.round(m.lat * 1e5) / 1e5, Math.round(m.lng * 1e5) / 1e5, m.sigmaM, sev, t, h.id);
        // the road the new marker is on
        const R = roads();
        if (m && R) {
            const sn = R.snap(m.lat, m.lng, fin(h.heading) ? h.heading : null);
            s.hzRoad.run(sn ? JSON.stringify(roadRef(sn)) : (h.road ? JSON.stringify(h.road) : null), sn ? "ok" : h.road ? "needs_resnap" : "unmatched", h.id);
        }
    }
    /** A time as a public bucket (India time): today / yesterday / this_week / earlier. @param {number|null} t @param {number} now */
    const bucketOf = (t, now) => {
        if (!fin(t)) return null;
        const IST = 5.5 * 3600000, day = (/** @type {number} */ x) => Math.floor((x + IST) / 86400000);
        const d = day(now) - day(/** @type {number} */ (t));
        return d <= 0 ? "today" : d === 1 ? "yesterday" : d < 7 ? "this_week" : "earlier";
    };
    /** The start of that day (India time): the most precise time a phone gets. @param {number|null} t */
    const dayStart = (t) => { if (!fin(t)) return null; const IST = 5.5 * 3600000; return Math.floor((/** @type {number} */ (t) + IST) / 86400000) * 86400000 - IST; };
    /** What /area sends for a hazard. @param {any} h @param {any} sm @param {number} now @param {boolean} low a low-traffic road */
    const hazardOut = (h, sm, now, low) => ({
        id: h.id, type: h.type, ptype: AG.publicType(h.type), lat: h.lat, lng: h.lng, sigmaM: h.sigmaM, heading: h.heading, bothWays: h.bothWays, severity: h.severity,
        status: sm.status, ...(low && sm.found < L.fewBelow && sm.notFound < L.fewBelow
            ? { found: null, notFound: null, unsure: null, reviewers: null, agreementPct: null, fewRiders: true }
            : { found: sm.found, notFound: sm.notFound, unsure: sm.unsure, reviewers: sm.reviewers, agreementPct: sm.agreementPct, fewRiders: false }),
        lowTraffic: low, roadStatus: h.roadStatus, carriageway: h.road ? h.road.carriageway : null,
        // community thanks: shown, never part of the facts
        thanks: sm.thanks || 0,
        // sensor evidence, apart: "felt by sensors on N rides", "passed N times, nothing felt" (last 30 days)
        sensorFelt: sm.sensor ? sm.sensor.felt : 0, sensorClean: sm.sensor ? sm.sensor.clean : 0,
        // times as days and buckets only, never the hour
        firstReportedAt: dayStart(sm.firstReportedAt), lastFoundAt: dayStart(sm.lastFoundAt), lastReviewedAt: dayStart(sm.lastReviewedAt),
        lastFoundBucket: bucketOf(sm.lastFoundAt, now), recentDisagree: sm.recentDisagree,
        // a hazard whose road changed under it (OSM update) stays on the map, quiet, until it's re-snapped or reconfirmed
        independent: sm.independent, stale: sm.stale, alertable: sm.alertable && h.roadStatus !== "needs_resnap", expiresAt: sm.expiresAt
    });

    function purge(/** @type {any} */ s) {
        const t = now();
        if (t - lastPurge < L.purgeEveryMs) return;
        lastPurge = t;
        for (const [type, def] of Object.entries(RS.TYPES)) stats.purged += Number(s.purge.run(type, t - def.maxAgeMs).changes || 0);
        stats.purged += Number(s.coverPurge.run(t - RS.COVER.freshMs).changes || 0);
        stats.purged += Number(s.feedPurge.run(t).changes || 0);
        // RoadPulse: hours become days after a month
        for (const q of [s.dayReports, s.dayVotes, s.dayHistory]) q.run(t - L.hourKeepMs);
        // RoadPulse hazards: fixed (official) or with no vote for their lifetime, kept hazardKeepMs more, then deleted
        for (const h of s.hzAll.all()) {
            const last = Number(s.vtLast.get(h.id).t || h.updated);
            const life = /** @type {any} */ (AG.POLICY.lifetimeMs)[h.type] || 30 * 86400000;
            const gone = (fin(h.fixed_at) && t - h.fixed_at > L.hazardKeepMs) || t - last > life + L.hazardKeepMs;
            if (gone) { s.vtDeleteHazard.run(h.id); s.vhDeleteHazard.run(h.id); s.snDeleteHazard.run(h.id); s.thDeleteHazard.run(h.id); s.rpDeleteHazard.run(h.id); s.hzDelete.run(h.id); stats.purged++; }
        }
    }

    /** A feed row → an observation the rules understand (feed ids may hold ":" or "#": hashed into an observation id). @param {any} r */
    const feedObs = (r) => ({
        id: `f${crypto.createHash("sha256").update(r.id).digest("hex").slice(0, 20)}`, type: r.type, t: r.t, lat: r.lat, lng: r.lng,
        source: r.source, rider: "feed", present: true, conf: r.conf, ref: r.ref, validUntil: r.valid_until
    });

    /** @param {any} body */
    async function upload(body) {
        const s = ready();
        if (!s) return { status: 503, json: { ok: false, reason: "roadsense-not-configured" } };
        if (!body || body.v !== 1 || typeof body.rider !== "string" || !PSEUDONYM_RE.test(body.rider)) return { status: 400, json: { ok: false, reason: "bad-request" } };
        if (!Array.isArray(body.obs) || !body.obs.length || body.obs.length > L.uploadMax) return { status: 400, json: { ok: false, reason: `1 to ${L.uploadMax} observations` } };
        const t = now();
        const rider = labelOf(body.rider);
        const today = Number(s.countToday.get(rider, t - 86400000).n || 0);
        if (today + body.obs.length > L.perRiderPerDay) return { status: 429, json: { ok: false, reason: "daily-limit" } };
        stats.uploads++;
        /** @type {{ i: number, error: string }[]} */ const rejected = [];
        let accepted = 0, duplicate = 0;
        s.tx(() => {
            body.obs.forEach((/** @type {any} */ raw, /** @type {number} */ i) => {
                const why = (/** @type {string} */ error) => { if (rejected.length < 20) rejected.push({ i, error }); stats.rejected++; };
                if (!raw || typeof raw !== "object") return why("not an object");
                if (typeof raw.id !== "string") return why("id is required");
                if (!PHONE_SOURCES.has(raw.source)) return why("source must be imu, camera or rider");
                const v = RS.validateObservation({ ...raw, rider: "upload" });
                if (!v.ok) return why(/** @type {string} */ (v.error));
                const ob = v.obs;
                if (ob.t < t - L.pastMs || ob.t > t + L.futureMs) return why("t is outside the accepted window");
                const lat = Math.round(ob.lat * 1e5) / 1e5, lng = Math.round(ob.lng * 1e5) / 1e5;
                const r = s.insert.run(ob.id, RS.tileOf(lat, lng), ob.type, Math.round(ob.t), lat, lng, ob.source, rider, ob.present ? 1 : 0,
                    Math.round(ob.conf * 1000) / 1000, ob.peakMs2 === null ? null : Math.round(ob.peakMs2 * 10) / 10, t);
                if (Number(r.changes) > 0) accepted++; else duplicate++;
            });
        })();
        stats.accepted += accepted; stats.duplicates += duplicate;
        purge(s);
        return { status: 200, json: { ok: true, accepted, duplicate, rejected } };
    }

    /** @param {any} body */
    async function area(body) {
        const s = ready();
        if (!s) return { status: 503, json: { ok: false, reason: "roadsense-not-configured" } };
        if (!body || body.v !== 1 || !Array.isArray(body.tiles) || !body.tiles.length || body.tiles.length > L.tilesMax) return { status: 400, json: { ok: false, reason: `1 to ${L.tilesMax} tiles` } };
        const tiles = [...new Set(body.tiles.map(String))];
        if (tiles.some((x) => !RS.tileBounds(x))) return { status: 400, json: { ok: false, reason: "bad tile" } };
        const t = now();
        const oldest = t - Math.max(...Object.values(RS.TYPES).map((d) => d.maxAgeMs));
        stats.areas++;
        purge(s);
        /** @type {any[]} */ const out = [];
        /** @type {Record<string, number>} */ const perTile = {};
        /** @type {Set<string>} */ const sent = new Set();
        for (const tile of tiles) {
            // the phone's own rules, run over this tile: only the evidence of live events goes back
            const log = RS.createLog({ policy: { maxEvents: Infinity } });
            // newest rows are read (the limit keeps what matters), then added oldest first
            log.addAll([
                ...s.tile.all(tile, oldest, L.obsPerTile).map((/** @type {any} */ r) => ({
                    id: r.id, type: r.type, t: r.t, lat: r.lat, lng: r.lng, source: r.source, rider: r.rider, present: r.present === 1, conf: r.conf, peakMs2: fin(r.peak) ? r.peak : null
                })),
                // official lists and predictions still in force here
                ...s.feedTile.all(tile, t).map(feedObs)
            ]);
            log.prune(t);
            const live = log.list(t)
                .sort((a, z) => (a.status === z.status ? z.confidence - a.confidence : a.status === "verified" ? -1 : 1))
                .slice(0, L.eventsPerTile);
            perTile[tile] = live.length;
            for (const e of live) {
                for (const ob of log.evidence(e.id)) {
                    if (out.length >= L.responseObsMax) break;
                    if (sent.has(ob.id)) continue;
                    sent.add(ob.id);
                    out.push(ob);
                }
            }
        }
        // smooth passes in these tiles: [cell, label, hour (s)], the newest coverPerCell labels per cell
        /** @type {any[]} */ const cover = [];
        for (const tile of tiles) {
            /** @type {Map<string, number>} */ const perCell = new Map();
            for (const r of s.coverTile.all(tile, t - RS.COVER.freshMs, L.responseCoverMax)) {
                if (cover.length >= L.responseCoverMax) break;
                const n = perCell.get(r.cell) || 0;
                if (n >= L.coverPerCell) continue;
                perCell.set(r.cell, n + 1);
                cover.push([r.cell, r.label, Math.round(r.t / 1000)]);
            }
        }
        // RoadPulse: the reviewed, published hazards with what riders said about them (archived ones left out)
        /** @type {any[]} */ const hazards = [];
        for (const tile of tiles) {
            const live = [];
            const low = Number(s.ridersInTile.get(tile, t - 30 * 86400000, tile, t - 30 * 86400000).n || 0) < L.lowTrafficRiders;
            for (const r of s.hzTile.all(tile)) {
                const h = hazardOf(r), sm = summaryOf(s, h, t);
                if (sm.status === "archived") continue;
                // a low-traffic road: one rider's new report waits for a second rider, or 48 h
                if (low && !sm.independent && sm.found < 2 && t - (sm.firstReportedAt || t) < L.lowTrafficHoldMs) { stats.held++; continue; }
                live.push(hazardOut(h, { ...sm, sensor: sensorOf(s, h, t), thanks: Number(s.thOf.get(h.id).n || 0) }, t, low));
            }
            live.sort((a, z) => (z.lastFoundAt || 0) - (a.lastFoundAt || 0));
            hazards.push(...live.slice(0, L.hazardsPerTile));
        }
        stats.served += out.length;
        stats.coverServed += cover.length;
        stats.hazardsServed += hazards.length;
        return { status: 200, json: { ok: true, t, tiles: perTile, obs: out, cover, hazards, truncated: out.length >= L.responseObsMax || cover.length >= L.responseCoverMax } };
    }

    /**
     * Smooth passes. The second argument carries the caller's network address, used only in memory to count
     * an address once per cell per day.
     * @param {any} body @param {{ ip?: string }} [req]
     */
    async function coverUpload(body, req = {}) {
        const s = ready();
        if (!s) return { status: 503, json: { ok: false, reason: "roadsense-not-configured" } };
        if (!body || body.v !== 1 || !Array.isArray(body.cells) || !body.cells.length || body.cells.length > L.coverMax) return { status: 400, json: { ok: false, reason: `1 to ${L.coverMax} cells` } };
        const t = now();
        const day = new Date(t).toISOString().slice(0, 10);
        if (day !== seenDay || seen.size > L.seenMax) { seen = new Map(); seenDay = day; }
        let accepted = 0, repeat = 0, rejected = 0;
        s.tx(() => {
            for (const c of body.cells) {
                if (!c || typeof c.cell !== "string" || !CELL_RE.test(c.cell) || typeof c.token !== "string" || !TOKEN_RE.test(c.token) || !fin(c.t) || c.t < t - RS.COVER.freshMs || c.t > t + L.futureMs) { rejected++; continue; }
                const once = crypto.createHmac("sha256", o.secret()).update(`mu-cover-v1|${req.ip || "?"}|${c.cell}|${day}`).digest("hex").slice(0, 24);
                if (seen.has(once)) { repeat++; continue; }
                seen.set(once, true);
                const [y, x] = c.cell.split(":").map(Number);
                const mid = { lat: (y + 0.5) * RS.COVER.cellDeg, lng: (x + 0.5) * RS.COVER.cellDeg };
                if (Math.abs(mid.lat) > 90 || Math.abs(mid.lng) > 180) { rejected++; continue; }
                s.coverUpsert.run(c.cell, RS.tileOf(mid.lat, mid.lng), crypto.createHash("sha256").update(c.token).digest("hex").slice(0, 16), Math.floor(c.t / 3600000) * 3600000);
                accepted++;
            }
        })();
        stats.coverAccepted += accepted; stats.coverRepeat += repeat;
        purge(s);
        return { status: 200, json: { ok: true, accepted, repeat, rejected } };
    }

    /**
     * Official lists and predictions into the feed table (from server.js at start, or a scheduled adapter).
     * @param {any[]} items validated items (roadsense-feeds.js validateFeedItem)
     */
    function ingest(items) {
        const s = ready();
        if (!s) return 0;
        let n = 0;
        s.tx(() => {
            for (const it of items || []) {
                if (!it || !RS.FEED_SOURCES.includes(it.source) || !fin(it.lat) || !fin(it.lng) || !fin(it.validUntil) || !fin(it.t) || !it.ref) continue;
                s.feedUpsert.run(it.id, RS.tileOf(it.lat, it.lng), it.type, it.source, it.ref, it.lat, it.lng, Math.round(it.t), Math.round(it.validUntil), it.conf, it.url || null, it.detail || null);
                n++;
            }
        })();
        stats.feedIngested += n;
        return n;
    }

    /**
     * RoadPulse: a rider's reviewed reports and votes. Each report becomes a "found" vote on the hazard it
     * duplicates, or a new hazard; each vote updates that rider's one vote on a hazard.
     * @param {any} body
     */
    async function publish(body, req = {}) {
        const s = ready();
        if (!s) return { status: 503, json: { ok: false, reason: "roadsense-not-configured" } };
        const reports = body && Array.isArray(body.reports) ? body.reports : [], votes = body && Array.isArray(body.votes) ? body.votes : [];
        const thanks = body && Array.isArray(body.thanks) ? body.thanks : [];
        const anon = Boolean(body && body.anonymous === true);
        if (!body || body.v !== 1 || (!anon && (typeof body.contributor !== "string" || !PSEUDONYM_RE.test(body.contributor)))
            || (anon && (body.contributor !== undefined || body.device !== undefined || reports.length > 0))
            || (body.device !== undefined && (typeof body.device !== "string" || !PSEUDONYM_RE.test(body.device)))
            || reports.length > L.publishReportsMax || votes.length > L.publishVotesMax || thanks.length > L.publishVotesMax
            || (anon && thanks.length > 0) || reports.length + votes.length + thanks.length === 0) {
            return { status: 400, json: { ok: false, reason: anon && reports.length ? "new hazards need a contributor" : "bad-request" } };
        }
        const t = now();
        const who = anon ? "" : contributorOf(body.contributor), dev = !anon && body.device ? deviceOf(body.device) : null;
        if (anon) {
            // anonymous: limited per network address and day, in memory only (like smooth passes)
            const day = new Date(t).toISOString().slice(0, 10);
            if (day !== anonDay || anonSeen.size > L.seenMax) { anonSeen = new Map(); anonDay = day; }
            const k = crypto.createHmac("sha256", o.secret()).update(`mu-anon-v1|${req.ip || "?"}|${day}`).digest("hex").slice(0, 24);
            const n = anonSeen.get(k) || 0;
            if (n + votes.length > L.votesPerDay) return { status: 429, json: { ok: false, reason: "daily-limit" } };
            anonSeen.set(k, n + votes.length);
        } else if (Number(s.rpToday.get(who, t - 86400000).n || 0) + reports.length > L.reportsPerDay
            || Number(s.vtToday.get(who, t - 86400000).n || 0) + votes.length > L.votesPerDay) return { status: 429, json: { ok: false, reason: "daily-limit" } };
        /** @type {any[]} */ const results = [];
        /** @type {{ i: number, kind: string, error: string }[]} */ const rejected = [];
        const okTime = (/** @type {any} */ x) => fin(x) && x >= t - L.pastMs && x <= t + L.futureMs;
        s.tx(() => {
            reports.forEach((/** @type {any} */ r, /** @type {number} */ i) => {
                const why = (/** @type {string} */ error) => { if (rejected.length < 20) rejected.push({ i, kind: "report", error }); };
                if (!r || typeof r !== "object" || typeof r.id !== "string" || !ID_RE.test(r.id)) return why("id is required");
                if (!AG.publicType(r.type)) return why("unknown type");
                if (![1, 2, 3].includes(r.severity)) return why("severity 1..3");
                if (!fin(r.lat) || !fin(r.lng) || Math.abs(r.lat) > 90 || Math.abs(r.lng) > 180) return why("bad position");
                if (r.sigmaM !== undefined && r.sigmaM !== null && (!fin(r.sigmaM) || r.sigmaM < 0 || r.sigmaM > 500)) return why("bad sigmaM");
                if (r.heading !== undefined && r.heading !== null && (!fin(r.heading) || r.heading < 0 || r.heading >= 360)) return why("bad heading");
                if (!okTime(r.t)) return why("t is outside the accepted window");
                if (!REPORT_SOURCES.has(r.source)) return why("source must be sensor or manual");
                const lat = Math.round(r.lat * 1e5) / 1e5, lng = Math.round(r.lng * 1e5) / 1e5, th = hourOf(r.t);
                const sigma = fin(r.sigmaM) ? Math.round(r.sigmaM * 10) / 10 : null, heading = fin(r.heading) ? Math.round(r.heading) : null;
                const R = roads();
                const sn = R ? R.snap(lat, lng, heading) : null;
                const rep = { type: r.type, lat, lng, sigmaM: sigma, heading, road: roadRef(sn) };
                const reach = (Math.max(AG.POLICY.matchM, 2 * (sigma || 0), sn ? 30 : 0) + 5) / 111320;
                const near = s.hzNear.all(lat - reach, lat + reach, lng - reach / Math.cos(lat * Math.PI / 180), lng + reach / Math.cos(lat * Math.PI / 180)).map(hazardOf);
                const match = matchHazard(s, near, rep);
                let hid, created = false, epoch;
                if (match) {
                    const sm = summaryOf(s, match, t);
                    epoch = AG.epochFor(match, sm, "found");
                    if (epoch !== match.epoch) { s.hzEpoch.run(epoch, th, who, dev, t, match.id); match.epoch = epoch; }
                    hid = match.id;
                    stats.reportsMatched++;
                } else {
                    if (sigma !== null && sigma > AG.POLICY.maxNewSigmaM) return why("too inaccurate to create a hazard");
                    hid = `h${crypto.randomBytes(8).toString("hex")}`;
                    epoch = 0;
                    s.hzInsert.run(hid, RS.tileOf(lat, lng), r.type, lat, lng, sigma, heading, r.bothWays === true ? 1 : 0, r.severity, 0, th, who, dev, t);
                    if (R) s.hzRoad.run(sn ? JSON.stringify(rep.road) : null, sn ? "ok" : "unmatched", hid);
                    created = true;
                    stats.hazardsCreated++;
                }
                const ins = s.rpInsert.run(r.id, hid, epoch, who, dev, r.type, r.severity, lat, lng, sigma, heading, th, r.source, t);
                if (Number(ins.changes) > 0 && rep.road) s.rpRoad.run(JSON.stringify(rep.road), r.id);
                if (Number(ins.changes) === 0) { results.push({ id: r.id, duplicate: true }); return; }
                // the report is the reporter's "found", with the ride it came from as its passage
                s.vtUpsert.run(hid, epoch, who, dev, "found", r.severity, th, t, 1, 0);
                s.vhInsert.run(hid, epoch, who, dev, "found", r.severity, JSON.stringify({ report: r.id, source: r.source }), 1, 0, th, t);
                if (r.source === "sensor") s.snAdd.run(hid, epoch, dayOf(th), 1, 0);     // sensor evidence: felt on this ride
                if (r.bothWays === true && !created) s.hzBoth.run(hid);
                replace(s, hazardOf(s.hzGet.get(hid)), t);
                results.push({ id: r.id, hazard: hid, created });
            });
            votes.forEach((/** @type {any} */ v, /** @type {number} */ i) => {
                const why = (/** @type {string} */ error) => { if (rejected.length < 20) rejected.push({ i, kind: "vote", error }); };
                if (!v || typeof v.hazard !== "string" || !HAZARD_RE.test(v.hazard)) return why("hazard is required");
                if (anon && (typeof v.token !== "string" || !PSEUDONYM_RE.test(v.token))) return why("an anonymous vote needs its per-hazard token");
                if (!AG.VERDICTS.includes(v.verdict)) return why("verdict must be found, not_found or unsure");
                if (!okTime(v.t)) return why("t is outside the accepted window");
                if (v.severity !== undefined && v.severity !== null && ![1, 2, 3].includes(v.severity)) return why("severity 1..3");
                const row = s.hzGet.get(v.hazard);
                if (!row) return why("no such hazard");
                const h = hazardOf(row), sm = summaryOf(s, h, t), th = hourOf(v.t);
                const voter = anon ? `a${crypto.createHmac("sha256", o.secret()).update(`mu-anon-vote-v1|${v.hazard}|${v.token}`).digest("hex").slice(0, 15)}` : who;
                const ps = passageOf(v.passage);
                // a new epoch only from a "found" that counts (and not anonymously: someone must stand behind a new pothole)
                const epoch = ps.ok && !anon ? AG.epochFor(h, sm, v.verdict) : h.epoch;
                if (epoch !== h.epoch) { s.hzEpoch.run(epoch, th, voter, dev, t, h.id); h.epoch = epoch; }
                const sev = v.verdict === "found" && fin(v.severity) ? v.severity : null;
                s.vhInsert.run(h.id, epoch, voter, dev, v.verdict, sev, ps.json, ps.ok ? 1 : 0, anon ? 1 : 0, th, t);
                s.vtUpsert.run(h.id, epoch, voter, dev, v.verdict, sev, th, t, ps.ok ? 1 : 0, anon ? 1 : 0);
                // sensor evidence on this pass, apart from the answer: felt, or passed with a good fix and nothing felt
                if (ps.ok && ps.felt === true) s.snAdd.run(h.id, epoch, dayOf(th), 1, 0);
                else if (ps.ok && ps.felt === false && ps.quality === "good") s.snAdd.run(h.id, epoch, dayOf(th), 0, 1);
                s.hzTouch.run(t, h.id);
                if (v.verdict === "found" && fin(v.severity)) replace(s, h, t);
                stats.votes++;
                results.push({ hazard: h.id, verdict: v.verdict, counts: ps.ok });
            });
            // community thanks: one per rider and hazard, never one's own, never part of accuracy
            for (const id of thanks) {
                if (typeof id !== "string" || !HAZARD_RE.test(id) || !s.hzGet.get(id)) continue;
                if (s.rpOfContributor.all(who).some((/** @type {any} */ r) => r.hazard_id === id)) continue;
                s.thAdd.run(id, who, t);
            }
        })();
        stats.published++;
        purge(s);
        return { status: 200, json: { ok: true, results, rejected } };
    }

    /**
     * Road upkeep (daily, and whenever the road data changes): re-snap every hazard from its physical point; split a
     * hazard whose reports form two groups along its road; merge two hazards that are one. Nothing is deleted for a
     * road change. @returns {{ resnapped: number, needsResnap: number, split: number, merged: number }}
     */
    function maintain() {
        const s = ready();
        const out = { resnapped: 0, needsResnap: 0, split: 0, merged: 0 };
        const R = roads();
        if (!s || !R) return out;
        const t = now();
        s.tx(() => {
            // 1. re-snap from the physical point (and each report's road, for splitting)
            for (const row of s.hzAllFull.all()) {
                const h = hazardOf(row);
                const sn = R.snap(h.lat, h.lng, fin(h.heading) ? h.heading : null);
                if (sn) { s.hzRoad.run(JSON.stringify(roadRef(sn)), "ok", h.id); out.resnapped++; }
                else { s.hzRoad.run(h.road ? JSON.stringify(h.road) : null, h.road ? "needs_resnap" : "unmatched", h.id); if (h.road) out.needsResnap++; }
                for (const rp of s.rpFullOfHazard.all(h.id, h.epoch)) {
                    const rs = R.snap(rp.lat, rp.lng, fin(rp.heading) ? rp.heading : null);
                    s.rpRoad.run(rs ? JSON.stringify(roadRef(rs)) : null, rp.id);
                }
            }
            // 2. split: two groups along the same road, each from 2+ riders
            for (const row of s.hzAllFull.all()) {
                const h = hazardOf(row);
                if (!h.road || h.roadStatus !== "ok") continue;
                const reps = s.rpFullOfHazard.all(h.id, h.epoch).map((/** @type {any} */ r) => ({ ...r, road: r.road ? JSON.parse(r.road) : null }))
                    .filter((/** @type {any} */ r) => r.road && r.road.wayId === h.road.wayId);
                const at = RD.splitPoint(reps.map((/** @type {any} */ r) => ({ alongM: r.road.alongM, sigmaM: r.sigma, contributor: r.contributor })));
                if (at === null) continue;
                const far = reps.filter((/** @type {any} */ r) => r.road.alongM > at), near = reps.filter((/** @type {any} */ r) => r.road.alongM <= at);
                // the new hazard takes the group the marker isn't in
                const move = h.road.alongM <= at ? far : near;
                const keep = move === far ? near : far;
                const nid = `h${crypto.randomBytes(8).toString("hex")}`;
                const first = move.reduce((/** @type {any} */ a, /** @type {any} */ b) => (a && a.id < b.id ? a : b), null);
                s.hzInsert.run(nid, RS.tileOf(move[0].lat, move[0].lng), h.type, move[0].lat, move[0].lng, move[0].sigma, h.heading, h.bothWays ? 1 : 0, h.severity, h.epoch, h.firstReportedAt, first.contributor, first.device, t);
                for (const r of move) s.rpMove.run(nid, r.id);
                // a rider whose reports all moved takes their vote along; a rider with reports on both sides votes on both
                const keepers = new Set(keep.map((/** @type {any} */ r) => r.contributor));
                for (const c of new Set(move.map((/** @type {any} */ r) => r.contributor))) {
                    const v = s.vtOne.get(h.id, h.epoch, c);
                    if (!v) continue;
                    if (keepers.has(c)) s.vtUpsert.run(nid, h.epoch, c, v.device, v.verdict, v.severity, v.t, v.received, v.counts, v.anon);
                    else s.vtMove.run(nid, h.id, h.epoch, c);
                }
                replace(s, hazardOf(s.hzGet.get(h.id)), t);
                replace(s, hazardOf(s.hzGet.get(nid)), t);
                out.split++;
            }
            // 3. merge: two hazards on the same road and direction, within each other's tolerance
            const all = s.hzAllFull.all().map(hazardOf).filter((/** @type {any} */ h) => h.road && h.roadStatus === "ok");
            const gone = new Set();
            for (const a of all) for (const b of all) {
                if (a.id >= b.id || gone.has(a.id) || gone.has(b.id) || AG.publicType(a.type) !== AG.publicType(b.type) || a.epoch !== b.epoch) continue;
                const m = RD.sameByRoad({ road: a.road, sigmaM: a.sigmaM, reports: Number(s.rpCountOf.get(a.id, a.epoch).n || 0), ...{ bothWays: a.bothWays } }, { road: b.road, sigmaM: b.sigmaM });
                if (!m.same) continue;
                // the older (first reported) one stays
                const [stay, go] = (a.firstReportedAt || 0) <= (b.firstReportedAt || 0) ? [a, b] : [b, a];
                s.rpMoveAll.run(stay.id, go.id);
                for (const v of s.vtOfHazard.all(go.id)) {
                    const mine = s.vtOne.get(stay.id, v.epoch, v.contributor);
                    if (!mine || v.t > mine.t) s.vtUpsert.run(stay.id, v.epoch, v.contributor, v.device, v.verdict, v.severity, v.t, v.received, v.counts, v.anon);
                    s.vtDeleteOne.run(go.id, v.epoch, v.contributor);
                }
                s.vhMoveAll.run(stay.id, go.id);
                s.snMoveAll.run(stay.id, go.id);
                s.snDeleteHazard.run(go.id);
                s.hzDelete.run(go.id);
                replace(s, hazardOf(s.hzGet.get(stay.id)), t);
                gone.add(go.id);
                out.merged++;
            }
        })();
        return out;
    }

    /**
     * The server-measurable part of the pilot scorecard (docs/roadpulse/PILOT-SCORECARD.md): what the hazards' states
     * are, how many were independently confirmed and how fast, and how much of what riders said counts. The rest of
     * the scorecard (location error, false alerts, battery, review completion) comes from field tests on phones.
     */
    function scorecard() {
        const s = ready();
        if (!s) return null;
        const t = now();
        /** @type {Record<string, number>} */ const states = {};
        const confirmDays = [];
        let independent = 0, needsResnap = 0;
        for (const row of s.hzAllFull.all()) {
            const h = hazardOf(row);
            const votes = s.vtOfHazard.all(h.id).map((/** @type {any} */ v) => ({ ...v, counts: v.counts === 1, anon: v.anon === 1 }));
            const sm = AG.summarize(h, votes, t);
            states[sm.status] = (states[sm.status] || 0) + 1;
            if (h.roadStatus === "needs_resnap") needsResnap++;
            if (!sm.independent) continue;
            independent++;
            const firstIndependent = votes.filter((v) => v.counts && !v.anon && v.verdict === "found" && v.contributor !== h.reporter && v.epoch === h.epoch && v.t >= (h.firstReportedAt || 0) + AG.POLICY.independentGapMs)
                .reduce((m, v) => Math.min(m, v.t), Infinity);
            if (Number.isFinite(firstIndependent)) confirmDays.push((firstIndependent - (h.firstReportedAt || firstIndependent)) / 86400000);
        }
        const all = db().prepare(`SELECT COUNT(*) AS n, SUM(counts) AS counted, SUM(anon) AS anon FROM roadsense_vote`).get();
        const hist = db().prepare(`SELECT COUNT(*) AS n FROM roadsense_vote_history`).get();
        const riders30 = db().prepare(`SELECT COUNT(DISTINCT contributor) AS n FROM roadsense_report WHERE received > ? AND contributor != ''`).get(t - 30 * 86400000);
        const sorted = confirmDays.sort((a, b) => a - b);
        const pct = (/** @type {number} */ q) => (sorted.length ? Math.round(sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))] * 10) / 10 : null);
        return {
            at: t, hazardsByState: states, independentlyConfirmed: independent, needsResnap,
            daysToIndependentConfirmation: { median: pct(0.5), p90: pct(0.9) },
            votes: { current: Number(all.n || 0), withPassage: Number(all.counted || 0), anonymous: Number(all.anon || 0), history: Number(hist.n || 0) },
            reportersLast30Days: Number(riders30.n || 0)
        };
    }
    const db = () => o.db();

    /** A rider's reputation and badges, from their reports and what other riders said about them. @param {any} body */
    async function me(body) {
        const s = ready();
        if (!s) return { status: 503, json: { ok: false, reason: "roadsense-not-configured" } };
        if (!body || body.v !== 1 || typeof body.contributor !== "string" || !PSEUDONYM_RE.test(body.contributor)) return { status: 400, json: { ok: false, reason: "bad-request" } };
        const who = contributorOf(body.contributor);
        const votesOf = (/** @type {string} */ id) => s.vtOfHazard.all(id).map((/** @type {any} */ v) => ({ ...v, counts: v.counts === 1, anon: v.anon === 1 }));
        const rep = REP.reputationOf({
            contributor: who, reports: s.rpAllOfContributor.all(who), votesOf,
            reviewsGiven: Number(s.vtGivenBy.get(who).n || 0), reviews: s.reviewsOf.all(who), thanksReceived: Number(s.thReceived.get(who, who).n || 0)
        });
        return { status: 200, json: { ok: true, ...rep } };
    }

    /** @param {any} body */
    async function forget(body) {
        const s = ready();
        if (!s) return { status: 503, json: { ok: false, reason: "roadsense-not-configured" } };
        const riders = body && Array.isArray(body.riders) ? body.riders : null;
        const labels = body && body.cover === undefined ? [] : body && Array.isArray(body.cover) ? body.cover : null;
        const contributors = body && body.contributors === undefined ? [] : body && Array.isArray(body.contributors) ? body.contributors : null;
        if (!body || body.v !== 1 || !riders || !labels || !contributors || riders.length > L.forgetMax || labels.length > L.forgetCoverMax || contributors.length > L.forgetContributorsMax
            || riders.length + labels.length + contributors.length === 0
            || [...riders, ...contributors].some((/** @type {any} */ r) => typeof r !== "string" || !PSEUDONYM_RE.test(r)) || labels.some((/** @type {any} */ l) => typeof l !== "string" || !LABEL_RE.test(l))) {
            return { status: 400, json: { ok: false, reason: "bad-request" } };
        }
        let deleted = 0;
        const t = now();
        s.tx(() => {
            for (const p of riders) deleted += Number(s.forget.run(labelOf(p)).changes || 0);
            for (const l of labels) deleted += Number(s.coverForget.run(l).changes || 0);
            // RoadPulse: the rider's reports and votes; a hazard nobody else voted on goes with them
            for (const c of contributors) {
                const who = contributorOf(c);
                const touched = new Set([...s.rpOfContributor.all(who), ...s.vtOfContributor.all(who)].map((/** @type {any} */ r) => r.hazard_id));
                deleted += Number(s.rpForget.run(who).changes || 0) + Number(s.vtForget.run(who).changes || 0);
                s.vhForget.run(who);
                s.thForget.run(who);
                for (const id of touched) {
                    const row = s.hzGet.get(id);
                    if (!row) continue;
                    if (!s.vtOfHazard.all(id).length) { s.rpDeleteHazard.run(id); s.vhDeleteHazard.run(id); s.snDeleteHazard.run(id); s.thDeleteHazard.run(id); s.hzDelete.run(id); continue; }
                    if (row.reporter === who) s.hzEpoch.run(row.epoch, row.first_t, "", null, t, id);      // no longer theirs
                    replace(s, hazardOf(s.hzGet.get(id)), t);
                }
            }
        })();
        stats.forgotten += deleted;
        return { status: 200, json: { ok: true, deleted } };
    }

    return {
        upload, area, forget, cover: coverUpload, ingest, publish, me, maintain, scorecard, labelOf, contributorOf,
        configured: () => Boolean(o.db()),
        stats: () => {
            const s = ready();
            return { ...stats, stored: s ? Number(s.count.get().n || 0) : 0, coverStored: s ? Number(s.coverCount.get().n || 0) : 0, feedStored: s ? Number(s.feedCount.get().n || 0) : 0,
                hazardsStored: s ? Number(s.hzCount.get().n || 0) : 0 };
        }
    };
}

module.exports = { createRoadsense, LIMITS };
