// @ts-check
"use strict";
/* ============================================================================
   MapUnite fleet data — anonymous fill-ups for calibration (Step 8)
   ==============================================================================
   What a phone sends, only after the rider opts in (POST /api/bikes/fillups):
   one record per FULL-TO-FULL tank interval the fill-up learner already uses —
     litres, km, idle hours, km per 5 km/h speed bin (40 bins), total mass on the
     bike (rounded to 5 kg), fuel grade, and which bike (the bundle hash the phone
     used, plus the bike's stable id — or the class, for a typical bike — so records
     made with an older catalogue build are still placed).
   What it never sends or the server never stores: location, routes, times of
   day, dates of rides, device ids, IP addresses, names. The only link between a
   rider's tanks is `contributor`: a random token the app makes for this purpose
   only (resettable); the server keeps an HMAC of it, used to cap one rider's
   weight in a fit and to delete everything on request (DELETE with the token).
   The day a record arrived is kept for retention, nothing finer.

   Records are validated hard (plausible km/L, a speed histogram that adds up to
   the distance, a known bike and fuel), and a resent record is recognised by its
   content and stored once.

   Tables live in the server's own writable database (data/mapunite.db), next to
   the bike-request queue — never in bikes.sqlite, which is a build output.
   ============================================================================ */

const crypto = require("crypto");
const { BINS, BIN_KMH } = require("./calibration.js");

const CONSENT = "fleet-calibration-v1";
const LIMITS = Object.freeze({
    tanksPerPost: 20,
    kmMin: 5, kmMax: 3000,
    litresMin: 0.2, litresMax: 60,
    kmPerLMin: 2, kmPerLMax: 120,
    idleHMax: 48,
    massMin: 40, massMax: 400,
    histSlack: 0.1                     // the speed bins must add up to the distance within ±10 %
});

const SCHEMA = `
CREATE TABLE IF NOT EXISTS fleet_tank (
    tank_id      INTEGER PRIMARY KEY,
    fingerprint  TEXT NOT NULL UNIQUE,                 -- HMAC(contributor, content): a resent tank is stored once
    contributor  TEXT NOT NULL,                        -- HMAC of the app's random token, never the token
    class_key    TEXT NOT NULL,
    bike_id      TEXT NOT NULL,                        -- the bike (variant or class default id): stable across catalogue builds
    bundle       TEXT NOT NULL CHECK (length(bundle) = 16),   -- the bundle the phone used (its data version)
    fuel_code    TEXT NOT NULL,
    mass_kg      INTEGER NOT NULL CHECK (mass_kg BETWEEN ${LIMITS.massMin} AND ${LIMITS.massMax} AND mass_kg % 5 = 0),
    litres       REAL NOT NULL CHECK (litres > 0),
    km           REAL NOT NULL CHECK (km > 0),
    idle_h       REAL NOT NULL CHECK (idle_h >= 0),
    hist         TEXT NOT NULL CHECK (json_valid(hist) AND json_array_length(hist) = ${BINS}),
    received_day TEXT NOT NULL CHECK (received_day GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]')
) STRICT;
CREATE INDEX IF NOT EXISTS fleet_tank_by_class ON fleet_tank (class_key, bike_id);
CREATE INDEX IF NOT EXISTS fleet_tank_by_contributor ON fleet_tank (contributor);
CREATE TABLE IF NOT EXISTS fleet_fit (
    class_key       TEXT PRIMARY KEY,
    fitted_day      TEXT NOT NULL,
    catalog_version TEXT NOT NULL,
    result          TEXT NOT NULL CHECK (json_valid(result))
) STRICT, WITHOUT ROWID;
`;

/**
 * @typedef {{ classKey: string, bikeId: string, bundle: string, fuelCode: string, massKg: number, litres: number, km: number, idleH: number, hist: number[] }} TankInput
 * @typedef {{ index: number, field: string, message: string }} TankError
 */

/**
 * Check one tank record from a phone. `known` says which bikes and fuels exist.
 * @param {unknown} t
 * @param {{ bundleClass: (hash: string) => { classKey: string, bikeId: string } | null,
 *           bikeClass?: (bikeId: string|null|undefined, classKey: string|null|undefined) => { classKey: string, bikeId: string } | null,
 *           fuels: string[], evClass: (classKey: string) => boolean }} known
 *   bundleClass: the bike a bundle hash of the CURRENT catalogue is; bikeClass: the bike by its id (or a
 *   class's typical bike), for a hash an older build shipped (a reviewed calibration changes its class's hashes)
 * @returns {{ ok: true, value: TankInput } | { ok: false, field: string, message: string }}
 */
function validateTank(t, known) {
    const bad = (/** @type {string} */ field, /** @type {string} */ message) => ({ ok: /** @type {false} */ (false), field, message });
    if (!t || typeof t !== "object" || Array.isArray(t)) return bad("", "a tank must be an object");
    const x = /** @type {Record<string, any>} */ (t);
    if (typeof x.bundle !== "string" || !/^[0-9a-f]{16}$/.test(x.bundle)) return bad("bundle", "bundle must be a 16-hex bundle hash");
    if (x.bike !== undefined && x.bike !== null && typeof x.bike !== "string") return bad("bike", "bike must be the bike's id");
    const bike = known.bundleClass(x.bundle) || (known.bikeClass ? known.bikeClass(x.bike, x.classKey) : null);
    if (!bike) return bad("bundle", "not a bike in the catalogue");
    if (typeof x.bike === "string" && x.bike !== bike.bikeId) return bad("bike", `the bundle is ${bike.bikeId}, not ${x.bike}`);
    const classKey = bike.classKey;
    if (x.classKey !== undefined && x.classKey !== classKey) return bad("classKey", `the bundle is a ${classKey}, not ${x.classKey}`);
    if (known.evClass(classKey)) return bad("bundle", "electric bikes calibrate from charging data, not fill-ups");
    if (typeof x.fuelCode !== "string" || !known.fuels.includes(x.fuelCode)) return bad("fuelCode", "unknown fuel grade");
    const num = (/** @type {string} */ k) => (typeof x[k] === "number" && Number.isFinite(x[k]) ? x[k] : NaN);
    const massKg = num("massKg"), litres = num("litres"), km = num("km"), idleH = x.idleH === undefined ? 0 : num("idleH");
    if (!(massKg >= LIMITS.massMin && massKg <= LIMITS.massMax)) return bad("massKg", `mass must be ${LIMITS.massMin}–${LIMITS.massMax} kg`);
    if (!(km >= LIMITS.kmMin && km <= LIMITS.kmMax)) return bad("km", `km must be ${LIMITS.kmMin}–${LIMITS.kmMax}`);
    if (!(litres >= LIMITS.litresMin && litres <= LIMITS.litresMax)) return bad("litres", `litres must be ${LIMITS.litresMin}–${LIMITS.litresMax}`);
    if (!(km / litres >= LIMITS.kmPerLMin && km / litres <= LIMITS.kmPerLMax)) return bad("litres", `${(km / litres).toFixed(1)} km/L isn't plausible for a motorcycle or scooter`);
    if (!(idleH >= 0 && idleH <= LIMITS.idleHMax)) return bad("idleH", `idle hours must be 0–${LIMITS.idleHMax}`);
    if (!Array.isArray(x.hist) || x.hist.length !== BINS || !x.hist.every((v) => typeof v === "number" && Number.isFinite(v) && v >= 0)) return bad("hist", `hist must be ${BINS} distances (km per ${BIN_KMH} km/h bin)`);
    const sum = x.hist.reduce((a, v) => a + v, 0);
    if (Math.abs(sum - km) > LIMITS.histSlack * km) return bad("hist", `the speed bins add up to ${sum.toFixed(1)} km, the tank to ${km} km`);
    return {
        ok: true,
        value: {
            classKey, bikeId: bike.bikeId, bundle: x.bundle, fuelCode: x.fuelCode,
            massKg: 5 * Math.round(massKg / 5),                    // never finer than 5 kg
            litres: Math.round(litres * 100) / 100, km: Math.round(km * 10) / 10,
            idleH: Math.round(idleH * 100) / 100, hist: x.hist.map((v) => Math.round(v * 1000) / 1000)
        }
    };
}

class FleetStore {
    /**
     * @param {{ exec: (sql: string) => any, prepare: (sql: string) => any }} db  the server's writable database
     * @param {{ secret?: string|Buffer|null, now?: () => number, retentionDays?: number }} [opts]
     *   secret: HMAC key for contributor tokens (the server's SERVER_SECRET). Without it the store is
     *           read-only for tokens (the calibration CLI only reads tanks and saves fits).
     */
    constructor(db, opts = {}) {
        if (!db || typeof db.prepare !== "function") throw new TypeError("FleetStore needs a writable SQLite database");
        this._db = db;
        this._secret = opts.secret || null;
        this._now = opts.now || Date.now;
        this.retentionDays = opts.retentionDays === undefined ? 730 : opts.retentionDays;
        db.exec(SCHEMA);
        this._st = {
            insert: db.prepare(`INSERT INTO fleet_tank (fingerprint, contributor, class_key, bike_id, bundle, fuel_code, mass_kg, litres, km, idle_h, hist, received_day)
                                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT (fingerprint) DO NOTHING`),
            byClass: db.prepare("SELECT contributor, bike_id AS bike, fuel_code AS fuelCode, mass_kg AS massKg, litres, km, idle_h AS idleH, hist FROM fleet_tank WHERE class_key = ? ORDER BY tank_id"),
            classes: db.prepare("SELECT class_key AS classKey, count(*) AS tanks, count(DISTINCT contributor) AS riders, sum(km) AS km FROM fleet_tank GROUP BY class_key ORDER BY class_key"),
            mine: db.prepare("SELECT class_key AS classKey, count(*) AS tanks FROM fleet_tank WHERE contributor = ? GROUP BY class_key ORDER BY class_key"),
            forget: db.prepare("DELETE FROM fleet_tank WHERE contributor = ?"),
            purge: db.prepare("DELETE FROM fleet_tank WHERE received_day < ?"),
            saveFit: db.prepare(`INSERT INTO fleet_fit (class_key, fitted_day, catalog_version, result) VALUES (?, ?, ?, ?)
                                 ON CONFLICT (class_key) DO UPDATE SET fitted_day = excluded.fitted_day, catalog_version = excluded.catalog_version, result = excluded.result`),
            fit: db.prepare("SELECT class_key AS classKey, fitted_day AS fittedDay, catalog_version AS catalogVersion, result FROM fleet_fit WHERE class_key = ?"),
            fits: db.prepare("SELECT class_key AS classKey, fitted_day AS fittedDay, catalog_version AS catalogVersion, result FROM fleet_fit ORDER BY class_key")
        };
    }

    /** The server-side id of a contributor token (never stored as given). @param {string} token */
    contributorId(token) {
        if (!this._secret) throw new Error("FleetStore: no secret, so contributor tokens can't be used here");
        if (typeof token !== "string" || !/^[0-9a-f]{32,64}$/.test(token)) throw new RangeError("contributor must be 32–64 hex characters (a random token the app made)");
        return crypto.createHmac("sha256", this._secret).update(`mu-fleet-v1|${token}`).digest("hex").slice(0, 32);
    }

    /**
     * Store validated tanks for one contributor, atomically. Resent tanks are skipped.
     * @param {string} token @param {TankInput[]} tanks
     * @returns {{ stored: number, duplicates: number }}
     */
    submit(token, tanks) {
        const who = this.contributorId(token);
        const day = this.today();
        let stored = 0;
        this._db.exec("BEGIN IMMEDIATE");
        try {
            for (const t of tanks) {
                const content = JSON.stringify([t.bikeId, t.fuelCode, t.massKg, t.litres, t.km, t.idleH, t.hist]);
                const fp = crypto.createHmac("sha256", /** @type {string|Buffer} */ (this._secret)).update(`${who}|${content}`).digest("hex").slice(0, 32);
                stored += Number(this._st.insert.run(fp, who, t.classKey, t.bikeId, t.bundle, t.fuelCode, t.massKg, t.litres, t.km, t.idleH, JSON.stringify(t.hist), day).changes);
            }
            this._db.exec("COMMIT");
        } catch (e) {
            try { this._db.exec("ROLLBACK"); } catch { /* already rolled back */ }
            throw e;
        }
        return { stored, duplicates: tanks.length - stored };
    }

    /** Everything one contributor sent, by class (for "your contribution"). @param {string} token */
    mine(token) { return this._st.mine.all(this.contributorId(token)).map((r) => ({ classKey: r.classKey, tanks: Number(r.tanks) })); }

    /** Delete everything a contributor sent. @param {string} token @returns {number} tanks deleted */
    forget(token) { return Number(this._st.forget.run(this.contributorId(token)).changes); }

    /** Drop tanks older than the retention period. @returns {number} */
    purge() {
        if (!this.retentionDays) return 0;
        const cutoff = new Date(this._now() - this.retentionDays * 86400_000).toISOString().slice(0, 10);
        return Number(this._st.purge.run(cutoff).changes);
    }

    /** Tanks of one class, in the calibration's shape. @param {string} classKey */
    tanks(classKey) {
        return this._st.byClass.all(classKey).map((r) => ({
            contributor: r.contributor, bike: r.bike, fuelCode: r.fuelCode, massKg: Number(r.massKg),
            litres: Number(r.litres), km: Number(r.km), idleH: Number(r.idleH), hist: JSON.parse(r.hist)
        }));
    }

    /** Per class: tanks, riders, km. */
    classes() { return this._st.classes.all().map((r) => ({ classKey: r.classKey, tanks: Number(r.tanks), riders: Number(r.riders), km: Math.round(Number(r.km) * 10) / 10 })); }

    /** @param {string} classKey @param {string} catalogVersion @param {any} result */
    saveFit(classKey, catalogVersion, result) { this._st.saveFit.run(classKey, this.today(), catalogVersion, JSON.stringify(result)); }

    /** @param {string} classKey */
    fit(classKey) { const r = this._st.fit.get(classKey); return r ? { classKey: r.classKey, fittedDay: r.fittedDay, catalogVersion: r.catalogVersion, result: JSON.parse(r.result) } : null; }
    fits() { return this._st.fits.all().map((r) => ({ classKey: r.classKey, fittedDay: r.fittedDay, catalogVersion: r.catalogVersion, result: JSON.parse(r.result) })); }

    today() { return new Date(this._now()).toISOString().slice(0, 10); }
}

module.exports = { CONSENT, LIMITS, SCHEMA, FleetStore, validateTank };
