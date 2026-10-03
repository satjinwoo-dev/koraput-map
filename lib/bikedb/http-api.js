// @ts-check
"use strict";
/* ============================================================================
   MapUnite bike catalogue — HTTP API (Express router, mounted at /api/bikes)
   ==============================================================================
     GET  /api/bikes/search?q=royal+enf&limit=20   FTS5 search, ranked like the app
     GET  /api/bikes/bundles/<hash>[.json]         a runtime bundle by content hash (immutable)
     GET  /api/bikes/bundles/<bike-id>             the same bytes by bike id (short cache)
     POST /api/bikes/requests                      ask for a bike that isn't listed yet
     GET  /api/bikes/status                        catalogue version and size
     POST /api/bikes/fillups                       anonymous full-tank records, opt-in (Step 8)
     POST /api/bikes/fillups/mine                  what this contributor token has sent
     DELETE /api/bikes/fillups                     delete everything this contributor token sent
     GET  /api/bikes/calibration                   per class: tanks, riders, the latest fit (summary)
     GET  /api/bikes/calibration/<class-key>       the latest fit for one class, in full (dashboard)

   Both load paths are first-class:
     - Website: same origin, relative URLs, no CORS needed.
     - Android app (Capacitor): pages come from https://localhost and call the
       server cross-origin. Allowed origins (the server's CORS_ORIGIN, which
       always includes NATIVE_APP_ORIGINS) get Access-Control-Allow-Origin, a
       preflight answer for the JSON POST, and Cross-Origin-Resource-Policy:
       cross-origin. A POST from any other foreign origin is refused (403).

   Bundles are content-addressed: /bundles/<hash> never changes, so it is cached
   for a year (immutable) and answers If-None-Match with 304. Search answers are
   cached briefly and carry the catalogue version, so a client can tell when its
   offline catalog.json is out of date.

   Mount this router BEFORE the server's global JSON parser and rate limiter:
   it has its own body limit (4 KB) and its own limits, sized for type-ahead
   search (one request per keystroke), not for the general API budget.
   ============================================================================ */

const crypto = require("crypto");
const express = require("express");
const rateLimitModule = require("express-rate-limit");
const { CatalogDb, CatalogUnavailable, HASH_RE, SLUG_RE } = require("./catalog-db.js");
const { RequestQueue, validateRequest } = require("./request-queue.js");
const { FleetStore, validateTank, CONSENT, LIMITS: FLEET_LIMITS } = require("./fleet.js");

const rateLimit = /** @type {any} */ (rateLimitModule).rateLimit || rateLimitModule;

const MAX_QUERY_PARAM_CHARS = 200;
const BODY_LIMIT = "4kb";
const DEFAULT_LIMITS = Object.freeze({
    search: { windowMs: 60_000, max: 240 },        // type-ahead: one request per keystroke
    bundles: { windowMs: 60_000, max: 600 },
    requests: { windowMs: 3_600_000, max: 20 },
    fillups: { windowMs: 3_600_000, max: 30 },
    calibration: { windowMs: 60_000, max: 120 }
});
const FILLUPS_BODY_LIMIT = "64kb";             // up to 20 tanks of 40 speed bins
const CACHE = Object.freeze({
    immutable: "public, max-age=31536000, immutable",
    bundleById: "public, max-age=300",
    search: "public, max-age=60",
    status: "no-cache",
    calibration: "public, max-age=300"
});

/**
 * @typedef {"*" | false | string | string[]} CorsOrigins
 * @typedef {{ windowMs: number, max: number }} Limit
 */

/**
 * @param {{
 *   catalog: CatalogDb | string,
 *   queueDb?: any | (() => any) | null,
 *   fleetSecret?: string | (() => string),
 *   corsOrigins?: CorsOrigins,
 *   requesterKey?: (req: any) => string,
 *   limits?: Partial<Record<keyof typeof DEFAULT_LIMITS, Limit>> | false,
 *   log?: { warn: (...a: any[]) => void, error: (...a: any[]) => void },
 *   now?: () => number
 * }} opts
 *   catalog:      a CatalogDb, or the path of bikes.sqlite
 *   queueDb:      the server's writable database (or a function returning it, for late initialisation)
 *   fleetSecret:  HMAC key for anonymous fill-up contributor tokens (the server's SERVER_SECRET); without it
 *                 the fill-up routes answer 503
 *   corsOrigins:  "*" (any origin), false (same origin only), or the allowed origins
 *   requesterKey: pseudonymous requester id for the request queue (default: HMAC of the client IP with a per-process key)
 *   limits:       per-route rate limits, or false to disable them (tests)
 */
function createBikeApi(opts) {
    const log = opts.log || console;
    const now = opts.now || Date.now;
    const catalog = typeof opts.catalog === "string" ? new CatalogDb({ file: opts.catalog, now }) : opts.catalog;
    if (!(catalog instanceof CatalogDb)) throw new TypeError("createBikeApi needs { catalog } (a CatalogDb or the path of bikes.sqlite)");
    const allowOrigin = originPolicy(opts.corsOrigins === undefined ? false : opts.corsOrigins);
    const processKey = crypto.randomBytes(32);
    const requesterKey = opts.requesterKey || ((/** @type {any} */ req) => crypto.createHmac("sha256", processKey).update(`mu-bike-request|${req.ip}`).digest("hex").slice(0, 32));

    /** @type {RequestQueue|null} */
    let queue = null;
    const getQueue = () => {
        if (queue) return queue;
        const db = typeof opts.queueDb === "function" ? opts.queueDb() : opts.queueDb;
        if (!db) return null;
        queue = new RequestQueue(db, { now });
        return queue;
    };

    /** @type {FleetStore|null} */
    let fleet = null;
    const getFleet = () => {
        if (fleet) return fleet;
        const db = typeof opts.queueDb === "function" ? opts.queueDb() : opts.queueDb;
        const secret = typeof opts.fleetSecret === "function" ? opts.fleetSecret() : opts.fleetSecret;
        if (!db || !secret) return null;
        fleet = new FleetStore(db, { secret, now });
        return fleet;
    };

    const limits = opts.limits === false ? null : { ...DEFAULT_LIMITS, ...(opts.limits || {}) };
    /** @param {keyof typeof DEFAULT_LIMITS} name */
    const limiter = (name) => {
        if (!limits) return (/** @type {any} */ _req, /** @type {any} */ _res, /** @type {any} */ next) => next();
        const l = limits[name];
        return rateLimit({
            windowMs: l.windowMs, max: l.max, standardHeaders: true, legacyHeaders: false,
            handler: (/** @type {any} */ _req, /** @type {any} */ res) => res.status(429).json({ ok: false, reason: "rate-limited" })
        });
    };

    const router = express.Router({ strict: true });

    // ---- CORS + cross-origin resource policy, for every route ----
    router.use((req, res, next) => {
        res.vary("Origin");
        res.set("Cross-Origin-Resource-Policy", "cross-origin");
        res.set("X-Content-Type-Options", "nosniff");
        const origin = req.get("origin");
        const allowed = origin !== undefined && (allowOrigin(origin) || isSameOrigin(req, origin));
        if (allowed) {
            res.set("Access-Control-Allow-Origin", /** @type {string} */ (origin));
            res.set("Access-Control-Expose-Headers", "X-Catalog-Version, X-Bundle-Hash, X-Bundle-Id, Content-Location, Retry-After");
        }
        if (req.method === "OPTIONS") {
            res.set("Allow", "GET, HEAD, POST, DELETE, OPTIONS");
            if (allowed) {
                res.set("Access-Control-Allow-Methods", "GET, HEAD, POST, DELETE");
                res.set("Access-Control-Allow-Headers", "Content-Type");
                res.set("Access-Control-Max-Age", "600");
            }
            return res.status(204).end();
        }
        res.locals.originAllowed = origin === undefined || allowed;
        next();
    });

    // ---- search ----
    router.get("/search", limiter("search"), (req, res) => {
        const q = req.query.q, rawLimit = req.query.limit;
        if (typeof q !== "string") return res.status(400).json({ ok: false, reason: "bad-query", message: "q must be given once, as text" });
        if (q.length > MAX_QUERY_PARAM_CHARS) return res.status(400).json({ ok: false, reason: "bad-query", message: `q is longer than ${MAX_QUERY_PARAM_CHARS} characters` });
        if (rawLimit !== undefined && (typeof rawLimit !== "string" || !/^\d{1,4}$/.test(rawLimit))) return res.status(400).json({ ok: false, reason: "bad-limit", message: "limit must be a whole number" });
        return withCatalog(res, () => {
            const r = catalog.search(q, { limit: rawLimit === undefined ? undefined : Number(rawLimit) });
            res.set("Cache-Control", CACHE.search);
            res.set("X-Catalog-Version", r.catalogVersion);
            res.json({ ok: true, catalogVersion: r.catalogVersion, query: q, tokens: r.tokens, total: r.total, bundlePath: `${req.baseUrl}/bundles/{hash}`, results: r.results });
        });
    });

    // ---- bundles ----
    router.get("/bundles/:key", limiter("bundles"), (req, res) => {
        const raw = String(req.params.key);
        const key = raw.endsWith(".json") ? raw.slice(0, -5) : raw;
        const byHash = HASH_RE.test(key);
        if (!byHash && !SLUG_RE.test(key)) return res.status(400).json({ ok: false, reason: "bad-key", message: "use a 16-character bundle hash or a bike id" });
        return withCatalog(res, () => {
            const b = catalog.bundle(key);
            if (!b) return res.status(404).json({ ok: false, reason: "not-found" });
            res.set("Content-Type", "application/json; charset=utf-8");
            res.set("ETag", `"${b.hash}"`);
            res.set("X-Bundle-Hash", b.hash);
            res.set("X-Bundle-Id", b.id);
            if (byHash) res.set("Cache-Control", CACHE.immutable);
            else {
                res.set("Cache-Control", CACHE.bundleById);
                res.set("Content-Location", `${req.baseUrl}/bundles/${b.hash}`);
            }
            res.send(Buffer.from(b.body, "utf8"));     // express answers If-None-Match with 304 and HEAD without a body
        });
    });

    // ---- requests for missing bikes ----
    router.post("/requests", limiter("requests"),
        (req, res, next) => {
            if (!res.locals.originAllowed) return res.status(403).json({ ok: false, reason: "origin-not-allowed" });
            if (!req.is("application/json")) return res.status(415).json({ ok: false, reason: "json-required" });
            next();
        },
        express.json({ limit: BODY_LIMIT, strict: true }),
        (req, res) => {
            const v = validateRequest(req.body, { now: now() });
            if (v.ok === false) return res.status(400).json({ ok: false, reason: "invalid", errors: /** @type {{ errors: any[] }} */ (v).errors });
            const input = v.value;
            const q = getQueue();
            if (!q) return res.status(503).json({ ok: false, reason: "queue-unavailable" });

            // Already in the catalogue? Say so (the rider picks it) unless they insist it's a different bike.
            let catalogChecked = false;
            /** @type {any[]} */
            let similar = [];
            try {
                const sameMarket = (/** @type {any} */ r) => r.market === input.market;
                const exact = catalog.search([input.make, input.model, input.variant || ""].join(" "), { limit: 20 }).results.filter(sameMarket).slice(0, 5);
                catalogChecked = true;
                if (exact.length && !input.force) return res.status(200).json({ ok: true, status: "listed", matches: exact });
                similar = exact.length ? exact : catalog.search(`${input.make} ${input.model}`, { limit: 20 }).results.filter(sameMarket).slice(0, 5);
            } catch (e) {
                if (!(e instanceof CatalogUnavailable)) throw e;          // no catalogue: queue without the check
            }
            const r = q.submit(input, requesterKey(req));
            res.status(202).json({
                ok: true, status: "queued", created: r.created, newVote: r.newVote, catalogChecked,
                request: { id: r.request.id, market: r.request.market, make: r.request.make, model: r.request.model, variant: r.request.variant, status: r.request.status, requesters: r.request.requesters },
                similar
            });
        });

    // ---- anonymous fill-ups (Step 8: fleet calibration) ----
    /** Origin + JSON checks shared by the writing routes. */
    const writeGuard = (/** @type {any} */ req, /** @type {any} */ res, /** @type {any} */ next) => {
        if (!res.locals.originAllowed) return res.status(403).json({ ok: false, reason: "origin-not-allowed" });
        if (!req.is("application/json")) return res.status(415).json({ ok: false, reason: "json-required" });
        next();
    };
    const fleetBody = express.json({ limit: FILLUPS_BODY_LIMIT, strict: true });
    /** The contributor token from a body, or a 400. */
    const tokenOf = (/** @type {any} */ body, /** @type {any} */ res) => {
        const t = body && body.contributor;
        if (typeof t !== "string" || !/^[0-9a-f]{32,64}$/.test(t)) { res.status(400).json({ ok: false, reason: "invalid", errors: [{ field: "contributor", message: "a random 32–64 hex token made by the app" }] }); return null; }
        return t;
    };
    const withFleet = (/** @type {any} */ res, /** @type {(f: FleetStore) => any} */ fn) => {
        const f = getFleet();
        if (!f) return res.status(503).json({ ok: false, reason: "fleet-unavailable" });
        return fn(f);
    };

    router.post("/fillups", limiter("fillups"), writeGuard, fleetBody, (req, res) => {
        const b = req.body;
        if (!b || typeof b !== "object" || Array.isArray(b)) return res.status(400).json({ ok: false, reason: "invalid", errors: [{ field: "", message: "body must be a JSON object" }] });
        if (b.consent !== CONSENT) return res.status(400).json({ ok: false, reason: "consent-required", message: `send consent: "${CONSENT}" only after the rider opted in` });
        const token = tokenOf(b, res);
        if (!token) return;
        if (!Array.isArray(b.tanks) || b.tanks.length < 1 || b.tanks.length > FLEET_LIMITS.tanksPerPost) return res.status(400).json({ ok: false, reason: "invalid", errors: [{ field: "tanks", message: `1–${FLEET_LIMITS.tanksPerPost} tanks per request` }] });
        return withCatalog(res, () => withFleet(res, (f) => {
            const fuels = catalog.fuelCodes();
            const known = {
                bundleClass: (/** @type {string} */ h) => { const c = catalog.bundleClass(h); return c ? { classKey: c.classKey, bikeId: c.bikeId } : null; },
                bikeClass: (/** @type {any} */ id, /** @type {any} */ k) => { const c = catalog.bikeClass(id, k); return c ? { classKey: c.classKey, bikeId: c.bikeId } : null; },
                evClass: (/** @type {string} */ k) => k.startsWith("ev."),
                fuels
            };
            /** @type {any[]} */
            const good = [];
            /** @type {{ index: number, field: string, message: string }[]} */
            const rejected = [];
            b.tanks.forEach((/** @type {unknown} */ t, /** @type {number} */ i) => {
                const v = validateTank(t, known);
                if (v.ok) good.push(v.value);
                else rejected.push({ index: i, field: /** @type {any} */ (v).field, message: /** @type {any} */ (v).message });
            });
            if (!good.length) return res.status(400).json({ ok: false, reason: "invalid", rejected });
            const r = f.submit(token, good);
            res.status(202).json({ ok: true, stored: r.stored, duplicates: r.duplicates, rejected });
        }));
    });

    router.post("/fillups/mine", limiter("calibration"), writeGuard, fleetBody, (req, res) => {
        const token = tokenOf(req.body, res);
        if (!token) return;
        return withFleet(res, (f) => { res.set("Cache-Control", "no-store"); res.json({ ok: true, classes: f.mine(token) }); });
    });

    router.delete("/fillups", limiter("fillups"), writeGuard, fleetBody, (req, res) => {
        const token = tokenOf(req.body, res);
        if (!token) return;
        return withFleet(res, (f) => res.json({ ok: true, deleted: f.forget(token) }));
    });

    // ---- calibration results (the Fuel Learner dashboard) ----
    router.get("/calibration", limiter("calibration"), (_req, res) => withFleet(res, (f) => {
        const fits = new Map(f.fits().map((x) => [x.classKey, x]));
        const counts = new Map(f.classes().map((c) => [c.classKey, c]));
        const keys = [...new Set([...fits.keys(), ...counts.keys()])].sort();
        res.set("Cache-Control", CACHE.calibration);
        res.json({
            ok: true,
            classes: keys.map((k) => {
                const c = counts.get(k), x = fits.get(k);
                return {
                    classKey: k, tanks: c ? c.tanks : 0, riders: c ? c.riders : 0, km: c ? c.km : 0,
                    fit: x ? { fittedDay: x.fittedDay, catalogVersion: x.catalogVersion, proposed: x.result.proposed, reason: x.result.reason,
                        overhead: x.result.overhead || null, cv: x.result.cv || null, tanks: x.result.evidence ? x.result.evidence.tanks : 0 } : null
                };
            })
        });
    }));

    router.get("/calibration/:classKey", limiter("calibration"), (req, res) => {
        const key = String(req.params.classKey);
        if (!/^(ice_manual|ice_cvt|ev)\.[a-z_]{3,20}$/.test(key)) return res.status(400).json({ ok: false, reason: "bad-key" });
        return withFleet(res, (f) => {
            const x = f.fit(key);
            const c = f.classes().find((r) => r.classKey === key) || { tanks: 0, riders: 0, km: 0 };
            /** what the current catalogue ships for this class (the build applies reviewed calibrations) */
            let shipped = null;
            try {
                const c = catalog.bikeClass(null, key);
                const cd = c ? catalog.bundle(c.bikeId) : null;
                const body = cd ? JSON.parse(cd.body) : null;
                if (body && body.calibration) shipped = body.calibration;
            } catch (e) { if (!(e instanceof CatalogUnavailable)) throw e; }
            if (!x && !c.tanks) return res.status(404).json({ ok: false, reason: "not-found" });
            res.set("Cache-Control", CACHE.calibration);
            res.json({ ok: true, classKey: key, data: c, fit: x ? { fittedDay: x.fittedDay, catalogVersion: x.catalogVersion, ...x.result } : null, shipped });
        });
    });

    // ---- status ----
    router.get("/status", (req, res) => {
        const s = catalog.status();
        res.set("Cache-Control", CACHE.status);
        if (s.catalogVersion) res.set("X-Catalog-Version", s.catalogVersion);
        res.status(s.available ? 200 : 503).json({
            ok: s.available, reason: s.reason, catalogVersion: s.catalogVersion, schemaVersion: s.schemaVersion,
            variants: s.variants, bundles: s.bundles, bundlePath: `${req.baseUrl}/bundles/{hash}`, requests: Boolean(opts.queueDb)
        });
    });

    router.use((_req, res) => res.status(404).json({ ok: false, reason: "not-found" }));

    // body-parser errors (too large, bad JSON) and anything unexpected: JSON, never a stack trace
    router.use((/** @type {any} */ err, /** @type {any} */ _req, /** @type {any} */ res, /** @type {any} */ _next) => {
        if (err && err.type === "entity.too.large") return res.status(413).json({ ok: false, reason: "too-large" });
        if (err && err.type === "entity.parse.failed") return res.status(400).json({ ok: false, reason: "bad-json" });
        if (err && (err.type === "charset.unsupported" || err.type === "encoding.unsupported")) return res.status(415).json({ ok: false, reason: "json-required" });
        log.error("[bikes] request failed:", err && err.stack ? err.stack : err);
        res.status(500).json({ ok: false, reason: "server-error" });
    });

    /** @param {any} res @param {() => void} fn */
    function withCatalog(res, fn) {
        try { return fn(); }
        catch (e) {
            if (!(e instanceof CatalogUnavailable)) throw e;
            res.set("Retry-After", "30");
            res.set("Cache-Control", "no-store");
            return res.status(503).json({ ok: false, reason: e.reason });
        }
    }

    return { router, catalog, queue: getQueue, fleet: getFleet, status: () => catalog.status(), close: () => catalog.close() };
}

/**
 * @param {CorsOrigins} cors
 * @returns {(origin: string) => boolean}
 */
function originPolicy(cors) {
    if (cors === "*") return () => true;
    if (cors === false || cors === null) return () => false;
    const list = new Set((Array.isArray(cors) ? cors : String(cors).split(",")).map((s) => s.trim().replace(/\/+$/, "")).filter(Boolean));
    return (origin) => list.has(origin);
}

/**
 * The page's own origin calling (the website): a browser sends Origin on a same-origin POST too.
 * Hosts are compared, not schemes: behind a TLS proxy that doesn't send X-Forwarded-Proto the
 * server sees http while the page is https, and the website must not lose its own API.
 * @param {any} req @param {string} origin
 */
function isSameOrigin(req, origin) {
    const host = req.get("host");
    if (!host) return false;
    try {
        const u = new URL(origin);
        return (u.protocol === "https:" || u.protocol === "http:") && u.host === String(host).toLowerCase();
    } catch { return false; }
}

module.exports = { createBikeApi, originPolicy, DEFAULT_LIMITS, BODY_LIMIT, CACHE, MAX_QUERY_PARAM_CHARS };
