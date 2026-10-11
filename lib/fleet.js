"use strict";
/* ============================================================================
   MapUnite server — anonymous tank telemetry (FLEET.md v1, roadmap step 10)
   ==============================================================================
   createFleet(db, { contract, now })  framework-agnostic handlers over SQLite
     .upload({ auth, body })   → { status, json }   POST /api/fleet/v1/tanks
     .remove({ auth })         → { status, json }   DELETE /api/fleet/v1/contributor
     .summary(bikeId)          → { status, json }   GET /api/fleet/v1/bikes/:id/summary
     .purgeOld()               24-month retention (call daily)
   mount(app, express, db, { limiter })  Express glue used by server.js

   Works with better-sqlite3 (server.js) and node:sqlite (tests): only
   prepare/run/get/all/exec are used. Validation is MUFleet.contract — the same
   code the phone runs (public/js/rides/fleet.js).

   Stored: the tank fields, the consent version, the app version, received_at.
   NOT stored: IP address, user agent, the contributor secret (only its SHA-256).
   ============================================================================ */
const crypto = require("crypto");
const path = require("path");

const DAY_LIMIT = 200;                 // tanks per contributor per UTC day
const K_ANON = 5;                      // contributors before a bike summary is published
const RETENTION_MS = 730 * 86400000;   // ~24 months
const AUTH_RE = /^Fleet ([A-Za-z0-9_-]{22})$/;

function defaultContract() {
    return require(path.join(__dirname, "..", "public", "js", "rides", "fleet.js")).contract;
}

/**
 * @param {{ prepare: Function, exec: Function }} db
 * @param {{ contract?: any, now?: () => number }} [o]
 */
function createFleet(db, o = {}) {
    const C = o.contract || defaultContract();
    const now = o.now || Date.now;
    db.exec(`
        CREATE TABLE IF NOT EXISTS fleet_contributors (
            hash TEXT PRIMARY KEY, created_at INTEGER NOT NULL, last_seen INTEGER NOT NULL, day TEXT, day_count INTEGER NOT NULL DEFAULT 0
        );
        CREATE TABLE IF NOT EXISTS fleet_tanks (
            id TEXT PRIMARY KEY, contributor_hash TEXT NOT NULL, bike_id TEXT, class_key TEXT NOT NULL, month TEXT NOT NULL,
            distance REAL NOT NULL, fuel REAL NOT NULL, odo_distance REAL, coverage REAL,
            band0 REAL NOT NULL, band1 REAL NOT NULL, band2 REAL NOT NULL, band3 REAL NOT NULL,
            idle_time REAL NOT NULL, trips INTEGER NOT NULL, consent TEXT NOT NULL, app TEXT, received_at INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS fleet_tanks_bike ON fleet_tanks(bike_id);
        CREATE INDEX IF NOT EXISTS fleet_tanks_contributor ON fleet_tanks(contributor_hash);
        CREATE INDEX IF NOT EXISTS fleet_tanks_received ON fleet_tanks(received_at);
    `);
    const q = {
        getC: db.prepare("SELECT hash, day, day_count FROM fleet_contributors WHERE hash = ?"),
        insC: db.prepare("INSERT INTO fleet_contributors (hash, created_at, last_seen, day, day_count) VALUES (?, ?, ?, ?, 0)"),
        touchC: db.prepare("UPDATE fleet_contributors SET last_seen = ?, day = ?, day_count = ? WHERE hash = ?"),
        hasT: db.prepare("SELECT 1 AS x FROM fleet_tanks WHERE id = ?"),
        insT: db.prepare(`INSERT INTO fleet_tanks (id, contributor_hash, bike_id, class_key, month, distance, fuel, odo_distance, coverage, band0, band1, band2, band3, idle_time, trips, consent, app, received_at)
                          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`),
        delT: db.prepare("DELETE FROM fleet_tanks WHERE contributor_hash = ?"),
        delC: db.prepare("DELETE FROM fleet_contributors WHERE hash = ?"),
        countBike: db.prepare("SELECT COUNT(DISTINCT contributor_hash) AS c, COUNT(*) AS n FROM fleet_tanks WHERE bike_id = ?"),
        econBike: db.prepare("SELECT distance / (fuel * MIN(1.0, COALESCE(coverage, 1.0))) AS e FROM fleet_tanks WHERE bike_id = ? ORDER BY e"),
        purge: db.prepare("DELETE FROM fleet_tanks WHERE received_at < ?"),
        purgeC: db.prepare("DELETE FROM fleet_contributors WHERE last_seen < ? AND hash NOT IN (SELECT DISTINCT contributor_hash FROM fleet_tanks)")
    };
    const hashOf = (secret) => crypto.createHash("sha256").update(secret).digest("hex");
    /** @returns {string|null} */
    function contributorHash(auth) {
        const m = AUTH_RE.exec(String(auth || "").trim());
        return m ? hashOf(m[1]) : null;
    }
    function tx(fn) {
        db.exec("BEGIN");
        try { const r = fn(); db.exec("COMMIT"); return r; } catch (e) { try { db.exec("ROLLBACK"); } catch { /* already rolled back */ } throw e; }
    }

    function upload({ auth, body }) {
        const h = contributorHash(auth);
        if (!h) return { status: 401, json: { ok: false, error: "Authorization: Fleet <contributor> required" } };
        if (body && Array.isArray(body.tanks) && body.tanks.length > C.MAX_TANKS) return { status: 413, json: { ok: false, error: `at most ${C.MAX_TANKS} tanks per request` } };
        const envErr = C.validateEnvelope(body);
        if (envErr) return { status: 400, json: { ok: false, error: envErr } };
        const t0 = now();
        const day = new Date(t0).toISOString().slice(0, 10);
        return tx(() => {
            let c = q.getC.get(h);
            if (!c) { q.insC.run(h, t0, t0, day); c = { hash: h, day, day_count: 0 }; }
            const used = c.day === day ? Number(c.day_count) : 0;
            if (used + body.tanks.length > DAY_LIMIT) return { status: 429, json: { ok: false, error: "daily limit reached, try tomorrow" } };
            let accepted = 0, duplicates = 0;
            const rejected = [];
            for (const t of body.tanks) {
                const err = C.validateTank(t, t0);
                if (err) { rejected.push({ id: t && typeof t.id === "string" ? t.id.slice(0, 16) : null, error: err }); continue; }
                if (q.hasT.get(t.id)) { duplicates++; continue; }
                q.insT.run(t.id, h, body.bike.id, body.bike.classKey, t.month, t.distance, t.fuel, t.odoDistance ?? null, t.coverage ?? null,
                    t.bandShare[0], t.bandShare[1], t.bandShare[2], t.bandShare[3], t.idleTime, t.trips, body.consent, body.app, t0);
                accepted++;
            }
            q.touchC.run(t0, day, used + accepted, h);
            if (!accepted && !duplicates && rejected.length) return { status: 400, json: { ok: false, error: "no valid tanks", rejected } };
            return { status: 200, json: { ok: true, accepted, duplicates, ...(rejected.length ? { rejected } : {}) } };
        });
    }

    function remove({ auth }) {
        const h = contributorHash(auth);
        if (!h) return { status: 401, json: { ok: false, error: "Authorization: Fleet <contributor> required" } };
        return tx(() => {
            const r = q.delT.run(h);
            q.delC.run(h);
            return { status: 200, json: { ok: true, deleted: Number(r.changes || 0) } };
        });
    }

    function summary(bikeId) {
        if (typeof bikeId !== "string" || !/^[a-z0-9-]{3,80}$/.test(bikeId)) return { status: 400, json: { ok: false, error: "bad bike id" } };
        const c = q.countBike.get(bikeId);
        if (!c || Number(c.c) < K_ANON) return { status: 404, json: { ok: false, error: "not enough contributors" } };
        const e = q.econBike.all(bikeId).map((r) => Number(r.e)).filter(Number.isFinite);
        const at = (p) => e[Math.min(e.length - 1, Math.max(0, Math.round(p * (e.length - 1))))];
        return { status: 200, json: { ok: true, bike: bikeId, contributors: Number(c.c), tanks: Number(c.n), metresPerCubicMetre: { p25: at(0.25), median: at(0.5), p75: at(0.75) } } };
    }

    function purgeOld() {
        const cut = now() - RETENTION_MS;
        const r = q.purge.run(cut);
        q.purgeC.run(cut);
        return Number(r.changes || 0);
    }

    return { upload, remove, summary, purgeOld, contributorHash, K_ANON, DAY_LIMIT };
}

/**
 * Express routes. server.js: require("./lib/fleet").mount(app, express, () => db, { limiter }).
 * `db` may be a function returning the database, so the routes can be registered before
 * the app's global JSON parser (their own 32 kB limit then applies) while the database
 * is opened later in server.js.
 * @param {any} app @param {any} express @param {any} db @param {{ limiter?: any, contract?: any }} [o]
 */
function mount(app, express, db, o = {}) {
    let instance = null;
    const fleetOf = () => (instance || (instance = createFleet(typeof db === "function" ? db() : db, { contract: o.contract })));
    const fleet = {
        upload: (a) => fleetOf().upload(a), remove: (a) => fleetOf().remove(a),
        summary: (id) => fleetOf().summary(id), purgeOld: () => fleetOf().purgeOld()
    };
    const mw = o.limiter ? [o.limiter] : [];
    const send = (res, r) => res.status(r.status).set("Cache-Control", "no-store").json(r.json);
    app.post("/api/fleet/v1/tanks", ...mw, express.json({ limit: "32kb" }), (req, res) => {
        try { send(res, fleet.upload({ auth: req.get("authorization"), body: req.body })); } catch (e) { res.status(500).json({ ok: false, error: "server error" }); }
    });
    app.delete("/api/fleet/v1/contributor", ...mw, (req, res) => {
        try { send(res, fleet.remove({ auth: req.get("authorization") })); } catch (e) { res.status(500).json({ ok: false, error: "server error" }); }
    });
    app.get("/api/fleet/v1/bikes/:id/summary", ...mw, (req, res) => {
        try { send(res, fleet.summary(req.params.id)); } catch (e) { res.status(500).json({ ok: false, error: "server error" }); }
    });
    // express.json() above runs per route; a too-large body arrives as a 413 from body-parser
    const timer = setInterval(() => { try { fleet.purgeOld(); } catch { /* next time */ } }, 24 * 3600000);
    if (timer.unref) timer.unref();
    return fleet;
}

module.exports = { createFleet, mount, DAY_LIMIT, K_ANON, RETENTION_MS };
