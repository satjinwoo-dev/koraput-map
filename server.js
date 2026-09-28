"use strict";

/* ============================================================================
   MapUnite Server — server.js
   ==============================================================================
   Realtime hot path (users/chatMessages/memories/geofences/currentTrip) stays
   in-memory, exactly as before — that's what makes a squad's live map fast.
   SQLite sits BESIDE it as a persistence bolt-on: trips/memories/geofences are
   written through on creation, and it survives restarts. It does not replace
   the in-memory broadcast path.

   Requires (npm install):
     express helmet express-rate-limit socket.io better-sqlite3
   Requires Node 18+ (native fetch / AbortSignal.timeout, no extra dependency).

   Env vars (all optional):
     PORT                default 3000
     CORS_ORIGIN         default "*"              — tighten to your domain in prod
     DB_PATH             default ./data/mapunite.db
     OSRM_BASE_URL       default https://router.project-osrm.org
     HTTP_RATE_LIMIT_MAX default 300 (per 15 min, per IP)
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
// 1. APP / HTTP / SOCKET.IO BOOTSTRAP
// ==========================================================================
const app = express();
const server = http.createServer(app);
const io = new Server(server, {
    cors: { origin: process.env.CORS_ORIGIN || "*", methods: ["GET", "POST"] },
    // Compressed memory photos as base64 can comfortably exceed Socket.IO's
    // 1MB default buffer — that default silently drops the message with no
    // client-side error. 8MB gives real headroom while still bounding abuse.
    maxHttpBufferSize: 8 * 1024 * 1024
});

// Needed so express-rate-limit sees the real client IP, not Render's proxy IP,
// when the app sits behind a reverse proxy (Render, Heroku, etc.)
app.set("trust proxy", 1);

// ==========================================================================
// 2. SECURITY MIDDLEWARE
// ==========================================================================
app.use(helmet({
    // A correct CSP for this app has to allow: unpkg.com (Leaflet), Google
    // Fonts, jsdelivr (emoji-picker-element), maps.googleapis.com + its own
    // sub-origins, several map-tile hosts, and a handful of fetch() targets
    // (OSRM/Open-Meteo/BigDataCloud/Nominatim). Shipping a CSP I haven't been
    // able to test against your live page risks silently breaking the map —
    // worse than no CSP. Left OFF by default; the exact policy this app needs
    // is below, commented, ready to test and enable yourself.
    contentSecurityPolicy: false,
    crossOriginEmbedderPolicy: false
}));

/*
// Tested-shape CSP — enable once you've verified it against your live page:
app.use(helmet.contentSecurityPolicy({
  directives: {
    defaultSrc: ["'self'"],
    scriptSrc: ["'self'", "'unsafe-inline'", "https://unpkg.com", "https://cdn.jsdelivr.net", "https://maps.googleapis.com"],
    styleSrc: ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com", "https://unpkg.com"],
    fontSrc: ["'self'", "https://fonts.gstatic.com"],
    imgSrc: ["'self'", "data:", "blob:", "https://*.google.com", "https://*.googleapis.com", "https://*.ggpht.com",
             "https://*.gstatic.com", "https://*.tile.openstreetmap.org", "https://*.basemaps.cartocdn.com"],
    connectSrc: ["'self'", "wss:", "https://maps.googleapis.com", "https://router.project-osrm.org",
                 "https://api.open-meteo.com", "https://api.bigdatacloud.net", "https://nominatim.openstreetmap.org"]
  }
}));
*/

const httpLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: Number(process.env.HTTP_RATE_LIMIT_MAX) || 300,
    standardHeaders: true,
    legacyHeaders: false,
    // BUG FIX (roadmap §15): Socket.IO's own polling-transport handshake hits
    // this same Express middleware stack. Counting it against the page-view
    // budget meant normal realtime traffic alone could exhaust the limiter
    // and lock riders out. The per-socket limiter further down covers abuse
    // on the realtime side instead.
    skip: (req) => req.path.startsWith("/socket.io/")
});
app.use(httpLimiter);

app.use(express.static(path.join(__dirname, "public")));
app.use(express.json({ limit: "256kb" }));

app.get("/healthz", (_req, res) => res.json({ ok: true, uptimeSec: Math.round(process.uptime()) }));

// ==========================================================================
// 3. PERSISTENCE — better-sqlite3
// ==========================================================================
const DB_PATH = process.env.DB_PATH || path.join(__dirname, "data", "mapunite.db");
fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
const db = new Database(DB_PATH);
db.pragma("journal_mode = WAL");

// NOTE if you deploy this on Render (or similar): the filesystem is ephemeral
// unless you attach a persistent disk at DB_PATH's directory. Without one,
// this survives a crash/restart but NOT a redeploy — the whole point of this
// section is defeated silently. Attach a disk, or point DB_PATH at one.

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  device_id   TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  avatar      TEXT,
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
  trip_id     TEXT,
  created_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_memories_device ON memories(device_id);
CREATE TABLE IF NOT EXISTS geofences (
  id               TEXT PRIMARY KEY,
  name             TEXT NOT NULL,
  lat              REAL NOT NULL,
  lng              REAL NOT NULL,
  radius           INTEGER NOT NULL,
  owner_device_id  TEXT
);
`);
// Images stored inline as base64 TEXT is fine at hobby volume (same call the
// client-side memory-compression code already makes). If memory count grows
// a lot, move image_ref to filesystem/blob storage and keep the DB holding
// just a path — the schema doesn't need to change to do that later.

const stmt = {
    upsertUser: db.prepare(`
        INSERT INTO users (device_id, name, avatar, created_at, last_seen) VALUES (?,?,?,?,?)
        ON CONFLICT(device_id) DO UPDATE SET name=excluded.name, avatar=excluded.avatar, last_seen=excluded.last_seen
    `),
    insertTrip: db.prepare(`
        INSERT INTO trips (id, host_device_id, name, mode, started_at, ended_at, total_dist_km, avg_speed, max_speed, fuel_used_l)
        VALUES (?,?,?,?,?,?,?,?,?,?)
    `),
    insertTripPoint: db.prepare(`INSERT INTO trip_points (trip_id, ts, lat, lng, speed_kmh, accuracy) VALUES (?,?,?,?,?,?)`),
    insertMemory: db.prepare(`INSERT INTO memories (id, device_id, name, lat, lng, image_ref, trip_id, created_at) VALUES (?,?,?,?,?,?,?,?)`),
    insertGeofence: db.prepare(`INSERT INTO geofences (id, name, lat, lng, radius, owner_device_id) VALUES (?,?,?,?,?,?)`),
    deleteGeofence: db.prepare(`DELETE FROM geofences WHERE id = ?`),
    tripIdsForDevice: db.prepare(`SELECT id FROM trips WHERE host_device_id = ?`),
    deleteTripPointsFor: db.prepare(`DELETE FROM trip_points WHERE trip_id = ?`),
    deleteTripsForDevice: db.prepare(`DELETE FROM trips WHERE host_device_id = ?`),
    deleteMemoriesForDevice: db.prepare(`DELETE FROM memories WHERE device_id = ?`)
};

// ==========================================================================
// 4. IN-MEMORY HOT PATH (unchanged shape from the original — this is what
//    every realtime broadcast reads/writes; SQLite above never sits on this path)
// ==========================================================================
const users = new Map();
const chatMessages = [];
const memories = [];
let geofences = [];
let currentTrip = null;
const voiceSquadMembers = new Map(); // socketId -> {id,name,avatar} — real roster, not a fake panel

const OSRM_BASE = process.env.OSRM_BASE_URL || "https://router.project-osrm.org";
// Swapping to a self-hosted OSRM instance later (recommended before any real
// production load — the public instance has no SLA) is a one-line env change.

const REACTION_EMOJIS = ["👍", "❤️", "😂", "😮", "😢", "🔥"];
const ALLOWED_MSG_TYPES = ["text", "image", "video", "audio", "document"];
const ALLOWED_MODES = ["drive", "bike", "walk"];
const MAX_AVATAR_B64_LEN = 3_000_000;
const MAX_MEMORY_IMAGE_B64_LEN = 6_000_000;
const DEFAULT_AVATAR = "satyam.png";

// ==========================================================================
// 5. PURE HELPERS
// ==========================================================================
const generateId = () => crypto.randomUUID();

function distanceKm(a, b, c, d) {
    const p = Math.PI / 180;
    const x = 0.5 - Math.cos((c - a) * p) / 2 + Math.cos(a * p) * Math.cos(c * p) * (1 - Math.cos((d - b) * p)) / 2;
    return 12742 * Math.asin(Math.sqrt(x));
}

const isFiniteNum = (v) => typeof v === "number" && Number.isFinite(v);
const isValidLat = (v) => isFiniteNum(v) && v >= -90 && v <= 90;
const isValidLng = (v) => isFiniteNum(v) && v >= -180 && v <= 180;
const isValidCoordPair = (lat, lng) => isValidLat(lat) && isValidLng(lng);
const isNonEmptyStr = (v, max = 200) => typeof v === "string" && v.trim().length > 0 && v.length <= max;
const isValidRadius = (v) => isFiniteNum(v) && v >= 10 && v <= 50000;
const clampStr = (v, max) => String(v ?? "").slice(0, max);

function sanitizeReplyTo(r) {
    if (!r || typeof r !== "object") return null;
    if (!isNonEmptyStr(r.id, 60) || !ALLOWED_MSG_TYPES.includes(r.type)) return null;
    return { id: r.id, name: clampStr(r.name, 40), type: r.type, preview: clampStr(r.preview, 60) };
}

// Only ever send this shape to other clients — never the raw `users` record
// (which can carry deviceId, an internal tracking identifier that shouldn't
// be handed to every peer).
function publicUser(u) {
    const hidden = u.sharing === false; // "paused sharing" = no location visible to anyone
    return {
        id: u.id,
        name: u.name,
        avatar: u.avatar,
        online: u.online !== false,
        lat: hidden ? null : u.lat,
        lng: hidden ? null : u.lng,
        alt: hidden ? null : (u.alt ?? null),
        speedKmh: hidden ? null : (u.speedKmh ?? null),
        weather: u.weather || ""
    };
}

// ==========================================================================
// 6. PER-SOCKET EVENT RATE LIMIT + CRASH-PROOF HANDLER WRAPPER
// ==========================================================================
// This is the structural fix for the messageReaction crash class, applied to
// EVERY handler, not just the one that was reported: an uncaught synchronous
// exception inside a Socket.IO callback crashes the whole Node process in
// this architecture, dropping every connected rider. No handler below is
// allowed to throw past this wrapper.
const socketEventCounts = new Map();
const EVENT_WINDOW_MS = 10_000;
const EVENT_MAX_PER_WINDOW = 60;

function allowEvent(socketId) {
    const now = Date.now();
    let rec = socketEventCounts.get(socketId);
    if (!rec || now - rec.windowStart > EVENT_WINDOW_MS) {
        rec = { count: 0, windowStart: now };
        socketEventCounts.set(socketId, rec);
    }
    rec.count++;
    return rec.count <= EVENT_MAX_PER_WINDOW;
}

function safeHandler(socket, fn) {
    return (...args) => {
        try {
            if (!allowEvent(socket.id)) return; // silently dropped, no crash, no info leak
            fn(...args);
        } catch (err) {
            console.error(`[socket:${socket.id}] handler error:`, err);
        }
    };
}

// ==========================================================================
// 7. OSRM HELPERS (meetup + carpool algorithms)
// ==========================================================================
function buildMeetupCandidates(members, extraCandidates) {
    const centroidLat = members.reduce((s, m) => s + m.lat, 0) / members.length;
    const centroidLng = members.reduce((s, m) => s + m.lng, 0) / members.length;

    let maxSpreadKm = 1;
    for (let i = 0; i < members.length; i++) {
        for (let j = i + 1; j < members.length; j++) {
            maxSpreadKm = Math.max(maxSpreadKm, distanceKm(members[i].lat, members[i].lng, members[j].lat, members[j].lng));
        }
    }
    const ringRadiusKm = Math.min(15, Math.max(0.5, maxSpreadKm / 2));

    const ring = [];
    const RING_POINTS = 6;
    for (let k = 0; k < RING_POINTS; k++) {
        const bearing = (k / RING_POINTS) * 2 * Math.PI;
        const dLat = (ringRadiusKm / 111) * Math.cos(bearing);
        const dLng = (ringRadiusKm / (111 * Math.cos((centroidLat * Math.PI) / 180))) * Math.sin(bearing);
        ring.push({ lat: centroidLat + dLat, lng: centroidLng + dLng, label: null });
    }
    return [{ lat: centroidLat, lng: centroidLng, label: "Centroid" }, ...ring, ...extraCandidates];
}

async function fetchOsrmTable(members, candidates) {
    const allCoords = [...members.map((m) => `${m.lng},${m.lat}`), ...candidates.map((c) => `${c.lng},${c.lat}`)];
    const sources = members.map((_, i) => i).join(";");
    const destinations = candidates.map((_, i) => members.length + i).join(";");
    const url = `${OSRM_BASE}/table/v1/driving/${allCoords.join(";")}?sources=${sources}&destinations=${destinations}&annotations=duration,distance`;
    try {
        const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
        if (!res.ok) return null;
        const json = await res.json();
        if (json.code !== "Ok") return null;
        return { durations: json.durations, distances: json.distances };
    } catch (e) {
        console.error("OSRM table fetch failed:", e.message);
        return null;
    }
}

// ==========================================================================
// 8. SOCKET.IO EVENT HANDLERS
// ==========================================================================
io.on("connection", (socket) => {
    console.log(`🟢 New Connection: ${socket.id}`);

    // --- A. PROFILE & INITIALIZATION -------------------------------------
    socket.on("profileReady", safeHandler(socket, (data) => {
        if (!data || !isNonEmptyStr(data.name, 40)) return;

        const deviceId = isNonEmptyStr(data.deviceId, 100) ? data.deviceId : null;
        const name = clampStr(data.name, 40);
        const avatar = typeof data.avatar === "string" && data.avatar.length > 0 && data.avatar.length <= MAX_AVATAR_B64_LEN
            ? data.avatar
            : DEFAULT_AVATAR;

        const user = { id: socket.id, deviceId, name, avatar, online: true, sharing: true, sessionMode: null, lat: null, lng: null };
        users.set(socket.id, user);

        // Real, but casual, identity: this closes "anyone can profileReady as
        // anyone" for the common case, not cryptographic auth. A stolen/copied
        // localStorage deviceId can still impersonate — full accounts would be
        // the honest next step if that threat matters for your squad.
        if (deviceId) stmt.upsertUser.run(deviceId, name, avatar, Date.now(), Date.now());

        socket.emit("chatHistory", chatMessages);
        socket.emit("loadMemoryPhotos", memories);
        socket.emit("loadGeofences", geofences);
        socket.emit("onlineUsers", Array.from(users.values()).map(publicUser));
        if (currentTrip) socket.emit("tripData", currentTrip);

        socket.broadcast.emit("userOnline", publicUser(user));
    }));

    // --- B. LIVE LOCATION + GEOFENCE CHECK --------------------------------
    socket.on("updateLocation", safeHandler(socket, (data) => {
        if (!users.has(socket.id) || !data || !isValidCoordPair(data.lat, data.lng)) return;

        const user = users.get(socket.id);
        if (user.sharing === false) return; // paused — do not update or broadcast position

        const oldLat = user.lat, oldLng = user.lng;
        user.lat = data.lat;
        user.lng = data.lng;
        user.alt = isFiniteNum(data.alt) ? data.alt : null;
        user.speedKmh = isFiniteNum(data.speedKmh) ? Math.min(Math.max(data.speedKmh, 0), 300) : 0;
        if (isNonEmptyStr(data.weather, 40)) user.weather = data.weather;
        users.set(socket.id, user);

        socket.broadcast.emit("friendMoved", publicUser(user));

        if (oldLat != null && oldLng != null) {
            geofences.forEach((fence) => {
                const distOld = distanceKm(oldLat, oldLng, fence.lat, fence.lng) * 1000;
                const distNew = distanceKm(user.lat, user.lng, fence.lat, fence.lng) * 1000;
                const wasOutside = distOld > fence.radius;
                const isInside = distNew <= fence.radius;
                if (wasOutside && isInside) io.emit("geofenceAlert", { user: user.name, fence: fence.name, type: "enter" });
                else if (!wasOutside && !isInside) io.emit("geofenceAlert", { user: user.name, fence: fence.name, type: "leave" });
            });
        }
    }));

    // --- C. CHAT SYSTEM ----------------------------------------------------
    socket.on("chatMessage", safeHandler(socket, (data) => {
        if (!users.has(socket.id) || !data || !ALLOWED_MSG_TYPES.includes(data.type)) return;
        if (data.type === "text" && !isNonEmptyStr(data.data, 1000)) return;
        if (data.type !== "text" && (typeof data.data !== "string" || data.data.length === 0 || data.data.length > 7_000_000)) return;

        const user = users.get(socket.id);
        const msg = {
            id: generateId(),
            senderId: socket.id,
            name: clampStr(data.name || user.name, 40),
            type: data.type,
            data: data.data,
            replyTo: sanitizeReplyTo(data.replyTo),
            time: new Date().toISOString(),
            reactions: { "👍": [], "❤️": [], "😂": [], "😮": [], "😢": [], "🔥": [] }
        };
        chatMessages.push(msg);
        if (chatMessages.length > 200) chatMessages.shift();
        io.emit("chatMessage", msg);
    }));

    socket.on("typing", safeHandler(socket, (isTyping) => {
        const user = users.get(socket.id);
        if (user) socket.broadcast.emit("typing", { id: socket.id, name: user.name, isTyping: !!isTyping });
    }));

    socket.on("messageReaction", safeHandler(socket, (data) => {
        // THE FIX: validated emoji + existence check before any property access.
        // A client could previously send ANY string as data.emoji; indexing
        // msg.reactions[data.emoji] on an unknown key threw synchronously and
        // took the whole server process down with it.
        if (!data || !isNonEmptyStr(data.messageId, 60) || !REACTION_EMOJIS.includes(data.emoji)) return;
        const msg = chatMessages.find((m) => m.id === data.messageId);
        if (!msg || !msg.reactions[data.emoji]) return;

        const userIndex = msg.reactions[data.emoji].indexOf(socket.id);
        if (userIndex > -1) {
            msg.reactions[data.emoji].splice(userIndex, 1);
        } else {
            Object.keys(msg.reactions).forEach((e) => {
                const idx = msg.reactions[e].indexOf(socket.id);
                if (idx > -1) msg.reactions[e].splice(idx, 1);
            });
            msg.reactions[data.emoji].push(socket.id);
        }
        io.emit("messageReaction", { messageId: msg.id, reactions: msg.reactions });
    }));

    // --- D. GEOFENCING -------------------------------------------------------
    socket.on("addGeofence", safeHandler(socket, (data) => {
        const user = users.get(socket.id);
        if (!user || !data || !isNonEmptyStr(data.name, 60) || !isValidCoordPair(data.lat, data.lng) || !isValidRadius(data.radius)) return;

        const fence = {
            id: generateId(), name: clampStr(data.name, 60), lat: data.lat, lng: data.lng,
            radius: Math.round(data.radius), ownerId: socket.id, ownerName: user.name
        };
        geofences.push(fence);
        stmt.insertGeofence.run(fence.id, fence.name, fence.lat, fence.lng, fence.radius, user.deviceId || null);
        io.emit("loadGeofences", geofences);
    }));

    socket.on("removeGeofence", safeHandler(socket, (id) => {
        if (!isNonEmptyStr(id, 60)) return;
        const fence = geofences.find((f) => f.id === id);
        if (fence && fence.ownerId === socket.id) {
            geofences = geofences.filter((f) => f.id !== id);
            stmt.deleteGeofence.run(id);
            io.emit("loadGeofences", geofences);
        }
    }));

    // --- E. GROUP TRIP -------------------------------------------------------
    socket.on("startTrip", safeHandler(socket, (data) => {
        const user = users.get(socket.id);
        if (!user || !data || !isNonEmptyStr(data.name, 80) || !isValidCoordPair(data.lat, data.lng)) return;
        currentTrip = { id: generateId(), name: clampStr(data.name, 80), lat: data.lat, lng: data.lng, hostId: socket.id, members: [{ id: socket.id, name: user.name }] };
        io.emit("tripData", currentTrip);
    }));

    socket.on("joinTrip", safeHandler(socket, () => {
        const user = users.get(socket.id);
        if (currentTrip && user && !currentTrip.members.some((m) => m.id === socket.id)) {
            currentTrip.members.push({ id: socket.id, name: user.name });
            io.emit("tripData", currentTrip);
        }
    }));

    socket.on("leaveTrip", safeHandler(socket, () => {
        if (!currentTrip) return;
        if (currentTrip.hostId === socket.id) {
            currentTrip = null;
            io.emit("tripData", null);
        } else {
            currentTrip.members = currentTrip.members.filter((m) => m.id !== socket.id);
            io.emit("tripData", currentTrip);
        }
    }));

    // --- F. MEMORIES -----------------------------------------------------------
    socket.on("uploadMemoryPhoto", safeHandler(socket, (data) => {
        const user = users.get(socket.id);
        if (!user || !data || !isValidCoordPair(data.lat, data.lng)) return;
        if (typeof data.image !== "string" || !data.image.startsWith("data:image/") || data.image.length > MAX_MEMORY_IMAGE_B64_LEN) return;

        const time = data.time && !isNaN(Date.parse(data.time)) ? data.time : new Date().toISOString();
        const memory = {
            id: generateId(), name: clampStr(data.name || user.name, 40), lat: data.lat, lng: data.lng,
            image: data.image, time, deviceId: user.deviceId || null, tripId: currentTrip?.id || null
        };
        memories.push(memory);
        stmt.insertMemory.run(memory.id, memory.deviceId, memory.name, memory.lat, memory.lng, memory.image, memory.tripId, Date.parse(time));
        io.emit("newMemoryPin", memory);
    }));

    // --- G. EMERGENCY SOS --------------------------------------------------------
    socket.on("sos-alert", safeHandler(socket, (data) => {
        const user = users.get(socket.id);
        if (!user || !data || !isValidCoordPair(data.lat, data.lng)) return;
        socket.broadcast.emit("sos-alert", {
            name: clampStr(data.name || user.name, 40), lat: data.lat, lng: data.lng,
            alt: isFiniteNum(data.alt) ? data.alt : null
        });
    }));

    // --- H. WEBRTC SIGNALING (1:1 — unchanged relay pattern) --------------------
    socket.on("call-user", safeHandler(socket, (data) => {
        if (!data || !isNonEmptyStr(data.to, 40) || !io.sockets.sockets.has(data.to)) return;
        io.to(data.to).emit("incoming-call", { from: socket.id, name: clampStr(data.name || "", 40), signal: data.signal });
    }));
    socket.on("answer-call", safeHandler(socket, (data) => {
        if (!data || !isNonEmptyStr(data.to, 40) || !io.sockets.sockets.has(data.to)) return;
        io.to(data.to).emit("call-accepted", data.signal);
    }));
    socket.on("end-call", safeHandler(socket, (data) => {
        if (!data || !isNonEmptyStr(data.to, 40)) return;
        io.to(data.to).emit("call-ended");
    }));

    // --- I. GROUP VOICE — REAL roster relay (de-fakes join-voice-squad) --------
    // This server piece is a real, working roster broadcast. The actual N-way
    // mesh (each client opening a 1:1 leg via call-user/answer-call to every
    // existing member) is client-side orchestration — that lands in the
    // features.js step. Until that ships, joining the roster is real but
    // nothing calls anyone yet; don't advertise it as functional before then.
    socket.on("join-voice-squad", safeHandler(socket, () => {
        const user = users.get(socket.id);
        if (!user) return;
        const existingRoster = Array.from(voiceSquadMembers.values());
        voiceSquadMembers.set(socket.id, { id: socket.id, name: user.name, avatar: user.avatar });
        socket.emit("voice-squad-roster", { members: existingRoster });
        socket.broadcast.emit("voice-squad-member-joined", { id: socket.id, name: user.name, avatar: user.avatar });
    }));

    socket.on("leave-voice-squad", safeHandler(socket, () => {
        if (voiceSquadMembers.delete(socket.id)) {
            io.emit("voice-squad-member-left", { id: socket.id });
        }
    }));

    // --- J. SESSION / SHARING CONTROL (privacy §15) -----------------------------
    socket.on("startSession", safeHandler(socket, (data) => {
        const user = users.get(socket.id);
        if (!user) return;
        user.sessionMode = ALLOWED_MODES.includes(data?.mode) ? data.mode : "drive";
        users.set(socket.id, user);
        socket.emit("sessionStarted", { mode: user.sessionMode });
    }));

    socket.on("endSession", safeHandler(socket, () => {
        const user = users.get(socket.id);
        if (!user) return;
        user.sessionMode = null;
        users.set(socket.id, user);
        socket.emit("sessionEnded", {});
    }));

    socket.on("setSharing", safeHandler(socket, (data) => {
        const user = users.get(socket.id);
        if (!user) return;
        user.sharing = data?.enabled !== false;
        users.set(socket.id, user);
        if (!user.sharing) socket.broadcast.emit("userOffline", { id: socket.id });
        else socket.broadcast.emit("userOnline", publicUser(user));
    }));

    // --- K. MEETUP OPTIMIZATION (real road-network travel time, not a guess) ---
    // Client calls: socket.emit('computeMeetup', {memberIds, strategy}, (res) => {...})
    // Uses an ack callback rather than a broadcast 'meetupResult' event — this
    // is a request scoped to one asker, not squad-wide news; an ack avoids
    // broadcasting to everyone and avoids needing a correlation id client-side.
    socket.on("computeMeetup", safeHandler(socket, async (data, ack) => {
        if (typeof ack !== "function") return;
        try {
            const memberIds = Array.isArray(data?.memberIds) ? data.memberIds.slice(0, 8) : [];
            const strategy = data?.strategy === "minimax" ? "minimax" : "sum";

            const members = memberIds
                .map((id) => (id === "me" ? users.get(socket.id) : users.get(id)))
                .filter((u) => u && isValidCoordPair(u.lat, u.lng) && u.sharing !== false);

            if (members.length < 2) return ack({ ok: false, reason: "need-at-least-2-located-members" });

            const extraCandidates = Array.isArray(data?.extraCandidates)
                ? data.extraCandidates.filter((c) => isValidCoordPair(c?.lat, c?.lng)).slice(0, 6)
                : [];
            const candidates = buildMeetupCandidates(members, extraCandidates);
            const matrix = await fetchOsrmTable(members, candidates);
            if (!matrix) return ack({ ok: false, reason: "routing-service-unavailable" });

            const scored = candidates
                .map((cand, ci) => {
                    const perMember = members.map((m, mi) => ({
                        id: m.id, name: m.name,
                        durationSec: matrix.durations[mi][ci], distanceM: matrix.distances[mi][ci]
                    }));
                    if (perMember.some((p) => p.durationSec == null)) return null; // unreachable for someone
                    return {
                        lat: cand.lat, lng: cand.lng, label: cand.label,
                        perMember,
                        sumSec: perMember.reduce((a, p) => a + p.durationSec, 0),
                        maxSec: Math.max(...perMember.map((p) => p.durationSec))
                    };
                })
                .filter(Boolean);

            if (scored.length === 0) return ack({ ok: false, reason: "no-reachable-candidate" });

            scored.sort((a, b) => (strategy === "minimax" ? a.maxSec - b.maxSec : a.sumSec - b.sumSec));
            ack({ ok: true, strategy, results: scored.slice(0, 3) });
        } catch (err) {
            console.error("computeMeetup error:", err);
            ack({ ok: false, reason: "internal-error" });
        }
    }));

    // --- L. CARPOOL PICKUP ORDERING (OSRM /trip — restricted TSP, solved for free) ---
    // Client calls: socket.emit('carpoolOptimize', {start, pickups, destination}, (res)=>{...})
    socket.on("carpoolOptimize", safeHandler(socket, async (data, ack) => {
        if (typeof ack !== "function") return;
        try {
            const start = data?.start, dest = data?.destination;
            const stops = Array.isArray(data?.pickups) ? data.pickups.slice(0, 8) : [];
            if (!isValidCoordPair(start?.lat, start?.lng) || !isValidCoordPair(dest?.lat, dest?.lng)) {
                return ack({ ok: false, reason: "invalid-start-or-destination" });
            }
            if (stops.length === 0 || stops.some((s) => !isValidCoordPair(s?.lat, s?.lng))) {
                return ack({ ok: false, reason: "invalid-pickup-coords" });
            }

            const coordStr = [start, ...stops, dest].map((p) => `${p.lng},${p.lat}`).join(";");
            const url = `${OSRM_BASE}/trip/v1/driving/${coordStr}?source=first&destination=last&roundtrip=false&steps=false`;
            const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
            if (!res.ok) return ack({ ok: false, reason: "routing-service-unavailable" });
            const json = await res.json();
            if (json.code !== "Ok" || !json.trips?.length) return ack({ ok: false, reason: "no-route-found" });

            const trip = json.trips[0];
            const pickupOrder = json.waypoints
                .map((wp, originalIdx) => ({ originalIdx, tripOrder: wp.waypoint_index }))
                .filter((w) => w.originalIdx > 0 && w.originalIdx <= stops.length) // exclude start(0) & destination(last)
                .sort((a, b) => a.tripOrder - b.tripOrder)
                .map((w) => stops[w.originalIdx - 1]);

            ack({
                ok: true, pickupOrder,
                totalDistanceKm: +(trip.distance / 1000).toFixed(2),
                totalDurationMin: Math.round(trip.duration / 60),
                geometry: trip.geometry
            });
        } catch (err) {
            console.error("carpoolOptimize error:", err);
            ack({ ok: false, reason: "internal-error" });
        }
    }));

    // --- M. TRIP ANALYTICS PERSISTENCE ------------------------------------------
    // One event at trip end carrying a downsampled point log, NOT a DB write per
    // GPS tick — the realtime layer is untouched by this.
    socket.on("tripFinished", safeHandler(socket, (data) => {
        const user = users.get(socket.id);
        if (!user || !user.deviceId || !data) return;

        const points = (Array.isArray(data.points) ? data.points : [])
            .slice(0, 2000)
            .filter((p) => isValidCoordPair(p?.lat, p?.lng) && isFiniteNum(p?.ts));

        const tripId = generateId();
        stmt.insertTrip.run(
            tripId, user.deviceId, clampStr(data.name || "", 80),
            ALLOWED_MODES.includes(data.mode) ? data.mode : "drive",
            isFiniteNum(data.startedAt) ? data.startedAt : Date.now(),
            isFiniteNum(data.endedAt) ? data.endedAt : Date.now(),
            isFiniteNum(data.totalDistKm) ? data.totalDistKm : 0,
            isFiniteNum(data.avgSpeed) ? data.avgSpeed : 0,
            isFiniteNum(data.maxSpeed) ? data.maxSpeed : 0,
            isFiniteNum(data.fuelUsedL) ? data.fuelUsedL : 0
        );

        const insertMany = db.transaction((pts) => {
            for (const p of pts) {
                stmt.insertTripPoint.run(tripId, p.ts, p.lat, p.lng, isFiniteNum(p.speedKmh) ? p.speedKmh : null, isFiniteNum(p.accuracy) ? p.accuracy : null);
            }
        });
        insertMany(points);
    }));

    // --- N. PRIVACY: DELETE MY HISTORY ------------------------------------------
    socket.on("deleteMyHistory", safeHandler(socket, (_data, ack) => {
        const user = users.get(socket.id);
        if (!user || !user.deviceId) {
            if (typeof ack === "function") ack({ ok: false, reason: "no-device-identity" });
            return;
        }
        const tripIds = stmt.tripIdsForDevice.all(user.deviceId).map((r) => r.id);
        const del = db.transaction(() => {
            for (const id of tripIds) stmt.deleteTripPointsFor.run(id);
            stmt.deleteTripsForDevice.run(user.deviceId);
            stmt.deleteMemoriesForDevice.run(user.deviceId);
        });
        del();
        if (typeof ack === "function") ack({ ok: true, tripsDeleted: tripIds.length });
    }));

    // --- O. DISCONNECT -----------------------------------------------------------
    socket.on("disconnect", () => {
        console.log(`🔴 Disconnected: ${socket.id}`);
        socketEventCounts.delete(socket.id);

        if (voiceSquadMembers.delete(socket.id)) {
            io.emit("voice-squad-member-left", { id: socket.id });
        }

        if (users.has(socket.id)) {
            const user = users.get(socket.id);
            user.online = false;

            io.emit("userOffline", { id: socket.id });
            io.emit("friendDisconnected", socket.id);

            if (currentTrip) {
                if (currentTrip.hostId === socket.id) {
                    currentTrip = null;
                    io.emit("tripData", null);
                } else {
                    currentTrip.members = currentTrip.members.filter((m) => m.id !== socket.id);
                    io.emit("tripData", currentTrip);
                }
            }

            setTimeout(() => users.delete(socket.id), 5000);
        }
    });
});

// ==========================================================================
// 9. START SERVER
// ==========================================================================
const PORT = process.env.PORT || 3000;
server.listen(PORT, "0.0.0.0", () => {
    console.log(`🚀 MapUnite Server running on http://localhost:${PORT}`);
    console.log(`   DB: ${DB_PATH}`);
    console.log(`   OSRM: ${OSRM_BASE}`);
});
