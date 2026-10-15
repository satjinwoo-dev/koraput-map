// @ts-check
"use strict";
/* ============================================================================
   MapUnite RoadSense Live — the server's half of the sync (/api/master/roadsense/*)
   ==============================================================================
     POST /roadsense/upload  { v: 1, rider, obs: [...] }   ≤ 200 observations a call
     POST /roadsense/area    { v: 1, tiles: ["y:x", …] }   ≤ 24 tiles of 0.05° (≈ 5.5 km)
     POST /roadsense/forget  { v: 1, riders: [...] }       delete everything those pseudonyms sent

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
    purgeEveryMs: 3600000
});
const PSEUDONYM_RE = /^[A-Za-z0-9_-]{16,64}$/;
const PHONE_SOURCES = new Set(["imu", "camera", "rider"]);
const fin = (/** @type {any} */ v) => typeof v === "number" && Number.isFinite(v);

/**
 * @param {{ db: () => any, secret: () => string, now?: () => number, limits?: Partial<typeof LIMITS> }} o
 */
function createRoadsense(o) {
    const now = o.now || Date.now;
    const L = { ...LIMITS, ...(o.limits || {}) };
    /** @type {any} */ let schemaFor = null;
    /** @type {any} */ let q = null;
    let lastPurge = -Infinity;
    const stats = { uploads: 0, accepted: 0, duplicates: 0, rejected: 0, areas: 0, served: 0, forgotten: 0, purged: 0 };

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
`);
        q = {
            insert: db.prepare(`INSERT OR IGNORE INTO roadsense_obs (id, tile, type, t, lat, lng, source, rider, present, conf, peak, received) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`),
            countToday: db.prepare(`SELECT COUNT(*) AS n FROM roadsense_obs WHERE rider = ? AND received > ?`),
            tile: db.prepare(`SELECT id, type, t, lat, lng, source, rider, present, conf, peak FROM roadsense_obs WHERE tile = ? AND t > ? ORDER BY t DESC LIMIT ?`),
            forget: db.prepare(`DELETE FROM roadsense_obs WHERE rider = ?`),
            purge: db.prepare(`DELETE FROM roadsense_obs WHERE type = ? AND t < ?`),
            count: db.prepare(`SELECT COUNT(*) AS n FROM roadsense_obs`),
            tx: (/** @type {Function} */ fn) => db.transaction(fn)
        };
        schemaFor = db;
        return q;
    }

    /** The stored label for a pseudonym: stable for the day it's used, unlinkable to it without the secret. @param {string} pseudonym */
    const labelOf = (pseudonym) => `r${crypto.createHmac("sha256", o.secret()).update(`mu-roadsense-v1|${pseudonym}`).digest("hex").slice(0, 15)}`;

    function purge(/** @type {any} */ s) {
        const t = now();
        if (t - lastPurge < L.purgeEveryMs) return;
        lastPurge = t;
        for (const [type, def] of Object.entries(RS.TYPES)) stats.purged += Number(s.purge.run(type, t - def.maxAgeMs).changes || 0);
    }

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
            log.addAll(s.tile.all(tile, oldest, L.obsPerTile).map((/** @type {any} */ r) => ({
                id: r.id, type: r.type, t: r.t, lat: r.lat, lng: r.lng, source: r.source, rider: r.rider, present: r.present === 1, conf: r.conf, peakMs2: fin(r.peak) ? r.peak : null
            })));
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
        stats.served += out.length;
        return { status: 200, json: { ok: true, t, tiles: perTile, obs: out, truncated: out.length >= L.responseObsMax } };
    }

    /** @param {any} body */
    async function forget(body) {
        const s = ready();
        if (!s) return { status: 503, json: { ok: false, reason: "roadsense-not-configured" } };
        if (!body || body.v !== 1 || !Array.isArray(body.riders) || !body.riders.length || body.riders.length > L.forgetMax || body.riders.some((/** @type {any} */ r) => typeof r !== "string" || !PSEUDONYM_RE.test(r))) {
            return { status: 400, json: { ok: false, reason: "bad-request" } };
        }
        let deleted = 0;
        s.tx(() => { for (const p of body.riders) deleted += Number(s.forget.run(labelOf(p)).changes || 0); })();
        stats.forgotten += deleted;
        return { status: 200, json: { ok: true, deleted } };
    }

    return {
        upload, area, forget, labelOf,
        configured: () => Boolean(o.db()),
        stats: () => { const s = ready(); return { ...stats, stored: s ? Number(s.count.get().n || 0) : 0 }; }
    };
}

module.exports = { createRoadsense, LIMITS };
