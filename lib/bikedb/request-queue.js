// @ts-check
"use strict";
/* ============================================================================
   MapUnite bike catalogue — queue of requests for bikes we don't have yet
   ==============================================================================
   Riders who can't find their bike ask for it. A request is only a NAME (make,
   model, variant, market) plus optional hints; it never becomes bike data by
   itself. A curator researches it into data/bikes/ like any other bike, with
   sources, confidence and the fuel-safety rules (or into pending/).

   The queue lives in the server's own writable database (data/mapunite.db), not
   in bikes.sqlite, which is a read-only build output replaced on every build.

   One row per distinct bike: names are normalised with the catalogue search
   tokeniser, so "Royal-Enfield hunter350" and "Royal Enfield Hunter 350" are the
   same request. Demand is counted per requester (a pseudonymous key the server
   derives with its secret; the raw IP is never stored), so one rider asking
   ten times is one vote. Each requester's latest hints (year, powertrain, note)
   are kept for the curator.
   ============================================================================ */

const Search = require("../../public/js/bikedb/catalog-search.js");

const POWERTRAINS = ["ice_manual", "ice_cvt", "ev"];
const STATUSES = ["queued", "researching", "added", "rejected"];
const LIMITS = Object.freeze({ name: 60, note: 280, requester: 64 });
/** Characters a name may not contain: control characters, and the angle brackets of markup. */
const BAD_NAME_CHARS = /[\u0000-\u001f\u007f-\u009f<>]/;
const BAD_NOTE_CHARS = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS bike_request (
    request_id   INTEGER PRIMARY KEY,
    request_key  TEXT NOT NULL UNIQUE,              -- market|make tokens|model tokens|variant tokens
    market       TEXT NOT NULL CHECK (length(market) = 2 AND market = upper(market)),
    make         TEXT NOT NULL CHECK (length(make) BETWEEN 1 AND ${LIMITS.name}),
    model        TEXT NOT NULL CHECK (length(model) BETWEEN 1 AND ${LIMITS.name}),
    variant      TEXT CHECK (variant IS NULL OR length(variant) BETWEEN 1 AND ${LIMITS.name}),
    status       TEXT NOT NULL DEFAULT 'queued' CHECK (status IN (${STATUSES.map((s) => `'${s}'`).join(", ")})),
    requesters   INTEGER NOT NULL DEFAULT 0 CHECK (requesters >= 0),
    first_at     INTEGER NOT NULL,                  -- ms since 1970
    last_at      INTEGER NOT NULL
) STRICT;
CREATE INDEX IF NOT EXISTS bike_request_by_demand ON bike_request (status, requesters DESC, first_at);
CREATE TABLE IF NOT EXISTS bike_request_vote (
    request_id  INTEGER NOT NULL REFERENCES bike_request (request_id) ON DELETE CASCADE,
    requester   TEXT NOT NULL CHECK (length(requester) BETWEEN 1 AND ${LIMITS.requester}),
    year        INTEGER CHECK (year IS NULL OR year BETWEEN 1950 AND 2100),
    powertrain  TEXT CHECK (powertrain IS NULL OR powertrain IN (${POWERTRAINS.map((p) => `'${p}'`).join(", ")})),
    note        TEXT CHECK (note IS NULL OR length(note) <= ${LIMITS.note}),
    at          INTEGER NOT NULL,
    PRIMARY KEY (request_id, requester)
) STRICT, WITHOUT ROWID;
`;

/**
 * @typedef {{ make: string, model: string, variant: string|null, market: string, year: number|null, powertrain: string|null, note: string|null, force: boolean }} BikeRequestInput
 * @typedef {{ field: string, message: string }} FieldError
 * @typedef {{ id: number, key: string, market: string, make: string, model: string, variant: string|null, status: string, requesters: number, firstAt: number, lastAt: number }} BikeRequest
 */

/**
 * Check and normalise a request body. Unknown keys are ignored (newer apps may send more).
 * @param {unknown} body
 * @param {{ now?: number }} [opts]
 * @returns {{ ok: true, value: BikeRequestInput } | { ok: false, errors: FieldError[] }}
 */
function validateRequest(body, opts = {}) {
    /** @type {FieldError[]} */
    const errors = [];
    if (!body || typeof body !== "object" || Array.isArray(body)) return { ok: false, errors: [{ field: "", message: "body must be a JSON object" }] };
    const b = /** @type {Record<string, unknown>} */ (body);
    const thisYear = new Date(opts.now === undefined ? Date.now() : opts.now).getUTCFullYear();

    /** @param {string} field @param {boolean} required */
    const name = (field, required) => {
        const v = b[field];
        if (v === undefined || v === null || (typeof v === "string" && v.trim() === "")) {
            if (required) errors.push({ field, message: `${field} is required` });
            return null;
        }
        if (typeof v !== "string") { errors.push({ field, message: `${field} must be a string` }); return null; }
        const s = v.normalize("NFC").replace(/\s+/g, " ").trim();
        if (s.length > LIMITS.name) { errors.push({ field, message: `${field} is longer than ${LIMITS.name} characters` }); return null; }
        if (BAD_NAME_CHARS.test(s)) { errors.push({ field, message: `${field} contains characters that aren't allowed` }); return null; }
        if (Search.queryTokens(s).length === 0) { errors.push({ field, message: `${field} needs at least one letter or digit` }); return null; }
        return s;
    };
    const make = name("make", true), model = name("model", true), variant = name("variant", false);

    let market = "IN";
    if (b.market !== undefined && b.market !== null) {
        if (typeof b.market !== "string" || !/^[A-Za-z]{2}$/.test(b.market.trim())) errors.push({ field: "market", message: "market must be a 2-letter country code, e.g. IN" });
        else market = b.market.trim().toUpperCase();
    }
    /** @type {number|null} */
    let year = null;
    if (b.year !== undefined && b.year !== null) {
        if (typeof b.year !== "number" || !Number.isInteger(b.year) || b.year < 1950 || b.year > thisYear + 2) errors.push({ field: "year", message: `year must be a whole number from 1950 to ${thisYear + 2}` });
        else year = b.year;
    }
    /** @type {string|null} */
    let powertrain = null;
    if (b.powertrain !== undefined && b.powertrain !== null) {
        if (typeof b.powertrain !== "string" || !POWERTRAINS.includes(b.powertrain)) errors.push({ field: "powertrain", message: `powertrain must be one of ${POWERTRAINS.join(", ")}` });
        else powertrain = b.powertrain;
    }
    /** @type {string|null} */
    let note = null;
    if (b.note !== undefined && b.note !== null && b.note !== "") {
        if (typeof b.note !== "string") errors.push({ field: "note", message: "note must be a string" });
        else {
            const s = b.note.normalize("NFC").trim();
            if (s.length > LIMITS.note) errors.push({ field: "note", message: `note is longer than ${LIMITS.note} characters` });
            else if (BAD_NOTE_CHARS.test(s)) errors.push({ field: "note", message: "note contains control characters" });
            else note = s || null;
        }
    }
    if (b.force !== undefined && typeof b.force !== "boolean") errors.push({ field: "force", message: "force must be true or false" });

    if (errors.length || make === null || model === null) return { ok: false, errors };
    return { ok: true, value: { make, model, variant, market, year, powertrain, note, force: b.force === true } };
}

/**
 * The dedup key: market + the search tokens of make, model and variant.
 * @param {{ market: string, make: string, model: string, variant: string|null }} r
 */
function requestKey(r) {
    const t = (/** @type {string|null} */ s) => (s ? Search.queryTokens(s).join(" ") : "");
    return [r.market, t(r.make), t(r.model), t(r.variant)].join("|");
}

class RequestQueue {
    /**
     * @param {{ exec: (sql: string) => any, prepare: (sql: string) => any }} db  a writable better-sqlite3 / node:sqlite database (or lib/bikedb/sqlite.js wrapper)
     * @param {{ now?: () => number }} [opts]
     */
    constructor(db, opts = {}) {
        if (!db || typeof db.prepare !== "function" || typeof db.exec !== "function") throw new TypeError("RequestQueue needs a writable SQLite database");
        this._db = db;
        this._now = opts.now || Date.now;
        db.exec(SCHEMA);
        this._st = {
            find: db.prepare("SELECT request_id AS id FROM bike_request WHERE request_key = ?"),
            insert: db.prepare("INSERT INTO bike_request (request_key, market, make, model, variant, first_at, last_at) VALUES (?, ?, ?, ?, ?, ?, ?)"),
            vote: db.prepare(`INSERT INTO bike_request_vote (request_id, requester, year, powertrain, note, at) VALUES (?, ?, ?, ?, ?, ?)
                              ON CONFLICT (request_id, requester) DO UPDATE SET
                                  year = coalesce(excluded.year, year), powertrain = coalesce(excluded.powertrain, powertrain),
                                  note = coalesce(excluded.note, note), at = excluded.at`),
            hasVote: db.prepare("SELECT 1 AS x FROM bike_request_vote WHERE request_id = ? AND requester = ?"),
            touch: db.prepare("UPDATE bike_request SET last_at = ?, requesters = (SELECT count(*) FROM bike_request_vote WHERE request_id = ?) WHERE request_id = ?"),
            get: db.prepare(`SELECT request_id AS id, request_key AS key, market, make, model, variant, status, requesters, first_at AS firstAt, last_at AS lastAt
                             FROM bike_request WHERE request_id = ?`),
            list: db.prepare(`SELECT request_id AS id, request_key AS key, market, make, model, variant, status, requesters, first_at AS firstAt, last_at AS lastAt
                              FROM bike_request WHERE status = ? ORDER BY requesters DESC, first_at, request_id LIMIT ?`),
            votes: db.prepare("SELECT requester, year, powertrain, note, at FROM bike_request_vote WHERE request_id = ? ORDER BY at, requester"),
            setStatus: db.prepare("UPDATE bike_request SET status = ? WHERE request_id = ?")
        };
    }

    /**
     * Queue a request (or add this requester's vote to the existing one). Atomic.
     * @param {BikeRequestInput} input  validateRequest() output
     * @param {string} requester        pseudonymous requester key
     * @returns {{ created: boolean, newVote: boolean, request: BikeRequest }}
     */
    submit(input, requester) {
        if (typeof requester !== "string" || requester.length < 1 || requester.length > LIMITS.requester) throw new TypeError("requester must be a short non-empty string");
        const key = requestKey(input);
        const now = this._now();
        const st = this._st;
        let created = false, newVote = false, id = 0;
        this._db.exec("BEGIN IMMEDIATE");
        try {
            const row = st.find.get(key);
            if (row) id = Number(row.id);
            else {
                id = Number(st.insert.run(key, input.market, input.make, input.model, input.variant, now, now).lastInsertRowid);
                created = true;
            }
            newVote = !st.hasVote.get(id, requester);
            st.vote.run(id, requester, input.year, input.powertrain, input.note, now);
            st.touch.run(now, id, id);
            this._db.exec("COMMIT");
        } catch (e) {
            try { this._db.exec("ROLLBACK"); } catch { /* already rolled back */ }
            throw e;
        }
        return { created, newVote, request: this.get(id) };
    }

    /** @param {number} id @returns {BikeRequest} */
    get(id) {
        const r = this._st.get.get(id);
        return r && { id: Number(r.id), key: r.key, market: r.market, make: r.make, model: r.model, variant: r.variant ?? null,
            status: r.status, requesters: Number(r.requesters), firstAt: Number(r.firstAt), lastAt: Number(r.lastAt) };
    }

    /**
     * Most-wanted first: for curators (scripts/bikedb/requests.mjs).
     * @param {{ status?: string, limit?: number }} [opts]
     * @returns {BikeRequest[]}
     */
    list(opts = {}) {
        const status = opts.status || "queued";
        if (!STATUSES.includes(status)) throw new RangeError(`status must be one of ${STATUSES.join(", ")}`);
        return this._st.list.all(status, Math.max(1, Math.min(1000, Math.floor(opts.limit || 50)))).map((r) => this.get(Number(r.id)));
    }

    /** Each requester's hints for one request. @param {number} id */
    votes(id) {
        return this._st.votes.all(id).map((v) => ({ requester: v.requester, year: v.year ?? null, powertrain: v.powertrain ?? null, note: v.note ?? null, at: Number(v.at) }));
    }

    /** @param {number} id @param {string} status */
    setStatus(id, status) {
        if (!STATUSES.includes(status)) throw new RangeError(`status must be one of ${STATUSES.join(", ")}`);
        return Number(this._st.setStatus.run(status, id).changes) === 1;
    }
}

module.exports = { RequestQueue, validateRequest, requestKey, POWERTRAINS, STATUSES, LIMITS, SCHEMA };
