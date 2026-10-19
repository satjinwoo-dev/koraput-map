// @ts-check
"use strict";
/* ============================================================================
   MapUnite Master AI — HTTP API (Express router, mounted at /api/master)
   ==============================================================================
     POST /api/master/weather      weather + air quality along the corridor ahead
     POST /api/master/traffic      live flow at points ahead (TomTom)
     POST /api/master/road         bridges, tunnels, breakers, crossings, bad surface, OSM hazards
     POST /api/master/blackspots   official accident blackspots near the corridor
     POST /api/master/poi          vetted hospitals, mechanics, service centres, hotels, dhabas
     POST /api/master/search       the Deep Search sub-agent (Gemini + Google Search, else local Ollama)
     POST /api/master/destination  arrival risk at the destination
     POST /api/master/music        mood of the playing track + what to play next
     POST /api/master/roadsense/upload  RoadSense Live: a phone's anonymous road observations (opt-in)
     POST /api/master/roadsense/area    the live road evidence in the tiles along a route
     POST /api/master/roadsense/cover   smooth passes ("ridden, nothing found"), per-cell unlinkable labels
     POST /api/master/roadsense/forget  delete what a phone's pseudonyms (and RoadPulse contributor) sent
     POST /api/master/roadsense/publish RoadPulse: hazards a rider reviewed after a ride and chose to publish, and votes
     POST /api/master/roadsense/me      RoadPulse: that rider's reputation and badges (accuracy confirmed by others)
     GET  /api/master/bw?kb=64     random bytes, uncacheable: the phone times them (bandwidth)
     GET  /api/master/status       which providers are configured, cache/circuit health

   ALL API KEYS STAY HERE, read from the environment by server.js:
     GOOGLE_MAPS_SERVER_KEY (Places) · TOMTOM_API_KEY · GEMINI_API_KEY · GROQ_API_KEY ·
     LASTFM_API_KEY · OPEN_METEO_API_KEY (optional, commercial plan)
   The local reasoning engine needs no key: Ollama on OLLAMA_URL (lib/master/llm.js).
   A route whose provider isn't configured answers 503 { reason: "<x>-not-configured" }
   and the phone's agent goes "degraded" for that one feature.

   Each route has its own rate limit sized for what a phone's agent actually
   sends (weather every few minutes, POI tiles as you move …) with headroom for a
   convoy behind one carrier IP (CGNAT). Bodies are capped at 16 KB (search 4 KB).
   Handlers are pure async functions (body → { status, json }), unit-tested
   without Express (test/server/master-api.test.mjs).
   ============================================================================ */

const crypto = require("crypto");
const path = require("path");
const { createWeather } = require("./weather");
const { createTraffic } = require("./traffic");
const { createRoad } = require("./road");
const { createBlackspots } = require("./blackspots");
const { createPoi } = require("./poi");
const { createSearch } = require("./search");
const { enginesFromEnv } = require("./llm");
const { createEditDirector } = require("./edit-director");
const { createSafety } = require("./safety");
const { createMusic } = require("./music");
const { createRidePlan } = require("./rideplan");
const { createMetNo } = require("./metno");
const { createHospitals } = require("./hospitals");
const { createNasaPower } = require("./nasapower");
const RS = require("../../public/js/master/roadsense/roadsense.js");

/** Same host as the server (the website calling its own API: browsers send Origin on same-origin POSTs). @param {any} req @param {string} origin */
function isSameOrigin(req, origin) {
    const host = req.headers && req.headers.host;
    if (!host) return false;
    try { const u = new URL(origin); return (u.protocol === "https:" || u.protocol === "http:") && u.host === String(host).toLowerCase(); } catch { return false; }
}

/**
 * Build every service. Injectable for tests.
 * @param {{ env?: Record<string, string|undefined>, fetchImpl?: typeof fetch, now?: () => number, blackspotsDir?: string, hospitalsDir?: string, overpassUrl?: string, dem?: any, ratings?: any, roadsense?: any }} [o]
 */
function createMasterServices(o = {}) {
    const env = o.env || process.env;
    const fetchImpl = o.fetchImpl;
    const now = o.now;
    const overpassUrl = o.overpassUrl || env.OVERPASS_URL || "https://overpass-api.de/api/interpreter";
    const weather = createWeather({ fetchImpl, now, apiKey: env.OPEN_METEO_API_KEY || "", forecastUrl: env.OPEN_METEO_FORECAST_URL, airUrl: env.OPEN_METEO_AIR_URL });
    const traffic = createTraffic({ fetchImpl, now, apiKey: env.TOMTOM_API_KEY || "" });
    const road = createRoad({ fetchImpl, now, overpassUrl });
    const blackspots = createBlackspots();
    blackspots.loadDir(o.blackspotsDir || env.MASTER_BLACKSPOTS_DIR || path.join(__dirname, "..", "..", "data", "master", "blackspots"));
    const poi = createPoi({ fetchImpl, now, overpassUrl, googleKey: env.MASTER_POI_GOOGLE === "0" ? "" : env.GOOGLE_MAPS_SERVER_KEY || "", googleTtlMs: (Number(env.PLACES_CACHE_SECONDS) || 900) * 1000 });
    // reasoning: a chain of free engines, Gemini → Groq → local Ollama by default (MASTER_LLM_ORDER; lib/master/llm.js)
    const engines = enginesFromEnv(env, { fetchImpl, now });
    const search = createSearch({ engines, now, dailyMax: Number(env.MASTER_SEARCH_DAILY_MAX) || 1000 });
    const safety = createSafety({ weather, blackspots, poi, now });
    const music = createMusic({ fetchImpl, now, apiKey: env.LASTFM_API_KEY || "" });
    // Ride Plan: the whole route before a ride, nothing paid: OSM places, MapUnite riders' ratings, a government
    // hospital directory (known locations), MET Norway's forecast fetched by this server, terrain, official blackspots
    const metno = createMetNo({ fetchImpl, now, userAgent: env.MET_NO_USER_AGENT || undefined, url: env.MET_NO_URL || undefined });
    const hospitals = createHospitals();
    hospitals.loadDir(o.hospitalsDir || env.MASTER_HOSPITALS_DIR || path.join(__dirname, "..", "..", "data", "master", "hospitals"));
    const power = createNasaPower({ fetchImpl, now, url: env.NASA_POWER_URL || undefined });
    const ridePlan = createRidePlan({ fetchImpl, now, overpassUrl, metno, power, hospitals, blackspots, dem: o.dem || null, ratings: o.ratings || null, roadsense: o.roadsense || null, tileOf: RS.tileOf });
    // Ride Edit's AI director: the Summit Cut system prompt on the same free engines; the phone sends numbers only
    const editDirector = createEditDirector({ engines });
    return { weather, traffic, road, blackspots, poi, search, safety, music, engines, ridePlan, metno, hospitals, editDirector };
}

/** Turn a handler's thrown upstream error into a precise answer. @param {any} err */
function failure(err) {
    const code = err && err.code;
    if (code === "CIRCUIT_OPEN") return { status: 503, json: { ok: false, reason: "upstream-paused" } };
    if (code === "RATE_LIMITED") return { status: 503, json: { ok: false, reason: "upstream-rate-limited" } };
    if (code === "TIMEOUT") return { status: 504, json: { ok: false, reason: "upstream-timeout" } };
    return { status: 502, json: { ok: false, reason: "upstream-error" } };
}

/**
 * The /bw payload: kb kilobytes of random bytes (1–512).
 * @param {any} kbParam
 */
function bandwidthPayload(kbParam) {
    const kb = Math.max(1, Math.min(512, Math.round(Number(kbParam) || 64)));
    return crypto.randomBytes(kb * 1024);
}

/**
 * @param {{
 *   express: any, rateLimit: any, services?: ReturnType<typeof createMasterServices>,
 *   allowOrigin?: (origin: string) => boolean, log?: { warn: Function },
 *   roadsense?: ReturnType<typeof import("./roadsense").createRoadsense>, dem?: any,
 *   ratings?: ReturnType<typeof import("./place-ratings").createPlaceRatings>
 * }} o
 */
function createMasterApi(o) {
    const { express, rateLimit } = o;
    const s = o.services || createMasterServices({ dem: o.dem, ratings: o.ratings, roadsense: o.roadsense });
    const log = o.log || console;
    const router = express.Router();
    const limiter = (/** @type {number} */ perMin) => rateLimit({ windowMs: 60000, max: perMin, standardHeaders: true, legacyHeaders: false });

    // the Android app calls from https://localhost: CORS for allowed origins only (same rule as /api/bikes)
    router.use((/** @type {any} */ req, /** @type {any} */ res, /** @type {any} */ next) => {
        const origin = req.headers.origin;
        if (origin && isSameOrigin(req, origin)) { /* the website itself: no CORS headers needed */ }
        else if (origin && o.allowOrigin && o.allowOrigin(origin)) {
            res.setHeader("Access-Control-Allow-Origin", origin);
            res.setHeader("Vary", "Origin");
            res.setHeader("Access-Control-Allow-Headers", "content-type");
            res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
            res.setHeader("Cross-Origin-Resource-Policy", "cross-origin");
        } else if (origin && req.method !== "GET") {
            return res.status(403).json({ ok: false, reason: "origin-not-allowed" });
        }
        if (req.method === "OPTIONS") return res.sendStatus(204);
        res.setHeader("Cache-Control", "no-store");
        next();
    });

    /** @param {string} route @param {number} perMin @param {string} limit @param {(body: any, req: { ip?: string }) => Promise<{ status: number, json: any }>} fn */
    const post = (route, perMin, limit, fn) => router.post(route, limiter(perMin), express.json({ limit }), async (/** @type {any} */ req, /** @type {any} */ res) => {
        let out;
        // handlers get the body, and the address only for in-memory limits (RoadSense smooth passes)
        try { out = await fn(req.body || {}, { ip: req.ip }); }
        catch (err) {
            out = failure(err);
            log.warn(`[master] ${route} failed: ${(err && /** @type {any} */ (err).message) || err}`);
        }
        res.status(out.status).json(out.json);
    });

    post("/weather", 60, "16kb", s.weather.handle);
    post("/traffic", 120, "16kb", s.traffic.handle);
    post("/road", 30, "16kb", s.road.handle);
    post("/blackspots", 60, "16kb", s.blackspots.handle);
    post("/poi", 60, "16kb", s.poi.handle);
    // 16 kB: the question, the context and up to 10 earlier messages; 20 a minute leaves room for a quick back-and-forth
    post("/search", 20, "16kb", s.search.handle);
    post("/destination", 20, "4kb", s.safety.handle);
    post("/music", 30, "4kb", s.music.handle);
    // Ride Edit: ≤ 30 clips × 40 samples of numbers + the beat grid; an engine answer takes seconds, so 6 a minute
    if (s.editDirector) post("/edit-direct", 6, "192kb", s.editDirector.handle);
    // Ride Plan: up to 3 routes of ≤ 4000 points each; heavy upstream work, so 6 a minute per address
    if (s.ridePlan) post("/ride-plan", 6, "320kb", s.ridePlan.handle);
    // riders rate the places they said they stopped at (lib/master/place-ratings.js): needs the server's database
    if (o.ratings) {
        post("/ratings/candidates", 20, "2kb", o.ratings.candidates);
        post("/ratings/submit", 20, "4kb", o.ratings.submit);
        post("/ratings/lookup", 30, "16kb", o.ratings.lookup);
        post("/ratings/forget", 5, "2kb", o.ratings.forget);
    }
    // RoadSense Live (lib/master/roadsense.js): needs the server's database, so only when server.js passes it in.
    // Upload: a batch after a ride, ≤ 200 observations (≈ 30 kB); area: tiles along a route; forget: ≤ 800 pseudonyms
    if (o.roadsense) {
        post("/roadsense/upload", 30, "64kb", o.roadsense.upload);
        post("/roadsense/area", 60, "4kb", o.roadsense.area);
        post("/roadsense/cover", 30, "64kb", o.roadsense.cover);
        post("/roadsense/forget", 5, "128kb", o.roadsense.forget);
        post("/roadsense/publish", 20, "32kb", o.roadsense.publish);
        post("/roadsense/me", 10, "2kb", o.roadsense.me);
    }

    router.get("/bw", limiter(30), (/** @type {any} */ req, /** @type {any} */ res) => {
        res.setHeader("Content-Type", "application/octet-stream");
        res.setHeader("Cache-Control", "no-store, no-transform");
        res.send(bandwidthPayload(req.query.kb));
    });
    router.get("/status", limiter(30), async (/** @type {any} */ _req, /** @type {any} */ res) => res.json({
        ok: true,
        configured: { weather: true, traffic: s.traffic.configured(), road: true, blackspots: s.blackspots.info().count > 0, poi: s.poi.configured(), search: s.search.configured(), destination: true, music: s.music.configured(), roadsense: Boolean(o.roadsense && o.roadsense.configured()), ratings: Boolean(o.ratings && o.ratings.configured()), knownHospitals: s.hospitals ? s.hospitals.info().count : 0 },
        reasoning: await s.engines.health(),
        blackspots: s.blackspots.info(),
        health: { weather: s.weather.stats(), traffic: s.traffic.stats(), road: s.road.stats(), poi: s.poi.stats(), search: s.search.stats(), music: s.music.stats(), ...(o.roadsense ? { roadsense: o.roadsense.stats() } : {}) }
    }));

    return { router, services: s };
}

module.exports = { createMasterApi, createMasterServices, failure, bandwidthPayload, isSameOrigin };
