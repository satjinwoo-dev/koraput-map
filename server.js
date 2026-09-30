"use strict";

/* ============================================================================
   MapUnite Server — server.js  (v3, hardened)
   ==============================================================================
   Architecture
     - Realtime hot path (users / chat / memories / geofences / currentTrip)
       stays in memory. Every live broadcast reads and writes RAM only.
     - SQLite (better-sqlite3) sits BESIDE it. It is written through on
       creation and HYDRATED INTO RAM ON BOOT, so a restart no longer loses
       memories or geofences.
     - Every socket handler goes through safeHandler(): sync throws AND async
       rejections are caught, per-bucket rate limited, and can never take the
       process down.

   Requires (npm install):
     express helmet express-rate-limit socket.io better-sqlite3
   Requires Node 18+ (native fetch / AbortSignal.timeout).

   Env vars (all optional):
     PORT                     default 3000
     NODE_ENV                 "production" => same-origin CORS unless CORS_ORIGIN set
     CORS_ORIGIN              comma-separated origins, e.g. https://app.example.com
     DB_PATH                  default ./data/mapunite.db
     SERVER_SECRET            HMAC key for pseudonymous owner keys (auto-generated
                              and persisted in the DB if unset)
     OSRM_BASE_URL            default https://router.project-osrm.org
     OVERPASS_URL             default https://overpass-api.de/api/interpreter
     GOOGLE_MAPS_SERVER_KEY   server-side Places key (IP-restrict it in Google
                              Cloud). Never put a Maps key in client markup.
     HTTP_RATE_LIMIT_MAX      default 300 per 15 min per IP
     MAX_SOCKETS_PER_IP       default 20
     RECONNECT_GRACE_MS       default 30000
     TRIP_RETENTION_DAYS      default 30 (0 = keep forever)
     ENFORCE_CSP              "1" to enforce the CSP (default: report-only)
     RELAY_HOLD_MS            default 600000 — how long a rider whose socket is
                              gone stays in the trip while radio relays of their
                              position keep arriving (Phase 4)

   PHASE 3 (merged verbatim from server.additions.js):
     getTripRollups — day / week / month SQL rollups in the rider's local time.

   PHASE 4 — experimental offline relay (roadmap Section 5):
     - getRelayCredentials: per-trip keys for the LoRa radio relay. Everything
       is DERIVED from SERVER_SECRET + trip id (+ device id), so nothing new is
       stored and the keys die with the trip:
         groupKey  AES-128-GCM key every trip member shares (radio privacy —
                   Meshtastic's default channel is public),
         deviceKey per-rider HMAC key only the server and that rider know,
         rid       4-byte per-trip pseudonym for the rider (not linkable
                   across trips), tag = 4-byte trip filter.
     - relayUpload: a trip member with data uploads frames heard over radio
       from riders WITHOUT data. Each frame must decrypt under the group key
       AND carry a valid HMAC from its origin's device key — a member can
       carry another rider's position but cannot forge it. Replays, stale or
       out-of-order frames and implausible jumps are rejected per frame.
     - A rider whose socket is gone is held in the trip (RELAY_HOLD_MS) while
       relays keep arriving, instead of being dropped after the 30 s grace.
     - updateLocation accepts {est, accuracy} for dead-reckoned positions;
       public user records now carry accuracy / est / via / fixAt.
     - Privacy fix: an "approx" rider inside an active trip is exact for trip
       members only — everyone else now gets the 1 km cell (before, the whole
       map got the exact position, contradicting the settings text).
   ============================================================================ */

const express = require("express");
const http = require("http");
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");
const helmet = require("helmet");
const rateLimit = require("express-rate-limit");
const { Server } = require("socket.io");
const Database = require("better-sqlite3");

// ==========================================================================
// 0. CONFIG
// ==========================================================================
const IS_PROD = process.env.NODE_ENV === "production";
const PORT = Number(process.env.PORT) || 3000;
const DB_PATH = process.env.DB_PATH || path.join(__dirname, "data", "mapunite.db");
const OSRM_BASE = process.env.OSRM_BASE_URL || "https://router.project-osrm.org";
const OVERPASS_URL = process.env.OVERPASS_URL || "https://overpass-api.de/api/interpreter";
const GOOGLE_KEY = process.env.GOOGLE_MAPS_SERVER_KEY || "";
const MAX_SOCKETS_PER_IP = Number(process.env.MAX_SOCKETS_PER_IP) || 20;
const RECONNECT_GRACE_MS = Number(process.env.RECONNECT_GRACE_MS) || 30_000;
const TRIP_RETENTION_DAYS = process.env.TRIP_RETENTION_DAYS !== undefined
    ? Math.max(0, Number(process.env.TRIP_RETENTION_DAYS) || 0) : 30;
const CORS_ORIGIN = process.env.CORS_ORIGIN
    ? process.env.CORS_ORIGIN.split(",").map((s) => s.trim()).filter(Boolean)
    : (IS_PROD ? false : "*");

const REACTION_EMOJIS = ["👍", "❤️", "😂", "😮", "😢", "🔥"];
const ALLOWED_MSG_TYPES = ["text", "image", "video", "audio", "document"];
const ALLOWED_MODES = ["drive", "bike", "walk"];
const MEETUP_STRATEGIES = ["sum", "minimax", "fuel"];
const SHARING_MODES = ["exact", "approx", "off"];
const MAX_AVATAR_B64_LEN = 3_000_000;
const MAX_MEMORY_IMAGE_B64_LEN = 6_000_000;
const MAX_MEMORIES_IN_RAM = 100;
const MAX_GEOFENCES_TOTAL = 200;
const MAX_GEOFENCES_PER_OWNER = 20;
const MAX_PLAUSIBLE_KMH = 300;
const APPROX_GRID_KM = 1;
const DEFAULT_AVATAR = "satyam.png";

// Phase 4 — radio relay (see header). Frame layout is documented at
// openRelayFrame() and mirrored byte-for-byte by features.js ConvoyRelay.
const RELAY_HOLD_MS = Number(process.env.RELAY_HOLD_MS) || 10 * 60_000;
const RELAY_RADIO_GRACE_MS = Math.min(3 * 60_000, RELAY_HOLD_MS);   // radio-equipped rider: longer reconnect grace before the first relay lands
const RELAY_MAX_AGE_MS = 15 * 60_000;      // older than this is history, not a position
const RELAY_MAX_FUTURE_MS = 5 * 60_000;    // phone clock skew allowance
const RELAY_DIRECT_FRESH_MS = 20_000;      // a direct socket fix this recent beats any relay
const RELAY_FRAME = Object.freeze({
    VERSION: 1, PING: 1, SOS: 2, ACK: 4,
    HEADER: 17, GCM_TAG: 16, MAC: 8, POS_BODY: 16, MAX_BYTES: 140,
    FLAG_EST: 0x01, FLAG_ORIGIN_OFFLINE: 0x02, FLAG_COURSE: 0x04
});

// ==========================================================================
// 1. APP / HTTP / SOCKET.IO BOOTSTRAP
// ==========================================================================
const app = express();
const server = http.createServer(app);
const io = new Server(server, {
    cors: { origin: CORS_ORIGIN, methods: ["GET", "POST"] },
    // Base64 memory photos exceed Socket.IO's 1MB default, which silently
    // drops the packet. 8MB gives real headroom while still bounding abuse.
    maxHttpBufferSize: 8 * 1024 * 1024
});

// Real client IP behind Render / Heroku / nginx.
app.set("trust proxy", 1);

// ==========================================================================
// 2. SECURITY MIDDLEWARE
// ==========================================================================
// CSP ships in REPORT-ONLY mode by default: it cannot break the live page, and
// violations are logged via /csp-report. Flip ENFORCE_CSP=1 once the log is
// clean. Google Maps JS is intentionally absent from script-src — the client
// no longer loads it (Places is proxied below).
const cspDirectives = {
    defaultSrc: ["'self'"],
    scriptSrc: ["'self'", "https://unpkg.com", "https://cdn.jsdelivr.net"],
    styleSrc: ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com", "https://unpkg.com"],
    fontSrc: ["'self'", "https://fonts.gstatic.com"],
    imgSrc: ["'self'", "data:", "blob:", "https://*.google.com", "https://*.gstatic.com",
             "https://*.tile.openstreetmap.org", "https://*.basemaps.cartocdn.com", "https://unpkg.com"],
    connectSrc: ["'self'", "ws:", "wss:", "https://router.project-osrm.org",
                 "https://api.open-meteo.com", "https://api.bigdatacloud.net",
                 "https://nominatim.openstreetmap.org"],
    mediaSrc: ["'self'", "blob:", "data:"],
    workerSrc: ["'self'"],
    manifestSrc: ["'self'"],
    objectSrc: ["'none'"],
    frameAncestors: ["'none'"],
    baseUri: ["'self'"],
    formAction: ["'self'"],
    reportUri: ["/csp-report"]
};

app.use(helmet({
    contentSecurityPolicy: {
        useDefaults: false,
        reportOnly: process.env.ENFORCE_CSP !== "1",
        directives: cspDirectives
    },
    crossOriginEmbedderPolicy: false,
    // Permissions-Policy is set by hand: the app needs geolocation, mic and
    // camera on its own origin only.
    crossOriginResourcePolicy: { policy: "same-site" }
}));
app.use((_req, res, next) => {
    res.setHeader("Permissions-Policy",
        "geolocation=(self), microphone=(self), camera=(self), accelerometer=(self), gyroscope=(self), magnetometer=(self), bluetooth=(self), screen-wake-lock=(self)");
    next();
});

// NOTE on Socket.IO + rate limiting: engine.io intercepts /socket.io/ requests
// on the raw http.Server BEFORE Express sees them, so this limiter never counts
// them. The skip is kept as belt-and-braces (and for any proxy that rewrites the
// path). Realtime abuse is handled by the per-socket buckets and the per-IP
// connection cap further down, NOT by this page-view budget.
const httpLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: Number(process.env.HTTP_RATE_LIMIT_MAX) || 300,
    standardHeaders: true,
    legacyHeaders: false,
    skip: (req) => req.path.startsWith("/socket.io/")
});
app.use(httpLimiter);

// Static assets. sw.js must NEVER be served from a stale HTTP cache, otherwise
// a client can run a new app.js against an old worker (the classic PWA update
// race). Everything else may revalidate normally.
app.use(express.static(path.join(__dirname, "public"), {
    setHeaders(res, filePath) {
        const base = path.basename(filePath);
        if (base === "sw.js") {
            res.setHeader("Cache-Control", "no-cache, no-store, must-revalidate");
            res.setHeader("Service-Worker-Allowed", "/");
        } else if (base === "manifest.json" || base === "index.html") {
            res.setHeader("Cache-Control", "no-cache");
        }
    }
}));
app.use(express.json({ limit: "256kb" }));

app.get("/healthz", (_req, res) => res.json({ ok: true, uptimeSec: Math.round(process.uptime()) }));

// Public feature flags the client reads at boot (no secrets).
app.get("/api/config", (_req, res) => {
    res.json({
        ok: true,
        placesProxy: Boolean(GOOGLE_KEY),
        approxGridKm: APPROX_GRID_KM,
        tripRetentionDays: TRIP_RETENTION_DAYS,
        maxPlausibleKmh: MAX_PLAUSIBLE_KMH
    });
});

app.post("/csp-report",
    express.json({ type: ["application/json", "application/csp-report", "application/reports+json"], limit: "16kb" }),
    (req, res) => {
        try { console.warn("[CSP]", JSON.stringify(req.body).slice(0, 600)); } catch { /* ignore */ }
        res.sendStatus(204);
    });

// ---- Google Places proxy (keeps the API key off the client entirely) --------
const placesLimiter = rateLimit({ windowMs: 60 * 1000, max: 30, standardHeaders: true, legacyHeaders: false });
const SESSION_TOKEN_RE = /^[A-Za-z0-9_-]{8,64}$/;

app.get("/api/places/autocomplete", placesLimiter, async (req, res) => {
    if (!GOOGLE_KEY) return res.status(503).json({ ok: false, reason: "places-not-configured" });
    const q = typeof req.query.q === "string" ? req.query.q.trim() : "";
    if (q.length < 2 || q.length > 120) return res.status(400).json({ ok: false, reason: "bad-query" });

    const body = { input: q };
    const lat = Number(req.query.lat), lng = Number(req.query.lng);
    if (req.query.lat !== undefined && isValidCoordPair(lat, lng)) {
        body.locationBias = { circle: { center: { latitude: lat, longitude: lng }, radius: 50000 } };
    }
    if (typeof req.query.sessionToken === "string" && SESSION_TOKEN_RE.test(req.query.sessionToken)) {
        body.sessionToken = req.query.sessionToken;
    }
    try {
        const r = await fetch("https://places.googleapis.com/v1/places:autocomplete", {
            method: "POST",
            headers: { "Content-Type": "application/json", "X-Goog-Api-Key": GOOGLE_KEY },
            body: JSON.stringify(body),
            signal: AbortSignal.timeout(6000)
        });
        if (!r.ok) return res.status(502).json({ ok: false, reason: "upstream-error" });
        const json = await r.json();
        const suggestions = (json.suggestions || [])
            .map((s) => s.placePrediction)
            .filter((p) => p && p.placeId)
            .slice(0, 6)
            .map((p) => ({
                placeId: p.placeId,
                text: p.text?.text || "",
                main: p.structuredFormat?.mainText?.text || p.text?.text || "",
                secondary: p.structuredFormat?.secondaryText?.text || ""
            }));
        res.json({ ok: true, suggestions });
    } catch (e) {
        console.error("places autocomplete failed:", e.message);
        res.status(502).json({ ok: false, reason: "upstream-unreachable" });
    }
});

app.get("/api/places/details", placesLimiter, async (req, res) => {
    if (!GOOGLE_KEY) return res.status(503).json({ ok: false, reason: "places-not-configured" });
    const placeId = typeof req.query.placeId === "string" ? req.query.placeId : "";
    if (!/^[A-Za-z0-9_-]{10,300}$/.test(placeId)) return res.status(400).json({ ok: false, reason: "bad-place-id" });
    const qs = typeof req.query.sessionToken === "string" && SESSION_TOKEN_RE.test(req.query.sessionToken)
        ? `?sessionToken=${encodeURIComponent(req.query.sessionToken)}` : "";
    try {
        const r = await fetch(`https://places.googleapis.com/v1/places/${encodeURIComponent(placeId)}${qs}`, {
            headers: { "X-Goog-Api-Key": GOOGLE_KEY, "X-Goog-FieldMask": "id,displayName,formattedAddress,location" },
            signal: AbortSignal.timeout(6000)
        });
        if (!r.ok) return res.status(502).json({ ok: false, reason: "upstream-error" });
        const p = await r.json();
        if (!isValidCoordPair(p.location?.latitude, p.location?.longitude)) {
            return res.status(502).json({ ok: false, reason: "no-location" });
        }
        res.json({
            ok: true,
            place: {
                id: p.id, name: p.displayName?.text || "", address: p.formattedAddress || "",
                lat: p.location.latitude, lng: p.location.longitude
            }
        });
    } catch (e) {
        console.error("places details failed:", e.message);
        res.status(502).json({ ok: false, reason: "upstream-unreachable" });
    }
});

// ==========================================================================
// 3. PERSISTENCE — better-sqlite3
// ==========================================================================
fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
const db = new Database(DB_PATH);
db.pragma("journal_mode = WAL");
db.pragma("synchronous = NORMAL");
// Zero-trace deletes: overwrite freed pages so "Clear My History" is not
// recoverable from the file. Combined with a WAL checkpoint on delete.
db.pragma("secure_delete = ON");

// Render (and similar) has an ephemeral filesystem: attach a persistent disk
// at DB_PATH's directory or this survives restarts but not redeploys.

db.exec(`
CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS users (
  device_id   TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  avatar      TEXT,
  token_hash  TEXT,
  created_at  INTEGER NOT NULL,
  last_seen   INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS trips (
  id              TEXT PRIMARY KEY,
  host_device_id  TEXT NOT NULL,
  name            TEXT,
  mode            TEXT NOT NULL DEFAULT 'drive',
  started_at      INTEGER NOT NULL,
  ended_at        INTEGER,
  total_dist_km   REAL DEFAULT 0,
  avg_speed       REAL DEFAULT 0,
  max_speed       REAL DEFAULT 0,
  fuel_used_l     REAL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_trips_device ON trips(host_device_id);
CREATE INDEX IF NOT EXISTS idx_trips_started ON trips(started_at);
CREATE TABLE IF NOT EXISTS trip_points (
  trip_id   TEXT NOT NULL,
  ts        INTEGER NOT NULL,
  lat       REAL NOT NULL,
  lng       REAL NOT NULL,
  speed_kmh REAL,
  accuracy  REAL
);
CREATE INDEX IF NOT EXISTS idx_trip_points_trip ON trip_points(trip_id);
CREATE TABLE IF NOT EXISTS memories (
  id          TEXT PRIMARY KEY,
  device_id   TEXT,
  name        TEXT,
  lat         REAL NOT NULL,
  lng         REAL NOT NULL,
  image_ref   TEXT NOT NULL,
  caption     TEXT,
  trip_id     TEXT,
  created_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_memories_device ON memories(device_id);
CREATE INDEX IF NOT EXISTS idx_memories_created ON memories(created_at);
CREATE TABLE IF NOT EXISTS geofences (
  id               TEXT PRIMARY KEY,
  name             TEXT NOT NULL,
  lat              REAL NOT NULL,
  lng              REAL NOT NULL,
  radius           INTEGER NOT NULL,
  owner_device_id  TEXT
);
CREATE INDEX IF NOT EXISTS idx_geofences_owner ON geofences(owner_device_id);
`);

// Idempotent migrations for databases created by earlier versions.
function ensureColumn(table, column, ddl) {
    const cols = db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name);
    if (!cols.includes(column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${ddl}`);
}
ensureColumn("users", "token_hash", "TEXT");
ensureColumn("memories", "caption", "TEXT");

const stmt = {
    getMeta: db.prepare(`SELECT value FROM meta WHERE key = ?`),
    setMeta: db.prepare(`INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`),

    getUser: db.prepare(`SELECT device_id, token_hash FROM users WHERE device_id = ?`),
    upsertUser: db.prepare(`
        INSERT INTO users (device_id, name, avatar, token_hash, created_at, last_seen) VALUES (?,?,?,?,?,?)
        ON CONFLICT(device_id) DO UPDATE SET
            name = excluded.name, avatar = excluded.avatar, last_seen = excluded.last_seen,
            token_hash = COALESCE(users.token_hash, excluded.token_hash)
    `),
    deleteUser: db.prepare(`DELETE FROM users WHERE device_id = ?`),

    insertTrip: db.prepare(`
        INSERT INTO trips (id, host_device_id, name, mode, started_at, ended_at, total_dist_km, avg_speed, max_speed, fuel_used_l)
        VALUES (?,?,?,?,?,?,?,?,?,?)
    `),
    insertTripPoint: db.prepare(`INSERT INTO trip_points (trip_id, ts, lat, lng, speed_kmh, accuracy) VALUES (?,?,?,?,?,?)`),
    listTrips: db.prepare(`
        SELECT id, name, mode, started_at, ended_at, total_dist_km, avg_speed, max_speed, fuel_used_l
        FROM trips WHERE host_device_id = ? ORDER BY started_at DESC LIMIT ?
    `),
    getTripOwner: db.prepare(`SELECT host_device_id FROM trips WHERE id = ?`),
    getTripPoints: db.prepare(`
        SELECT ts, lat, lng, speed_kmh, accuracy FROM trip_points WHERE trip_id = ? ORDER BY ts ASC LIMIT ?
    `),
    deleteTripPointsForDevice: db.prepare(`
        DELETE FROM trip_points WHERE trip_id IN (SELECT id FROM trips WHERE host_device_id = ?)
    `),
    deleteTripsForDevice: db.prepare(`DELETE FROM trips WHERE host_device_id = ?`),
    purgeOldTripPoints: db.prepare(`DELETE FROM trip_points WHERE trip_id IN (SELECT id FROM trips WHERE started_at < ?)`),
    purgeOldTrips: db.prepare(`DELETE FROM trips WHERE started_at < ?`),

    insertMemory: db.prepare(`
        INSERT INTO memories (id, device_id, name, lat, lng, image_ref, caption, trip_id, created_at) VALUES (?,?,?,?,?,?,?,?,?)
    `),
    hydrateMemories: db.prepare(`
        SELECT id, device_id, name, lat, lng, image_ref, caption, trip_id, created_at
        FROM memories ORDER BY created_at DESC LIMIT ?
    `),
    listMemoriesMeta: db.prepare(`SELECT id, name, lat, lng, caption, trip_id, created_at FROM memories WHERE device_id = ?`),
    deleteMemoriesForDevice: db.prepare(`DELETE FROM memories WHERE device_id = ?`),

    insertGeofence: db.prepare(`INSERT INTO geofences (id, name, lat, lng, radius, owner_device_id) VALUES (?,?,?,?,?,?)`),
    deleteGeofence: db.prepare(`DELETE FROM geofences WHERE id = ?`),
    hydrateGeofences: db.prepare(`
        SELECT g.id, g.name, g.lat, g.lng, g.radius, g.owner_device_id, u.name AS owner_name
        FROM geofences g LEFT JOIN users u ON u.device_id = g.owner_device_id
    `),
    listGeofencesForDevice: db.prepare(`SELECT id, name, lat, lng, radius FROM geofences WHERE owner_device_id = ?`),
    deleteGeofencesForDevice: db.prepare(`DELETE FROM geofences WHERE owner_device_id = ?`)
};

// ---- Phase 3: trip rollups (merged verbatim from server.additions.js, BLOCK 1) ----
// Bucket expressions. The single `?` in each is the client's UTC offset in
// SECONDS, so "a trip at 00:30 IST" lands on the rider's local date, not UTC's.
//   day   -> 2026-09-29
//   week  -> the Monday that starts the week (ISO-style), e.g. 2026-09-28
//   month -> 2026-09
const ROLLUP_BUCKET_SQL = {
    day: "date(started_at / 1000 + ?, 'unixepoch')",
    week: "date(started_at / 1000 + ?, 'unixepoch', '-6 days', 'weekday 1')",
    month: "strftime('%Y-%m', started_at / 1000 + ?, 'unixepoch')"
};
const rollupStmts = Object.fromEntries(Object.entries(ROLLUP_BUCKET_SQL).map(([period, expr]) => [
    period,
    db.prepare(`
        SELECT ${expr}                                        AS bucket,
               COUNT(*)                                       AS trips,
               COALESCE(SUM(total_dist_km), 0)                AS dist,
               COALESCE(SUM(fuel_used_l), 0)                  AS fuel,
               COALESCE(MAX(max_speed), 0)                    AS maxs,
               COALESCE(SUM(MAX(ended_at - started_at, 0)), 0) AS dur,
               COALESCE(SUM(total_dist_km * avg_speed) / NULLIF(SUM(total_dist_km), 0), 0) AS avg
        FROM trips
        WHERE host_device_id = ? AND started_at >= ? AND ended_at IS NOT NULL
        GROUP BY bucket
        ORDER BY bucket DESC
        LIMIT ?
    `)
]));

// Server secret for pseudonymous owner keys. Persisted so keys stay stable
// across restarts. Owner keys let clients answer "is this mine?" WITHOUT the
// raw deviceId (a private tracking identifier) ever being broadcast.
const SERVER_SECRET = (() => {
    if (process.env.SERVER_SECRET) return process.env.SERVER_SECRET;
    const row = stmt.getMeta.get("server_secret");
    if (row) return row.value;
    const fresh = crypto.randomBytes(32).toString("hex");
    stmt.setMeta.run("server_secret", fresh);
    return fresh;
})();
const ownerKeyFor = (deviceId) => deviceId
    ? crypto.createHmac("sha256", SERVER_SECRET).update(String(deviceId)).digest("hex").slice(0, 16)
    : null;

// ---- Phase 4: radio relay key derivation --------------------------------------
// Domain-separated HMAC-SHA256 derivations from SERVER_SECRET: stable for the
// life of one trip, different for every trip, never stored, never logged.
function relayDerive(...parts) {
    return crypto.createHmac("sha256", SERVER_SECRET).update(["mu-relay-v1", ...parts].join("|")).digest();
}
const relayGroupKey = (tripId) => relayDerive("group", tripId).subarray(0, 16);        // AES-128-GCM, all members
const relayTripTag = (tripId) => relayDerive("tag", tripId).subarray(0, 4);             // cleartext trip filter
const relayRidFor = (tripId, deviceId) => relayDerive("rid", tripId, deviceId).subarray(0, 4); // per-trip pseudonym
const relayDeviceKey = (tripId, deviceId) => relayDerive("device", tripId, deviceId);  // HMAC key: server + that rider only

// ==========================================================================
// 4. IN-MEMORY HOT PATH
// ==========================================================================
const users = new Map();            // socketId -> internal user record
const chatMessages = [];
const memories = [];                // internal memory records (capped in RAM, full history in SQLite)
let geofences = [];                 // internal fence records
let currentTrip = null;
const voiceSquadMembers = new Map();
const deviceToSocket = new Map();   // deviceId -> live socketId
const pendingDeparture = new Map(); // deviceId -> grace timer
const venueCache = new Map();       // "lat,lng" -> {ts, venues}

// ==========================================================================
// 5. PURE HELPERS
// ==========================================================================
const generateId = () => crypto.randomUUID();

function distanceKm(lat1, lng1, lat2, lng2) {
    const p = Math.PI / 180;
    const x = 0.5 - Math.cos((lat2 - lat1) * p) / 2 +
        Math.cos(lat1 * p) * Math.cos(lat2 * p) * (1 - Math.cos((lng2 - lng1) * p)) / 2;
    return 12742 * Math.asin(Math.sqrt(Math.max(0, x)));
}

const isFiniteNum = (v) => typeof v === "number" && Number.isFinite(v);
const isValidLat = (v) => isFiniteNum(v) && v >= -90 && v <= 90;
const isValidLng = (v) => isFiniteNum(v) && v >= -180 && v <= 180;
const isValidCoordPair = (lat, lng) => isValidLat(lat) && isValidLng(lng);
const isNonEmptyStr = (v, max = 200) => typeof v === "string" && v.trim().length > 0 && v.length <= max;
const isValidRadius = (v) => isFiniteNum(v) && v >= 10 && v <= 50000;
const clampStr = (v, max) => String(v ?? "").slice(0, max);
const clampNum = (v, min, max, fallback) => (isFiniteNum(v) ? Math.min(Math.max(v, min), max) : fallback);
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const IMAGE_DATA_URL_RE = /^data:image\/(png|jpe?g|webp|gif|heic|heif);base64,/i;

function normalizeMode(m) {
    if (m === "car") return "drive";
    return ALLOWED_MODES.includes(m) ? m : "drive";
}

function sanitizeAvatar(a) {
    if (typeof a !== "string" || a.length === 0 || a.length > MAX_AVATAR_B64_LEN) return DEFAULT_AVATAR;
    if (a.startsWith("data:")) return IMAGE_DATA_URL_RE.test(a.slice(0, 40)) ? a : DEFAULT_AVATAR;
    return /^[\w.\-/]{1,100}$/.test(a) && !a.includes("..") ? a : DEFAULT_AVATAR;
}

function sanitizeReplyTo(r) {
    if (!r || typeof r !== "object") return null;
    if (!isNonEmptyStr(r.id, 60) || !ALLOWED_MSG_TYPES.includes(r.type)) return null;
    return { id: r.id, name: clampStr(r.name, 40), type: r.type, preview: clampStr(r.preview, 60) };
}

// WebRTC signalling payloads are relayed blindly, so bound them.
function isSignalPayload(s) {
    if (!s || typeof s !== "object" || !["offer", "answer", "ice"].includes(s.type)) return false;
    try { return JSON.stringify(s).length < 20_000; } catch { return false; }
}

const hashToken = (t) => crypto.createHash("sha256").update(String(t)).digest("hex");
function tokenMatches(presented, storedHash) {
    const a = Buffer.from(hashToken(presented), "hex");
    const b = Buffer.from(String(storedHash), "hex");
    return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// ---- Privacy: effective sharing mode + 1 km grid snapping -------------------
const isInActiveTrip = (socketId) => Boolean(currentTrip && currentTrip.members.some((m) => m.id === socketId));

// "off" is always honoured. "approx" is only honoured OUTSIDE an active squad
// trip — inside one, the squad needs your real position.
function effectiveMode(u) {
    const mode = u.sharingMode || "exact";
    if (mode === "off") return "off";
    if (mode === "approx" && !isInActiveTrip(u.id)) return "approx";
    return "exact";
}

function snapToGrid(lat, lng) {
    const latStep = APPROX_GRID_KM / 111.32;
    const cLat = (Math.floor(lat / latStep) + 0.5) * latStep;
    const cosLat = Math.max(0.01, Math.cos((cLat * Math.PI) / 180));
    const lngStep = latStep / cosLat;
    const cLng = (Math.floor(lng / lngStep) + 0.5) * lngStep;
    return {
        lat: +Math.min(90, Math.max(-90, cLat)).toFixed(5),
        lng: +Math.min(180, Math.max(-180, cLng)).toFixed(5)
    };
}

// The ONLY shape ever sent to other clients. Never the raw record (deviceId
// is a private identifier).
// `modeOverride` lets emitUserEvent() hand the SAME record to two audiences
// (exact for trip members, approx for everyone else) — see needsSplitView().
function publicUser(u, modeOverride = null) {
    const mode = modeOverride || effectiveMode(u);
    const hasFix = isValidCoordPair(u.lat, u.lng);
    let lat = null, lng = null, alt = null, speedKmh = null, accuracy = null;
    if (mode !== "off" && hasFix) {
        if (mode === "approx") {
            ({ lat, lng } = snapToGrid(u.lat, u.lng));
        } else {
            lat = u.lat; lng = u.lng; alt = u.alt ?? null; speedKmh = u.speedKmh ?? null;
            accuracy = isFiniteNum(u.accuracy) ? Math.round(u.accuracy) : null;
        }
    }
    const relayed = u.via === "radio";
    return {
        id: u.id, name: u.name, avatar: u.avatar, online: u.online !== false,
        lat, lng, alt, speedKmh, weather: mode === "exact" ? (u.weather || "") : "",
        approx: mode === "approx", ownerKey: ownerKeyFor(u.deviceId),
        // Phase 4 (additive — older clients ignore these):
        accuracy,                                            // metres, exact mode only
        est: mode === "exact" && Boolean(u.est),             // dead-reckoned, not a GPS fix
        via: relayed ? "radio" : null,                       // position arrived over the LoRa relay
        fixAt: relayed ? (u.fixAt || null) : null,           // origin's timestamp for that position
        relayedBy: relayed ? (u.relayedBy || null) : null
    };
}

// Phase 4 privacy fix. effectiveMode() lifts "approx" to "exact" inside an
// active trip so the SQUAD can navigate to the rider — but the old broadcast
// sent that exact record to EVERY socket. Split it: exact for trip members,
// the 1 km cell for everyone else.
const needsSplitView = (u) => u.sharingMode === "approx" && effectiveMode(u) === "exact";
function publicUserFor(u, viewerSocketId) {
    return needsSplitView(u) && !isInActiveTrip(viewerSocketId) ? publicUser(u, "approx") : publicUser(u);
}
function emitUserEvent(event, u, exceptSocketId = null) {
    if (!needsSplitView(u)) {
        const pub = publicUser(u);
        if (exceptSocketId) io.except(exceptSocketId).emit(event, pub);
        else io.emit(event, pub);
        return;
    }
    const exact = publicUser(u), approx = publicUser(u, "approx");
    const now = Date.now();
    // Same 30 s same-cell de-dupe updateLocation applies to plain approx riders.
    const sameCell = event === "friendMoved" && u.lastApproxSent && u.lastApproxSent.lat === approx.lat &&
        u.lastApproxSent.lng === approx.lng && now - u.lastApproxSent.ts < 30_000;
    if (!sameCell) u.lastApproxSent = { lat: approx.lat, lng: approx.lng, ts: now };
    for (const sid of io.sockets.sockets.keys()) {
        if (sid === exceptSocketId) continue;
        if (isInActiveTrip(sid)) io.to(sid).emit(event, exact);
        else if (!sameCell) io.to(sid).emit(event, approx);
    }
}

function publicMemory(m) {
    return {
        id: m.id, name: m.name, lat: m.lat, lng: m.lng, image: m.image,
        caption: m.caption || "", time: m.time, tripId: m.tripId || null,
        ownerKey: ownerKeyFor(m.deviceId)
    };
}

function publicFence(f) {
    return {
        id: f.id, name: f.name, lat: f.lat, lng: f.lng, radius: f.radius,
        ownerName: f.ownerName || "", ownerKey: ownerKeyFor(f.ownerDeviceId),
        // Live socket id of the owner (survives reconnects), so the client's
        // existing `ownerId === socket.id` check keeps working.
        ownerId: (f.ownerDeviceId && deviceToSocket.get(f.ownerDeviceId)) || f.ownerId || null
    };
}

function broadcastUserState(socketId) {
    const u = users.get(socketId);
    if (u) emitUserEvent("friendMoved", u);
}

// Geofence enter/leave for one position change (exact-sharing riders only: an
// alert would otherwise leak position finer than the 1 km grid; never for a
// dead-reckoned estimate, whose error circle can straddle a fence).
function checkGeofences(user, oldLat, oldLng, now) {
    if (effectiveMode(user) !== "exact" || user.est || oldLat == null || oldLng == null) return;
    geofences.forEach((fence) => {
        const wasOutside = distanceKm(oldLat, oldLng, fence.lat, fence.lng) * 1000 > fence.radius;
        const isInside = distanceKm(user.lat, user.lng, fence.lat, fence.lng) * 1000 <= fence.radius;
        if (wasOutside && isInside) io.emit("geofenceAlert", { user: user.name, fence: fence.name, type: "enter", at: now });
        else if (!wasOutside && !isInside) io.emit("geofenceAlert", { user: user.name, fence: fence.name, type: "leave", at: now });
    });
}

// ==========================================================================
// 6. RATE LIMITING + CRASH-PROOF HANDLER WRAPPER
// ==========================================================================
// One uncaught exception in a Socket.IO callback would crash the Node process
// and drop every rider. NO handler may throw past safeHandler, sync OR async.
// Buckets are separate so chatty events (typing) cannot starve GPS updates.
const BUCKETS = { general: { max: 100, windowMs: 10_000 }, location: { max: 40, windowMs: 10_000 } };
const socketEventCounts = new Map(); // `${socketId}:${bucket}` -> {count, windowStart}
const heavyGate = new Map();         // `${socketId}:${key}` -> lastTs

function allowEvent(socketId, bucket) {
    const cfg = BUCKETS[bucket] || BUCKETS.general;
    const key = `${socketId}:${bucket}`;
    const now = Date.now();
    let rec = socketEventCounts.get(key);
    if (!rec || now - rec.windowStart > cfg.windowMs) {
        rec = { count: 0, windowStart: now };
        socketEventCounts.set(key, rec);
    }
    rec.count++;
    return rec.count <= cfg.max;
}

function throttle(socketId, key, minGapMs) {
    const k = `${socketId}:${key}`;
    const now = Date.now();
    if (now - (heavyGate.get(k) || 0) < minGapMs) return false;
    heavyGate.set(k, now);
    return true;
}

function forgetSocketCounters(socketId) {
    for (const b of Object.keys(BUCKETS)) socketEventCounts.delete(`${socketId}:${b}`);
    for (const k of heavyGate.keys()) if (k.startsWith(`${socketId}:`)) heavyGate.delete(k);
}

function safeHandler(socket, fn, bucket = "general") {
    return (...args) => {
        const maybeAck = args[args.length - 1];
        const ack = typeof maybeAck === "function" ? maybeAck : null;
        const fail = (reason) => { if (ack) { try { ack({ ok: false, reason }); } catch { /* ignore */ } } };
        try {
            if (!allowEvent(socket.id, bucket)) return fail("rate-limited");
            const out = fn(...args);
            if (out && typeof out.catch === "function") {
                out.catch((err) => {
                    console.error(`[socket:${socket.id}] async handler error:`, err);
                    fail("internal-error");
                });
            }
        } catch (err) {
            console.error(`[socket:${socket.id}] handler error:`, err);
            fail("internal-error");
        }
    };
}

// Per-IP concurrent connection cap (Socket.IO's own traffic never touches the
// Express limiter, so this is the realtime-side abuse control).
const ipConnections = new Map();
io.use((socket, next) => {
    const fwd = socket.handshake.headers["x-forwarded-for"];
    const ip = (typeof fwd === "string" && fwd.split(",")[0].trim()) || socket.handshake.address || "unknown";
    const n = ipConnections.get(ip) || 0;
    if (n >= MAX_SOCKETS_PER_IP) return next(new Error("too-many-connections"));
    ipConnections.set(ip, n + 1);
    socket.on("disconnect", () => {
        const left = (ipConnections.get(ip) || 1) - 1;
        if (left <= 0) ipConnections.delete(ip); else ipConnections.set(ip, left);
    });
    next();
});

// ==========================================================================
// 7. ROUTING ALGORITHMS (meetup + carpool)
// ==========================================================================
async function fetchVenues(lat, lng, radiusM) {
    const cacheKey = `${lat.toFixed(3)},${lng.toFixed(3)},${Math.round(radiusM / 500)}`;
    const hit = venueCache.get(cacheKey);
    if (hit && Date.now() - hit.ts < 10 * 60 * 1000) return hit.venues;
    try {
        const q = `[out:json][timeout:6];node(around:${Math.round(radiusM)},${lat},${lng})` +
            `[amenity~"^(cafe|restaurant|fast_food|fuel|marketplace)$"][name];out 14;`;
        const res = await fetch(OVERPASS_URL, {
            method: "POST",
            headers: { "Content-Type": "application/x-www-form-urlencoded" },
            body: "data=" + encodeURIComponent(q),
            signal: AbortSignal.timeout(7000)
        });
        if (!res.ok) return [];
        const json = await res.json();
        const venues = (json.elements || [])
            .filter((e) => isValidCoordPair(e.lat, e.lon) && e.tags?.name)
            .slice(0, 10)
            .map((e) => ({ lat: e.lat, lng: e.lon, label: clampStr(e.tags.name, 60), kind: "venue", category: e.tags.amenity }));
        if (venueCache.size > 100) venueCache.clear();
        venueCache.set(cacheKey, { ts: Date.now(), venues });
        return venues;
    } catch (e) {
        console.warn("Overpass venue lookup failed (falling back to geometric candidates):", e.message);
        return [];
    }
}

function buildMeetupCandidates(members, venues, extra) {
    const cLat = members.reduce((s, m) => s + m.lat, 0) / members.length;
    const cLng = members.reduce((s, m) => s + m.lng, 0) / members.length;
    let maxSpreadKm = 1;
    for (let i = 0; i < members.length; i++) {
        for (let j = i + 1; j < members.length; j++) {
            maxSpreadKm = Math.max(maxSpreadKm, distanceKm(members[i].lat, members[i].lng, members[j].lat, members[j].lng));
        }
    }
    const ringKm = Math.min(15, Math.max(0.5, maxSpreadKm / 2));
    const ring = [];
    for (let k = 0; k < 6; k++) {
        const b = (k / 6) * 2 * Math.PI;
        ring.push({
            lat: cLat + (ringKm / 111.32) * Math.cos(b),
            lng: cLng + (ringKm / (111.32 * Math.max(0.01, Math.cos((cLat * Math.PI) / 180)))) * Math.sin(b),
            label: `Midpoint ${k + 1}`, kind: "ring"
        });
    }
    const all = [{ lat: cLat, lng: cLng, label: "Centroid", kind: "centroid" }, ...ring, ...venues,
        ...extra.map((c) => ({ lat: c.lat, lng: c.lng, label: clampStr(c.label || "Custom point", 60), kind: "custom" }))];
    return { candidates: all, centroid: { lat: cLat, lng: cLng }, maxSpreadKm };
}

async function fetchOsrmTable(members, candidates) {
    const coords = [...members, ...candidates].map((p) => `${p.lng.toFixed(6)},${p.lat.toFixed(6)}`).join(";");
    const sources = members.map((_, i) => i).join(";");
    const destinations = candidates.map((_, i) => members.length + i).join(";");
    const url = `${OSRM_BASE}/table/v1/driving/${coords}?sources=${sources}&destinations=${destinations}&annotations=duration,distance`;
    try {
        const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
        if (!res.ok) return null;
        const json = await res.json();
        if (json.code !== "Ok") return null;
        return json;
    } catch (e) {
        console.error("OSRM table fetch failed:", e.message);
        return null;
    }
}

// Greedy nearest-neighbour + 2-opt, start and destination fixed. Used when
// OSRM /trip is unreachable so carpooling still works (flagged approximate).
function orderPickupsFallback(start, stops, dest) {
    const remaining = stops.map((s, i) => ({ ...s, _i: i }));
    const route = [];
    let cur = start;
    while (remaining.length) {
        let bi = 0, bd = Infinity;
        remaining.forEach((p, i) => {
            const d = distanceKm(cur.lat, cur.lng, p.lat, p.lng);
            if (d < bd) { bd = d; bi = i; }
        });
        cur = remaining.splice(bi, 1)[0];
        route.push(cur);
    }
    const pathLen = (seq) => {
        let t = distanceKm(start.lat, start.lng, seq[0].lat, seq[0].lng);
        for (let i = 0; i < seq.length - 1; i++) t += distanceKm(seq[i].lat, seq[i].lng, seq[i + 1].lat, seq[i + 1].lng);
        return t + distanceKm(seq[seq.length - 1].lat, seq[seq.length - 1].lng, dest.lat, dest.lng);
    };
    let improved = true, guard = 0;
    while (improved && guard++ < 50) {
        improved = false;
        for (let i = 0; i < route.length - 1; i++) {
            for (let j = i + 1; j < route.length; j++) {
                const cand = route.slice(0, i).concat(route.slice(i, j + 1).reverse(), route.slice(j + 1));
                if (pathLen(cand) + 1e-9 < pathLen(route)) {
                    route.splice(0, route.length, ...cand);
                    improved = true;
                }
            }
        }
    }
    // Leg lengths (metres) with a 1.3 road-detour factor over great-circle.
    const seq = [start, ...route, dest];
    const legMeters = [];
    for (let i = 0; i < seq.length - 1; i++) {
        legMeters.push(distanceKm(seq[i].lat, seq[i].lng, seq[i + 1].lat, seq[i + 1].lng) * 1300);
    }
    return { ordered: route, legMeters };
}

// Fair, distance-proportional fuel split. Leg k runs stop k -> stop k+1; every
// rider picked up at or before stop k is aboard, so each leg's fuel is split
// equally among the driver and the riders actually aboard for it.
// ---- Fuel-aware meetup (roadmap Section 11, third strategy) -------------------
// Same U-shaped model the app's SmartDrive uses for a live ride (Section 9),
// applied to each rider's OSRM leg: rated km/L, degraded below 40 km/h
// (stop-start) and above 60 km/h (drag), judged by the leg's average speed.
// Walkers burn nothing. A rider who never set a mileage is costed at the
// app's default and NAMED in the result, so the estimate says what it assumed.
const DEFAULT_KM_PER_L = 18;               // SmartDrive's default mileage
function legFuelL(distanceM, durationSec, kmPerL) {
    if (!isFiniteNum(distanceM) || distanceM <= 0) return 0;
    const km = distanceM / 1000;
    const vKmh = isFiniteNum(durationSec) && durationSec > 0 ? km / (durationSec / 3600) : 40;
    let eff = kmPerL;
    if (vKmh > 60) eff -= (vKmh - 60) * 0.005 * kmPerL;
    else if (vKmh < 40) eff -= (40 - vKmh) * 0.004 * kmPerL;
    eff = Math.max(Math.min(5, kmPerL), eff);
    return km / eff;
}
function riderFuelProfile(u) {
    if (u.sessionMode === "walk") return { kmPerL: null, motorised: false, assumed: false };
    const set = isFiniteNum(u.kmPerL) && u.kmPerL >= 1 && u.kmPerL <= 100;
    return { kmPerL: set ? u.kmPerL : DEFAULT_KM_PER_L, motorised: true, assumed: !set };
}

function splitCarpoolCosts(ordered, legMeters, kmPerL, pricePerL) {
    const driver = { distanceKm: 0, fuelL: 0, cost: 0 };
    const riders = ordered.map((s) => ({ id: s.id || null, name: s.name || "", distanceKm: 0, fuelL: 0, cost: 0 }));
    legMeters.forEach((meters, k) => {
        const km = meters / 1000;
        const fuel = km / kmPerL;
        const aboard = Math.min(k, ordered.length);     // riders picked at positions 1..k
        const share = 1 / (aboard + 1);
        driver.distanceKm += km; driver.fuelL += fuel * share;
        for (let r = 0; r < aboard; r++) { riders[r].distanceKm += km; riders[r].fuelL += fuel * share; }
    });
    const round = (o) => {
        o.distanceKm = +o.distanceKm.toFixed(2);
        o.fuelL = +o.fuelL.toFixed(3);
        o.cost = +(o.fuelL * pricePerL).toFixed(2);
        return o;
    };
    return { driver: round(driver), riders: riders.map(round) };
}

// ==========================================================================
// 8. TRIP / IDENTITY LIFECYCLE HELPERS
// ==========================================================================
function removeFromTrip(socketId) {
    if (!currentTrip) return;
    if (currentTrip.hostId === socketId) {
        currentTrip = null;
        io.emit("tripData", null);
    } else if (currentTrip.members.some((m) => m.id === socketId)) {
        currentTrip.members = currentTrip.members.filter((m) => m.id !== socketId);
        io.emit("tripData", currentTrip);
    }
}

// Mobile sockets get a NEW id on every reconnect. Carry trip role / roster
// state over to it so a network blip does not end the squad's trip.
function migrateIdentity(oldId, newId) {
    if (currentTrip) {
        if (currentTrip.hostId === oldId) currentTrip.hostId = newId;
        currentTrip.members.forEach((m) => { if (m.id === oldId) m.id = newId; });
    }
    if (voiceSquadMembers.delete(oldId)) io.emit("voice-squad-member-left", { id: oldId });
    users.delete(oldId);
    forgetSocketCounters(oldId);
    io.emit("friendDisconnected", oldId);
}

function finalizeDeparture(socketId) {
    const user = users.get(socketId);
    if (!user || user.online) return; // came back in the meantime
    // Phase 4: a rider out of data but still being relayed over radio is
    // still IN the convoy — keep their trip seat instead of dropping them.
    // A radio-equipped rider also gets a longer grace for the first relay.
    const now = Date.now();
    const relayedRecently = Boolean(user.relayedAt && now - user.relayedAt < RELAY_HOLD_MS);
    const radioGrace = Boolean(user.relayCapable && user.offlineSince && now - user.offlineSince < RELAY_RADIO_GRACE_MS);
    if ((relayedRecently || radioGrace) && isInActiveTrip(socketId)) {
        const timer = setTimeout(() => finalizeDeparture(socketId), Math.min(30_000, RELAY_HOLD_MS));
        timer.unref?.();
        if (user.deviceId) pendingDeparture.set(user.deviceId, timer);
        return;
    }
    if (user.deviceId) {
        pendingDeparture.delete(user.deviceId);
        if (deviceToSocket.get(user.deviceId) === socketId) deviceToSocket.delete(user.deviceId);
    }
    removeFromTrip(socketId);
    if (voiceSquadMembers.delete(socketId)) io.emit("voice-squad-member-left", { id: socketId });
    io.emit("friendDisconnected", socketId);
    users.delete(socketId);
    forgetSocketCounters(socketId);   // relay throttles can re-create keys after disconnect
}

// ---- Phase 4: radio relay frames ---------------------------------------------
// rid (hex) -> live user record for every verified member of the active trip.
function relayRosterMap() {
    const out = new Map();
    if (!currentTrip) return out;
    for (const m of currentTrip.members) {
        const u = users.get(m.id);
        if (u && u.deviceId) out.set(relayRidFor(currentTrip.id, u.deviceId).toString("hex"), u);
    }
    return out;
}

// Frame layout (big-endian) — features.js ConvoyRelay writes exactly this:
//   [0]       version << 4 | type        1 = position ping, 2 = SOS, 4 = radio ack (never uploaded)
//   [1..4]    trip tag
//   [5..16]   AES-GCM nonce = rid(4) | unix seconds(4) | seq(2) | random(2)
//   [17..]    AES-128-GCM(groupKey, AAD = bytes 0..16) of
//               body(16) | HMAC-SHA256(deviceKey, bytes 0..16 | body)[0..8]
//             followed by the 16-byte GCM tag.
//   Position body: lat i32 (1e-7 deg) | lng i32 | speed u8 km/h (255 = n/a) |
//     course u8 (x 360/256, valid if FLAG_COURSE) | accuracy u16 m | flags u8 |
//     battery u8 % (255 = n/a) | alt i16 m (-32768 = n/a)
// GCM proves "a trip member wrote this"; the device HMAC proves WHICH member,
// so the rider who uploads can carry a friend's position but cannot forge it.
function parseRelayPosition(b) {
    const speed = b.readUInt8(8), courseRaw = b.readUInt8(9), flags = b.readUInt8(12);
    const batt = b.readUInt8(13), alt = b.readInt16BE(14);
    return {
        lat: b.readInt32BE(0) / 1e7, lng: b.readInt32BE(4) / 1e7,
        speedKmh: speed === 255 ? null : speed,
        course: flags & RELAY_FRAME.FLAG_COURSE ? Math.round((courseRaw * 360) / 256) % 360 : null,
        accuracy: b.readUInt16BE(10), flags,
        est: Boolean(flags & RELAY_FRAME.FLAG_EST),
        originOffline: Boolean(flags & RELAY_FRAME.FLAG_ORIGIN_OFFLINE),
        battery: batt === 255 ? null : Math.min(100, batt),
        alt: alt === -32768 ? null : alt
    };
}

function openRelayFrame(b64, tripId, roster) {
    if (typeof b64 !== "string" || b64.length < 60 || b64.length > 200 || !/^[A-Za-z0-9+/]+={0,2}$/.test(b64)) return { status: "bad-frame" };
    const buf = Buffer.from(b64, "base64");
    if (buf.length < RELAY_FRAME.HEADER + RELAY_FRAME.MAC + RELAY_FRAME.GCM_TAG + 1 || buf.length > RELAY_FRAME.MAX_BYTES) return { status: "bad-frame" };
    const version = buf[0] >> 4, type = buf[0] & 0x0f;
    if (version !== RELAY_FRAME.VERSION) return { status: "bad-version" };
    if (!buf.subarray(1, 5).equals(relayTripTag(tripId))) return { status: "wrong-trip" };
    const header = buf.subarray(0, RELAY_FRAME.HEADER);
    const nonce = buf.subarray(5, RELAY_FRAME.HEADER);
    const base = { type, rid: nonce.subarray(0, 4).toString("hex"), ts: nonce.readUInt32BE(4), seq: nonce.readUInt16BE(8), nonceHex: nonce.toString("hex") };
    if (type === RELAY_FRAME.ACK) return { ...base, status: "not-uploadable" };
    if (type !== RELAY_FRAME.PING && type !== RELAY_FRAME.SOS) return { ...base, status: "bad-type" };
    const origin = roster.get(base.rid);
    if (!origin) return { ...base, status: "unknown-rider" };

    let plain;
    try {
        const d = crypto.createDecipheriv("aes-128-gcm", relayGroupKey(tripId), nonce, { authTagLength: RELAY_FRAME.GCM_TAG });
        d.setAAD(header);
        d.setAuthTag(buf.subarray(buf.length - RELAY_FRAME.GCM_TAG));
        plain = Buffer.concat([d.update(buf.subarray(RELAY_FRAME.HEADER, buf.length - RELAY_FRAME.GCM_TAG)), d.final()]);
    } catch {
        return { ...base, status: "bad-group-auth" };
    }
    if (plain.length !== RELAY_FRAME.POS_BODY + RELAY_FRAME.MAC) return { ...base, status: "bad-body" };
    const body = plain.subarray(0, RELAY_FRAME.POS_BODY);
    const want = crypto.createHmac("sha256", relayDeviceKey(tripId, origin.deviceId)).update(header).update(body).digest().subarray(0, RELAY_FRAME.MAC);
    if (!crypto.timingSafeEqual(plain.subarray(RELAY_FRAME.POS_BODY), want)) return { ...base, status: "bad-device-mac" };
    return { ...base, status: "ok", origin, pos: parseRelayPosition(body) };
}

// One verified frame -> the origin rider's record + broadcasts. Returns a
// per-frame status string for the uploader's ack.
function applyRelayFrame(frame, uploader, now) {
    const u = frame.origin;
    if (u.id === uploader.id) return "own-frame";
    const tsMs = frame.ts * 1000;
    if (tsMs > now + RELAY_MAX_FUTURE_MS) return "bad-time";
    if (now - tsMs > RELAY_MAX_AGE_MS) return "stale";
    u.relaySeen = u.relaySeen || [];
    if (u.relaySeen.includes(frame.nonceHex)) return "duplicate";
    u.relaySeen.push(frame.nonceHex);
    if (u.relaySeen.length > 128) u.relaySeen.shift();
    const p = frame.pos;
    if (!isValidCoordPair(p.lat, p.lng)) return "bad-coords";

    let sosStatus = null;
    if (frame.type === RELAY_FRAME.SOS) {
        // A rider may press SOS with data, then lose it and have the radio
        // retry: one broadcast per origin per minute covers both paths.
        if (u.lastSosAt && now - u.lastSosAt < 60_000) sosStatus = "sos-duplicate";
        else {
            u.lastSosAt = now;
            sosStatus = "sos-broadcast";
            io.emit("sos-alert", {
                id: u.id, name: u.name, lat: p.lat, lng: p.lng, alt: p.alt, ownerKey: ownerKeyFor(u.deviceId),
                via: "radio", relayedBy: uploader.name, at: tsMs
            });
        }
    }

    // Position part (SOS frames carry one too).
    let posStatus;
    if (u.sharingMode === "off") posStatus = "sharing-off";
    else if (u.online && !u.via && u.lastFix && now - u.lastFix.ts < RELAY_DIRECT_FRESH_MS) posStatus = "live-direct";
    else if (u.posTs && tsMs <= u.posTs) posStatus = "older";
    else {
        let plausible = true;
        if (u.posTs && isValidCoordPair(u.lat, u.lng)) {
            const dtH = Math.max(5, (tsMs - u.posTs) / 1000) / 3600;
            const dKm = distanceKm(u.lat, u.lng, p.lat, p.lng);
            plausible = !(dKm > 0.2 && dKm / dtH > MAX_PLAUSIBLE_KMH);
        }
        if (!plausible) posStatus = "implausible";
        else {
            const oldLat = u.lat, oldLng = u.lng;
            u.lat = p.lat; u.lng = p.lng; u.alt = p.alt;
            u.speedKmh = p.speedKmh ?? 0;
            u.accuracy = p.accuracy;
            u.est = p.est;
            u.via = "radio"; u.relayedBy = uploader.name; u.relayedAt = now; u.fixAt = tsMs; u.posTs = tsMs;
            u.lastFix = { lat: p.lat, lng: p.lng, ts: now };
            emitUserEvent("friendMoved", u);
            checkGeofences(u, oldLat, oldLng, now);
            posStatus = "applied";
        }
    }
    return sosStatus || posStatus;
}

// ==========================================================================
// 9. SOCKET.IO EVENT HANDLERS
// ==========================================================================
io.on("connection", (socket) => {
    console.log(`🟢 New Connection: ${socket.id}`);

    // --- A. PROFILE & DEVICE IDENTITY ---------------------------------------
    socket.on("profileReady", safeHandler(socket, (data) => {
        if (!data || !isNonEmptyStr(data.name, 40)) return;

        const deviceId = typeof data.deviceId === "string" && UUID_RE.test(data.deviceId) ? data.deviceId.toLowerCase() : null;
        const name = clampStr(data.name, 40).trim();
        const avatar = sanitizeAvatar(data.avatar);

        // Device-token check. First sight of a deviceId: server mints a secret
        // token, returns it once, stores only its hash. After that the token
        // must be presented. A copied deviceId alone can no longer impersonate.
        // (A repeat profileReady on the same, already-verified socket is
        // accepted — the client legitimately sends it more than once at boot.)
        const existing = users.get(socket.id);
        const alreadyVerified = Boolean(existing && existing.deviceId === deviceId && existing.verified);
        let issuedToken = null;
        let newHash = null;
        if (deviceId && !alreadyVerified) {
            const row = stmt.getUser.get(deviceId);
            if (row && row.token_hash) {
                if (!isNonEmptyStr(data.deviceToken, 128) || !tokenMatches(data.deviceToken, row.token_hash)) {
                    socket.emit("profileRejected", { reason: "device-token-mismatch" });
                    return;
                }
            } else {
                issuedToken = crypto.randomBytes(24).toString("base64url");
                newHash = hashToken(issuedToken);
            }
        }

        // Same device already connected elsewhere (stale socket after a network
        // change, or a second tab): the newest socket wins and inherits state.
        if (deviceId) {
            const pending = pendingDeparture.get(deviceId);
            if (pending) { clearTimeout(pending); pendingDeparture.delete(deviceId); }
            const stale = Array.from(users.values()).find((u) => u.deviceId === deviceId && u.id !== socket.id);
            if (stale) {
                migrateIdentity(stale.id, socket.id);
                const staleSock = io.sockets.sockets.get(stale.id);
                if (staleSock) staleSock.disconnect(true);
            }
            deviceToSocket.set(deviceId, socket.id);
        }

        const user = {
            id: socket.id, deviceId, verified: Boolean(deviceId), name, avatar, online: true,
            sharingMode: existing?.sharingMode || "exact", sessionMode: existing?.sessionMode || null,
            sessionId: existing?.sessionId || null, lat: null, lng: null, lastFix: null, spoofStrikes: 0
        };
        users.set(socket.id, user);

        if (deviceId) stmt.upsertUser.run(deviceId, name, avatar, newHash, Date.now(), Date.now());

        socket.emit("profileAccepted", {
            ownerKey: ownerKeyFor(deviceId),
            deviceToken: issuedToken,                // null unless first registration
            sharingMode: user.sharingMode,
            tripRetentionDays: TRIP_RETENTION_DAYS
        });
        socket.emit("chatHistory", chatMessages);
        socket.emit("loadMemoryPhotos", memories.map(publicMemory));
        socket.emit("loadGeofences", geofences.map(publicFence));
        socket.emit("onlineUsers", Array.from(users.values()).map((u) => publicUserFor(u, socket.id)));
        if (currentTrip) socket.emit("tripData", currentTrip);
        emitUserEvent("userOnline", user, socket.id);
    }));

    // --- B. LIVE LOCATION + ANTI-SPOOF + GEOFENCE CHECK ---------------------
    socket.on("updateLocation", safeHandler(socket, (data) => {
        const user = users.get(socket.id);
        if (!user || !data || !isValidCoordPair(data.lat, data.lng)) return;
        if (user.sharingMode === "off") return;

        // Teleport rejection: > 300 km/h between fixes is physically implausible
        // for this app. The baseline is server time (client clocks are
        // untrusted). After 3 consecutive rejections the new position is
        // accepted as the baseline so a legitimate relocation cannot lock a
        // rider out forever.
        const now = Date.now();
        if (user.lastFix) {
            const dtH = (now - user.lastFix.ts) / 3_600_000;
            const dKm = distanceKm(user.lastFix.lat, user.lastFix.lng, data.lat, data.lng);
            if (dKm > 0.2 && dtH > 0 && dKm / dtH > MAX_PLAUSIBLE_KMH && user.spoofStrikes < 3) {
                user.spoofStrikes++;
                socket.emit("locationRejected", { reason: "implausible-jump", strikes: user.spoofStrikes });
                return;
            }
        }
        user.spoofStrikes = 0;

        const oldLat = user.lat, oldLng = user.lng;
        const oldMode = effectiveMode(user);
        user.lat = data.lat;
        user.lng = data.lng;
        user.lastFix = { lat: data.lat, lng: data.lng, ts: now };
        user.alt = isFiniteNum(data.alt) ? data.alt : null;
        user.speedKmh = isFiniteNum(data.speedKmh) ? clampNum(data.speedKmh, 0, 300, 0) : 0;
        user.accuracy = isFiniteNum(data.accuracy) ? clampNum(data.accuracy, 0, 100000, null) : null;
        if (isNonEmptyStr(data.weather, 40)) user.weather = data.weather;
        // Phase 4: dead-reckoned position (the rider has data but no GPS —
        // e.g. an urban tunnel). A direct update always ends any radio relay.
        user.est = data.est === true;
        user.via = null; user.relayedBy = null; user.fixAt = null;
        user.posTs = now;

        const mode = effectiveMode(user);
        const pub = publicUser(user);
        // Approximate riders move between 1 km cells rarely; do not spam the
        // squad with identical snapped coordinates every second.
        if (mode === "approx") {
            const sameCell = user.lastBroadcast && user.lastBroadcast.lat === pub.lat && user.lastBroadcast.lng === pub.lng;
            if (sameCell && oldMode === "approx" && now - user.lastBroadcast.ts < 30_000) return;
            user.lastBroadcast = { lat: pub.lat, lng: pub.lng, ts: now };
        }
        emitUserEvent("friendMoved", user, socket.id);

        // Geofence events: exact-sharing riders only, never for estimates.
        checkGeofences(user, oldLat, oldLng, now);
    }, "location"));

    // --- C. CHAT --------------------------------------------------------------
    socket.on("chatMessage", safeHandler(socket, (data) => {
        const user = users.get(socket.id);
        if (!user || !data || !ALLOWED_MSG_TYPES.includes(data.type)) return;
        if (data.type === "text" && !isNonEmptyStr(data.data, 1000)) return;
        if (data.type !== "text" && (typeof data.data !== "string" || data.data.length === 0 || data.data.length > 7_000_000)) return;

        const msg = {
            id: generateId(), senderId: socket.id, name: clampStr(data.name || user.name, 40),
            type: data.type, data: data.data, replyTo: sanitizeReplyTo(data.replyTo),
            time: new Date().toISOString(),
            reactions: Object.fromEntries(REACTION_EMOJIS.map((e) => [e, []]))
        };
        chatMessages.push(msg);
        if (chatMessages.length > 200) chatMessages.shift();
        io.emit("chatMessage", msg);
    }));

    socket.on("typing", safeHandler(socket, (isTyping) => {
        const user = users.get(socket.id);
        if (user) socket.broadcast.emit("typing", { id: socket.id, name: user.name, isTyping: Boolean(isTyping) });
    }));

    socket.on("messageReaction", safeHandler(socket, (data) => {
        // THE CRASH FIX: emoji is validated against an allow-list and the
        // reaction array's existence is checked BEFORE any property access.
        if (!users.has(socket.id) || !data || !isNonEmptyStr(data.messageId, 60) || !REACTION_EMOJIS.includes(data.emoji)) return;
        const msg = chatMessages.find((m) => m.id === data.messageId);
        if (!msg || !msg.reactions || !Array.isArray(msg.reactions[data.emoji])) return;

        const list = msg.reactions[data.emoji];
        const idx = list.indexOf(socket.id);
        if (idx > -1) {
            list.splice(idx, 1);
        } else {
            for (const e of Object.keys(msg.reactions)) {
                const i = msg.reactions[e].indexOf(socket.id);
                if (i > -1) msg.reactions[e].splice(i, 1);
            }
            list.push(socket.id);
        }
        io.emit("messageReaction", { messageId: msg.id, reactions: msg.reactions });
    }));

    // --- D. GEOFENCING ----------------------------------------------------------
    socket.on("addGeofence", safeHandler(socket, (data) => {
        const user = users.get(socket.id);
        if (!user || !data || !isNonEmptyStr(data.name, 60) || !isValidCoordPair(data.lat, data.lng) || !isValidRadius(data.radius)) return;
        if (geofences.length >= MAX_GEOFENCES_TOTAL) return;
        const mine = geofences.filter((f) => (user.deviceId ? f.ownerDeviceId === user.deviceId : f.ownerId === socket.id)).length;
        if (mine >= MAX_GEOFENCES_PER_OWNER) return;

        const fence = {
            id: generateId(), name: clampStr(data.name, 60).trim(), lat: data.lat, lng: data.lng,
            radius: Math.round(data.radius), ownerId: socket.id, ownerName: user.name, ownerDeviceId: user.deviceId || null
        };
        geofences.push(fence);
        stmt.insertGeofence.run(fence.id, fence.name, fence.lat, fence.lng, fence.radius, fence.ownerDeviceId);
        io.emit("loadGeofences", geofences.map(publicFence));
    }));

    socket.on("removeGeofence", safeHandler(socket, (id) => {
        const user = users.get(socket.id);
        if (!user || !isNonEmptyStr(id, 60)) return;
        const fence = geofences.find((f) => f.id === id);
        if (!fence) return;
        // Ownership follows the DEVICE, so it survives reconnects and restarts.
        const owns = fence.ownerDeviceId ? fence.ownerDeviceId === user.deviceId : fence.ownerId === socket.id;
        if (!owns) return;
        geofences = geofences.filter((f) => f.id !== id);
        stmt.deleteGeofence.run(id);
        io.emit("loadGeofences", geofences.map(publicFence));
    }));

    // --- E. GROUP TRIP ----------------------------------------------------------
    socket.on("startTrip", safeHandler(socket, (data) => {
        const user = users.get(socket.id);
        if (!user || !data || !isNonEmptyStr(data.name, 80) || !isValidCoordPair(data.lat, data.lng)) return;
        if (currentTrip && currentTrip.hostId !== socket.id) {
            socket.emit("tripError", { reason: "trip-already-active" }); // no silent hijack of someone else's trip
            return;
        }
        currentTrip = {
            id: generateId(), name: clampStr(data.name, 80).trim(), lat: data.lat, lng: data.lng,
            hostId: socket.id, members: [{ id: socket.id, name: user.name }]
        };
        io.emit("tripData", currentTrip);
        broadcastUserState(socket.id);
    }));

    socket.on("joinTrip", safeHandler(socket, () => {
        const user = users.get(socket.id);
        if (currentTrip && user && !currentTrip.members.some((m) => m.id === socket.id)) {
            currentTrip.members.push({ id: socket.id, name: user.name });
            io.emit("tripData", currentTrip);
            broadcastUserState(socket.id); // precision may rise from approx to exact
        }
    }));

    socket.on("leaveTrip", safeHandler(socket, () => {
        removeFromTrip(socket.id);
        broadcastUserState(socket.id);     // precision may drop back to approx
    }));

    // --- F. MEMORIES ------------------------------------------------------------
    socket.on("uploadMemoryPhoto", safeHandler(socket, (data) => {
        const user = users.get(socket.id);
        if (!user || !data || !isValidCoordPair(data.lat, data.lng)) return;
        if (typeof data.image !== "string" || data.image.length > MAX_MEMORY_IMAGE_B64_LEN || !IMAGE_DATA_URL_RE.test(data.image.slice(0, 40))) return;

        const time = data.time && !isNaN(Date.parse(data.time)) ? new Date(data.time).toISOString() : new Date().toISOString();
        const memory = {
            id: generateId(), name: clampStr(data.name || user.name, 40), lat: data.lat, lng: data.lng,
            image: data.image, caption: clampStr(data.caption, 140), time,
            deviceId: user.deviceId || null, tripId: currentTrip?.id || null
        };
        memories.push(memory);
        if (memories.length > MAX_MEMORIES_IN_RAM) memories.shift();
        stmt.insertMemory.run(memory.id, memory.deviceId, memory.name, memory.lat, memory.lng, memory.image, memory.caption, memory.tripId, Date.parse(time));
        io.emit("newMemoryPin", publicMemory(memory));
    }));

    // --- G. EMERGENCY SOS (deliberately exact — it is an emergency) -------------
    socket.on("sos-alert", safeHandler(socket, (data) => {
        const user = users.get(socket.id);
        if (!user || !data || !isValidCoordPair(data.lat, data.lng)) return;
        if (!throttle(socket.id, "sos", 5000)) return;
        user.lastSosAt = Date.now();          // Phase 4: a radio copy of this SOS won't re-alert
        socket.broadcast.emit("sos-alert", {
            id: socket.id, name: clampStr(data.name || user.name, 40), lat: data.lat, lng: data.lng,
            alt: isFiniteNum(data.alt) ? data.alt : null,
            ownerKey: ownerKeyFor(user.deviceId), at: user.lastSosAt   // Phase 4: lets clients de-dupe radio + server copies
        });
    }));

    // --- H. WEBRTC 1:1 SIGNALLING (payloads validated; sender attached) ----------
    socket.on("call-user", safeHandler(socket, (data) => {
        if (!users.has(socket.id) || !data || !isNonEmptyStr(data.to, 40) || !users.has(data.to) || !isSignalPayload(data.signal)) return;
        io.to(data.to).emit("incoming-call", { from: socket.id, name: clampStr(data.name || "", 40), signal: data.signal });
    }));
    socket.on("answer-call", safeHandler(socket, (data) => {
        if (!users.has(socket.id) || !data || !isNonEmptyStr(data.to, 40) || !users.has(data.to) || !isSignalPayload(data.signal)) return;
        // Extra 2nd arg carries the answerer's id; the old client ignores it.
        io.to(data.to).emit("call-accepted", data.signal, socket.id);
    }));
    socket.on("end-call", safeHandler(socket, (data) => {
        if (!data || !isNonEmptyStr(data.to, 40)) return;
        io.to(data.to).emit("call-ended", socket.id);
    }));

    // --- I. GROUP VOICE — roster + per-peer signalling relay ---------------------
    // The mesh is client-orchestrated (features.js): each newcomer opens one
    // RTCPeerConnection per existing member and signals over `voice-signal`,
    // which (unlike call-accepted) always carries `from`, so many simultaneous
    // legs cannot be confused. Only members of the roster may signal each other.
    socket.on("join-voice-squad", safeHandler(socket, () => {
        const user = users.get(socket.id);
        if (!user) return;
        const existingRoster = Array.from(voiceSquadMembers.values());
        voiceSquadMembers.set(socket.id, { id: socket.id, name: user.name, avatar: user.avatar });
        socket.emit("voice-squad-roster", { members: existingRoster });
        socket.broadcast.emit("voice-squad-member-joined", { id: socket.id, name: user.name, avatar: user.avatar });
    }));

    socket.on("voice-signal", safeHandler(socket, (data) => {
        if (!data || !isNonEmptyStr(data.to, 40) || !isSignalPayload(data.signal)) return;
        if (!voiceSquadMembers.has(socket.id) || !voiceSquadMembers.has(data.to)) return;
        io.to(data.to).emit("voice-signal", { from: socket.id, signal: data.signal });
    }));

    socket.on("leave-voice-squad", safeHandler(socket, () => {
        if (voiceSquadMembers.delete(socket.id)) io.emit("voice-squad-member-left", { id: socket.id });
    }));

    // --- J. SESSION + SHARING CONTROL (privacy) ----------------------------------
    socket.on("startSession", safeHandler(socket, (data, ack) => {
        const user = users.get(socket.id);
        if (!user) return typeof ack === "function" && ack({ ok: false, reason: "no-profile" });
        user.sessionMode = normalizeMode(data?.mode);
        user.sessionId = generateId();
        user.sessionStartedAt = Date.now();
        const payload = { mode: user.sessionMode, sessionId: user.sessionId, startedAt: user.sessionStartedAt };
        socket.emit("sessionStarted", payload);
        if (typeof ack === "function") ack({ ok: true, ...payload });
    }));

    socket.on("endSession", safeHandler(socket, (_data, ack) => {
        const user = users.get(socket.id);
        if (!user) return typeof ack === "function" && ack({ ok: false, reason: "no-profile" });
        const summary = { sessionId: user.sessionId, durationSec: user.sessionStartedAt ? Math.round((Date.now() - user.sessionStartedAt) / 1000) : 0 };
        user.sessionMode = null; user.sessionId = null; user.sessionStartedAt = null;
        socket.emit("sessionEnded", summary);
        if (typeof ack === "function") ack({ ok: true, ...summary });
    }));

    // setSharing: {mode: "exact"|"approx"|"off"}  (legacy {enabled:boolean} still works)
    socket.on("setSharing", safeHandler(socket, (data) => {
        const user = users.get(socket.id);
        if (!user) return;
        const mode = SHARING_MODES.includes(data?.mode) ? data.mode : (data?.enabled === false ? "off" : "exact");
        user.sharingMode = mode;
        user.lastBroadcast = null;
        if (mode === "off") {
            user.lat = null; user.lng = null; user.lastFix = null; // do not retain a stale precise fix
            socket.broadcast.emit("userOffline", { id: socket.id });
        } else {
            emitUserEvent("userOnline", user, socket.id);
        }
        socket.emit("sharingChanged", { mode });
    }));

    // The rider's own stated mileage (km/L) — the app's fuel-efficiency setting.
    // Kept on the live user only (re-sent after every profileAccepted), used by
    // the fuel-aware meetup strategy. Never broadcast.
    socket.on("setMileage", safeHandler(socket, (data) => {
        const user = users.get(socket.id);
        if (!user || !data) return;
        if (data.kmPerL === null) { user.kmPerL = null; return; }
        if (!isFiniteNum(data.kmPerL) || data.kmPerL < 1 || data.kmPerL > 100) return;
        user.kmPerL = Math.round(data.kmPerL * 10) / 10;
    }));

    // --- K. MEETUP OPTIMISATION ---------------------------------------------------
    // socket.emit('computeMeetup', {memberIds:["me", ...], strategy:"sum"|"minimax"|"fuel", extraCandidates?}, ack)
    // Candidates: centroid + ring + REAL nearby venues (Overpass) + custom points.
    // All three strategies are ranked from ONE OSRM matrix so the UI can flip
    // between "Fastest overall", "Fair to all" and "Least fuel" without another
    // network round-trip.
    socket.on("computeMeetup", safeHandler(socket, async (data, ack) => {
        if (typeof ack !== "function") return;
        const requester = users.get(socket.id);
        if (!requester) return ack({ ok: false, reason: "no-profile" });
        if (!throttle(socket.id, "meetup", 3000)) return ack({ ok: false, reason: "too-frequent" });

        const strategy = MEETUP_STRATEGIES.includes(data?.strategy) ? data.strategy : "sum";
        const ids = Array.isArray(data?.memberIds) ? data.memberIds.filter((i) => typeof i === "string").slice(0, 8) : [];
        const seen = new Set();
        const members = ids
            .map((id) => (id === "me" ? requester : users.get(id)))
            .filter((u) => u && !seen.has(u.id) && seen.add(u.id) && isValidCoordPair(u.lat, u.lng) && effectiveMode(u) === "exact");
        if (members.length < 2) return ack({ ok: false, reason: "need-at-least-2-located-members" });

        const extra = Array.isArray(data?.extraCandidates)
            ? data.extraCandidates.filter((c) => isValidCoordPair(c?.lat, c?.lng)).slice(0, 4) : [];

        const centroidLat = members.reduce((s, m) => s + m.lat, 0) / members.length;
        const centroidLng = members.reduce((s, m) => s + m.lng, 0) / members.length;
        let spreadKm = 1;
        for (let i = 0; i < members.length; i++) for (let j = i + 1; j < members.length; j++) {
            spreadKm = Math.max(spreadKm, distanceKm(members[i].lat, members[i].lng, members[j].lat, members[j].lng));
        }
        const venues = await fetchVenues(centroidLat, centroidLng, Math.min(6000, Math.max(800, spreadKm * 500)));
        const { candidates } = buildMeetupCandidates(members, venues, extra);

        const table = await fetchOsrmTable(members, candidates);
        if (!table) return ack({ ok: false, reason: "routing-service-unavailable" });
        const fuelProfiles = members.map(riderFuelProfile);

        const scored = [];
        candidates.forEach((cand, ci) => {
            const snapDist = table.destinations?.[ci]?.distance;
            // Drop centroid/ring points that snap >800 m to a road (lake, forest, ...).
            if (cand.kind !== "venue" && cand.kind !== "custom" && isFiniteNum(snapDist) && snapDist > 800) return;
            const perMember = members.map((m, mi) => {
                const durationSec = table.durations?.[mi]?.[ci] ?? null;
                const distanceM = table.distances?.[mi]?.[ci] ?? null;
                const fp = fuelProfiles[mi];
                // No distance from OSRM (shouldn't happen with annotations=distance):
                // fuel unknown for this rider, so this candidate can't be fuel-ranked.
                const fuelL = !fp.motorised ? 0 : (isFiniteNum(distanceM) ? legFuelL(distanceM, durationSec, fp.kmPerL) : null);
                return { id: m.id, name: m.name, durationSec, distanceM, fuelL: fuelL === null ? null : Math.round(fuelL * 1000) / 1000 };
            });
            if (perMember.some((p) => p.durationSec == null)) return;
            const fuelKnown = perMember.every((p) => p.fuelL !== null);
            const loc = table.destinations?.[ci]?.location;
            scored.push({
                lat: cand.lat, lng: cand.lng, label: cand.label, kind: cand.kind, category: cand.category || null,
                snapped: Array.isArray(loc) ? { lat: loc[1], lng: loc[0] } : null,
                perMember,
                fuelL: fuelKnown ? Math.round(perMember.reduce((a, p) => a + p.fuelL, 0) * 1000) / 1000 : null,
                sumSec: perMember.reduce((a, p) => a + p.durationSec, 0),
                maxSec: Math.max(...perMember.map((p) => p.durationSec)),
                minSec: Math.min(...perMember.map((p) => p.durationSec))
            });
        });
        if (scored.length === 0) return ack({ ok: false, reason: "no-reachable-candidate" });

        scored.forEach((s) => { s.spreadSec = s.maxSec - s.minSec; });
        // Minimum-sum tie-breaks on fairness; minimax tie-breaks on total time.
        const bySum = [...scored].sort((a, b) => a.sumSec - b.sumSec || a.maxSec - b.maxSec).slice(0, 3);
        const byMinimax = [...scored].sort((a, b) => a.maxSec - b.maxSec || a.sumSec - b.sumSec).slice(0, 3);
        // Least total estimated fuel; ties go to the faster, then the fairer point.
        const byFuel = scored.filter((c) => c.fuelL !== null)
            .sort((a, b) => a.fuelL - b.fuelL || a.sumSec - b.sumSec || a.maxSec - b.maxSec).slice(0, 3);
        const rankings = { sum: bySum, minimax: byMinimax, fuel: byFuel };
        ack({
            ok: true, strategy,
            results: rankings[strategy].length ? rankings[strategy] : bySum,
            rankings,
            fuelAssumptions: {
                defaultKmPerL: DEFAULT_KM_PER_L,
                assumedFor: members.filter((m, i) => fuelProfiles[i].assumed).map((m) => m.name),
                walking: members.filter((m, i) => !fuelProfiles[i].motorised).map((m) => m.name),
                note: "Estimate from road distance, average leg speed and each rider's stated km/L."
            },
            venuesFound: venues.length
        });
    }));

    // --- L. CARPOOL ORDERING + FUEL SPLIT ------------------------------------------
    // socket.emit('carpoolOptimize', {start, pickups:[{id,name,lat,lng}], destination, kmPerL?, fuelPricePerL?}, ack)
    socket.on("carpoolOptimize", safeHandler(socket, async (data, ack) => {
        if (typeof ack !== "function") return;
        if (!users.has(socket.id)) return ack({ ok: false, reason: "no-profile" });
        if (!throttle(socket.id, "carpool", 3000)) return ack({ ok: false, reason: "too-frequent" });

        const start = data?.start, dest = data?.destination;
        if (!isValidCoordPair(start?.lat, start?.lng) || !isValidCoordPair(dest?.lat, dest?.lng)) {
            return ack({ ok: false, reason: "invalid-start-or-destination" });
        }
        const rawStops = Array.isArray(data?.pickups) ? data.pickups.slice(0, 8) : [];
        if (rawStops.length === 0 || rawStops.some((s) => !isValidCoordPair(s?.lat, s?.lng))) {
            return ack({ ok: false, reason: "invalid-pickup-coords" });
        }
        const stops = rawStops.map((s) => ({ id: clampStr(s.id, 60) || null, name: clampStr(s.name, 40), lat: s.lat, lng: s.lng }));
        const kmPerL = clampNum(data?.kmPerL, 1, 100, 15);
        const pricePerL = clampNum(data?.fuelPricePerL, 0, 10_000, 0);

        let ordered = null, legMeters = null, geometry = null, approximate = false, durationSec = null;
        try {
            const coordStr = [start, ...stops, dest].map((p) => `${p.lng},${p.lat}`).join(";");
            const url = `${OSRM_BASE}/trip/v1/driving/${coordStr}?source=first&destination=last&roundtrip=false&overview=full&geometries=geojson&steps=false`;
            const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
            if (res.ok) {
                const json = await res.json();
                const trip = json.code === "Ok" ? json.trips?.[0] : null;
                if (trip && Array.isArray(trip.legs) && trip.legs.length === stops.length + 1) {
                    const n = stops.length + 2;
                    const posToInput = new Array(n).fill(null);
                    json.waypoints.forEach((wp, inputIdx) => { posToInput[wp.waypoint_index] = inputIdx; });
                    ordered = [];
                    for (let pos = 1; pos <= n - 2; pos++) ordered.push(stops[posToInput[pos] - 1]);
                    if (ordered.every(Boolean)) {
                        legMeters = trip.legs.map((l) => l.distance);
                        geometry = trip.geometry;
                        durationSec = trip.duration;
                    } else { ordered = null; }
                }
            }
        } catch (e) {
            console.warn("OSRM /trip failed, using greedy+2-opt fallback:", e.message);
        }
        if (!ordered) {
            const fb = orderPickupsFallback(start, stops, dest);
            ordered = fb.ordered.map(({ _i, ...rest }) => rest);
            legMeters = fb.legMeters;
            approximate = true;
        }

        const split = splitCarpoolCosts(ordered, legMeters, kmPerL, pricePerL);
        const totalMeters = legMeters.reduce((a, b) => a + b, 0);
        ack({
            ok: true, approximate,
            pickupOrder: ordered,
            legs: legMeters.map((m) => +(m / 1000).toFixed(2)),
            totalDistanceKm: +(totalMeters / 1000).toFixed(2),
            totalDurationMin: durationSec != null ? Math.round(durationSec / 60) : null,
            geometry,                                  // GeoJSON LineString (null in fallback)
            assumptions: { kmPerL, fuelPricePerL: pricePerL, note: "Estimate: fuel split by distance actually ridden, shared equally per leg." },
            driver: split.driver, riders: split.riders
        });
    }));

    // --- M. TRIP ANALYTICS PERSISTENCE ---------------------------------------------
    // One event at trip end with a downsampled log — no DB write per GPS tick.
    // Trip row + points commit in ONE transaction (no half-written trips).
    socket.on("tripFinished", safeHandler(socket, (data, ack) => {
        const user = users.get(socket.id);
        if (!user || !user.deviceId || !data) return typeof ack === "function" && ack({ ok: false, reason: "no-device-identity" });
        if (!throttle(socket.id, "tripFinished", 5000)) return typeof ack === "function" && ack({ ok: false, reason: "too-frequent" });

        const now = Date.now();
        const points = (Array.isArray(data.points) ? data.points : [])
            .slice(0, 2000)
            .filter((p) => isValidCoordPair(p?.lat, p?.lng) && isFiniteNum(p?.ts) && p.ts > now - 8 * 86_400_000 && p.ts < now + 300_000);

        const tripId = generateId();
        const startedAt = isFiniteNum(data.startedAt) ? Math.min(data.startedAt, now) : now;
        const endedAt = isFiniteNum(data.endedAt) ? Math.min(Math.max(data.endedAt, startedAt), now + 60_000) : now;

        db.transaction(() => {
            stmt.insertTrip.run(
                tripId, user.deviceId, clampStr(data.name || "", 80), normalizeMode(data.mode), startedAt, endedAt,
                clampNum(data.totalDistKm, 0, 5000, 0), clampNum(data.avgSpeed, 0, 300, 0),
                clampNum(data.maxSpeed, 0, 300, 0), clampNum(data.fuelUsedL, 0, 500, 0)
            );
            for (const p of points) {
                stmt.insertTripPoint.run(tripId, p.ts, p.lat, p.lng,
                    isFiniteNum(p.speedKmh) ? clampNum(p.speedKmh, 0, 300, null) : null,
                    isFiniteNum(p.accuracy) ? clampNum(p.accuracy, 0, 100000, null) : null);
            }
        })();
        if (typeof ack === "function") ack({ ok: true, tripId, points: points.length });
    }));

    // Analytics reads — strictly scoped to the caller's own deviceId.
    socket.on("listMyTrips", safeHandler(socket, (data, ack) => {
        if (typeof ack !== "function") return;
        const user = users.get(socket.id);
        if (!user?.deviceId) return ack({ ok: false, reason: "no-device-identity" });
        ack({ ok: true, trips: stmt.listTrips.all(user.deviceId, clampNum(data?.limit, 1, 100, 30)) });
    }));

    socket.on("getTripPoints", safeHandler(socket, (data, ack) => {
        if (typeof ack !== "function") return;
        const user = users.get(socket.id);
        if (!user?.deviceId) return ack({ ok: false, reason: "no-device-identity" });
        if (!isNonEmptyStr(data?.tripId, 60)) return ack({ ok: false, reason: "bad-trip-id" });
        const owner = stmt.getTripOwner.get(data.tripId);
        if (!owner || owner.host_device_id !== user.deviceId) return ack({ ok: false, reason: "not-found" });
        ack({ ok: true, points: stmt.getTripPoints.all(data.tripId, 5000) });
    }));

    // --- N. PRIVACY: EXPORT + DELETE -----------------------------------------------
    socket.on("exportMyData", safeHandler(socket, (_data, ack) => {
        if (typeof ack !== "function") return;
        const user = users.get(socket.id);
        if (!user?.deviceId) return ack({ ok: false, reason: "no-device-identity" });
        const trips = stmt.listTrips.all(user.deviceId, 1000).map((t) => ({
            ...t, points: stmt.getTripPoints.all(t.id, 5000)
        }));
        ack({
            ok: true, exportedAt: new Date().toISOString(),
            profile: { name: user.name }, trips,
            memories: stmt.listMemoriesMeta.all(user.deviceId),
            geofences: stmt.listGeofencesForDevice.all(user.deviceId)
        });
    }));

    // deleteMyHistory {includeIdentity?: boolean}
    // Purges trips, breadcrumbs, memories and owned geofences from SQLite AND
    // RAM, then checkpoints the WAL (secure_delete overwrites freed pages).
    socket.on("deleteMyHistory", safeHandler(socket, (data, ack) => {
        const user = users.get(socket.id);
        if (!user || !user.deviceId) return typeof ack === "function" && ack({ ok: false, reason: "no-device-identity" });
        const deviceId = user.deviceId;
        const includeIdentity = data?.includeIdentity === true;

        let tripsDeleted = 0, memoriesDeleted = 0, geofencesDeleted = 0;
        db.transaction(() => {
            stmt.deleteTripPointsForDevice.run(deviceId);
            tripsDeleted = stmt.deleteTripsForDevice.run(deviceId).changes;
            memoriesDeleted = stmt.deleteMemoriesForDevice.run(deviceId).changes;
            geofencesDeleted = stmt.deleteGeofencesForDevice.run(deviceId).changes;
            if (includeIdentity) stmt.deleteUser.run(deviceId);
        })();
        try { db.pragma("wal_checkpoint(TRUNCATE)"); } catch (e) { console.warn("WAL checkpoint skipped:", e.message); }

        for (let i = memories.length - 1; i >= 0; i--) if (memories[i].deviceId === deviceId) memories.splice(i, 1);
        geofences = geofences.filter((f) => f.ownerDeviceId !== deviceId);
        if (includeIdentity) { user.deviceId = null; user.verified = false; deviceToSocket.delete(deviceId); }

        io.emit("loadMemoryPhotos", memories.map(publicMemory));
        io.emit("loadGeofences", geofences.map(publicFence));
        if (typeof ack === "function") ack({ ok: true, tripsDeleted, memoriesDeleted, geofencesDeleted, identityDeleted: includeIdentity });
    }));

    // --- M2. TRIP ROLLUPS (Phase 3) ------------------------------------------------
    // socket.emit('getTripRollups', {period:"day"|"week"|"month", tzOffsetMin, limit?}, ack)
    // Read-only, cheap (indexed on host_device_id), throttled to 1/sec per socket.
    socket.on("getTripRollups", safeHandler(socket, (data, ack) => {
        if (typeof ack !== "function") return;
        const user = users.get(socket.id);
        if (!user?.deviceId) return ack({ ok: false, reason: "no-device-identity" });
        if (!throttle(socket.id, "rollups", 1000)) return ack({ ok: false, reason: "too-frequent" });

        const period = ["day", "week", "month"].includes(data?.period) ? data.period : "day";
        const tzOffsetSec = Math.round(clampNum(data?.tzOffsetMin, -840, 840, 0)) * 60;
        const defaultLimit = period === "day" ? 14 : period === "week" ? 8 : 6;
        const limit = Math.round(clampNum(data?.limit, 1, 60, defaultLimit));

        const rows = rollupStmts[period].all(tzOffsetSec, user.deviceId, 0, limit).map((r) => ({
            bucket: r.bucket,
            trips: r.trips,
            distanceKm: +r.dist.toFixed(2),
            durationMin: Math.round(r.dur / 60000),
            avgSpeed: +r.avg.toFixed(1),
            maxSpeed: +r.maxs.toFixed(1),
            fuelL: +r.fuel.toFixed(2)
        }));
        ack({ ok: true, period, rows, retentionDays: TRIP_RETENTION_DAYS });
    }));

    // --- P. RADIO RELAY (Phase 4) ---------------------------------------------------
    // socket.emit('getRelayCredentials', {radio?: boolean}, ack)
    //   -> {ok, v, tripId, rid, tag, groupKey, deviceKey, roster:[{rid, name, ownerKey}]}
    // Only for verified devices inside the active trip. Keys are base64, rid/tag hex.
    socket.on("getRelayCredentials", safeHandler(socket, (data, ack) => {
        if (typeof ack !== "function") return;
        const user = users.get(socket.id);
        if (!user?.deviceId) return ack({ ok: false, reason: "no-device-identity" });
        if (!currentTrip || !isInActiveTrip(socket.id)) return ack({ ok: false, reason: "not-in-trip" });
        if (!throttle(socket.id, "relayCreds", 2000)) return ack({ ok: false, reason: "too-frequent" });
        if (data?.radio === true) user.relayCapable = true;   // earns the longer reconnect grace
        const tripId = currentTrip.id;
        const roster = Array.from(relayRosterMap().entries()).map(([rid, u]) => ({ rid, name: u.name, ownerKey: ownerKeyFor(u.deviceId) }));
        ack({
            ok: true, v: RELAY_FRAME.VERSION, tripId, tripName: currentTrip.name,
            rid: relayRidFor(tripId, user.deviceId).toString("hex"),
            tag: relayTripTag(tripId).toString("hex"),
            groupKey: relayGroupKey(tripId).toString("base64"),
            deviceKey: relayDeviceKey(tripId, user.deviceId).toString("base64"),
            roster, issuedAt: Date.now()
        });
    }));

    // socket.emit('relayUpload', {frames:[base64, ...]}, ack) -> {ok, results:[{i, status, rid?, ts?, seq?, type?}]}
    // A trip member with data uploads frames it heard over radio.
    socket.on("relayUpload", safeHandler(socket, (data, ack) => {
        const reply = (o) => { if (typeof ack === "function") ack(o); };
        const uploader = users.get(socket.id);
        if (!uploader?.deviceId) return reply({ ok: false, reason: "no-device-identity" });
        if (!currentTrip || !isInActiveTrip(socket.id)) return reply({ ok: false, reason: "not-in-trip" });
        if (!throttle(socket.id, "relayUpload", 1000)) return reply({ ok: false, reason: "too-frequent" });
        const frames = Array.isArray(data?.frames) ? data.frames.slice(0, 16) : [];
        const roster = relayRosterMap();
        const now = Date.now();
        const results = frames.map((f, i) => {
            const fr = openRelayFrame(f, currentTrip.id, roster);
            const out = { i, status: fr.status };
            if (fr.rid) Object.assign(out, { rid: fr.rid, ts: fr.ts, seq: fr.seq, type: fr.type });
            if (fr.status === "ok") out.status = applyRelayFrame(fr, uploader, now);
            return out;
        });
        reply({ ok: true, results });
    }, "location"));

    // --- O. DISCONNECT (with reconnect grace) ---------------------------------------
    socket.on("disconnect", () => {
        console.log(`🔴 Disconnected: ${socket.id}`);
        forgetSocketCounters(socket.id);
        const user = users.get(socket.id);
        if (!user) return; // already migrated to a newer socket
        user.online = false;
        user.offlineSince = Date.now();      // Phase 4: radio grace is measured from here
        io.emit("userOffline", { id: socket.id });

        if (user.deviceId) {
            // Hold trip role/roster for a grace window so a tunnel or an
            // Wi-Fi<->LTE handover does not end the squad's trip.
            const timer = setTimeout(() => finalizeDeparture(socket.id), RECONNECT_GRACE_MS);
            timer.unref?.();
            pendingDeparture.set(user.deviceId, timer);
        } else {
            setTimeout(() => finalizeDeparture(socket.id), 5000).unref?.();
        }
    });
});

// ==========================================================================
// 10. STARTUP: HYDRATE RAM FROM SQLITE, RETENTION JOB, START, SHUTDOWN
// ==========================================================================
function hydrateFromDatabase() {
    stmt.hydrateMemories.all(MAX_MEMORIES_IN_RAM).reverse().forEach((r) => {
        memories.push({
            id: r.id, name: r.name || "", lat: r.lat, lng: r.lng, image: r.image_ref, caption: r.caption || "",
            time: new Date(r.created_at).toISOString(), deviceId: r.device_id || null, tripId: r.trip_id || null
        });
    });
    geofences = stmt.hydrateGeofences.all().map((r) => ({
        id: r.id, name: r.name, lat: r.lat, lng: r.lng, radius: r.radius,
        ownerId: null, ownerName: r.owner_name || "", ownerDeviceId: r.owner_device_id || null
    }));
    console.log(`   Hydrated ${memories.length} memories and ${geofences.length} geofences from SQLite`);
}

function purgeExpiredTrips() {
    if (TRIP_RETENTION_DAYS <= 0) return;
    const cutoff = Date.now() - TRIP_RETENTION_DAYS * 86_400_000;
    try {
        const removed = db.transaction(() => {
            stmt.purgeOldTripPoints.run(cutoff);
            return stmt.purgeOldTrips.run(cutoff).changes;
        })();
        if (removed) console.log(`🗑️  Retention: purged ${removed} trip(s) older than ${TRIP_RETENTION_DAYS} days`);
    } catch (e) {
        console.error("Retention purge failed:", e.message);
    }
}

hydrateFromDatabase();
purgeExpiredTrips();
setInterval(purgeExpiredTrips, 6 * 3600 * 1000).unref();

// Keep the process alive through stray promise rejections; for a truly uncaught
// exception process state is unknowable, so log and exit for the supervisor
// (Render / systemd / pm2) to restart cleanly.
process.on("unhandledRejection", (reason) => console.error("unhandledRejection:", reason));
process.on("uncaughtException", (err) => { console.error("uncaughtException:", err); shutdown(1); });

let shuttingDown = false;
function shutdown(code = 0) {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log("Shutting down…");
    const force = setTimeout(() => process.exit(code || 1), 8000);
    force.unref();
    io.close(() => {
        server.close(() => {
            try { db.pragma("wal_checkpoint(TRUNCATE)"); db.close(); } catch { /* ignore */ }
            process.exit(code);
        });
    });
}
process.on("SIGTERM", () => shutdown(0));
process.on("SIGINT", () => shutdown(0));

server.listen(PORT, "0.0.0.0", () => {
    console.log(`🚀 MapUnite Server running on http://localhost:${PORT}`);
    console.log(`   DB: ${DB_PATH}`);
    console.log(`   OSRM: ${OSRM_BASE}`);
    console.log(`   CORS: ${CORS_ORIGIN === false ? "same-origin only" : JSON.stringify(CORS_ORIGIN)}`);
    console.log(`   CSP: ${process.env.ENFORCE_CSP === "1" ? "enforced" : "report-only"}`);
    if (!GOOGLE_KEY) console.log("   Places proxy: disabled (set GOOGLE_MAPS_SERVER_KEY to enable)");
});
