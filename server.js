"use strict";

/* ============================================================================
   MapUnite Server — server.js  (v4: privacy scoping, persistence, clustering)
   ==============================================================================
   Architecture
     - Realtime hot path (users / trips / chat / memories / geofences) stays
       in memory; every live broadcast reads RAM only.
     - Every change to that shared state is an OPERATION applied by
       applyOp(). With one process, ops apply synchronously (LocalBus) —
       exactly the old behaviour. With REDIS_URL set, ops go through Redis
       and every process applies the same ops in the same order
       (lib/cluster.js), so any number of processes share one live state.
       Inside applyOp() a process only emits to ITS OWN sockets.
     - SQLite (better-sqlite3) sits beside it: users, trips + breadcrumbs,
       memories, geofences, chat history, circles. Files (memory photos,
       chat attachments) live on disk in MEDIA_DIR, not in the database
       (lib/media.js).
     - Every socket handler goes through safeHandler(): sync throws AND async
       rejections are caught, per-bucket rate limited, and can never take the
       process down.

   Requires (npm install):
     express helmet express-rate-limit socket.io better-sqlite3
   Optional, only for several processes behind a load balancer:
     @socket.io/redis-adapter redis      (plus a Redis server; see DEPLOY.md)
   Requires Node 18+ (native fetch / AbortSignal.timeout).

   Env vars (all optional):
     PORT                     default 3000
     NODE_ENV                 "production" => same-origin CORS unless CORS_ORIGIN set
     CORS_ORIGIN              comma-separated origins, e.g. https://app.example.com
     NATIVE_APP_ORIGINS       Android app origins, always allowed too (default
                              "https://localhost,capacitor://localhost"; "" = none)
     PUBLIC_DIR               default ./public (index.html, js/, shell.js, sw.js …)
     DB_PATH                  default ./data/mapunite.db
     MEDIA_DIR                default <DB_PATH dir>/media — memory photos + chat files
     SERVER_SECRET            HMAC key for pseudonymous owner keys (auto-generated
                              and persisted in the DB if unset). MUST be the same on
                              every process of a cluster (it is, when they share the DB).
     OSRM_BASE_URL            server-side routing, default https://router.project-osrm.org
     OSRM_PUBLIC_URL          routing URL the BROWSER uses (default the public demo
                              server). Point both at your own OSRM (DEPLOY.md).
     OVERPASS_URL             default https://overpass-api.de/api/interpreter
     GOOGLE_MAPS_SERVER_KEY   server-side Places key (IP-restrict it in Google Cloud)
     HTTP_RATE_LIMIT_MAX      default 300 per 15 min per IP
     MAX_SOCKETS_PER_IP       default 20
     RECONNECT_GRACE_MS       default 30000
     TRIP_RETENTION_DAYS      default 30 (0 = keep forever)
     CHAT_RETENTION_DAYS      default 30 (0 = keep forever)
     ENFORCE_CSP              "1" to enforce the CSP (default: report-only)
     RELAY_HOLD_MS            default 600000 (Phase 4 radio relay)
     REDIS_URL                redis://[:password@]host:6379[/db] or rediss://… —
                              turns on cluster mode
     CLUSTER_PREFIX           Redis channel prefix, default "mapunite"
     NODE_ID                  this process's name in the cluster (default host-pid-rand)
     STICKY_SESSIONS          "1" if your load balancer pins clients to one process;
                              otherwise cluster clients are told to use WebSocket only

   BATCH 2 (this version):
     - Privacy: "share only during a trip or ride" (tripOnly), audience
       "everyone" or "my circles", and the exact/approx/off mode are stored per
       device and survive reconnects (they used to reset to "exact").
     - Friend circles: create / join by invite code / leave / remove member /
       new code / delete. A circles-only rider is invisible to everyone else;
       riders in the same trip always see each other. Trips can be scoped to a
       circle, and several trips can run at once (one per group).
     - Chat history persists (SQLite, CHAT_RETENTION_DAYS), reactions are
       keyed by device (they survive reconnects), attachments go to disk.
     - Memory photos go to disk; existing base64 rows are migrated at boot.
     - "You were here before": recallPlace looks up your own past rides and
       memories near a point.
     - /config.js tells the browser which OSRM server to use.
     - Cluster mode over Redis (see lib/cluster.js).
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
const { createBus, attachSocketIoAdapter } = require("./lib/cluster");
const { MediaStore } = require("./lib/media");

// ==========================================================================
// 0. CONFIG
// ==========================================================================
const IS_PROD = process.env.NODE_ENV === "production";
const PORT = Number(process.env.PORT) || 3000;
const PUBLIC_DIR = process.env.PUBLIC_DIR || path.join(__dirname, "public");
const DB_PATH = process.env.DB_PATH || path.join(__dirname, "data", "mapunite.db");
const MEDIA_DIR = process.env.MEDIA_DIR || path.join(path.dirname(DB_PATH), "media");
const OSRM_BASE = process.env.OSRM_BASE_URL || "https://router.project-osrm.org";
const OSRM_PUBLIC_URL = (process.env.OSRM_PUBLIC_URL || "https://router.project-osrm.org").replace(/\/+$/, "");
const OVERPASS_URL = process.env.OVERPASS_URL || "https://overpass-api.de/api/interpreter";
const GOOGLE_KEY = process.env.GOOGLE_MAPS_SERVER_KEY || "";
const MAX_SOCKETS_PER_IP = Number(process.env.MAX_SOCKETS_PER_IP) || 20;
const RECONNECT_GRACE_MS = Number(process.env.RECONNECT_GRACE_MS) || 30_000;
const TRIP_RETENTION_DAYS = process.env.TRIP_RETENTION_DAYS !== undefined
    ? Math.max(0, Number(process.env.TRIP_RETENTION_DAYS) || 0) : 30;
const CHAT_RETENTION_DAYS = process.env.CHAT_RETENTION_DAYS !== undefined
    ? Math.max(0, Number(process.env.CHAT_RETENTION_DAYS) || 0) : 30;
// The Android/iOS app (Capacitor) runs its pages from https://localhost /
// capacitor://localhost and talks to this server cross-origin.
const NATIVE_APP_ORIGINS = (process.env.NATIVE_APP_ORIGINS ?? "https://localhost,capacitor://localhost")
    .split(",").map((s) => s.trim()).filter(Boolean);
const CORS_ORIGIN = process.env.CORS_ORIGIN
    ? Array.from(new Set(process.env.CORS_ORIGIN.split(",").map((s) => s.trim()).filter(Boolean).concat(NATIVE_APP_ORIGINS)))
    : (IS_PROD ? (NATIVE_APP_ORIGINS.length ? NATIVE_APP_ORIGINS : false) : "*");
const NATIVE_BG_HOLD_MS = 3 * 60_000;      // app in the background: keep the rider while native fixes arrive
const NATIVE_DIRECT_FRESH_MS = 10_000;     // a live socket fix this recent beats a native background POST
const REDIS_URL = process.env.REDIS_URL || "";
const CLUSTER_PREFIX = process.env.CLUSTER_PREFIX || "mapunite";
const STICKY_SESSIONS = process.env.STICKY_SESSIONS === "1";

const REACTION_EMOJIS = ["👍", "❤️", "😂", "😮", "😢", "🔥"];
const ALLOWED_MSG_TYPES = ["text", "image", "video", "audio", "document"];
const ALLOWED_MODES = ["drive", "bike", "walk"];
const MEETUP_STRATEGIES = ["sum", "minimax", "fuel"];
const ROUTE_AVOID_CLASSES = ["motorway", "toll"];      // OSRM car-profile exclude classes
const SHARING_MODES = ["exact", "approx", "off"];
const VISIBILITY_SCOPES = ["everyone", "circles"];
const MAX_AVATAR_B64_LEN = 3_000_000;
const MAX_MEMORY_IMAGE_B64_LEN = 6_000_000;
const MAX_MEMORY_IMAGE_BYTES = 4_500_000;
const MAX_CHAT_MEDIA_B64_LEN = 7_000_000;
const MAX_CHAT_MEDIA_BYTES = 5_200_000;
const MAX_MEMORIES_IN_RAM = 100;
const CHAT_RAM_LIMIT = 200;
const MAX_GEOFENCES_TOTAL = 200;
const MAX_GEOFENCES_PER_OWNER = 20;
const MAX_CIRCLES_PER_DEVICE = 10;
const MAX_CIRCLE_MEMBERS = 50;
const MAX_PLAUSIBLE_KMH = 300;
const APPROX_GRID_KM = 1;
const DEFAULT_AVATAR = "satyam.png";
const RECALL_DEFAULT_RADIUS_M = 150;
const RECALL_EXCLUDE_RECENT_MS = 6 * 3600_000;   // the ride you're on (or just finished) isn't "before"
const NODE_HB_MS = 5000;
const NODE_DEAD_MS = 20_000;

// Phase 4 — radio relay (see header). Frame layout is documented at
// openRelayFrame() and mirrored byte-for-byte by the client's ConvoyRelay.
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
    // Photos and chat attachments still arrive as base64 over the socket
    // (then go to disk). 8MB covers the 5MB attachment limit + base64.
    maxHttpBufferSize: 8 * 1024 * 1024
});

// Real client IP behind Render / Heroku / nginx.
app.set("trust proxy", 1);

const media = new MediaStore(MEDIA_DIR);

// What the browser needs to know at boot (no secrets). Served both as JSON
// and as /config.js, which index.html loads BEFORE the app scripts so the
// routing URL and transport list are known synchronously.
function publicConfig() {
    return {
        ok: true,
        osrmBase: OSRM_PUBLIC_URL,
        socketTransports: REDIS_URL && !STICKY_SESSIONS ? ["websocket"] : ["websocket", "polling"],
        cluster: Boolean(REDIS_URL),
        placesProxy: Boolean(GOOGLE_KEY),
        approxGridKm: APPROX_GRID_KM,
        tripRetentionDays: TRIP_RETENTION_DAYS,
        chatRetentionDays: CHAT_RETENTION_DAYS,
        maxPlausibleKmh: MAX_PLAUSIBLE_KMH
    };
}

// ==========================================================================
// 2. SECURITY MIDDLEWARE
// ==========================================================================
// CSP ships in REPORT-ONLY mode by default: it cannot break the live page, and
// violations are logged via /csp-report. Flip ENFORCE_CSP=1 once the log is
// clean. The Google Maps JS <script> stays (HTTP-referrer-restricted key), so
// its origins are listed; so are the tile servers the four base maps use and
// whichever OSRM server the browser is told to use.
const osrmOrigin = (() => { try { return new URL(OSRM_PUBLIC_URL).origin; } catch { return "https://router.project-osrm.org"; } })();
const cspDirectives = {
    defaultSrc: ["'self'"],
    scriptSrc: ["'self'", "https://unpkg.com", "https://cdn.jsdelivr.net", "https://maps.googleapis.com", "https://maps.gstatic.com"],
    styleSrc: ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com", "https://unpkg.com"],
    fontSrc: ["'self'", "https://fonts.gstatic.com"],
    imgSrc: ["'self'", "data:", "blob:", "https://*.google.com", "https://*.gstatic.com", "https://maps.googleapis.com",
             "https://*.tile.openstreetmap.org", "https://*.basemaps.cartocdn.com", "https://server.arcgisonline.com",
             "https://*.tile.opentopomap.org", "https://unpkg.com"],
    connectSrc: ["'self'", "ws:", "wss:", osrmOrigin, "https://maps.googleapis.com",
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
// connection cap further down, NOT by this budget.
// Batch 2: the limiter is mounted AFTER the static files. One page load is
// now ~25 small requests (index.html, 20 scripts, config, icons), and many
// riders on one mobile carrier share an IP (CGNAT) — counting static files
// would lock a whole convoy out after a few reloads. Media has its own limit.
const httpLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: Number(process.env.HTTP_RATE_LIMIT_MAX) || 300,
    standardHeaders: true,
    legacyHeaders: false,
    skip: (req) => req.path.startsWith("/socket.io/") || req.path.startsWith("/media/") || req.path === "/api/native/location"
});

app.get("/config.js", (_req, res) => {
    res.setHeader("Content-Type", "application/javascript; charset=utf-8");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Cross-Origin-Resource-Policy", "cross-origin");   // the Android app loads it from https://localhost
    res.send(`window.MU_CONFIG = Object.freeze(${JSON.stringify(publicConfig())});\n`);
});

// Memory photos + chat attachments (lib/media.js).
const mediaLimiter = rateLimit({ windowMs: 60 * 1000, max: 600, standardHeaders: true, legacyHeaders: false });
app.get("/media/:dir/:file", mediaLimiter, media.handler());
app.head("/media/:dir/:file", mediaLimiter, media.handler());

// Static assets. sw.js must NEVER be served from a stale HTTP cache, otherwise
// a client can run new app scripts against an old worker (the classic PWA
// update race). Everything else may revalidate normally.
app.use(express.static(PUBLIC_DIR, {
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
app.use(httpLimiter);
app.use(express.json({ limit: "256kb" }));

app.get("/healthz", (_req, res) => res.json({
    ok: true, uptimeSec: Math.round(process.uptime()),
    node: bus.nodeId, cluster: bus.mode, clusterReady: bus.isReady(), users: users.size, trips: trips.size
}));

// Public feature flags the client reads at boot (no secrets).
app.get("/api/config", (_req, res) => res.json(publicConfig()));

// ---- Android app: background location (native POST, no WebView) -------------
// The app's background-location service POSTs each fix here directly from
// native code (so it keeps working when Android throttles or freezes the
// WebView). Authenticated with the same device id + device token the socket
// uses. The fix goes through the normal "loc" operation, so every privacy
// rule applies (off / trip-only / circles / approx).
const nativeGate = new Map();       // deviceId -> last accepted POST (process-local)
const nativeLimiter = rateLimit({ windowMs: 60 * 1000, max: 600, standardHeaders: true, legacyHeaders: false });
const pickNum = (...vals) => {
    for (const v of vals) {
        const n = typeof v === "string" && v.trim() !== "" ? Number(v) : v;
        if (isFiniteNum(n)) return n;
    }
    return null;
};
app.post("/api/native/location", nativeLimiter, express.json({ limit: "8kb" }), (req, res) => {
    const deviceId = String(req.get("x-mu-device") || "").toLowerCase();
    const auth = String(req.get("authorization") || "");
    const token = auth.startsWith("Bearer ") ? auth.slice(7).trim() : "";
    if (!UUID_RE.test(deviceId) || !isNonEmptyStr(token, 128)) return res.status(401).json({ ok: false, reason: "unauthenticated" });
    const row = stmt.getUser.get(deviceId);
    if (!row || !row.token_hash || !tokenMatches(token, row.token_hash)) return res.status(401).json({ ok: false, reason: "unauthenticated" });
    const body = req.body && typeof req.body === "object" ? req.body : {};
    const b = body.location && typeof body.location === "object" ? body.location : body;
    const lat = pickNum(b.latitude, b.lat), lng = pickNum(b.longitude, b.lng);
    if (!isValidCoordPair(lat, lng)) return res.status(400).json({ ok: false, reason: "bad-coords" });
    const now = Date.now();
    if (now - (nativeGate.get(deviceId) || 0) < 2500) return res.status(429).json({ ok: false, reason: "too-frequent" });
    nativeGate.set(deviceId, now);
    if (nativeGate.size > 20000) for (const [k, t] of nativeGate) if (now - t > 60_000) nativeGate.delete(k);
    const t = pickNum(b.time, b.timestamp);
    if (t !== null && (t < now - 5 * 60_000 || t > now + 60_000)) return res.json({ ok: false, reason: "stale" });
    const sid = deviceToSocket.get(deviceId);
    const user = sid ? users.get(sid) : null;
    // Not on the map any more (app closed for a while): the rider rejoins by
    // opening the app; a background POST alone doesn't re-create a session.
    if (!user) return res.status(409).json({ ok: false, reason: "not-connected" });
    if (user.online && !user.bgOnly && user.lastFix && now - user.lastFix.ts < NATIVE_DIRECT_FRESH_MS) {
        // The app's own socket is sending fresher fixes — don't double them up,
        // but note that the background service is alive, so if the socket drops
        // (app backgrounded, WebView frozen) the rider is held on the map.
        if (!user.bgAt || now - user.bgAt > 60_000) commit({ t: "bgseen", sid }).catch(() => { });
        return res.json({ ok: true, skipped: "live-socket" });
    }
    const speedMs = pickNum(b.speed), acc = pickNum(b.accuracy), alt = pickNum(b.altitude);
    commit({
        t: "loc", sid, lat, lng, alt,
        speedKmh: speedMs !== null && speedMs >= 0 ? clampNum(speedMs * 3.6, 0, 300, 0) : 0,
        accuracy: acc !== null ? clampNum(acc, 0, 100000, null) : null,
        weather: null, est: false, bg: true
    })
        .then((r) => res.json(r && r.ok ? { ok: true } : { ok: false, reason: (r && r.reason) || "rejected" }))
        .catch(() => res.status(503).json({ ok: false, reason: "cluster-unavailable" }));
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
// Several processes may share this file in cluster mode: wait for a lock
// instead of failing with SQLITE_BUSY.
db.pragma("busy_timeout = 5000");
// Zero-trace deletes: overwrite freed pages so "Clear My History" is not
// recoverable from the file. Combined with a WAL checkpoint on delete.
db.pragma("secure_delete = ON");

// Render (and similar) has an ephemeral filesystem: attach a persistent disk
// at DB_PATH's directory (MEDIA_DIR defaults to a folder beside it) or this
// survives restarts but not redeploys.

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
CREATE INDEX IF NOT EXISTS idx_trip_points_lat ON trip_points(lat);
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
CREATE TABLE IF NOT EXISTS chat_messages (
  id                TEXT PRIMARY KEY,
  sender_device_id  TEXT,
  sender_socket     TEXT,
  sender_name       TEXT NOT NULL,
  type              TEXT NOT NULL,
  body              TEXT NOT NULL,
  file_name         TEXT,
  reply_to          TEXT,
  reactions         TEXT,
  created_at        INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_chat_created ON chat_messages(created_at);
CREATE INDEX IF NOT EXISTS idx_chat_device ON chat_messages(sender_device_id);
CREATE TABLE IF NOT EXISTS circles (
  id               TEXT PRIMARY KEY,
  name             TEXT NOT NULL,
  invite_code      TEXT NOT NULL,
  owner_device_id  TEXT NOT NULL,
  created_at       INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_circles_code ON circles(invite_code);
CREATE TABLE IF NOT EXISTS circle_members (
  circle_id  TEXT NOT NULL,
  device_id  TEXT NOT NULL,
  joined_at  INTEGER NOT NULL,
  PRIMARY KEY (circle_id, device_id)
);
CREATE INDEX IF NOT EXISTS idx_circle_members_device ON circle_members(device_id);
`);

// Idempotent migrations for databases created by earlier versions.
// Two processes of a cluster may start together on a fresh database: if the
// other one added the column first, that's fine.
function ensureColumn(table, column, ddl) {
    const has = () => db.prepare(`PRAGMA table_info(${table})`).all().some((c) => c.name === column);
    if (has()) return;
    try { db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${ddl}`); }
    catch (e) { if (!has()) throw e; }
}
ensureColumn("users", "token_hash", "TEXT");
ensureColumn("memories", "caption", "TEXT");
ensureColumn("users", "sharing_mode", "TEXT");
ensureColumn("users", "visibility", "TEXT");
ensureColumn("users", "trip_only", "INTEGER");

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
    getPrefs: db.prepare(`SELECT sharing_mode, visibility, trip_only FROM users WHERE device_id = ?`),
    setPrefs: db.prepare(`UPDATE users SET sharing_mode = ?, visibility = ?, trip_only = ? WHERE device_id = ?`),
    userName: db.prepare(`SELECT name FROM users WHERE device_id = ?`),

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
        INSERT OR IGNORE INTO memories (id, device_id, name, lat, lng, image_ref, caption, trip_id, created_at) VALUES (?,?,?,?,?,?,?,?,?)
    `),
    hydrateMemories: db.prepare(`
        SELECT id, device_id, name, lat, lng, image_ref, caption, trip_id, created_at
        FROM memories ORDER BY created_at DESC LIMIT ?
    `),
    listMemoriesMeta: db.prepare(`SELECT id, name, lat, lng, caption, trip_id, created_at FROM memories WHERE device_id = ?`),
    listMemoryRefsForDevice: db.prepare(`SELECT image_ref FROM memories WHERE device_id = ?`),
    deleteMemoriesForDevice: db.prepare(`DELETE FROM memories WHERE device_id = ?`),
    legacyMemoryIds: db.prepare(`SELECT id FROM memories WHERE image_ref LIKE 'data:%'`),
    getMemoryImage: db.prepare(`SELECT image_ref FROM memories WHERE id = ?`),
    setMemoryRef: db.prepare(`UPDATE memories SET image_ref = ? WHERE id = ? AND image_ref LIKE 'data:%'`),
    countLegacyMemoryImages: db.prepare(`SELECT COUNT(*) AS n FROM memories WHERE image_ref LIKE 'data:%'`),

    insertGeofence: db.prepare(`INSERT OR IGNORE INTO geofences (id, name, lat, lng, radius, owner_device_id) VALUES (?,?,?,?,?,?)`),
    deleteGeofence: db.prepare(`DELETE FROM geofences WHERE id = ?`),
    hydrateGeofences: db.prepare(`
        SELECT g.id, g.name, g.lat, g.lng, g.radius, g.owner_device_id, u.name AS owner_name
        FROM geofences g LEFT JOIN users u ON u.device_id = g.owner_device_id
    `),
    listGeofencesForDevice: db.prepare(`SELECT id, name, lat, lng, radius FROM geofences WHERE owner_device_id = ?`),
    deleteGeofencesForDevice: db.prepare(`DELETE FROM geofences WHERE owner_device_id = ?`),

    insertChat: db.prepare(`
        INSERT OR IGNORE INTO chat_messages (id, sender_device_id, sender_socket, sender_name, type, body, file_name, reply_to, reactions, created_at)
        VALUES (?,?,?,?,?,?,?,?,?,?)
    `),
    updateChatReactions: db.prepare(`UPDATE chat_messages SET reactions = ? WHERE id = ?`),
    hydrateChat: db.prepare(`
        SELECT id, sender_device_id, sender_socket, sender_name, type, body, file_name, reply_to, reactions, created_at
        FROM chat_messages ORDER BY created_at DESC LIMIT ?
    `),
    listChatForDevice: db.prepare(`SELECT id, type, body, file_name, created_at FROM chat_messages WHERE sender_device_id = ? ORDER BY created_at ASC`),
    chatMediaForDevice: db.prepare(`SELECT id, body FROM chat_messages WHERE sender_device_id = ? AND type != 'text'`),
    chatIdsForDevice: db.prepare(`SELECT id FROM chat_messages WHERE sender_device_id = ?`),
    deleteChatForDevice: db.prepare(`DELETE FROM chat_messages WHERE sender_device_id = ?`),
    oldChatMedia: db.prepare(`SELECT body FROM chat_messages WHERE created_at < ? AND type != 'text'`),
    purgeOldChat: db.prepare(`DELETE FROM chat_messages WHERE created_at < ?`),

    insertCircle: db.prepare(`INSERT INTO circles (id, name, invite_code, owner_device_id, created_at) VALUES (?,?,?,?,?)`),
    getCircle: db.prepare(`SELECT id, name, invite_code, owner_device_id, created_at FROM circles WHERE id = ?`),
    getCircleByCode: db.prepare(`SELECT id, name, invite_code, owner_device_id, created_at FROM circles WHERE invite_code = ?`),
    setCircleCode: db.prepare(`UPDATE circles SET invite_code = ? WHERE id = ?`),
    setCircleOwner: db.prepare(`UPDATE circles SET owner_device_id = ? WHERE id = ?`),
    renameCircle: db.prepare(`UPDATE circles SET name = ? WHERE id = ?`),
    deleteCircle: db.prepare(`DELETE FROM circles WHERE id = ?`),
    insertCircleMember: db.prepare(`INSERT OR IGNORE INTO circle_members (circle_id, device_id, joined_at) VALUES (?,?,?)`),
    deleteCircleMember: db.prepare(`DELETE FROM circle_members WHERE circle_id = ? AND device_id = ?`),
    deleteCircleMembers: db.prepare(`DELETE FROM circle_members WHERE circle_id = ?`),
    isCircleMember: db.prepare(`SELECT 1 AS ok FROM circle_members WHERE circle_id = ? AND device_id = ?`),
    countCircleMembers: db.prepare(`SELECT COUNT(*) AS n FROM circle_members WHERE circle_id = ?`),
    countCirclesForDevice: db.prepare(`SELECT COUNT(*) AS n FROM circle_members WHERE device_id = ?`),
    circleIdsForDevice: db.prepare(`SELECT circle_id FROM circle_members WHERE device_id = ? ORDER BY joined_at ASC`),
    circlesForDevice: db.prepare(`
        SELECT c.id, c.name, c.invite_code, c.owner_device_id, c.created_at
        FROM circle_members m JOIN circles c ON c.id = m.circle_id
        WHERE m.device_id = ? ORDER BY m.joined_at ASC
    `),
    circleMembers: db.prepare(`
        SELECT m.device_id, m.joined_at, u.name
        FROM circle_members m LEFT JOIN users u ON u.device_id = m.device_id
        WHERE m.circle_id = ? ORDER BY m.joined_at ASC
    `),

    recallPoints: db.prepare(`
        SELECT p.trip_id, p.ts, p.lat, p.lng, t.name, t.mode, t.started_at
        FROM trip_points p JOIN trips t ON t.id = p.trip_id
        WHERE t.host_device_id = ? AND p.lat BETWEEN ? AND ? AND p.lng BETWEEN ? AND ? AND p.ts < ?
        LIMIT 5000
    `),
    recallMemories: db.prepare(`
        SELECT id, caption, lat, lng, created_at FROM memories
        WHERE device_id = ? AND lat BETWEEN ? AND ? AND lng BETWEEN ? AND ? AND created_at < ?
        ORDER BY created_at DESC LIMIT 50
    `)
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
// 4. LIVE STATE — replicated across processes by the cluster bus
// ==========================================================================
// Every process holds ALL of this (not just its own sockets' share). It only
// changes inside applyOp(), in the same order on every process.
const users = new Map();            // socketId -> internal user record
const chatMessages = [];            // newest CHAT_RAM_LIMIT messages (full history in SQLite)
const memories = [];                // newest MAX_MEMORIES_IN_RAM memories (full history in SQLite)
let geofences = [];                 // internal fence records
const trips = new Map();            // tripId -> {id, name, lat, lng, hostId, members, circleId, circleName, startedAt}
const voiceSquadMembers = new Map();
const deviceToSocket = new Map();   // deviceId -> live socketId
const clusterNodes = new Map();     // nodeId -> last heartbeat time (op clock)

// Process-local only (never replicated):
const pendingDeparture = new Map(); // deviceId -> grace timer, armed by the process that owns the socket
const venueCache = new Map();       // "lat,lng" -> {ts, venues}
const lastTripSent = new Map();     // local socketId -> JSON of the last tripData it received
const heartbeatSeen = new Map();    // nodeId -> local receipt time of its last heartbeat

const bus = createBus({ redisUrl: REDIS_URL, prefix: CLUSTER_PREFIX, log: console });
const NODE_ID = bus.nodeId;
let adapterAttached = false;

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


const mediaUrl = (ref) => (MediaStore.isRef(ref) ? MediaStore.url(ref) : (typeof ref === "string" && ref.startsWith("data:") ? ref : null));

// ---- Emitting. Inside applyOp() a process only talks to ITS OWN sockets;
// with several processes, each one covers its own share of the audience.
const localSocket = (sid) => io.sockets.sockets.get(sid) || null;
const isLocal = (sid) => io.sockets.sockets.has(sid);
function emitLocal(sid, event, ...args) { const s = localSocket(sid); if (s) s.emit(event, ...args); }
function emitAllLocal(event, ...args) { for (const s of io.sockets.sockets.values()) s.emit(event, ...args); }
function emitAllLocalExcept(exceptSid, event, ...args) {
    for (const [sid, s] of io.sockets.sockets) if (sid !== exceptSid) s.emit(event, ...args);
}
// Point-to-point to a socket wherever it is connected (WebRTC signalling).
function sendTo(sid, event, ...args) {
    if (isLocal(sid)) return emitLocal(sid, event, ...args);
    const node = users.get(sid)?.node;
    if (!node || node === NODE_ID) return;
    if (adapterAttached) return io.to(sid).emit(event, ...args);
    bus.sendToNode(node, { kind: "emit", sid, event, args }).catch((e) => console.warn("[cluster] direct emit failed:", e.message));
}
function onDirectMessage(msg) {
    if (msg && msg.kind === "emit" && typeof msg.sid === "string" && typeof msg.event === "string" && Array.isArray(msg.args)) {
        emitLocal(msg.sid, msg.event, ...msg.args);
    }
}

// Commit an op. Single process: applied synchronously and `fn` runs
// immediately (same timing as the old direct mutations). Cluster: `fn` runs
// once this process has applied the op in stream order.
function commit(op) { return bus.commit(op); }
function commitThen(op, fn) {
    if (bus.mode === "local") { const r = bus.commitSync(op); return fn ? fn(r) : r; }
    return bus.commit(op).then((r) => (fn ? fn(r) : r));
}

// ==========================================================================
// 5b. TRIPS, CIRCLES AND WHO-SEES-WHOM
// ==========================================================================
function tripOf(socketId) {
    for (const t of trips.values()) if (t.members.some((m) => m.id === socketId)) return t;
    return null;
}
const isInActiveTrip = (socketId) => Boolean(tripOf(socketId));
function sameTrip(a, b) {
    const t = tripOf(a);
    return Boolean(t && t.members.some((m) => m.id === b));
}
function sharesCircle(u, v) {
    if (!u || !v || !Array.isArray(u.circleIds) || !Array.isArray(v.circleIds) || !u.circleIds.length || !v.circleIds.length) return false;
    return u.circleIds.some((c) => v.circleIds.includes(c));
}
// A circle trip is visible (and joinable) only inside that circle.
function canSeeTrip(t, viewerSid) {
    if (!t) return false;
    if (t.members.some((m) => m.id === viewerSid)) return true;
    if (!t.circleId) return true;
    const v = users.get(viewerSid);
    return Boolean(v && Array.isArray(v.circleIds) && v.circleIds.includes(t.circleId));
}
// The one trip a client's trip panel shows: the one it's in, otherwise the
// newest trip it may join.
function tripFor(viewerSid) {
    const own = tripOf(viewerSid);
    if (own) return own;
    let best = null;
    for (const t of trips.values()) if (canSeeTrip(t, viewerSid) && (!best || t.startedAt > best.startedAt)) best = t;
    return best;
}
function publicTrip(t) {
    if (!t) return null;
    return {
        id: t.id, name: t.name, lat: t.lat, lng: t.lng, hostId: t.hostId,
        members: t.members.map((m) => ({ id: m.id, name: m.name })),
        circleId: t.circleId || null, circleName: t.circleName || null
    };
}
function pushTripViewTo(sid, force = false) {
    if (!users.has(sid)) return;
    const pub = publicTrip(tripFor(sid));
    const key = JSON.stringify(pub);
    if (!force && lastTripSent.get(sid) === key) return;
    lastTripSent.set(sid, key);
    emitLocal(sid, "tripData", pub);
}
function pushTripViews() { for (const sid of io.sockets.sockets.keys()) pushTripViewTo(sid); }

// "Share only during a trip or ride": sharing is live while the rider has a
// Drive/Bike/Walk session running or is in a group trip.
function sharingActive(u) { return !u.tripOnly || Boolean(u.sessionMode) || isInActiveTrip(u.id); }

// How viewer `viewerSid` may see rider `u`:
//   hidden  not in the audience at all (circles-only and not in a shared circle or trip)
//   nopos   listed, but no position (sharing off, or trip-only and not riding)
//   approx  1 km cell
//   exact   live position
// Riders in the same trip always see each other exactly (unless "off").
function viewLevel(u, viewerSid) {
    if (!u) return "hidden";
    if (u.id === viewerSid) return "self";
    const together = sameTrip(u.id, viewerSid);
    if (!together && u.visibility === "circles" && !sharesCircle(u, users.get(viewerSid))) return "hidden";
    if (u.sharingMode === "off" || !sharingActive(u)) return "nopos";
    if (together) return "exact";
    return u.sharingMode === "approx" ? "approx" : "exact";
}

// The ONLY shape ever sent to other clients. Never the raw record (deviceId
// is a private identifier).
function publicUser(u, level) {
    const hasFix = isValidCoordPair(u.lat, u.lng);
    let lat = null, lng = null, alt = null, speedKmh = null, accuracy = null;
    if (hasFix && level === "approx") {
        ({ lat, lng } = snapToGrid(u.lat, u.lng));
    } else if (hasFix && level === "exact") {
        lat = u.lat; lng = u.lng; alt = u.alt ?? null; speedKmh = u.speedKmh ?? null;
        accuracy = isFiniteNum(u.accuracy) ? Math.round(u.accuracy) : null;
    }
    const relayed = u.via === "radio" && level !== "nopos";
    return {
        id: u.id, name: u.name, avatar: u.avatar, online: u.online !== false,
        lat, lng, alt, speedKmh, weather: level === "exact" ? (u.weather || "") : "",
        approx: level === "approx", ownerKey: ownerKeyFor(u.deviceId),
        // Phase 4 (additive — older clients ignore these):
        accuracy,                                            // metres, exact only
        est: level === "exact" && Boolean(u.est),            // dead-reckoned, not a GPS fix
        via: relayed ? "radio" : null,                       // position arrived over the LoRa relay
        fixAt: relayed ? (u.fixAt || null) : null,           // origin's timestamp for that position
        relayedBy: relayed ? (u.relayedBy || null) : null,
        bg: level !== "nopos" && Boolean(u.bgOnly),          // Android app in the background (native location)
        // Batch 2: listed but not sharing right now (trip-only, not riding)
        paused: level === "nopos" && u.sharingMode !== "off"
    };
}

// One user event to every LOCAL viewer, each at their own level.
function emitUserEvent(event, u, exceptSid = null, { skipApprox = false } = {}) {
    let exact = null, approx = null, nopos = null;
    for (const [sid, sock] of io.sockets.sockets) {
        if (sid === exceptSid || sid === u.id) continue;
        const level = viewLevel(u, sid);
        if (level === "hidden") continue;
        if (level === "exact") sock.emit(event, exact || (exact = publicUser(u, "exact")));
        else if (level === "approx") { if (!skipApprox) sock.emit(event, approx || (approx = publicUser(u, "approx"))); }
        else sock.emit(event, nopos || (nopos = publicUser(u, "nopos")));
    }
}

// After anything that changes who may see `u` or how precisely: tell every
// local viewer the new truth — a marker, a listed-but-not-sharing entry, or
// removal from their map and list.
function refreshUserVisibility(u) {
    if (!u) return;
    for (const [sid, sock] of io.sockets.sockets) {
        if (sid === u.id) continue;
        const level = viewLevel(u, sid);
        if (level === "hidden") sock.emit("friendDisconnected", u.id);
        else if (level === "nopos") { sock.emit("friendMoved", publicUser(u, "nopos")); sock.emit("userOffline", { id: u.id }); }
        else sock.emit("userOnline", publicUser(u, level));
    }
}
// The viewer side: `viewerSid`'s own circles changed, so re-send everyone.
function refreshViewer(viewerSid) {
    const sock = localSocket(viewerSid);
    if (!sock) return;
    for (const u of users.values()) {
        if (u.id === viewerSid) continue;
        const level = viewLevel(u, viewerSid);
        if (level === "hidden") sock.emit("friendDisconnected", u.id);
        else if (level === "nopos") { sock.emit("friendMoved", publicUser(u, "nopos")); if (u.online !== false) sock.emit("userOffline", { id: u.id }); }
        else sock.emit("userOnline", publicUser(u, level));
    }
}
function visibleUsersFor(viewerSid) {
    const out = [];
    for (const u of users.values()) {
        if (u.id === viewerSid) continue;
        const level = viewLevel(u, viewerSid);
        if (level !== "hidden") out.push(publicUser(u, level));
    }
    return out;
}
function privacyState(u) {
    return {
        sharingMode: u.sharingMode, visibility: u.visibility, tripOnly: Boolean(u.tripOnly),
        active: u.sharingMode !== "off" && sharingActive(u),
        inTrip: isInActiveTrip(u.id), session: Boolean(u.sessionMode)
    };
}
function emitPrivacyState(u) { if (u) emitLocal(u.id, "privacyChanged", privacyState(u)); }
function loadPrefs(deviceId) {
    const row = deviceId ? stmt.getPrefs.get(deviceId) : null;
    return {
        sharingMode: SHARING_MODES.includes(row?.sharing_mode) ? row.sharing_mode : "exact",
        visibility: VISIBILITY_SCOPES.includes(row?.visibility) ? row.visibility : "everyone",
        tripOnly: row?.trip_only === 1
    };
}

function publicMemory(m) {
    return {
        id: m.id, name: m.name, lat: m.lat, lng: m.lng, image: mediaUrl(m.ref),
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

const emptyReactions = () => Object.fromEntries(REACTION_EMOJIS.map((e) => [e, []]));
function publicChat(m) {
    return {
        id: m.id, senderId: m.senderId, senderKey: ownerKeyFor(m.deviceId), name: m.name,
        type: m.type, data: m.type === "text" ? m.body : mediaUrl(m.body),
        fileName: m.fileName || null, replyTo: m.replyTo || null, time: m.time,
        reactions: m.reactions
    };
}
function chatFromRow(r) {
    let replyTo = null, reactions = null;
    try { replyTo = r.reply_to ? JSON.parse(r.reply_to) : null; } catch { replyTo = null; }
    try { reactions = r.reactions ? JSON.parse(r.reactions) : null; } catch { reactions = null; }
    const clean = emptyReactions();
    if (reactions && typeof reactions === "object") for (const e of REACTION_EMOJIS) if (Array.isArray(reactions[e])) clean[e] = reactions[e].filter((k) => typeof k === "string").slice(0, 200);
    return {
        id: r.id, senderId: r.sender_socket || null, deviceId: r.sender_device_id || null, name: r.sender_name,
        type: r.type, body: r.body, fileName: r.file_name || null, replyTo, reactions: clean,
        time: new Date(r.created_at).toISOString()
    };
}

// Geofence enter/leave for one position change — only to viewers who see
// this rider exactly (an alert would otherwise leak a position finer than
// what they're allowed to see), plus the rider. Never for an estimate.
function checkGeofences(user, oldLat, oldLng, now) {
    if (user.est || oldLat == null || oldLng == null) return;
    geofences.forEach((fence) => {
        const wasOutside = distanceKm(oldLat, oldLng, fence.lat, fence.lng) * 1000 > fence.radius;
        const isInside = distanceKm(user.lat, user.lng, fence.lat, fence.lng) * 1000 <= fence.radius;
        let type = null;
        if (wasOutside && isInside) type = "enter";
        else if (!wasOutside && !isInside) type = "leave";
        if (!type) return;
        const alert = { user: user.name, fence: fence.name, type, at: now };
        for (const [sid, sock] of io.sockets.sockets) {
            const level = viewLevel(user, sid);
            if (level === "self" || level === "exact") sock.emit("geofenceAlert", alert);
        }
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

// ---- Road speed limits (roadmap Section 8: "Overpass maxspeed, cached aggressively")
// The app asks for ~1.1 km tiles of DRIVABLE roads around the rider; each
// tile is fetched from Overpass once and shared by every rider for 24 h.
// Only what the phone needs to match itself to a road is sent: class, the
// PARSED limit (km/h) per direction and for motorcycles, oneway, geometry.
// A value OSM doesn't give as a number ("IN:urban", "none", "signals",
// "walk", conditional tags) is NOT turned into an invented number: the road
// is sent with limit null and the app keeps its flat 60/80/100 alerts there.
const ROAD_TILE_DEG = 0.01;
const ROAD_TILE_TTL_MS = 24 * 60 * 60 * 1000;
const ROAD_TILE_FAIL_TTL_MS = 60 * 1000;
const ROAD_TILE_MAX = 400;
const ROAD_TILE_MAX_INFLIGHT = 2;
const ROAD_TILE_KEY_RE = /^-?\d{1,5}:-?\d{1,5}$/;
const DRIVABLE_HIGHWAY_RE = "^(motorway|trunk|primary|secondary|tertiary|unclassified|residential|living_street|road|motorway_link|trunk_link|primary_link|secondary_link|tertiary_link)$";
const roadTileCache = new Map();          // key -> { ts, ways } | { ts, failed: true }
const roadTileInflight = new Map();       // key -> Promise

function parseMaxspeed(v) {
    if (typeof v !== "string" || !v.trim()) return null;
    const parts = v.split(";").map((x) => x.trim()).filter(Boolean);
    const vals = parts.map((x) => {
        const m = /^(\d{1,3}(?:\.\d+)?)\s*(km\/h|kmh|kph|mph|knots)?$/i.exec(x);
        if (!m) return null;
        let n = parseFloat(m[1]);
        if (/mph/i.test(m[2] || "")) n *= 1.609344;
        else if (/knots/i.test(m[2] || "")) n *= 1.852;
        return n >= 5 && n <= 150 ? Math.round(n) : null;
    });
    if (!vals.length || vals.some((x) => x === null)) return null;
    return Math.min(...vals);                 // "60;40" (lanes/vehicles) -> the stricter value
}

function roadTileBounds(key) {
    const [a, b] = key.split(":").map(Number);
    const s = a * ROAD_TILE_DEG, w = b * ROAD_TILE_DEG;
    return { s: +s.toFixed(5), w: +w.toFixed(5), n: +(s + ROAD_TILE_DEG).toFixed(5), e: +(w + ROAD_TILE_DEG).toFixed(5) };
}

function compactRoadWay(el) {
    const t = el.tags || {};
    const hw = String(t.highway || "");
    let ow = 0;
    if (/^(yes|1|true)$/i.test(t.oneway || "") || (hw === "motorway" && !/^no$/i.test(t.oneway || "")) || t.junction === "roundabout") ow = 1;
    else if (/^(-1|reverse)$/i.test(t.oneway || "")) ow = -1;
    // Geometry may contain nulls where the way leaves the tile: keep each run separately.
    const runs = [];
    let cur = [];
    (el.geometry || []).forEach((g) => {
        if (g && isFiniteNum(g.lat) && isFiniteNum(g.lon)) cur.push(+g.lat.toFixed(5), +g.lon.toFixed(5));
        else { if (cur.length >= 4) runs.push(cur); cur = []; }
    });
    if (cur.length >= 4) runs.push(cur);
    if (!runs.length) return null;
    const lim = parseMaxspeed(t.maxspeed);
    return {
        id: el.id, hw, name: clampStr(t.name || t.ref || "", 60), ow,
        lim, fwd: parseMaxspeed(t["maxspeed:forward"]), bwd: parseMaxspeed(t["maxspeed:backward"]),
        mc: parseMaxspeed(t["maxspeed:motorcycle"]),
        raw: t.maxspeed ? clampStr(t.maxspeed, 30) : null,
        runs
    };
}

async function fetchRoadTile(key) {
    const hit = roadTileCache.get(key);
    if (hit && Date.now() - hit.ts < (hit.failed ? ROAD_TILE_FAIL_TTL_MS : ROAD_TILE_TTL_MS)) return hit;
    if (roadTileInflight.has(key)) return roadTileInflight.get(key);
    if (roadTileInflight.size >= ROAD_TILE_MAX_INFLIGHT) return { busy: true };
    const b = roadTileBounds(key);
    const q = `[out:json][timeout:20];way(${b.s},${b.w},${b.n},${b.e})[highway~"${DRIVABLE_HIGHWAY_RE}"];out tags geom(${b.s},${b.w},${b.n},${b.e});`;
    const job = (async () => {
        try {
            const res = await fetch(OVERPASS_URL, {
                method: "POST",
                headers: { "Content-Type": "application/x-www-form-urlencoded", "User-Agent": "MapUnite/1.0 (squad riding app; speed-limit tiles)" },
                body: "data=" + encodeURIComponent(q),
                signal: AbortSignal.timeout(25000)
            });
            if (!res.ok) throw new Error(`Overpass HTTP ${res.status}`);
            const json = await res.json();
            const ways = (json.elements || []).filter((e) => e.type === "way").map(compactRoadWay).filter(Boolean);
            const entry = { ts: Date.now(), ways };
            if (roadTileCache.size >= ROAD_TILE_MAX) roadTileCache.delete(roadTileCache.keys().next().value);   // oldest first
            roadTileCache.set(key, entry);
            return entry;
        } catch (e) {
            console.warn(`Road tile ${key} failed:`, e.message);
            const entry = { ts: Date.now(), failed: true };
            roadTileCache.set(key, entry);
            return entry;
        } finally {
            roadTileInflight.delete(key);
        }
    })();
    roadTileInflight.set(key, job);
    return job;
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

// ---- Carpool maths (roadmap Sections 5, 12, 28 #6 / #14) --------------------
// Points are indexed 0 = driver start, 1..n = pickups, n+1 = drop-off, with
// OSRM road matrices D (metres) and T (seconds).
//
// Pickup ORDER, exact (n <= 8 -> at most 40,320 orders, microseconds each):
//   shortest  least total drive time (what OSRM /trip approximates)
//   fairest   least WORST detour: a rider's detour = their time in the car
//             from pickup to drop-off minus their direct drive time; ties
//             go to the shorter total. (Section 12: "/trip only optimizes
//             total time".)
function permutations(n) {
    const out = [], a = Array.from({ length: n }, (_, i) => i + 1), c = new Array(n).fill(0);
    out.push(a.slice());
    let i = 0;
    while (i < n) {                                          // Heap's algorithm
        if (c[i] < i) { const k = i % 2 ? c[i] : 0; [a[k], a[i]] = [a[i], a[k]]; out.push(a.slice()); c[i]++; i = 0; }
        else { c[i] = 0; i++; }
    }
    return out;
}
function evaluateOrder(order, D, T) {
    const n = order.length, dest = n + 1, seq = [0, ...order, dest];
    let totalM = 0, totalS = 0;
    const cumS = [0];
    for (let k = 0; k < seq.length - 1; k++) { totalM += D[seq[k]][seq[k + 1]]; totalS += T[seq[k]][seq[k + 1]]; cumS.push(totalS); }
    const detours = order.map((p, k) => Math.max(0, (totalS - cumS[k + 1]) - T[p][dest]));    // pickup at seq index k+1
    return { order, totalM, totalS, detours, worstS: detours.length ? Math.max(...detours) : 0 };
}
function bestPickupOrders(D, T, n) {
    let shortest = null, fairest = null;
    for (const perm of permutations(n)) {
        const e = evaluateOrder(perm, D, T);
        if (!shortest || e.totalS < shortest.totalS - 1e-6) shortest = e;
        if (!fairest || e.worstS < fairest.worstS - 1e-6 || (Math.abs(e.worstS - fairest.worstS) <= 1e-6 && e.totalS < fairest.totalS)) fairest = e;
    }
    return { shortest, fairest };
}

// SHAPLEY fuel split (Section 5 / 28 #6). Players: the driver + every rider.
// A coalition's cost (litres):
//   with the driver     the cheapest car route from the start through ITS
//                       riders' pickups to the drop-off (Held-Karp, exact);
//   without the driver  its riders each going alone, straight to the
//                       drop-off, at the same km/L (their stand-alone cost).
// Each player pays their average marginal cost over every join order — so a
// rider whose pickup is on the way and who'd otherwise drive far alone pays
// less than one who drags the car 10 km off-route. Shares add up to the
// optimal carpool's cost; they're scaled to the plan actually driven.
function carpoolCoalitionCosts(D, n) {
    const dest = n + 1, FULL = 1 << n;
    const dp = Array.from({ length: FULL }, () => new Array(n).fill(Infinity));
    for (let j = 0; j < n; j++) dp[1 << j][j] = D[0][j + 1];
    for (let mask = 1; mask < FULL; mask++) {
        for (let j = 0; j < n; j++) {
            if (!(mask & (1 << j)) || dp[mask][j] === Infinity) continue;
            for (let k = 0; k < n; k++) {
                if (mask & (1 << k)) continue;
                const nm = mask | (1 << k), v = dp[mask][j] + D[j + 1][k + 1];
                if (v < dp[nm][k]) dp[nm][k] = v;
            }
        }
    }
    const routeM = new Array(FULL);
    routeM[0] = D[0][dest];
    for (let mask = 1; mask < FULL; mask++) {
        let best = Infinity;
        for (let j = 0; j < n; j++) if (mask & (1 << j)) best = Math.min(best, dp[mask][j] + D[j + 1][dest]);
        routeM[mask] = best;
    }
    return routeM;                                            // metres, indexed by rider bitmask
}
function shapleyCarpoolSplit(D, n, kmPerL) {
    const routeM = carpoolCoalitionCosts(D, n), dest = n + 1;
    const soloM = Array.from({ length: n }, (_, i) => D[i + 1][dest]);
    // player 0 = driver, players 1..n = riders; coalition bitmask over n+1 players
    const N = n + 1, fact = [1];
    for (let i = 1; i <= N; i++) fact[i] = fact[i - 1] * i;
    const costM = (m) => {
        const riders = m >> 1;
        if (m & 1) return routeM[riders];
        let s = 0;
        for (let i = 0; i < n; i++) if (riders & (1 << i)) s += soloM[i];
        return s;
    };
    const phi = new Array(N).fill(0);
    for (let p = 0; p < N; p++) {
        for (let m = 0; m < (1 << N); m++) {
            if (m & (1 << p)) continue;
            let size = 0; for (let q = m; q; q &= q - 1) size++;
            phi[p] += (fact[size] * fact[N - size - 1] / fact[N]) * (costM(m | (1 << p)) - costM(m));
        }
    }
    return { sharesM: phi, optimalM: routeM[(1 << n) - 1], litresPerM: 1 / (1000 * kmPerL) };
}

async function fetchCarpoolMatrix(points, avoid) {
    const coordStr = points.map((p) => `${p.lng},${p.lat}`).join(";");
    const base = `${OSRM_BASE}/table/v1/driving/${coordStr}?annotations=duration,distance`;
    const attempts = avoid.length > 1 ? [avoid, ...avoid.map((c) => [c]), []] : avoid.length === 1 ? [avoid, []] : [[]];
    for (const ex of attempts) {
        try {
            const res = await fetch(ex.length ? `${base}&exclude=${ex.join(",")}` : base, { signal: AbortSignal.timeout(8000) });
            let body = null;
            try { body = await res.json(); } catch { body = null; }
            const ok = body && body.code === "Ok" && Array.isArray(body.durations) && Array.isArray(body.distances) &&
                body.durations.every((r) => r.every(isFiniteNum)) && body.distances.every((r) => r.every(isFiniteNum));
            if (ok) return { D: body.distances, T: body.durations, applied: ex };
            if (!body || !/^(InvalidValue|InvalidOptions|InvalidQuery|NoTable|NoRoute)$/.test(body.code)) return null;
        } catch (e) { return null; }
    }
    return null;
}
async function fetchOrderedRoute(points, avoidApplied) {
    const coordStr = points.map((p) => `${p.lng},${p.lat}`).join(";");
    const url = `${OSRM_BASE}/route/v1/driving/${coordStr}?overview=full&geometries=geojson&steps=false${avoidApplied.length ? `&exclude=${avoidApplied.join(",")}` : ""}`;
    try {
        const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
        const body = await res.json();
        const r = body && body.code === "Ok" && body.routes && body.routes[0];
        return r && Array.isArray(r.legs) ? { geometry: r.geometry, legMeters: r.legs.map((l) => l.distance), durationSec: r.duration } : null;
    } catch (e) { return null; }
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
// 8. TRIP / IDENTITY LIFECYCLE HELPERS (called from applyOp only)
// ==========================================================================
// Removes a rider from their trip. A host leaving ends the trip for all.
// Returns the socket ids whose trip membership changed.
function removeFromTrip(socketId) {
    const t = tripOf(socketId);
    if (!t) return [];
    let affected;
    if (t.hostId === socketId) {
        trips.delete(t.id);
        affected = t.members.map((m) => m.id);
    } else {
        t.members = t.members.filter((m) => m.id !== socketId);
        affected = [socketId];
        pushTripFuelProfiles(t);
    }
    pushTripViews();
    return affected;
}
// Membership changes can change precision (approx -> exact inside a trip),
// trip-only sharing and circles-only visibility — in BOTH directions: how
// others see the rider, and how the rider sees everyone else.
function afterMembershipChange(socketIds) {
    for (const sid of socketIds) {
        const u = users.get(sid);
        if (!u) continue;
        refreshUserVisibility(u);
        refreshViewer(sid);
        emitPrivacyState(u);
    }
}

// Each trip member's own fuel profile (stated km/L, "not set" -> default and
// flagged, walkers burn nothing), sent ONLY to the members of that trip so
// each phone's trip panel can cost every rider at their own km/L. Re-sent
// when the roster, anyone's km/L or anyone's Walk session changes.
function tripFuelProfiles(t) {
    if (!t) return null;
    const profiles = {};
    t.members.forEach((m) => {
        const u = users.get(m.id);
        if (!u) return;
        const fp = riderFuelProfile(u);
        profiles[m.id] = { kmPerL: fp.motorised ? fp.kmPerL : null, assumed: fp.assumed, walking: !fp.motorised };
    });
    return profiles;
}
function pushTripFuelProfiles(t) {
    if (!t) return;
    const profiles = tripFuelProfiles(t);
    const payload = { tripId: t.id, profiles, defaultKmPerL: DEFAULT_KM_PER_L };
    t.members.forEach((m) => emitLocal(m.id, "tripFuelProfiles", payload));
}

// Mobile sockets get a NEW id on every reconnect. Carry trip role / roster
// state over to it so a network blip does not end the squad's trip.
function migrateIdentity(oldId, newId) {
    let inTrip = false;
    for (const t of trips.values()) {
        if (t.hostId === oldId) { t.hostId = newId; inTrip = true; }
        t.members.forEach((m) => { if (m.id === oldId) { m.id = newId; inTrip = true; } });
    }
    if (voiceSquadMembers.delete(oldId)) emitAllLocal("voice-squad-member-left", { id: oldId });
    users.delete(oldId);
    forgetSocketCounters(oldId);
    lastTripSent.delete(oldId);
    emitAllLocal("friendDisconnected", oldId);
    return inTrip;
}

function clearLocalDeparture(deviceId) {
    const pending = pendingDeparture.get(deviceId);
    if (pending) { clearTimeout(pending); pendingDeparture.delete(deviceId); }
}
function armDeparture(user, ms) {
    const sid = user.id;
    const timer = setTimeout(() => {
        if (user.deviceId && pendingDeparture.get(user.deviceId) === timer) pendingDeparture.delete(user.deviceId);
        commit({ t: "depart", sid }).catch((e) => console.warn("depart op failed:", e.message));
    }, ms);
    timer.unref?.();
    if (user.deviceId) pendingDeparture.set(user.deviceId, timer);
}
// Drop a user from every structure (after the grace period, or when the
// process that held their socket died).
function dropUser(socketId) {
    const user = users.get(socketId);
    if (!user) return;
    if (user.deviceId) {
        clearLocalDeparture(user.deviceId);
        if (deviceToSocket.get(user.deviceId) === socketId) deviceToSocket.delete(user.deviceId);
    }
    const affected = removeFromTrip(socketId).filter((id) => id !== socketId);
    if (voiceSquadMembers.delete(socketId)) emitAllLocal("voice-squad-member-left", { id: socketId });
    users.delete(socketId);
    forgetSocketCounters(socketId);   // relay throttles can re-create keys after disconnect
    lastTripSent.delete(socketId);
    emitAllLocal("friendDisconnected", socketId);
    afterMembershipChange(affected);
}

// ---- Phase 4: radio relay frames ---------------------------------------------
// rid (hex) -> live user record for every verified member of the trip.
function relayRosterMap(trip) {
    const out = new Map();
    if (!trip) return out;
    for (const m of trip.members) {
        const u = users.get(m.id);
        if (u && u.deviceId) out.set(relayRidFor(trip.id, u.deviceId).toString("hex"), u);
    }
    return out;
}

// Frame layout (big-endian) — the client's ConvoyRelay writes exactly this:
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
            emitAllLocal("sos-alert", {
                id: u.id, name: u.name, lat: p.lat, lng: p.lng, alt: p.alt, ownerKey: ownerKeyFor(u.deviceId),
                via: "radio", relayedBy: uploader.name, at: tsMs
            });
        }
    }

    // Position part (SOS frames carry one too).
    let posStatus;
    if (u.sharingMode === "off" || !sharingActive(u)) posStatus = "sharing-off";
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
// 8b. OPERATIONS — the only code that changes shared state
// ==========================================================================
// op.t selects the handler; op.now is the op's own clock (never Date.now()
// in here); ids are generated by whoever commits. `mine` is true on the
// process that committed the op: only it writes to SQLite and arms timers.
const OPS = {
    "profile"(op) {
        const { sid, deviceId } = op;
        const existing = users.get(sid);
        let carried = null, movedTrip = false;
        if (deviceId) {
            clearLocalDeparture(deviceId);
            const stale = Array.from(users.values()).find((u) => u.deviceId === deviceId && u.id !== sid) || null;
            if (stale) {
                // Same device reconnected (new socket id, maybe on another
                // process): the newest socket wins and keeps the ride going.
                carried = { sessionMode: stale.sessionMode, sessionId: stale.sessionId, sessionStartedAt: stale.sessionStartedAt, relayCapable: stale.relayCapable };
                const staleSock = localSocket(stale.id);
                movedTrip = migrateIdentity(stale.id, sid);
                if (staleSock) staleSock.disconnect(true);
            }
            deviceToSocket.set(deviceId, sid);
        }
        const user = {
            id: sid, node: op.node, deviceId, verified: Boolean(op.verified), name: op.name, avatar: op.avatar, online: true,
            sharingMode: op.prefs.sharingMode, visibility: op.prefs.visibility, tripOnly: Boolean(op.prefs.tripOnly),
            circleIds: Array.isArray(op.circleIds) ? op.circleIds : [],
            sessionMode: existing?.sessionMode || carried?.sessionMode || null,
            sessionId: existing?.sessionId || carried?.sessionId || null,
            sessionStartedAt: existing?.sessionStartedAt || carried?.sessionStartedAt || null,
            relayCapable: Boolean(existing?.relayCapable || carried?.relayCapable),
            lat: null, lng: null, lastFix: null, spoofStrikes: 0
        };
        users.set(sid, user);
        if (movedTrip) pushTripViews();
        emitUserEvent("userOnline", user, sid);
        return { ok: true };
    },

    "loc"(op) {
        const user = users.get(op.sid);
        if (!user) return { ok: false, reason: "no-profile" };
        if (user.sharingMode === "off" || !sharingActive(user)) return { ok: false, reason: "not-sharing" };
        // Android app in the background: its socket may be gone, but native
        // fixes keep the rider live on everyone's map.
        if (op.bg) {
            user.bgAt = op.now;
            if (user.online === false) { user.online = true; user.bgOnly = true; }
        }
        // Teleport rejection: > 300 km/h between fixes is physically implausible
        // for this app. The baseline is server time (client clocks are
        // untrusted). After 3 consecutive rejections the new position is
        // accepted as the baseline so a legitimate relocation cannot lock a
        // rider out forever.
        const now = op.now;
        if (user.lastFix) {
            const dtH = (now - user.lastFix.ts) / 3_600_000;
            const dKm = distanceKm(user.lastFix.lat, user.lastFix.lng, op.lat, op.lng);
            if (dKm > 0.2 && dtH > 0 && dKm / dtH > MAX_PLAUSIBLE_KMH && user.spoofStrikes < 3) {
                user.spoofStrikes++;
                emitLocal(op.sid, "locationRejected", { reason: "implausible-jump", strikes: user.spoofStrikes });
                return { ok: false, reason: "implausible-jump" };
            }
        }
        user.spoofStrikes = 0;
        const oldLat = user.lat, oldLng = user.lng;
        user.lat = op.lat;
        user.lng = op.lng;
        user.lastFix = { lat: op.lat, lng: op.lng, ts: now };
        user.alt = op.alt;
        user.speedKmh = op.speedKmh;
        user.accuracy = op.accuracy;
        if (op.weather) user.weather = op.weather;
        // Phase 4: dead-reckoned position (the rider has data but no GPS —
        // e.g. an urban tunnel). A direct update always ends any radio relay.
        user.est = op.est === true;
        user.via = null; user.relayedBy = null; user.fixAt = null;
        user.posTs = now;
        // Approximate viewers move between 1 km cells rarely; don't re-send
        // the same snapped cell more than every 30 s.
        const cell = snapToGrid(op.lat, op.lng);
        const sameCell = Boolean(user.lastApproxSent && user.lastApproxSent.lat === cell.lat && user.lastApproxSent.lng === cell.lng && now - user.lastApproxSent.ts < 30_000);
        if (!sameCell) user.lastApproxSent = { lat: cell.lat, lng: cell.lng, ts: now };
        emitUserEvent("friendMoved", user, op.sid, { skipApprox: sameCell });
        checkGeofences(user, oldLat, oldLng, now);
        return { ok: true };
    },

    "chat.add"(op, mine) {
        const m = op.msg;
        if (chatMessages.some((x) => x.id === m.id)) return { ok: true, duplicate: true };
        chatMessages.push(m);
        if (chatMessages.length > CHAT_RAM_LIMIT) chatMessages.shift();
        if (mine) {
            try {
                stmt.insertChat.run(m.id, m.deviceId, m.senderId, m.name, m.type, m.body, m.fileName, m.replyTo ? JSON.stringify(m.replyTo) : null, JSON.stringify(m.reactions), Date.parse(m.time));
            } catch (e) { console.error("chat insert failed:", e.message); }
        }
        emitAllLocal("chatMessage", publicChat(m));
        return { ok: true };
    },

    "chat.react"(op, mine) {
        const msg = chatMessages.find((m) => m.id === op.messageId);
        if (!msg || !msg.reactions || !Array.isArray(msg.reactions[op.emoji])) return { ok: false };
        const list = msg.reactions[op.emoji];
        const idx = list.indexOf(op.key);
        if (idx > -1) {
            list.splice(idx, 1);
        } else {
            for (const e of Object.keys(msg.reactions)) {
                const i = msg.reactions[e].indexOf(op.key);
                if (i > -1) msg.reactions[e].splice(i, 1);
            }
            list.push(op.key);
        }
        if (mine) { try { stmt.updateChatReactions.run(JSON.stringify(msg.reactions), msg.id); } catch (e) { console.error("reaction save failed:", e.message); } }
        emitAllLocal("messageReaction", { messageId: msg.id, reactions: msg.reactions });
        return { ok: true };
    },

    "chat.purge"(op) {
        const cutoff = op.before;
        const removed = chatMessages.filter((m) => Date.parse(m.time) < cutoff).map((m) => m.id);
        if (!removed.length) return { ok: true, removed: 0 };
        for (let i = chatMessages.length - 1; i >= 0; i--) if (Date.parse(chatMessages[i].time) < cutoff) chatMessages.splice(i, 1);
        emitAllLocal("chatMessagesRemoved", { ids: removed });
        return { ok: true, removed: removed.length };
    },

    "typing"(op) {
        const user = users.get(op.sid);
        if (user) emitAllLocalExcept(op.sid, "typing", { id: op.sid, name: user.name, isTyping: Boolean(op.isTyping) });
    },

    "geofence.add"(op, mine) {
        const user = users.get(op.sid);
        if (!user) return { ok: false };
        if (geofences.some((f) => f.id === op.fence.id)) return { ok: true };
        if (geofences.length >= MAX_GEOFENCES_TOTAL) return { ok: false, reason: "too-many" };
        const mineCount = geofences.filter((f) => (user.deviceId ? f.ownerDeviceId === user.deviceId : f.ownerId === op.sid)).length;
        if (mineCount >= MAX_GEOFENCES_PER_OWNER) return { ok: false, reason: "too-many-yours" };
        const fence = { ...op.fence, ownerId: op.sid, ownerName: user.name, ownerDeviceId: user.deviceId || null };
        geofences.push(fence);
        if (mine) { try { stmt.insertGeofence.run(fence.id, fence.name, fence.lat, fence.lng, fence.radius, fence.ownerDeviceId); } catch (e) { console.error("geofence insert failed:", e.message); } }
        emitAllLocal("loadGeofences", geofences.map(publicFence));
        return { ok: true };
    },

    "geofence.remove"(op, mine) {
        const user = users.get(op.sid);
        const fence = geofences.find((f) => f.id === op.id);
        if (!user || !fence) return { ok: false };
        // Ownership follows the DEVICE, so it survives reconnects and restarts.
        const owns = fence.ownerDeviceId ? fence.ownerDeviceId === user.deviceId : fence.ownerId === op.sid;
        if (!owns) return { ok: false };
        geofences = geofences.filter((f) => f.id !== op.id);
        if (mine) { try { stmt.deleteGeofence.run(op.id); } catch (e) { console.error("geofence delete failed:", e.message); } }
        emitAllLocal("loadGeofences", geofences.map(publicFence));
        return { ok: true };
    },

    "trip.start"(op) {
        const user = users.get(op.sid);
        if (!user) return { ok: false, reason: "no-profile" };
        const cur = tripOf(op.sid);
        if (cur && cur.hostId !== op.sid) {
            emitLocal(op.sid, "tripError", { reason: "already-in-trip" });   // leave that one first
            return { ok: false, reason: "already-in-trip" };
        }
        let circleId = null, circleName = null;
        if (op.circleId) {
            if (!user.circleIds.includes(op.circleId)) {
                emitLocal(op.sid, "tripError", { reason: "not-in-circle" });
                return { ok: false, reason: "not-in-circle" };
            }
            circleId = op.circleId; circleName = op.circleName || null;
        }
        const dropped = [];
        if (cur) {                                   // the host restarts: their old trip ends
            trips.delete(cur.id);
            cur.members.forEach((m) => { if (m.id !== op.sid) dropped.push(m.id); });
        }
        const trip = {
            id: op.tripId, name: op.name, lat: op.lat, lng: op.lng, hostId: op.sid,
            members: [{ id: op.sid, name: user.name }], circleId, circleName, startedAt: op.now
        };
        trips.set(trip.id, trip);
        pushTripViews();
        pushTripFuelProfiles(trip);
        afterMembershipChange([op.sid, ...dropped]);
        return { ok: true, tripId: trip.id };
    },

    "trip.join"(op) {
        const user = users.get(op.sid);
        if (!user || tripOf(op.sid)) return { ok: false };
        const target = op.tripId ? trips.get(op.tripId) : tripFor(op.sid);
        if (!target || !canSeeTrip(target, op.sid)) return { ok: false, reason: "no-trip" };
        target.members.push({ id: op.sid, name: user.name });
        pushTripViews();
        pushTripFuelProfiles(target);
        afterMembershipChange([op.sid]);
        return { ok: true };
    },

    "trip.leave"(op) {
        const affected = removeFromTrip(op.sid);
        afterMembershipChange(affected.length ? affected : [op.sid]);
        return { ok: true };
    },

    "memory.add"(op, mine) {
        const m = op.memory;
        if (memories.some((x) => x.id === m.id)) return { ok: true };
        memories.push(m);
        if (memories.length > MAX_MEMORIES_IN_RAM) memories.shift();
        if (mine) {
            try { stmt.insertMemory.run(m.id, m.deviceId, m.name, m.lat, m.lng, m.ref, m.caption, m.tripId, Date.parse(m.time)); }
            catch (e) { console.error("memory insert failed:", e.message); }
        }
        emitAllLocal("newMemoryPin", publicMemory(m));
        return { ok: true };
    },

    "sos"(op) {
        const user = users.get(op.sid);
        if (!user) return;
        user.lastSosAt = op.now;          // Phase 4: a radio copy of this SOS won't re-alert
        emitAllLocalExcept(op.sid, "sos-alert", {
            id: op.sid, name: op.name, lat: op.lat, lng: op.lng, alt: op.alt,
            ownerKey: ownerKeyFor(user.deviceId), at: op.now   // Phase 4: lets clients de-dupe radio + server copies
        });
    },

    "voice.join"(op) {
        const user = users.get(op.sid);
        if (!user) return;
        const existingRoster = Array.from(voiceSquadMembers.values()).filter((m) => m.id !== op.sid);
        voiceSquadMembers.set(op.sid, { id: op.sid, name: user.name, avatar: user.avatar });
        emitLocal(op.sid, "voice-squad-roster", { members: existingRoster });
        emitAllLocalExcept(op.sid, "voice-squad-member-joined", { id: op.sid, name: user.name, avatar: user.avatar });
    },

    "voice.leave"(op) {
        if (voiceSquadMembers.delete(op.sid)) emitAllLocal("voice-squad-member-left", { id: op.sid });
    },

    "session.start"(op) {
        const user = users.get(op.sid);
        if (!user) return { ok: false, reason: "no-profile" };
        const wasActive = sharingActive(user);
        user.sessionMode = op.mode;
        user.sessionId = op.sessionId;
        user.sessionStartedAt = op.now;
        pushTripFuelProfiles(tripOf(op.sid));          // walking burns no fuel
        if (!wasActive) refreshUserVisibility(user);   // trip-only rider starts sharing
        const payload = { mode: user.sessionMode, sessionId: user.sessionId, startedAt: user.sessionStartedAt };
        emitLocal(op.sid, "sessionStarted", payload);
        emitPrivacyState(user);
        return { ok: true, ...payload };
    },

    "session.end"(op) {
        const user = users.get(op.sid);
        if (!user) return { ok: false, reason: "no-profile" };
        const summary = { sessionId: user.sessionId, durationSec: user.sessionStartedAt ? Math.round((op.now - user.sessionStartedAt) / 1000) : 0 };
        user.sessionMode = null; user.sessionId = null; user.sessionStartedAt = null;
        pushTripFuelProfiles(tripOf(op.sid));
        if (!sharingActive(user)) {
            // Trip-only rider stopped: forget the live fix, vanish from maps.
            user.lat = null; user.lng = null; user.lastFix = null; user.lastApproxSent = null;
            refreshUserVisibility(user);
        }
        emitLocal(op.sid, "sessionEnded", summary);
        emitPrivacyState(user);
        return { ok: true, ...summary };
    },

    "prefs"(op) {
        const user = users.get(op.sid);
        if (!user) return { ok: false };
        if (SHARING_MODES.includes(op.sharingMode)) user.sharingMode = op.sharingMode;
        if (VISIBILITY_SCOPES.includes(op.visibility)) user.visibility = op.visibility;
        if (typeof op.tripOnly === "boolean") user.tripOnly = op.tripOnly;
        user.lastApproxSent = null;
        if (user.sharingMode === "off" || !sharingActive(user)) {
            user.lat = null; user.lng = null; user.lastFix = null;   // do not retain a precise fix we may no longer share
        }
        refreshUserVisibility(user);
        emitLocal(op.sid, "sharingChanged", { mode: user.sharingMode });
        emitPrivacyState(user);
        return { ok: true, privacy: privacyState(user) };
    },

    "mileage"(op) {
        const user = users.get(op.sid);
        if (!user) return;
        user.kmPerL = op.kmPerL;
        // Trip-mates' panels cost this rider at their own km/L; also sent after
        // every (re)connect, which is how a reconnected rider's new socket id
        // gets its profile back into the trip.
        pushTripFuelProfiles(tripOf(op.sid));
    },

    "relay.capable"(op) {
        const user = users.get(op.sid);
        if (user) user.relayCapable = true;   // earns the longer reconnect grace
    },

    "relay.frames"(op) {
        const uploader = users.get(op.sid);
        if (!uploader?.deviceId) return { ok: false, reason: "no-device-identity" };
        const trip = tripOf(op.sid);
        if (!trip) return { ok: false, reason: "not-in-trip" };
        const roster = relayRosterMap(trip);
        const results = op.frames.map((f, i) => {
            const fr = openRelayFrame(f, trip.id, roster);
            const out = { i, status: fr.status };
            if (fr.rid) Object.assign(out, { rid: fr.rid, ts: fr.ts, seq: fr.seq, type: fr.type });
            if (fr.status === "ok") out.status = applyRelayFrame(fr, uploader, op.now);
            return out;
        });
        return { ok: true, results };
    },

    "disconnect"(op, mine) {
        const user = users.get(op.sid);
        if (!user) return;
        user.online = false;
        user.offlineSince = op.now;      // Phase 4: radio grace is measured from here
        for (const [sid, sock] of io.sockets.sockets) {
            if (sid !== op.sid && viewLevel(user, sid) !== "hidden") sock.emit("userOffline", { id: op.sid });
        }
        // Hold trip role/roster for a grace window so a tunnel or an
        // Wi-Fi<->LTE handover does not end the squad's trip.
        if (mine) armDeparture(user, user.deviceId ? RECONNECT_GRACE_MS : 5000);
    },

    // Android app: its background-location service is running (see
    // /api/native/location). Only arms the depart hold; changes nothing visible.
    "bgseen"(op) {
        const user = users.get(op.sid);
        if (user) user.bgAt = op.now;
    },

    "depart"(op, mine) {
        const user = users.get(op.sid);
        if (!user || (user.online && !user.bgOnly)) return; // came back in the meantime
        // Android app in the background, still sending native fixes: keep them.
        if (user.bgAt && op.now - user.bgAt < NATIVE_BG_HOLD_MS) {
            if (mine) armDeparture(user, 60_000);
            return;
        }
        // Phase 4: a rider out of data but still being relayed over radio is
        // still IN the convoy — keep their trip seat instead of dropping them.
        // A radio-equipped rider also gets a longer grace for the first relay.
        const now = op.now;
        const relayedRecently = Boolean(user.relayedAt && now - user.relayedAt < RELAY_HOLD_MS);
        const radioGrace = Boolean(user.relayCapable && user.offlineSince && now - user.offlineSince < RELAY_RADIO_GRACE_MS);
        if ((relayedRecently || radioGrace) && isInActiveTrip(op.sid)) {
            if (mine) armDeparture(user, Math.min(30_000, RELAY_HOLD_MS));
            return;
        }
        dropUser(op.sid);
    },

    "history.deleted"(op) {
        const { deviceId } = op;
        for (let i = memories.length - 1; i >= 0; i--) if (memories[i].deviceId === deviceId) memories.splice(i, 1);
        geofences = geofences.filter((f) => f.ownerDeviceId !== deviceId);
        const removedChat = [];
        for (let i = chatMessages.length - 1; i >= 0; i--) if (chatMessages[i].deviceId === deviceId) { removedChat.push(chatMessages[i].id); chatMessages.splice(i, 1); }
        if (op.includeIdentity) {
            for (const u of users.values()) {
                if (u.deviceId === deviceId) { u.deviceId = null; u.verified = false; u.circleIds = []; }
            }
            deviceToSocket.delete(deviceId);
        }
        emitAllLocal("loadMemoryPhotos", memories.map(publicMemory));
        emitAllLocal("loadGeofences", geofences.map(publicFence));
        if (removedChat.length) emitAllLocal("chatMessagesRemoved", { ids: removedChat });
        return { ok: true };
    },

    "circles.changed"(op) {
        const changed = [];
        for (const d of op.devices) {
            for (const u of users.values()) {
                if (u.deviceId === d.deviceId) { u.circleIds = d.circleIds.slice(); changed.push(u); }
            }
        }
        // Who sees whom may have changed in both directions.
        for (const u of changed) { refreshUserVisibility(u); refreshViewer(u.id); emitLocal(u.id, "circlesChanged", { circleIds: u.circleIds }); }
        pushTripViews();
        return { ok: true };
    },

    "node.hb"(op) {
        clusterNodes.set(op.node, op.now);
        heartbeatSeen.set(op.node, Date.now());   // local, for failure detection only
    },

    "node.gone"(op) {
        const gone = op.gone;
        clusterNodes.delete(gone);
        heartbeatSeen.delete(gone);
        if (gone === NODE_ID) {
            // The cluster gave up on this process (e.g. it was cut off from
            // Redis too long): drop our sockets so they reconnect and
            // re-register cleanly.
            for (const s of io.sockets.sockets.values()) s.disconnect(true);
            return;
        }
        for (const u of Array.from(users.values())) if (u.node === gone) dropUser(u.id);
    }
};

function applyOp(op) {
    const fn = OPS[op.t];
    if (!fn) return undefined;
    return fn(op, op.node === NODE_ID);
}

function snapshotState() {
    return {
        v: 1,
        users: Array.from(users.values()),
        trips: Array.from(trips.values()),
        voice: Array.from(voiceSquadMembers.values()),
        chat: chatMessages,
        memories,
        geofences,
        deviceToSocket: Array.from(deviceToSocket.entries()),
        nodes: Array.from(clusterNodes.entries())
    };
}
function restoreState(s) {
    users.clear(); (s.users || []).forEach((u) => users.set(u.id, u));
    trips.clear(); (s.trips || []).forEach((t) => trips.set(t.id, t));
    voiceSquadMembers.clear(); (s.voice || []).forEach((m) => voiceSquadMembers.set(m.id, m));
    chatMessages.splice(0, chatMessages.length, ...(s.chat || []));
    memories.splice(0, memories.length, ...(s.memories || []));
    geofences = s.geofences || [];
    deviceToSocket.clear(); (s.deviceToSocket || []).forEach(([k, v]) => deviceToSocket.set(k, v));
    clusterNodes.clear(); (s.nodes || []).forEach(([k, v]) => { clusterNodes.set(k, v); heartbeatSeen.set(k, Date.now()); });
}

// ---- Circles helpers (SQLite is the source of truth; users carry circleIds) --
const INVITE_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";   // no 0/O, 1/I/L
function newInviteCode() {
    for (let attempt = 0; attempt < 10; attempt++) {
        const b = crypto.randomBytes(8);
        let s = "";
        for (let i = 0; i < 8; i++) s += INVITE_ALPHABET[b[i] % INVITE_ALPHABET.length];
        const code = `${s.slice(0, 4)}-${s.slice(4)}`;
        if (!stmt.getCircleByCode.get(code)) return code;
    }
    throw new Error("could not mint a unique invite code");
}
function normalizeInviteCode(raw) {
    const s = String(raw || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
    return s.length === 8 ? `${s.slice(0, 4)}-${s.slice(4)}` : null;
}
const circleIdsOf = (deviceId) => stmt.circleIdsForDevice.all(deviceId).map((r) => r.circle_id);
function circleSummary(c, viewerDeviceId) {
    const members = stmt.circleMembers.all(c.id).map((m) => {
        const sid = deviceToSocket.get(m.device_id);
        const live = sid ? users.get(sid) : null;
        return {
            name: m.name || "Rider", ownerKey: ownerKeyFor(m.device_id),
            isOwner: m.device_id === c.owner_device_id, isYou: m.device_id === viewerDeviceId,
            online: Boolean(live && live.online !== false), joinedAt: m.joined_at
        };
    });
    return {
        id: c.id, name: c.name, inviteCode: c.invite_code, isOwner: c.owner_device_id === viewerDeviceId,
        members, memberCount: members.length, createdAt: c.created_at
    };
}
// Remove one device from one circle; the oldest remaining member inherits
// ownership, an empty circle is deleted. Returns the device ids affected.
function removeFromCircleDb(circleId, deviceId) {
    const c = stmt.getCircle.get(circleId);
    if (!c) return [];
    const before = stmt.circleMembers.all(circleId).map((m) => m.device_id);
    db.transaction(() => {
        stmt.deleteCircleMember.run(circleId, deviceId);
        const rest = stmt.circleMembers.all(circleId);
        if (rest.length === 0) stmt.deleteCircle.run(circleId);
        else if (c.owner_device_id === deviceId) stmt.setCircleOwner.run(rest[0].device_id, circleId);
    })();
    return before;
}
// Tell every process about new memberships for these devices.
function commitCircleChange(deviceIds) {
    const uniq = Array.from(new Set(deviceIds.filter(Boolean)));
    if (!uniq.length) return Promise.resolve();
    return commit({ t: "circles.changed", devices: uniq.map((d) => ({ deviceId: d, circleIds: circleIdsOf(d) })) });
}
function purgeMediaRefs(refs) {
    let n = 0;
    for (const r of refs) if (media.remove(r)) n++;
    return n;
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
        if (deviceId) stmt.upsertUser.run(deviceId, name, avatar, newHash, Date.now(), Date.now());

        // Privacy settings belong to the device and survive reconnects (they
        // used to fall back to "exact" on every new socket).
        const prefs = deviceId ? loadPrefs(deviceId) : {
            sharingMode: existing?.sharingMode || "exact", visibility: existing?.visibility || "everyone", tripOnly: Boolean(existing?.tripOnly)
        };
        const circleIds = deviceId ? circleIdsOf(deviceId) : [];

        return commitThen({ t: "profile", sid: socket.id, deviceId, verified: Boolean(deviceId), name, avatar, prefs, circleIds }, () => {
            const user = users.get(socket.id);
            if (!user || !socket.connected) return;
            socket.emit("profileAccepted", {
                ownerKey: ownerKeyFor(deviceId),
                deviceToken: issuedToken,                // null unless first registration
                sharingMode: user.sharingMode,
                privacy: privacyState(user),
                tripRetentionDays: TRIP_RETENTION_DAYS,
                chatRetentionDays: CHAT_RETENTION_DAYS
            });
            socket.emit("chatHistory", chatMessages.map(publicChat));
            socket.emit("loadMemoryPhotos", memories.map(publicMemory));
            socket.emit("loadGeofences", geofences.map(publicFence));
            socket.emit("onlineUsers", visibleUsersFor(socket.id));
            const t = publicTrip(tripFor(socket.id));
            lastTripSent.set(socket.id, JSON.stringify(t));
            if (t) socket.emit("tripData", t);
        });
    }));

    // --- B. LIVE LOCATION + ANTI-SPOOF + GEOFENCE CHECK ---------------------
    socket.on("updateLocation", safeHandler(socket, (data) => {
        const user = users.get(socket.id);
        if (!user || !data || !isValidCoordPair(data.lat, data.lng)) return;
        // Not sharing (off, or trip-only and not riding): drop at the door.
        if (user.sharingMode === "off" || !sharingActive(user)) return;
        return commit({
            t: "loc", sid: socket.id, lat: data.lat, lng: data.lng,
            alt: isFiniteNum(data.alt) ? data.alt : null,
            speedKmh: isFiniteNum(data.speedKmh) ? clampNum(data.speedKmh, 0, 300, 0) : 0,
            accuracy: isFiniteNum(data.accuracy) ? clampNum(data.accuracy, 0, 100000, null) : null,
            weather: isNonEmptyStr(data.weather, 40) ? data.weather : null,
            est: data.est === true
        });
    }, "location"));

    // --- C. CHAT --------------------------------------------------------------
    // Text is stored as-is; attachments are decoded, type-checked by their
    // bytes and written to MEDIA_DIR/chat — clients get a /media/ URL, never
    // the raw data-URL (which also closes an HTML-injection hole: the old
    // server relayed any string as an "image" src).
    socket.on("chatMessage", safeHandler(socket, (data) => {
        const user = users.get(socket.id);
        if (!user || !data || !ALLOWED_MSG_TYPES.includes(data.type)) return;
        if (data.type === "text" && !isNonEmptyStr(data.data, 1000)) return;
        let body = null, fileName = null;
        if (data.type === "text") body = data.data;
        else {
            if (typeof data.data !== "string" || data.data.length === 0 || data.data.length > MAX_CHAT_MEDIA_B64_LEN) return;
            if (!/^data:[a-z0-9.+-]+\/[a-z0-9.+-]+(;[a-z0-9=._+-]+)*;base64,/i.test(data.data.slice(0, 200))) return socket.emit("chatRejected", { reason: "not-a-data-url", type: data.type });
            if (!throttle(socket.id, "chatMedia", 1500)) return socket.emit("chatRejected", { reason: "too-frequent" });
            const saved = media.saveDataUrl(data.data, `chat-${data.type}`, "chat", MAX_CHAT_MEDIA_BYTES);
            if (!saved.ok) return socket.emit("chatRejected", { reason: saved.reason, type: data.type });
            body = saved.ref;
            if (isNonEmptyStr(data.fileName, 120)) fileName = data.fileName.replace(/[\\/:*?"<>|\u0000-\u001f]/g, "_").trim().slice(0, 120) || null;
        }
        const msg = {
            id: generateId(), senderId: socket.id, deviceId: user.deviceId || null, name: clampStr(data.name || user.name, 40),
            type: data.type, body, fileName, replyTo: sanitizeReplyTo(data.replyTo),
            time: new Date().toISOString(), reactions: emptyReactions()
        };
        const p = commit({ t: "chat.add", msg });
        if (data.type !== "text") p.catch(() => media.remove(body));
        return p;
    }));

    socket.on("typing", safeHandler(socket, (isTyping) => {
        if (!users.has(socket.id)) return;
        if (!throttle(socket.id, `typing${Boolean(isTyping)}`, 800)) return;
        return commit({ t: "typing", sid: socket.id, isTyping: Boolean(isTyping) });
    }));

    socket.on("messageReaction", safeHandler(socket, (data) => {
        // THE CRASH FIX: emoji is validated against an allow-list and the
        // reaction array's existence is checked BEFORE any property access.
        const user = users.get(socket.id);
        if (!user || !data || !isNonEmptyStr(data.messageId, 60) || !REACTION_EMOJIS.includes(data.emoji)) return;
        // Keyed by device (pseudonymous ownerKey), so a reaction survives the
        // rider's reconnects and a server restart.
        const key = user.deviceId ? ownerKeyFor(user.deviceId) : `s:${socket.id}`;
        return commit({ t: "chat.react", sid: socket.id, messageId: data.messageId, emoji: data.emoji, key });
    }));

    // --- D. GEOFENCING ----------------------------------------------------------
    socket.on("addGeofence", safeHandler(socket, (data) => {
        const user = users.get(socket.id);
        if (!user || !data || !isNonEmptyStr(data.name, 60) || !isValidCoordPair(data.lat, data.lng) || !isValidRadius(data.radius)) return;
        return commit({
            t: "geofence.add", sid: socket.id,
            fence: { id: generateId(), name: clampStr(data.name, 60).trim(), lat: data.lat, lng: data.lng, radius: Math.round(data.radius) }
        });
    }));

    socket.on("removeGeofence", safeHandler(socket, (id) => {
        if (!users.has(socket.id) || !isNonEmptyStr(id, 60)) return;
        return commit({ t: "geofence.remove", sid: socket.id, id });
    }));

    // --- E. GROUP TRIP ----------------------------------------------------------
    // startTrip {name, lat, lng, circleId?} — with a circleId, only that
    // circle sees (and can join) the trip. Several trips can run at once.
    socket.on("startTrip", safeHandler(socket, (data) => {
        const user = users.get(socket.id);
        if (!user || !data || !isNonEmptyStr(data.name, 80) || !isValidCoordPair(data.lat, data.lng)) return;
        let circleId = null, circleName = null;
        if (data.circleId != null && data.circleId !== "") {
            if (!isNonEmptyStr(data.circleId, 60) || !user.deviceId) return socket.emit("tripError", { reason: "not-in-circle" });
            const c = stmt.getCircle.get(data.circleId);
            if (!c || !stmt.isCircleMember.get(c.id, user.deviceId)) return socket.emit("tripError", { reason: "not-in-circle" });
            circleId = c.id; circleName = c.name;
        }
        return commit({
            t: "trip.start", sid: socket.id, tripId: generateId(), name: clampStr(data.name, 80).trim(),
            lat: data.lat, lng: data.lng, circleId, circleName
        });
    }));

    socket.on("joinTrip", safeHandler(socket, (data) => {
        if (!users.has(socket.id)) return;
        const tripId = isNonEmptyStr(data?.tripId, 60) ? data.tripId : null;
        return commit({ t: "trip.join", sid: socket.id, tripId });
    }));

    socket.on("leaveTrip", safeHandler(socket, () => {
        if (!users.has(socket.id)) return;
        return commit({ t: "trip.leave", sid: socket.id });
    }));

    // --- F. MEMORIES ------------------------------------------------------------
    socket.on("uploadMemoryPhoto", safeHandler(socket, (data) => {
        const user = users.get(socket.id);
        if (!user || !data || !isValidCoordPair(data.lat, data.lng)) return;
        if (typeof data.image !== "string" || data.image.length > MAX_MEMORY_IMAGE_B64_LEN || !IMAGE_DATA_URL_RE.test(data.image.slice(0, 40))) return;
        if (!throttle(socket.id, "memory", 1500)) return socket.emit("memoryRejected", { reason: "too-frequent" });
        const saved = media.saveDataUrl(data.image, "memories", "memories", MAX_MEMORY_IMAGE_BYTES);
        if (!saved.ok) return socket.emit("memoryRejected", { reason: saved.reason });

        const time = data.time && !isNaN(Date.parse(data.time)) ? new Date(data.time).toISOString() : new Date().toISOString();
        const memory = {
            id: generateId(), name: clampStr(data.name || user.name, 40), lat: data.lat, lng: data.lng,
            ref: saved.ref, caption: clampStr(data.caption, 140), time,
            deviceId: user.deviceId || null, tripId: tripOf(socket.id)?.id || null
        };
        return commit({ t: "memory.add", memory }).catch((e) => { media.remove(saved.ref); throw e; });
    }));

    // --- G. EMERGENCY SOS (deliberately exact, to everyone — it is an emergency) -
    socket.on("sos-alert", safeHandler(socket, (data) => {
        const user = users.get(socket.id);
        if (!user || !data || !isValidCoordPair(data.lat, data.lng)) return;
        if (!throttle(socket.id, "sos", 5000)) return;
        return commit({
            t: "sos", sid: socket.id, name: clampStr(data.name || user.name, 40), lat: data.lat, lng: data.lng,
            alt: isFiniteNum(data.alt) ? data.alt : null
        });
    }));

    // --- H. WEBRTC 1:1 SIGNALLING (payloads validated; sender attached) ----------
    // sendTo() reaches the callee on whichever process holds their socket.
    socket.on("call-user", safeHandler(socket, (data) => {
        if (!users.has(socket.id) || !data || !isNonEmptyStr(data.to, 40) || !users.has(data.to) || !isSignalPayload(data.signal)) return;
        sendTo(data.to, "incoming-call", { from: socket.id, name: clampStr(data.name || "", 40), signal: data.signal });
    }));
    socket.on("answer-call", safeHandler(socket, (data) => {
        if (!users.has(socket.id) || !data || !isNonEmptyStr(data.to, 40) || !users.has(data.to) || !isSignalPayload(data.signal)) return;
        // Extra 2nd arg carries the answerer's id; the old client ignores it.
        sendTo(data.to, "call-accepted", data.signal, socket.id);
    }));
    socket.on("end-call", safeHandler(socket, (data) => {
        if (!data || !isNonEmptyStr(data.to, 40)) return;
        sendTo(data.to, "call-ended", socket.id);
    }));

    // --- I. GROUP VOICE — roster + per-peer signalling relay ---------------------
    // The mesh is client-orchestrated (VoiceSquad): each newcomer opens one
    // RTCPeerConnection per existing member and signals over `voice-signal`,
    // which (unlike call-accepted) always carries `from`, so many simultaneous
    // legs cannot be confused. Only members of the roster may signal each other.
    socket.on("join-voice-squad", safeHandler(socket, () => {
        if (!users.has(socket.id)) return;
        return commit({ t: "voice.join", sid: socket.id });
    }));

    socket.on("voice-signal", safeHandler(socket, (data) => {
        if (!data || !isNonEmptyStr(data.to, 40) || !isSignalPayload(data.signal)) return;
        if (!voiceSquadMembers.has(socket.id) || !voiceSquadMembers.has(data.to)) return;
        sendTo(data.to, "voice-signal", { from: socket.id, signal: data.signal });
    }));

    socket.on("leave-voice-squad", safeHandler(socket, () => {
        if (!voiceSquadMembers.has(socket.id)) return;
        return commit({ t: "voice.leave", sid: socket.id });
    }));

    // --- J. SESSION + SHARING CONTROL (privacy) ----------------------------------
    socket.on("startSession", safeHandler(socket, (data, ack) => {
        if (!users.has(socket.id)) return typeof ack === "function" && ack({ ok: false, reason: "no-profile" });
        return commitThen({ t: "session.start", sid: socket.id, mode: normalizeMode(data?.mode), sessionId: generateId() },
            (r) => { if (typeof ack === "function") ack(r); });
    }));

    socket.on("endSession", safeHandler(socket, (_data, ack) => {
        if (!users.has(socket.id)) return typeof ack === "function" && ack({ ok: false, reason: "no-profile" });
        return commitThen({ t: "session.end", sid: socket.id }, (r) => { if (typeof ack === "function") ack(r); });
    }));

    // setSharing: {mode: "exact"|"approx"|"off"}  (legacy {enabled:boolean} still works)
    // setPrivacy: {sharingMode?, visibility?: "everyone"|"circles", tripOnly?: boolean}
    // Both persist per device, so the choice survives reconnects and restarts.
    function applyPrivacy(patch, ack) {
        const user = users.get(socket.id);
        if (!user) return typeof ack === "function" && ack({ ok: false, reason: "no-profile" });
        const next = {
            sharingMode: SHARING_MODES.includes(patch.sharingMode) ? patch.sharingMode : user.sharingMode,
            visibility: VISIBILITY_SCOPES.includes(patch.visibility) ? patch.visibility : user.visibility,
            tripOnly: typeof patch.tripOnly === "boolean" ? patch.tripOnly : Boolean(user.tripOnly)
        };
        if (next.visibility === "circles" && !user.deviceId) return typeof ack === "function" && ack({ ok: false, reason: "no-device-identity" });
        if (user.deviceId) stmt.setPrefs.run(next.sharingMode, next.visibility, next.tripOnly ? 1 : 0, user.deviceId);
        return commitThen({ t: "prefs", sid: socket.id, ...next }, (r) => { if (typeof ack === "function") ack(r); });
    }
    socket.on("setSharing", safeHandler(socket, (data, ack) => {
        const mode = SHARING_MODES.includes(data?.mode) ? data.mode : (data?.enabled === false ? "off" : "exact");
        return applyPrivacy({ sharingMode: mode }, ack);
    }));
    socket.on("setPrivacy", safeHandler(socket, (data, ack) => {
        if (!data || typeof data !== "object") return typeof ack === "function" && ack({ ok: false, reason: "bad-request" });
        return applyPrivacy({ sharingMode: data.sharingMode, visibility: data.visibility, tripOnly: data.tripOnly }, ack);
    }));

    // The rider's own stated mileage (km/L) — the app's fuel-efficiency setting.
    // Kept on the live user only (re-sent after every profileAccepted), used by
    // the fuel-aware meetup strategy. Never broadcast.
    socket.on("setMileage", safeHandler(socket, (data) => {
        if (!users.has(socket.id) || !data) return;
        let kmPerL;
        if (data.kmPerL === null) kmPerL = null;
        else if (isFiniteNum(data.kmPerL) && data.kmPerL >= 1 && data.kmPerL <= 100) kmPerL = Math.round(data.kmPerL * 10) / 10;
        else return;
        return commit({ t: "mileage", sid: socket.id, kmPerL });
    }));

    // --- J2. FRIEND CIRCLES --------------------------------------------------------
    // A circle is a named group joined with an invite code. A rider whose
    // audience is "My circles" is seen only by people who share a circle
    // with them (plus whoever is in the same trip). Trips can be started for
    // one circle. Only verified devices can be in circles.
    const needDevice = (ack) => {
        const user = users.get(socket.id);
        if (!user?.deviceId) { if (typeof ack === "function") ack({ ok: false, reason: "no-device-identity" }); return null; }
        return user;
    };

    socket.on("listCircles", safeHandler(socket, (_data, ack) => {
        if (typeof ack !== "function") return;
        const user = needDevice(ack); if (!user) return;
        ack({ ok: true, circles: stmt.circlesForDevice.all(user.deviceId).map((c) => circleSummary(c, user.deviceId)) });
    }));

    socket.on("createCircle", safeHandler(socket, (data, ack) => {
        if (typeof ack !== "function") return;
        const user = needDevice(ack); if (!user) return;
        if (!isNonEmptyStr(data?.name, 40)) return ack({ ok: false, reason: "bad-name" });
        if (!throttle(socket.id, "circleCreate", 2000)) return ack({ ok: false, reason: "too-frequent" });
        if (stmt.countCirclesForDevice.get(user.deviceId).n >= MAX_CIRCLES_PER_DEVICE) return ack({ ok: false, reason: "too-many-circles" });
        const id = generateId(), now = Date.now();
        db.transaction(() => {
            stmt.insertCircle.run(id, clampStr(data.name, 40).trim(), newInviteCode(), user.deviceId, now);
            stmt.insertCircleMember.run(id, user.deviceId, now);
        })();
        return commitCircleChange([user.deviceId]).then(() => ack({ ok: true, circle: circleSummary(stmt.getCircle.get(id), user.deviceId) }));
    }));

    socket.on("joinCircle", safeHandler(socket, (data, ack) => {
        if (typeof ack !== "function") return;
        const user = needDevice(ack); if (!user) return;
        if (!throttle(socket.id, "circleJoin", 1500)) return ack({ ok: false, reason: "too-frequent" });
        const code = normalizeInviteCode(data?.code);
        const c = code ? stmt.getCircleByCode.get(code) : null;
        if (!c) return ack({ ok: false, reason: "not-found" });
        if (stmt.isCircleMember.get(c.id, user.deviceId)) return ack({ ok: false, reason: "already-member", circle: circleSummary(c, user.deviceId) });
        if (stmt.countCircleMembers.get(c.id).n >= MAX_CIRCLE_MEMBERS) return ack({ ok: false, reason: "circle-full" });
        if (stmt.countCirclesForDevice.get(user.deviceId).n >= MAX_CIRCLES_PER_DEVICE) return ack({ ok: false, reason: "too-many-circles" });
        stmt.insertCircleMember.run(c.id, user.deviceId, Date.now());
        const members = stmt.circleMembers.all(c.id).map((m) => m.device_id);
        return commitCircleChange(members).then(() => ack({ ok: true, circle: circleSummary(c, user.deviceId) }));
    }));

    socket.on("leaveCircle", safeHandler(socket, (data, ack) => {
        if (typeof ack !== "function") return;
        const user = needDevice(ack); if (!user) return;
        if (!isNonEmptyStr(data?.circleId, 60) || !stmt.isCircleMember.get(data.circleId, user.deviceId)) return ack({ ok: false, reason: "not-a-member" });
        const affected = removeFromCircleDb(data.circleId, user.deviceId);
        return commitCircleChange(affected).then(() => ack({ ok: true }));
    }));

    // Owner only: {circleId, ownerKey} of the member to remove.
    socket.on("removeCircleMember", safeHandler(socket, (data, ack) => {
        if (typeof ack !== "function") return;
        const user = needDevice(ack); if (!user) return;
        const c = isNonEmptyStr(data?.circleId, 60) ? stmt.getCircle.get(data.circleId) : null;
        if (!c || c.owner_device_id !== user.deviceId) return ack({ ok: false, reason: "not-owner" });
        const target = stmt.circleMembers.all(c.id).find((m) => ownerKeyFor(m.device_id) === data.ownerKey);
        if (!target || target.device_id === user.deviceId) return ack({ ok: false, reason: "not-found" });
        const affected = removeFromCircleDb(c.id, target.device_id);
        return commitCircleChange(affected).then(() => ack({ ok: true }));
    }));

    // Owner only: a fresh invite code (the old one stops working).
    socket.on("renewCircleCode", safeHandler(socket, (data, ack) => {
        if (typeof ack !== "function") return;
        const user = needDevice(ack); if (!user) return;
        const c = isNonEmptyStr(data?.circleId, 60) ? stmt.getCircle.get(data.circleId) : null;
        if (!c || c.owner_device_id !== user.deviceId) return ack({ ok: false, reason: "not-owner" });
        stmt.setCircleCode.run(newInviteCode(), c.id);
        ack({ ok: true, circle: circleSummary(stmt.getCircle.get(c.id), user.deviceId) });
    }));

    socket.on("renameCircle", safeHandler(socket, (data, ack) => {
        if (typeof ack !== "function") return;
        const user = needDevice(ack); if (!user) return;
        const c = isNonEmptyStr(data?.circleId, 60) ? stmt.getCircle.get(data.circleId) : null;
        if (!c || c.owner_device_id !== user.deviceId) return ack({ ok: false, reason: "not-owner" });
        if (!isNonEmptyStr(data?.name, 40)) return ack({ ok: false, reason: "bad-name" });
        stmt.renameCircle.run(clampStr(data.name, 40).trim(), c.id);
        const members = stmt.circleMembers.all(c.id).map((m) => m.device_id);
        return commitCircleChange(members).then(() => ack({ ok: true, circle: circleSummary(stmt.getCircle.get(c.id), user.deviceId) }));
    }));

    socket.on("deleteCircle", safeHandler(socket, (data, ack) => {
        if (typeof ack !== "function") return;
        const user = needDevice(ack); if (!user) return;
        const c = isNonEmptyStr(data?.circleId, 60) ? stmt.getCircle.get(data.circleId) : null;
        if (!c || c.owner_device_id !== user.deviceId) return ack({ ok: false, reason: "not-owner" });
        const members = stmt.circleMembers.all(c.id).map((m) => m.device_id);
        db.transaction(() => { stmt.deleteCircleMembers.run(c.id); stmt.deleteCircle.run(c.id); })();
        return commitCircleChange(members).then(() => ack({ ok: true }));
    }));

    // --- J3. "YOU WERE HERE BEFORE" -------------------------------------------------
    // recallPlace {lat, lng, radiusM?} -> your OWN past rides that passed within
    // radiusM (default 150 m) and your own memories there. Rides from the last
    // 6 hours don't count (that's today's ride, not "before").
    socket.on("recallPlace", safeHandler(socket, (data, ack) => {
        if (typeof ack !== "function") return;
        const user = users.get(socket.id);
        if (!user?.deviceId) return ack({ ok: false, reason: "no-device-identity" });
        if (!isValidCoordPair(data?.lat, data?.lng)) return ack({ ok: false, reason: "bad-coords" });
        if (!throttle(socket.id, "recall", 800)) return ack({ ok: false, reason: "too-frequent" });
        const radiusM = Math.round(clampNum(data.radiusM, 30, 2000, RECALL_DEFAULT_RADIUS_M));
        const dLat = radiusM / 111_320;
        const dLng = radiusM / (111_320 * Math.max(0.01, Math.cos((data.lat * Math.PI) / 180)));
        const before = Date.now() - RECALL_EXCLUDE_RECENT_MS;
        const rows = stmt.recallPoints.all(user.deviceId, data.lat - dLat, data.lat + dLat, data.lng - dLng, data.lng + dLng, before);
        const byTrip = new Map();
        for (const r of rows) {
            const dM = distanceKm(data.lat, data.lng, r.lat, r.lng) * 1000;
            if (dM > radiusM) continue;
            const cur = byTrip.get(r.trip_id);
            if (!cur) byTrip.set(r.trip_id, { tripId: r.trip_id, name: r.name || "", mode: r.mode, at: r.ts, closestM: Math.round(dM) });
            else { if (r.ts < cur.at) cur.at = r.ts; cur.closestM = Math.min(cur.closestM, Math.round(dM)); }
        }
        const visits = Array.from(byTrip.values()).sort((a, b) => b.at - a.at);
        const mems = stmt.recallMemories.all(user.deviceId, data.lat - dLat, data.lat + dLat, data.lng - dLng, data.lng + dLng, before)
            .filter((m) => distanceKm(data.lat, data.lng, m.lat, m.lng) * 1000 <= radiusM)
            .map((m) => ({ id: m.id, caption: m.caption || "", at: m.created_at }));
        const days = new Set(visits.map((v) => new Date(v.at).toISOString().slice(0, 10)));
        ack({
            ok: true, radiusM, visits: visits.slice(0, 10), visitCount: visits.length, dayCount: days.size,
            firstAt: visits.length ? Math.min(...visits.map((v) => v.at)) : null,
            lastAt: visits.length ? visits[0].at : null,
            memories: mems.slice(0, 10), memoryCount: mems.length
        });
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
            // Only riders this requester may see EXACTLY (circles, trip-only and
            // approx sharing all respected); their own position always counts.
            .filter((u) => u && !seen.has(u.id) && seen.add(u.id) && isValidCoordPair(u.lat, u.lng) &&
                (u.id === socket.id ? u.sharingMode !== "off" : viewLevel(u, socket.id) === "exact"));
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

    // --- M. ROAD SPEED-LIMIT TILES ---------------------------------------------------
    // socket.emit('getRoadTile', { key: "<floor(lat/0.01)>:<floor(lng/0.01)>" }, ack)
    // -> { ok, key, ways:[{id, hw, name, ow, lim, fwd, bwd, mc, raw, runs:[[lat,lng,lat,lng,...]]}], fetchedAt }
    socket.on("getRoadTile", safeHandler(socket, async (data, ack) => {
        if (typeof ack !== "function") return;
        if (!users.has(socket.id)) return ack({ ok: false, reason: "no-profile" });
        const key = typeof data?.key === "string" ? data.key : "";
        if (!ROAD_TILE_KEY_RE.test(key)) return ack({ ok: false, reason: "bad-key" });
        const b = roadTileBounds(key);
        if (!isValidCoordPair(b.s, b.w) || !isValidCoordPair(b.n, b.e)) return ack({ ok: false, reason: "bad-key" });
        if (!throttle(socket.id, "roadTile", 400)) return ack({ ok: false, reason: "too-frequent" });
        const tile = await fetchRoadTile(key);
        if (tile.busy) return ack({ ok: false, reason: "busy" });
        if (tile.failed) return ack({ ok: false, reason: "overpass-unavailable" });
        ack({ ok: true, key, ways: tile.ways, fetchedAt: tile.ts, source: "openstreetmap" });
    }));

    // --- L. CARPOOL ORDERING + FUEL SPLIT ------------------------------------------
    // socket.emit('carpoolOptimize', {start, pickups:[{id,name,lat,lng}], destination, kmPerL?, fuelPricePerL?, avoid?:["motorway","toll"], objective?:"shortest"|"fair"}, ack)
    // `avoid` is the DRIVER's route preference (OSRM exclude classes). Tried
    // together, then one at a time (some OSRM builds can't combine them), then
    // not at all — the reply says which were actually applied.
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

        const avoidRequested = Array.isArray(data?.avoid) ? [...new Set(data.avoid.filter((c) => ROUTE_AVOID_CLASSES.includes(c)))] : [];
        let avoidApplied = [];
        const objective = data?.objective === "fair" ? "fair" : "shortest";

        let ordered = null, legMeters = null, geometry = null, approximate = false, durationSec = null;
        try {
            const coordStr = [start, ...stops, dest].map((p) => `${p.lng},${p.lat}`).join(";");
            const base = `${OSRM_BASE}/trip/v1/driving/${coordStr}?source=first&destination=last&roundtrip=false&overview=full&geometries=geojson&steps=false`;
            const attempts = avoidRequested.length > 1 ? [avoidRequested, ...avoidRequested.map((c) => [c]), []]
                : avoidRequested.length === 1 ? [avoidRequested, []] : [[]];
            let json = null;
            for (const ex of attempts) {
                const res = await fetch(ex.length ? `${base}&exclude=${ex.join(",")}` : base, { signal: AbortSignal.timeout(8000) });
                let body = null;
                try { body = await res.json(); } catch { body = null; }
                if (body && body.code === "Ok" && body.trips?.[0]) { json = body; avoidApplied = ex; break; }
                // Anything but "can't do this exclude" / "no route that way" is a real outage: stop, use the fallback.
                if (!body || !/^(InvalidValue|InvalidOptions|InvalidQuery|NoTrips|NoRoute)$/.test(body.code)) break;
            }
            if (json) {
                const trip = json.trips[0];
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
            avoidApplied = [];                     // straight-line fallback knows nothing about road classes
        }

        // Exact orders + Shapley from one road matrix (Batch 1). Without the
        // matrix (routing down) the plan above stands and these are omitted.
        let orders = null, shapley = null;
        const matrix = approximate ? null : await fetchCarpoolMatrix([start, ...stops, dest], avoidApplied);
        if (matrix) {
            const n = stops.length;
            const { shortest, fairest } = bestPickupOrders(matrix.D, matrix.T, n);
            const describe = (e) => ({
                pickupOrder: e.order.map((i) => stops[i - 1]),
                totalMin: Math.round(e.totalS / 60), totalKm: +(e.totalM / 1000).toFixed(2),
                worstDetourMin: Math.round(e.worstS / 60),
                detours: e.order.map((i, k) => ({ id: stops[i - 1].id, name: stops[i - 1].name, min: Math.round(e.detours[k] / 60) }))
            });
            orders = { shortest: describe(shortest), fairest: describe(fairest), objective };
            if (objective === "fair") {
                const seqPts = [start, ...fairest.order.map((i) => stops[i - 1]), dest];
                const r = await fetchOrderedRoute(seqPts, avoidApplied);
                ordered = fairest.order.map((i) => stops[i - 1]);
                if (r) { legMeters = r.legMeters; geometry = r.geometry; durationSec = r.durationSec; }
                else {
                    legMeters = seqPts.slice(0, -1).map((_, k) => matrix.D[k === 0 ? 0 : fairest.order[k - 1]][k === seqPts.length - 2 ? n + 1 : fairest.order[k]]);
                    geometry = null; durationSec = fairest.totalS;
                }
            }
            const sh = shapleyCarpoolSplit(matrix.D, n, kmPerL);
            const drivenM = legMeters.reduce((a, b) => a + b, 0);
            const scale = sh.optimalM > 0 ? drivenM / sh.optimalM : 1;            // shares follow the plan actually driven
            const litres = (m) => +(m * scale * sh.litresPerM).toFixed(3);
            const idIdx = new Map(stops.map((st, i) => [st, i + 1]));
            shapley = {
                driver: { fuelL: litres(sh.sharesM[0]), cost: +(litres(sh.sharesM[0]) * pricePerL).toFixed(2) },
                riders: ordered.map((st) => { const L2 = litres(sh.sharesM[idIdx.get(st)]); return { id: st.id, name: st.name, fuelL: L2, cost: +(L2 * pricePerL).toFixed(2), aloneL: +(matrix.D[idIdx.get(st)][n + 1] * sh.litresPerM).toFixed(3) }; }),
                note: "Shapley: each person pays their average extra cost over every order people could join in; going alone is costed at the same km/L."
            };
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
            avoid: { requested: avoidRequested, applied: avoidApplied },
            objective: orders ? objective : "shortest",
            orders, shapley,
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
        const trips2 = stmt.listTrips.all(user.deviceId, 1000).map((t) => ({
            ...t, points: stmt.getTripPoints.all(t.id, 5000)
        }));
        ack({
            ok: true, exportedAt: new Date().toISOString(),
            profile: { name: user.name, privacy: privacyState(user) }, trips: trips2,
            memories: stmt.listMemoriesMeta.all(user.deviceId),
            geofences: stmt.listGeofencesForDevice.all(user.deviceId),
            chatMessages: stmt.listChatForDevice.all(user.deviceId).map((m) => ({
                id: m.id, type: m.type, text: m.type === "text" ? m.body : null,
                file: m.type === "text" ? null : mediaUrl(m.body), fileName: m.file_name || null,
                at: new Date(m.created_at).toISOString()
            })),
            circles: stmt.circlesForDevice.all(user.deviceId).map((c) => ({ name: c.name, owner: c.owner_device_id === user.deviceId, createdAt: c.created_at }))
        });
    }));

    // deleteMyHistory {includeIdentity?: boolean}
    // Purges trips, breadcrumbs, memories (+ photo files), owned geofences and
    // chat messages (+ attachment files) from SQLite, disk AND every process's
    // RAM, then checkpoints the WAL (secure_delete overwrites freed pages).
    // With includeIdentity, also leaves every circle and forgets the device.
    socket.on("deleteMyHistory", safeHandler(socket, (data, ack) => {
        const user = users.get(socket.id);
        if (!user || !user.deviceId) return typeof ack === "function" && ack({ ok: false, reason: "no-device-identity" });
        const deviceId = user.deviceId;
        const includeIdentity = data?.includeIdentity === true;

        const memoryRefs = stmt.listMemoryRefsForDevice.all(deviceId).map((r) => r.image_ref);
        const chatRefs = stmt.chatMediaForDevice.all(deviceId).map((r) => r.body);
        let tripsDeleted = 0, memoriesDeleted = 0, geofencesDeleted = 0, chatDeleted = 0;
        let circleDevices = [];
        const circleIds = includeIdentity ? circleIdsOf(deviceId) : [];
        for (const cid of circleIds) circleDevices = circleDevices.concat(removeFromCircleDb(cid, deviceId));
        db.transaction(() => {
            stmt.deleteTripPointsForDevice.run(deviceId);
            tripsDeleted = stmt.deleteTripsForDevice.run(deviceId).changes;
            memoriesDeleted = stmt.deleteMemoriesForDevice.run(deviceId).changes;
            geofencesDeleted = stmt.deleteGeofencesForDevice.run(deviceId).changes;
            chatDeleted = stmt.deleteChatForDevice.run(deviceId).changes;
            if (includeIdentity) stmt.deleteUser.run(deviceId);
        })();
        try { db.pragma("wal_checkpoint(TRUNCATE)"); } catch (e) { console.warn("WAL checkpoint skipped:", e.message); }
        const filesDeleted = purgeMediaRefs(memoryRefs) + purgeMediaRefs(chatRefs);

        return commit({ t: "history.deleted", deviceId, includeIdentity })
            .then(() => (circleDevices.length ? commit({ t: "circles.changed", devices: Array.from(new Set(circleDevices)).map((d) => ({ deviceId: d, circleIds: d === deviceId ? [] : circleIdsOf(d) })) }) : null))
            .then(() => {
                if (typeof ack === "function") ack({ ok: true, tripsDeleted, memoriesDeleted, geofencesDeleted, chatDeleted, filesDeleted, circlesLeft: circleIds.length, identityDeleted: includeIdentity });
            });
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
    // Only for verified devices inside a trip. Keys are base64, rid/tag hex.
    socket.on("getRelayCredentials", safeHandler(socket, (data, ack) => {
        if (typeof ack !== "function") return;
        const user = users.get(socket.id);
        if (!user?.deviceId) return ack({ ok: false, reason: "no-device-identity" });
        const trip = tripOf(socket.id);
        if (!trip) return ack({ ok: false, reason: "not-in-trip" });
        if (!throttle(socket.id, "relayCreds", 2000)) return ack({ ok: false, reason: "too-frequent" });
        const reply = () => {
            const tripId = trip.id;
            const roster = Array.from(relayRosterMap(trip).entries()).map(([rid, u]) => ({ rid, name: u.name, ownerKey: ownerKeyFor(u.deviceId) }));
            ack({
                ok: true, v: RELAY_FRAME.VERSION, tripId, tripName: trip.name,
                rid: relayRidFor(tripId, user.deviceId).toString("hex"),
                tag: relayTripTag(tripId).toString("hex"),
                groupKey: relayGroupKey(tripId).toString("base64"),
                deviceKey: relayDeviceKey(tripId, user.deviceId).toString("base64"),
                roster, issuedAt: Date.now()
            });
        };
        if (data?.radio === true && !user.relayCapable) return commitThen({ t: "relay.capable", sid: socket.id }, reply);
        reply();
    }));

    // socket.emit('relayUpload', {frames:[base64, ...]}, ack) -> {ok, results:[{i, status, rid?, ts?, seq?, type?}]}
    // A trip member with data uploads frames it heard over radio.
    socket.on("relayUpload", safeHandler(socket, (data, ack) => {
        const reply = (o) => { if (typeof ack === "function") ack(o); };
        const uploader = users.get(socket.id);
        if (!uploader?.deviceId) return reply({ ok: false, reason: "no-device-identity" });
        if (!isInActiveTrip(socket.id)) return reply({ ok: false, reason: "not-in-trip" });
        if (!throttle(socket.id, "relayUpload", 1000)) return reply({ ok: false, reason: "too-frequent" });
        const frames = Array.isArray(data?.frames) ? data.frames.slice(0, 16).map((f) => (typeof f === "string" ? f.slice(0, 400) : "")) : [];
        return commitThen({ t: "relay.frames", sid: socket.id, frames }, reply);
    }, "location"));

    // --- O. DISCONNECT (with reconnect grace) ---------------------------------------
    socket.on("disconnect", () => {
        console.log(`🔴 Disconnected: ${socket.id}`);
        forgetSocketCounters(socket.id);
        lastTripSent.delete(socket.id);
        if (!users.has(socket.id)) return; // already migrated to a newer socket
        commit({ t: "disconnect", sid: socket.id }).catch((e) => console.warn("disconnect op failed:", e.message));
    });
});

// ==========================================================================
// 10. STARTUP: MIGRATE, HYDRATE, JOIN THE CLUSTER, RETENTION, LISTEN, SHUTDOWN
// ==========================================================================
// One-time (idempotent, crash-safe) move of base64 memory photos out of
// SQLite into MEDIA_DIR. Several processes may run it at once: the UPDATE
// only succeeds while the row still holds a data-URL, and the loser deletes
// its duplicate file.
function migrateLegacyMedia() {
    const total = stmt.countLegacyMemoryImages.get().n;
    if (!total) return 0;
    let moved = 0, failed = 0;
    for (const { id } of stmt.legacyMemoryIds.all()) {
        const row = stmt.getMemoryImage.get(id);
        if (!row || typeof row.image_ref !== "string" || !row.image_ref.startsWith("data:")) continue;   // another process got it
        const saved = media.saveDataUrl(row.image_ref, "memories", "memories", 64 * 1024 * 1024);
        if (!saved.ok) { failed++; continue; }
        const changed = stmt.setMemoryRef.run(saved.ref, id).changes;
        if (changed) moved++; else media.remove(saved.ref);
    }
    try { db.pragma("wal_checkpoint(TRUNCATE)"); } catch { /* ignore */ }
    console.log(`   Media: moved ${moved} memory photo(s) from the database to ${MEDIA_DIR}${failed ? ` (${failed} unreadable, left in place)` : ""}`);
    return moved;
}

function hydrateFromDatabase() {
    memories.length = 0;
    stmt.hydrateMemories.all(MAX_MEMORIES_IN_RAM).reverse().forEach((r) => {
        memories.push({
            id: r.id, name: r.name || "", lat: r.lat, lng: r.lng, ref: r.image_ref, caption: r.caption || "",
            time: new Date(r.created_at).toISOString(), deviceId: r.device_id || null, tripId: r.trip_id || null
        });
    });
    geofences = stmt.hydrateGeofences.all().map((r) => ({
        id: r.id, name: r.name, lat: r.lat, lng: r.lng, radius: r.radius,
        ownerId: null, ownerName: r.owner_name || "", ownerDeviceId: r.owner_device_id || null
    }));
    chatMessages.length = 0;
    stmt.hydrateChat.all(CHAT_RAM_LIMIT).reverse().forEach((r) => chatMessages.push(chatFromRow(r)));
    console.log(`   Hydrated ${memories.length} memories, ${geofences.length} geofences and ${chatMessages.length} chat messages from SQLite`);
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

function purgeExpiredChat() {
    if (CHAT_RETENTION_DAYS <= 0) return;
    const cutoff = Date.now() - CHAT_RETENTION_DAYS * 86_400_000;
    try {
        const refs = stmt.oldChatMedia.all(cutoff).map((r) => r.body);
        const removed = stmt.purgeOldChat.run(cutoff).changes;
        const files = purgeMediaRefs(refs);
        if (removed) console.log(`🗑️  Retention: purged ${removed} chat message(s) (${files} file(s)) older than ${CHAT_RETENTION_DAYS} days`);
        if (bus.isReady()) commit({ t: "chat.purge", before: cutoff }).catch(() => {});
    } catch (e) {
        console.error("Chat retention purge failed:", e.message);
    }
}

// Cluster liveness: every process heartbeats through the op stream; the
// lowest-named live process declares a silent one gone, which drops its
// riders everywhere (they reconnect to a live process within seconds).
function startClusterTimers() {
    if (bus.mode !== "redis") return;
    const beat = () => commit({ t: "node.hb" }).catch(() => {});
    beat();
    setInterval(() => {
        beat();
        const now = Date.now();
        const alive = Array.from(heartbeatSeen.entries()).filter(([, t]) => now - t <= NODE_DEAD_MS).map(([n]) => n).sort();
        if (!alive.length || alive[0] !== NODE_ID) return;
        for (const [n, t] of heartbeatSeen) {
            if (n !== NODE_ID && now - t > NODE_DEAD_MS) commit({ t: "node.gone", gone: n }).catch(() => {});
        }
    }, NODE_HB_MS).unref();
}

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
    const leave = bus.mode === "redis" && bus.isReady()
        ? commit({ t: "node.gone", gone: NODE_ID }).catch(() => {}).then(() => bus.stop())
        : Promise.resolve(bus.stop());
    leave.finally(() => {
        io.close(() => {
            server.close(() => {
                try { db.pragma("wal_checkpoint(TRUNCATE)"); db.close(); } catch { /* ignore */ }
                process.exit(code);
            });
        });
    });
}
process.on("SIGTERM", () => shutdown(0));
process.on("SIGINT", () => shutdown(0));

function listen() {
    server.listen(PORT, "0.0.0.0", () => {
        console.log(`🚀 MapUnite Server running on http://localhost:${PORT}`);
        console.log(`   DB: ${DB_PATH}`);
        console.log(`   Media: ${MEDIA_DIR}`);
        console.log(`   OSRM: ${OSRM_BASE} (browser: ${OSRM_PUBLIC_URL})`);
        console.log(`   CORS: ${CORS_ORIGIN === false ? "same-origin only" : JSON.stringify(CORS_ORIGIN)}`);
        console.log(`   CSP: ${process.env.ENFORCE_CSP === "1" ? "enforced" : "report-only"}`);
        console.log(`   Cluster: ${bus.mode === "redis" ? `node ${NODE_ID} via Redis${adapterAttached ? " + Socket.IO adapter" : ""}` : "single process"}`);
        if (!GOOGLE_KEY) console.log("   Places proxy: disabled (set GOOGLE_MAPS_SERVER_KEY to enable)");
    });
}

migrateLegacyMedia();
purgeExpiredTrips();
setInterval(purgeExpiredTrips, 6 * 3600 * 1000).unref();

const started = bus.start({
    apply: applyOp,
    snapshot: snapshotState,
    restore: restoreState,
    hydrate: hydrateFromDatabase,
    onDirect: onDirectMessage
});
if (bus.mode === "local") {
    // Synchronous in single-process mode: state is ready before the first
    // connection, exactly as before.
    purgeExpiredChat();
    setInterval(purgeExpiredChat, 6 * 3600 * 1000).unref();
    listen();
} else {
    started
        .then(() => attachSocketIoAdapter(io, REDIS_URL, { prefix: CLUSTER_PREFIX }).catch((e) => { console.warn("[cluster] adapter not attached:", e.message); return false; }))
        .then((attached) => {
            adapterAttached = attached;
            startClusterTimers();
            purgeExpiredChat();
            setInterval(purgeExpiredChat, 6 * 3600 * 1000).unref();
            listen();
        })
        .catch((e) => { console.error("[cluster] could not join the cluster:", e.message); process.exit(1); });
}
