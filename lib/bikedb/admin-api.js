// @ts-check
"use strict";
/* ============================================================================
   MapUnite bike catalogue — the admin API behind the bike curator
   (public/admin/curator.html, public/js/curator/)
   ==============================================================================
   Six routes under /api/admin, all JSON, all behind `Authorization: Bearer
   <ADMIN_TOKEN>` (compared in constant time). Without ADMIN_TOKEN on the server the
   whole API answers 404: it doesn't exist. A wrong token is a 401.

     GET  /bike-requests?status=queued|drafted|approved|rejected|duplicate|all
     GET  /bikedb/reference                     data/bikes/reference/*.json
     PUT  /bike-requests/:id/draft      { draft }
     POST /bike-requests/:id/approve    { bundle }
     POST /bike-requests/:id/reject     { reason }
     POST /bike-requests/:id/duplicate  { bikeId }

   Requests are the riders' "my bike isn't listed" queue (lib/bikedb/request-queue.js,
   one row per bike, one vote per rider). The curator's own state — the draft, how a
   request was resolved — lives in a table beside it (bike_request_curation), so the
   queue and `npm run bikes:requests` keep working as before.

   Approve decides on the server; the browser's checks are only a convenience:
     1. the id is a safe slug, the bundle is a variant, and no bike with that id exists;
     2. THE PICTURE RULE: an approved bike has a real picture — image.url (https) and
        the source that published it — never the class silhouette (the curator's
        approvalErrors(), and the same check here, independently). No exceptions:
        the frozen list of older bikes without pictures in the contract is never
        consulted here;
     3. the whole catalogue with the new bike validates (BikeContract.validateCatalog:
        units, sources, confidence, fuel approvals manufacturer-certified only, …).
   All three pass → data/bikes/variants/<id>.json (canonical formatting), then the
   catalogue is rebuilt (scripts/build-bike-catalog.mjs: catalog.json, the bundles,
   bikes.sqlite — the running server picks it up within 5 s). If the rebuild fails the
   file is removed again. Anything blocked → data/bikes/pending/<id>.json with the
   reasons (pending bikes are validated on every run and never shipped), and the
   request stays open. Keep data/bikes under version control: a commit is the audit
   trail of what was approved.
   ============================================================================ */

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { pathToFileURL } = require("url");
const { execFile } = require("child_process");
const express = require("express");
const rateLimitModule = require("express-rate-limit");
const rateLimit = /** @type {any} */ (rateLimitModule).rateLimit || rateLimitModule;
const Contract = require("../../public/js/bikedb/bundle-contract.js");
const CuratorDraft = require("../../public/js/curator/draft.js");
const { RequestQueue } = require("./request-queue.js");

const ROOT = path.resolve(__dirname, "..", "..");
const STATUSES = ["queued", "drafted", "approved", "rejected", "duplicate"];
const SLUG = /^[a-z0-9](?:[a-z0-9-]{0,78}[a-z0-9])?$/;
const LIMITS = Object.freeze({ body: "512kb", draft: 400 * 1024, reason: 500 });

const SCHEMA = `
CREATE TABLE IF NOT EXISTS bike_request_curation (
    request_id  INTEGER PRIMARY KEY REFERENCES bike_request (request_id) ON DELETE CASCADE,
    draft       TEXT CHECK (draft IS NULL OR json_valid(draft)),
    kind        TEXT CHECK (kind IS NULL OR kind IN ('approved', 'rejected', 'duplicate')),
    resolution  TEXT CHECK (resolution IS NULL OR length(resolution) <= ${LIMITS.reason}),
    location    TEXT CHECK (location IS NULL OR location IN ('variants', 'pending')),
    updated_at  INTEGER NOT NULL
) STRICT;
`;

/**
 * The picture rule, on the server: an approved bike has image { url: https…, src: a source it lists }.
 * @param {any} b @returns {Array<{ path: string, code: string, message: string }>}
 */
function pictureErrors(b) {
    const im = b && b.image;
    const url = im && typeof im.url === "string" ? im.url.trim() : "";
    if (!url) return [{ path: "image.url", code: "picture_required", message: "A picture is required to approve: image.url (https) and the source that published it (image.src)" }];
    const out = [];
    if (!/^https:\/\//i.test(url)) out.push({ path: "image.url", code: "picture_https", message: "image.url must be https (an http picture is blocked inside the app)" });
    const ids = new Set((Array.isArray(b.sources) ? b.sources : []).map((s) => s && s.id));
    if (!im.src || !ids.has(im.src)) out.push({ path: "image.src", code: "picture_source", message: "image.src must name one of the bundle's sources (who published the picture)" });
    return out;
}

/** Status the curator sees: its own decision if there is one, else from the queue's status. */
function curatorStatus(/** @type {string} */ queueStatus, /** @type {any} */ cur) {
    if (cur && cur.kind) return cur.kind;
    if (cur && cur.draft) return "drafted";
    return { queued: "queued", researching: "drafted", added: "approved", rejected: "rejected" }[queueStatus] || "queued";
}

/**
 * queueDb: the server's writable database. token: ADMIN_TOKEN (unset or under 16 characters = no admin API).
 * dataDir: data/bikes; publicDir / dbFile: where the build writes. build: the catalogue build (tests swap it).
 * catalog: the live CatalogDb, for "already in the catalogue" checks.
 * @param {{
 *   queueDb: any,
 *   token: string | null | undefined | (() => string | null | undefined),
 *   dataDir?: string, publicDir?: string, dbFile?: string,
 *   build?: (o: { dataDir: string, publicDir?: string, dbFile?: string }) => Promise<{ ok: boolean, output?: any, error?: string }>,
 *   catalog?: any,
 *   now?: () => number, log?: { warn: (...a: any[]) => void }, limits?: false | { windowMs: number, max: number }
 * }} opts
 */
function createAdminApi(opts) {
    const now = opts.now || Date.now;
    const log = opts.log || console;
    const dataDir = path.resolve(opts.dataDir || path.join(ROOT, "data", "bikes"));
    const tokenOf = () => { const t = typeof opts.token === "function" ? opts.token() : opts.token; return typeof t === "string" && t.length >= 16 ? t : null; };
    const digest = (/** @type {string} */ s) => crypto.createHash("sha256").update(s).digest();
    const build = opts.build || defaultBuild;

    let ready = null;
    /** @returns {{ db: any, queue: RequestQueue, st: Record<string, any> } | null} */
    function store() {
        if (ready) return ready;
        const db = typeof opts.queueDb === "function" ? opts.queueDb() : opts.queueDb;
        if (!db) return null;
        const queue = new RequestQueue(db, { now });          // creates bike_request first (the curation table refers to it)
        db.exec(SCHEMA);
        ready = {
            db, queue,
            st: {
                all: db.prepare(`SELECT r.request_id AS id, r.market, r.make, r.model, r.variant, r.status, r.requesters, r.first_at AS firstAt,
                                        c.draft, c.kind, c.resolution, c.location
                                 FROM bike_request r LEFT JOIN bike_request_curation c ON c.request_id = r.request_id
                                 ORDER BY r.requesters DESC, r.first_at, r.request_id LIMIT 2000`),
                one: db.prepare(`SELECT r.request_id AS id, r.status, c.kind, c.resolution FROM bike_request r
                                 LEFT JOIN bike_request_curation c ON c.request_id = r.request_id WHERE r.request_id = ?`),
                upsert: db.prepare(`INSERT INTO bike_request_curation (request_id, draft, kind, resolution, location, updated_at) VALUES (?, ?, ?, ?, ?, ?)
                                    ON CONFLICT (request_id) DO UPDATE SET draft = coalesce(excluded.draft, draft), kind = excluded.kind,
                                    resolution = excluded.resolution, location = coalesce(excluded.location, location), updated_at = excluded.updated_at`),
                setStatus: db.prepare("UPDATE bike_request SET status = ? WHERE request_id = ?")
            }
        };
        return ready;
    }

    const router = express.Router();
    if (opts.limits !== false) {
        const l = opts.limits || { windowMs: 60_000, max: 120 };
        router.use(rateLimit({ windowMs: l.windowMs, max: l.max, standardHeaders: true, legacyHeaders: false, handler: (_req, res) => res.status(429).json({ error: "Too many requests. Wait a minute." }) }));
    }
    // no token configured: the admin API doesn't exist. Then the token, in constant time.
    router.use((req, res, next) => {
        const token = tokenOf();
        if (!token) return res.status(404).json({ error: "Not found" });
        const m = /^Bearer\s+(\S+)$/.exec(String(req.get("authorization") || ""));
        if (!m || !crypto.timingSafeEqual(digest(m[1]), digest(token))) { res.set("WWW-Authenticate", "Bearer"); return res.status(401).json({ error: "The server didn't accept this admin token." }); }
        res.set("Cache-Control", "no-store");
        next();
    });
    router.use(express.json({ limit: LIMITS.body, strict: true }));
    const need = (/** @type {any} */ res) => { const s = store(); if (!s) res.status(503).json({ error: "The server's database isn't ready." }); return s; };
    /**
     * The request to act on, or the answer already sent: 404 unknown; 409 once approved (the bike is in the
     * catalogue: changing the request now would only make the queue disagree with data/bikes).
     * @returns {number|null}
     */
    const openRequest = (/** @type {any} */ s, /** @type {any} */ req, /** @type {any} */ res) => {
        const id = idOf(req);
        const row = id ? s.st.one.get(id) : null;
        if (!row) { res.status(404).json({ error: "No such request" }); return null; }
        if (row.kind === "approved") { res.status(409).json({ error: `Already approved as ${row.resolution}` }); return null; }
        return id;
    };
    let approving = false;                                     // one approve (write + rebuild) at a time
    /** @returns {number|null} */
    const idOf = (/** @type {any} */ req) => { const n = Number(req.params.id); return Number.isInteger(n) && n > 0 && String(n) === req.params.id ? n : null; };

    router.get("/bike-requests", (req, res) => {
        const s = need(res); if (!s) return;
        const want = String(req.query.status || "all");
        if (want !== "all" && !STATUSES.includes(want)) return res.status(400).json({ error: `status must be all or one of ${STATUSES.join(", ")}` });
        const requests = s.st.all.all().map((/** @type {any} */ r) => {
            const status = curatorStatus(r.status, r);
            const votes = s.queue.votes(Number(r.id));
            const out = {
                id: String(r.id), description: [r.make, r.model, r.variant].filter(Boolean).join(" "),
                make: r.make, model: r.model, variant: r.variant, market: r.market, classKey: null,
                createdAt: Number(r.firstAt), count: Number(r.requesters), status,
                hints: votes.map((/** @type {any} */ v) => ({ year: v.year, powertrain: v.powertrain, note: v.note })).filter((/** @type {any} */ v) => v.year || v.powertrain || v.note)
            };
            if (r.draft) /** @type {any} */ (out).draft = JSON.parse(r.draft);
            if (r.resolution) /** @type {any} */ (out).resolution = r.resolution;
            if (r.location) /** @type {any} */ (out).location = r.location;
            return out;
        });
        res.json({ requests: want === "all" ? requests : requests.filter((/** @type {any} */ r) => r.status === want) });
    });

    router.get("/bikedb/reference", (_req, res) => {
        try {
            const read = (/** @type {string} */ f) => JSON.parse(fs.readFileSync(path.join(dataDir, "reference", f), "utf8"));
            res.json({ fuelGrades: read("fuel-grades.json"), emissionStandards: read("emission-standards.json") });
        } catch (e) { res.status(500).json({ error: `Couldn't read the reference tables: ${/** @type {Error} */ (e).message}` }); }
    });

    router.put("/bike-requests/:id/draft", (req, res) => {
        const s = need(res); if (!s) return;
        const id = openRequest(s, req, res); if (!id) return;
        const draft = req.body && req.body.draft;
        if (!draft || typeof draft !== "object" || Array.isArray(draft)) return res.status(400).json({ error: "draft must be an object" });
        const text = JSON.stringify(draft);
        if (text.length > LIMITS.draft) return res.status(413).json({ error: "That draft is too large" });
        tx(s.db, () => { s.st.upsert.run(id, text, null, null, null, now()); s.st.setStatus.run("researching", id); });
        res.json({ ok: true });
    });

    router.post("/bike-requests/:id/reject", (req, res) => {
        const s = need(res); if (!s) return;
        const id = openRequest(s, req, res); if (!id) return;
        const reason = req.body && typeof req.body.reason === "string" ? req.body.reason.replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, LIMITS.reason) : "";
        if (!reason) return res.status(400).json({ error: "Give a reason" });
        tx(s.db, () => { s.st.upsert.run(id, null, "rejected", reason, null, now()); s.st.setStatus.run("rejected", id); });
        res.json({ ok: true });
    });

    router.post("/bike-requests/:id/duplicate", async (req, res) => {
        const s = need(res); if (!s) return;
        const id = openRequest(s, req, res); if (!id) return;
        const bikeId = req.body && req.body.bikeId;
        if (typeof bikeId !== "string" || !SLUG.test(bikeId)) return res.status(400).json({ error: "bikeId must be a bike's id" });
        if (!(await bikeExists(bikeId))) return res.status(400).json({ error: `${bikeId} isn't in the catalogue` });
        tx(s.db, () => { s.st.upsert.run(id, null, "duplicate", bikeId, null, now()); s.st.setStatus.run("added", id); });
        res.json({ ok: true });
    });

    router.post("/bike-requests/:id/approve", async (req, res) => {
        const s = need(res); if (!s) return;
        const id = openRequest(s, req, res); if (!id) return;
        const b = req.body && req.body.bundle;
        if (!b || typeof b !== "object" || Array.isArray(b)) return res.status(400).json({ error: "bundle must be an object" });
        if (typeof b.id !== "string" || !SLUG.test(b.id)) return res.status(400).json({ error: "bundle.id must be a lowercase slug (a-z, 0-9, -)" });
        if (b.kind !== "variant") return res.status(400).json({ error: "Only a variant can be approved from a request" });
        if (await bikeExists(b.id)) return res.status(409).json({ error: `${b.id} is already in the catalogue: use "Same bike" instead` });
        if (approving) return res.status(409).json({ error: "Another approve is still rebuilding the catalogue. Try again in a moment." });
        approving = true;
        try {
            const { loadCatalog } = await esm("scripts/bikedb/load-catalog.mjs");
            const { formatJson } = await esm("scripts/bikedb/format.mjs");
            const cat = loadCatalog(dataDir, { calibrations: false });
            const target = path.join(dataDir, "variants", `${b.id}.json`);
            const file = path.relative(ROOT, target).split(path.sep).join("/");     // the same naming loadCatalog uses
            const report = Contract.validateCatalog([...cat.entries, { file, bundle: b }], cat.ref);
            const mine = report.perFile.find((/** @type {any} */ p) => p.file === file);
            const contractErrors = [...(mine ? mine.result.errors : []), ...report.errors.filter((/** @type {any} */ e) => e.path === file)];
            const pic = pictureErrors(b);
            const draftErrors = CuratorDraft.approvalErrors(b).filter((/** @type {any} */ e) => !pic.some((x) => x.code === e.code));
            const seen = new Set();
            const errors = [...pic, ...draftErrors, ...contractErrors].filter((e) => { const k = `${e.path}|${e.code}`; if (seen.has(k)) return false; seen.add(k); return true; });
            const warnings = mine ? mine.result.warnings : [];
            const text = `${formatJson(b)}\n`;
            if (errors.length) {
                // blocked: kept in pending/ (validated on every run, never shipped); the request stays open
                writeAtomic(path.join(dataDir, "pending", `${b.id}.json`), text);
                tx(s.db, () => { s.st.upsert.run(id, JSON.stringify(b), null, null, "pending", now()); s.st.setStatus.run("researching", id); });
                return res.status(422).json({ ok: false, id: b.id, location: "pending", errors, warnings, error: errors[0].message });
            }
            writeAtomic(target, text);
            const built = await build({ dataDir, publicDir: opts.publicDir, dbFile: opts.dbFile });
            if (!built.ok) {
                try { fs.unlinkSync(target); } catch { /* already gone */ }
                return res.status(500).json({ ok: false, error: `The catalogue didn't rebuild, so ${b.id} wasn't added: ${built.error || "unknown error"}` });
            }
            try { fs.unlinkSync(path.join(dataDir, "pending", `${b.id}.json`)); } catch { /* wasn't pending */ }
            tx(s.db, () => { s.st.upsert.run(id, JSON.stringify(b), "approved", b.id, "variants", now()); s.st.setStatus.run("added", id); });
            res.json({ ok: true, id: b.id, location: "variants", warnings, catalogVersion: built.output && built.output.catalogVersion });
        } catch (e) {
            log.warn("[admin] approve failed:", e);
            res.status(500).json({ ok: false, error: `Approve failed: ${/** @type {Error} */ (e).message}` });
        } finally { approving = false; }
    });

    /** Is there a bike with this id (the live catalogue, else data/bikes)? */
    async function bikeExists(/** @type {string} */ bikeId) {
        try { if (opts.catalog && opts.catalog.bundle(bikeId)) return true; } catch { /* catalogue not built: check the files */ }
        return fs.existsSync(path.join(dataDir, "variants", `${bikeId}.json`)) || fs.existsSync(path.join(dataDir, "class-defaults", `${bikeId}.json`));
    }

    return { router, store, pictureErrors };
}

/** One SQLite transaction (better-sqlite3 and the lib/bikedb/sqlite.js wrapper alike). */
function tx(/** @type {any} */ db, /** @type {() => void} */ fn) {
    db.exec("BEGIN IMMEDIATE");
    try { fn(); db.exec("COMMIT"); }
    catch (e) { try { db.exec("ROLLBACK"); } catch { /* already rolled back */ } throw e; }
}

/** @param {string} rel */
function esm(rel) { return import(pathToFileURL(path.join(ROOT, rel)).href); }

/** Write a file in one step (tmp + rename), creating the directory. */
function writeAtomic(/** @type {string} */ file, /** @type {string} */ text) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, text);
    fs.renameSync(tmp, file);
}

/**
 * The catalogue build, as `npm run bikes:build` runs it (in a child process: the server keeps serving).
 * @param {{ dataDir: string, publicDir?: string, dbFile?: string }} o
 * @returns {Promise<{ ok: boolean, output?: any, error?: string }>}
 */
function defaultBuild(o) {
    const args = ["--disable-warning=ExperimentalWarning", path.join(ROOT, "scripts", "build-bike-catalog.mjs"), "--json", "--data", o.dataDir];
    if (o.publicDir) args.push("--out-public", o.publicDir);
    if (o.dbFile) args.push("--out-db", o.dbFile);
    return new Promise((resolve) => {
        execFile(process.execPath, args, { cwd: ROOT, timeout: 120000, maxBuffer: 8 * 1024 * 1024 }, (err, stdout, stderr) => {
            if (err) return resolve({ ok: false, error: String(stderr || err.message).split("\n").slice(0, 6).join(" ").trim() });
            try { resolve({ ok: true, output: JSON.parse(stdout) }); } catch { resolve({ ok: true, output: null }); }
        });
    });
}

module.exports = { createAdminApi, pictureErrors, curatorStatus, STATUSES, SCHEMA };
