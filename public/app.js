"use strict";

/* ============================================================================
   MapUnite client — app.js  (v3, roadmap-aligned refactor)
   ==============================================================================
   This is an ADDITIVE rewrite over the working original: the realtime hot path
   (GPS -> socket -> markers), chat, memories, geofencing, group trip, 1:1 WebRTC
   calling, search+navigation and the join flow are all preserved. What changed:

     - Service worker registration REMOVED from here — shell.js is now the one
       and only place that registers /sw.js (fixes the SW teardown/rebuild race).
     - Satellite/terrain tiles swapped off the unofficial mt0.google.com/vt path
       onto Esri World Imagery + OpenTopoMap (roadmap Section 20).
     - GpsFilter + gpsConfidence(): moving-average smoothing, spike rejection and a
       transparent 0..1 confidence score computed from ACTUAL accuracy/dt, not
       the hardcoded accuracy=10/dtSec=1 stand-ins the shipped build used
       (roadmap Sections 8 + 14).
     - SmartDrive.checkSafetyLimits: escalation-safe per-tier cooldown (a lower
       tier can no longer suppress a higher one) + confidence gating.
     - Fuel model v2: idle burn while stopped-but-active, U-shaped efficiency
       curve, explicit "what if you'd driven efficiently" comparison, all
       labeled as estimates in the results panel (roadmap Section 9).
     - DeviceIdentity: a persisted per-device UUID + server-issued token,
       completing the identity handshake server.js already expects
       (roadmap Section 15).
     - PrivacyControls: wires the sharing-mode segmented control + export/clear
       buttons Step 2 added to the settings modal to the matching sockets.
     - MeetupPlanner + CarpoolPlanner: new modules that call the server's
       computeMeetup / carpoolOptimize sockets and render into the map/UI
       (roadmap Sections 11 + 12).
     - Two real bugs fixed: `TripDB.restoreTrip()` / `TripDB.restoreNavState()`
       don't exist on TripDB (features.js only exposes `restoreAll()`) — both
       call sites threw. Fixed to read through `restoreAll()`.

   PHASE 3 (roadmap Sections 4 + 13) — additive:
     - TripAnalytics: day / week / month rollups from the server's
       `getTripRollups` (bucketed in the rider's LOCAL time via tzOffsetMin),
       an accessible SVG bar chart + table twin, recent rides from
       `listMyTrips`, and ride replay from `getTripPoints` drawn in the speed
       tiers the alerts use.
     - Offline-safe `tripFinished`: a finished ride is queued in localStorage
       and flushed after `profileAccepted`, so a ride that ends out of signal
       isn't lost.
     - Voice bridge: `voiceAnnounce()` hands speed / navigation / geofence /
       SOS cues to features.js's VoiceAssistant, and `mu:drive-state` events
       tell it (and hands-free listening) when a drive starts or stops.
     - Navigation now shows and speaks the NEXT maneuver ("In 200 metres, turn
       left onto NH-26"). Before, the banner showed the maneuver just done.
     - Fixed: the trip gear checklist never rendered (insertBefore() was given
       a node that isn't a child of #trip-panel, and the throw was swallowed).
     - Fixed: geofence / SOS island text was HTML-escaped and then set through
       textContent, so "Tom & Jerry" displayed as "Tom &amp; Jerry".

   PHASE 4 (roadmap Section 5 — experimental) — additive:
     - DeadReckoning: when GPS drops out mid-drive (tunnel, cutting, canopy),
       the marker keeps moving from the phone's motion sensors — heading
       from the OS's relative orientation (gyro fusion, no magnetometer),
       speed from GPS speed + learned forward-axis accelerations, snapped to
       the active route when there is one — inside an honestly growing
       uncertainty circle. The error is measured when GPS returns and kept
       in a small local log (settings). Coarse network fixes are blended in
       instead of yanking the marker a kilometre.
     - Navigation follows the estimate through a tunnel (prompts, trail,
       "No GPS" status) but never reroutes or declares arrival off a guess.
     - Friends: positions relayed over the LoRa radio (features.js
       ConvoyRelay) or dead-reckoned by the friend's phone are drawn and
       labelled as such ("📻 via radio · 40 s ago", "≈ ±120 m"), and count as
       live for the convoy / trip panel / "where is" even with their socket
       gone.
     - SOS: also goes out over the radio when one is paired; incoming SOS is
       de-duplicated across the radio and server copies.
     - Fixed: a friend's profile popup showed the data from when their
       marker was FIRST created (the click handler captured a stale object).
     - Fixed: you appeared in your own friend list (the server's trip-state
       broadcast reaches the sender too); a fix taken before the socket was
       identified was dropped, so a stationary rider showed no position until
       they moved; the trip panel asked OSRM for routes from "null,null"; an
       SOS pressed offline went out before re-identification and was lost.
     - UI: the compass button ("reset bearing" on a map that never rotates)
       is now "Follow me" — keeps the map centred on you, off when you drag.
   ============================================================================ */

const socket = io({ transports: ["websocket", "polling"] });
const DEFAULT_CENTER = [22.2475, 84.8828];
const DEFAULT_AVATAR = "satyam.png";
const MAX_NAME = 40;

const map = L.map("map", {
    zoomControl: false, preferCanvas: false, minZoom: 3, maxBounds: [[-90, -180], [90, 180]], maxBoundsViscosity: 1.0
}).setView(DEFAULT_CENTER, 13);

// ---- TILE LAYERS -----------------------------------------------------------
// Satellite + terrain used to hit https://{s}.google.com/vt/... — an
// undocumented XYZ path, not the licensed Maps tile API, that Google can
// rate-limit or kill without notice (roadmap Section 20). Swapped for two
// properly licensed free sources; street/dark were already fine and are
// unchanged.
const satelliteLayer = L.tileLayer(
    "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}",
    { maxZoom: 19, attribution: "Tiles &copy; Esri — Esri, Maxar, Earthstar Geographics" }
);
const streetLayer = L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", { maxZoom: 19, attribution: "&copy; OpenStreetMap contributors" });
const darkLayer = L.tileLayer("https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png", { maxZoom: 20, attribution: "&copy; OpenStreetMap contributors &copy; CARTO" });
const terrainLayer = L.tileLayer("https://{s}.tile.opentopomap.org/{z}/{x}/{y}.png", { maxZoom: 17, subdomains: "abc", attribution: "Map data: &copy; OpenStreetMap contributors, SRTM | Map style: &copy; OpenTopoMap (CC-BY-SA)" });
satelliteLayer.addTo(map);

let currentUser = { name: localStorage.getItem("koraput_name") || "", avatar: localStorage.getItem("koraput_avatar") || DEFAULT_AVATAR };
let myCoords = null, myWeather = "", ownMarker = null, accuracyCircle = null, cityName = "";
let lastWeatherFetch = 0;
const friendMarkers = Object.create(null);
const friendData = Object.create(null);

// ---- DEVICE IDENTITY (roadmap Section 15) ----------------------------------
// A UUID persisted in localStorage, sent with every profileReady. On first
// sight the server mints a secret token and returns it once (profileAccepted);
// we store only that token and resend it on every reconnect. This closes the
// "anyone can profileReady as anyone" gap without needing real accounts.
const DeviceIdentity = {
    KEY_ID: "mu_device_id", KEY_TOKEN: "mu_device_token",
    id: null, token: null,

    init() {
        this.id = localStorage.getItem(this.KEY_ID);
        if (!this.id || !/^[0-9a-f-]{36}$/i.test(this.id)) {
            this.id = (crypto.randomUUID ? crypto.randomUUID() : this._fallbackUuid());
            localStorage.setItem(this.KEY_ID, this.id);
        }
        this.token = localStorage.getItem(this.KEY_TOKEN) || null;
    },
    _fallbackUuid() {
        return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
            const r = (Math.random() * 16) | 0, v = c === "x" ? r : (r & 0x3) | 0x8;
            return v.toString(16);
        });
    },
    // Called from profileAccepted. The server only ever issues a token the
    // FIRST time it sees a deviceId — a truthy value here means "new token."
    storeIssuedToken(token) {
        if (typeof token === "string" && token.length > 0) {
            this.token = token;
            localStorage.setItem(this.KEY_TOKEN, token);
        }
    },
    // The server rejected our token (cleared storage on another device, or a
    // stale/corrupted token). We can't recover the old identity — the honest
    // move is to mint a fresh one rather than loop rejections forever.
    resetAfterRejection() {
        localStorage.removeItem(this.KEY_TOKEN);
        this.id = (crypto.randomUUID ? crypto.randomUUID() : this._fallbackUuid());
        this.token = null;
        localStorage.setItem(this.KEY_ID, this.id);
    }
};
DeviceIdentity.init();

// ---- GPS FILTER + CONFIDENCE (roadmap Sections 8 + 14) ---------------------
// Sits in front of SmartDrive.tick(): scores every raw fix FIRST, and only a
// fix that passes the gate is allowed to touch anything that persists — the
// speed average, trip distance/fuel, the graph, the trail, the broadcast
// speed. (Audit fix: the first v2 build smoothed BEFORE scoring, so one
// rejected 300 km/h spike sat in the 8-sample average and produced ~7 s of
// "64 km/h" at 0.92 confidence — false alerts from a fix it had rejected.)
//
//   accepted     conf >= GATE: becomes the new anchor, feeds the average.
//   rejected     conf <  GATE (weak accuracy, implausible acceleration): the
//                map still shows it (accuracy circle says how much to trust
//                it), but speed/stats hold their last good values.
//   hardReject   physically impossible jump from the last good fix: not
//                shown, not stored, not broadcast.
//   reanchored   REANCHOR_AFTER hard-rejected fixes that agree with EACH
//                OTHER mean the old anchor was the bad one (stale cached
//                fix, a wild first fix): accept them, credit no distance for
//                the jump, restart the average. Nothing can lock us out.
// Distances here are exact metres — the shared distanceKm() rounds to 10 m,
// which at 1 Hz quantised derived speed into 36 km/h steps and dropped every
// sub-10 m step from trip distance.
const GpsFilter = {
    history: [],           // recent speeds of ACCEPTED fixes, for the moving average
    MAX_HISTORY: 8,
    lastSmoothed: 0,       // read by features.js ("how fast am I going", where am I)
    GATE: 0.4,             // same threshold checkSafetyLimits() acts on
    STALE_GAP_SEC: 10,     // a longer gap between good fixes restarts the average
    REANCHOR_AFTER: 3,
    anchor: null,          // last ACCEPTED fix { lat, lng, t, speedKmh }
    pending: [],           // consecutive hard-rejected fixes that agree with each other
    stats: { accepted: 0, rejected: 0, hardRejected: 0, reanchored: 0 },

    smooth(rawSpeedKmh) {
        this.history.push(rawSpeedKmh);
        if (this.history.length > this.MAX_HISTORY) this.history.shift();
        return this.history.reduce((a, b) => a + b, 0) / this.history.length;
    },

    // > 8 m/s^2 sustained is implausible for normal riding/driving.
    isPlausibleJump(prevSpeedKmh, newSpeedKmh, dtSec) {
        if (dtSec <= 0) return true;
        const deltaMs = Math.abs(newSpeedKmh - prevSpeedKmh) / 3.6;
        return (deltaMs / dtSec) < 8;
    },

    // Coarse mode from a sustained speed band — used only as a fallback
    // suggestion; an explicit user mode pick (skunkworks) always wins.
    detectMode(avgSpeedKmh) {
        if (avgSpeedKmh < 7) return "walk";
        if (avgSpeedKmh < 25) return "cycle";
        return "drive";
    },

    metres(lat1, lng1, lat2, lng2) {
        const r = Math.PI / 180;
        const h = Math.sin((lat2 - lat1) * r / 2) ** 2 + Math.cos(lat1 * r) * Math.cos(lat2 * r) * Math.sin((lng2 - lng1) * r / 2) ** 2;
        return 12742000 * Math.asin(Math.min(1, Math.sqrt(h)));
    },

    // The time a fix was TAKEN. A warm-start fix served from the OS cache can
    // be minutes old; timing it "now" would make the first live fix look like
    // a teleport from wherever the phone was last seen.
    fixTime(p) {
        const now = Date.now();
        const t = Number(p && p.timestamp);
        return Number.isFinite(t) && t > 0 && t <= now + 5000 ? Math.min(t, now) : now;
    },

    // One raw fix in, one verdict out. Pure bookkeeping — no DOM, no sockets.
    //   fix: { lat, lng, t, accuracyM, gpsSpeedKmh (null when the device
    //          reported none / zero) }
    assess(fix) {
        const acc = Number.isFinite(fix.accuracyM) && fix.accuracyM > 0 ? fix.accuracyM : 100;
        const accScore = Math.max(0, 1 - acc / 100);
        const a = this.anchor;
        const out = { accepted: false, hardReject: false, reanchored: false, confidence: 0, accuracyM: acc,
            speedKmh: 0, smoothedKmh: this.lastSmoothed, distKm: 0, dtSec: 1 };

        let jumpM = 0, dtSec = 1, speed = Number.isFinite(fix.gpsSpeedKmh) && fix.gpsSpeedKmh >= 0 ? fix.gpsSpeedKmh : null;
        if (a) {
            jumpM = this.metres(a.lat, a.lng, fix.lat, fix.lng);
            dtSec = Math.max(0.001, (fix.t - a.t) / 1000);
            if (speed === null) speed = dtSec > 0.5 ? (jumpM / 1000) / dtSec * 3600 : 0;
        } else if (speed === null) speed = 0;
        out.speedKmh = speed;
        out.dtSec = dtSec;

        const conf = a
            ? gpsConfidence({ accuracyM: acc, prevSpeedKmh: a.speedKmh, newSpeedKmh: speed, dtSec, jumpDistanceKm: jumpM / 1000 })
            : accScore;                                           // first fix: nothing to compare against yet
        const teleport = Boolean(a) && jumpM / 1000 >= (300 / 3600) * dtSec;
        out.confidence = conf;

        if (conf >= this.GATE) {
            this.pending = [];
            if (dtSec > this.STALE_GAP_SEC) this.history = [];
            out.accepted = true;
            out.distKm = jumpM / 1000;
        } else if (teleport && accScore >= this.GATE) {
            // Accurate-looking but impossible from the anchor: is the ANCHOR the outlier?
            const last = this.pending[this.pending.length - 1];
            const agrees = last && (fix.t - last.t) > 0 &&
                this.metres(last.lat, last.lng, fix.lat, fix.lng) / 1000 < (300 / 3600) * Math.max(1, (fix.t - last.t) / 1000);
            this.pending = agrees ? this.pending.concat([{ lat: fix.lat, lng: fix.lng, t: fix.t }]) : [{ lat: fix.lat, lng: fix.lng, t: fix.t }];
            if (this.pending.length >= this.REANCHOR_AFTER) {
                // Speed of the re-anchored stretch comes from the agreeing fixes, never from the jump.
                if (!(Number.isFinite(fix.gpsSpeedKmh) && fix.gpsSpeedKmh >= 0)) {
                    const prev = this.pending[this.pending.length - 2];
                    const dt = (fix.t - prev.t) / 1000;
                    out.speedKmh = dt > 0.5 ? this.metres(prev.lat, prev.lng, fix.lat, fix.lng) / 1000 / dt * 3600 : 0;
                }
                this.pending = [];
                this.history = [];
                out.accepted = true; out.reanchored = true;
                out.confidence = accScore;
                out.distKm = 0;                                   // the jump itself is never credited
                this.stats.reanchored++;
            } else {
                out.hardReject = true;
            }
        } else if (teleport) {
            this.pending = [];
            out.hardReject = true;
        } else {
            this.pending = [];
        }

        if (out.accepted) {
            this.anchor = { lat: fix.lat, lng: fix.lng, t: fix.t, speedKmh: out.speedKmh };
            this.lastSmoothed = this.smooth(out.speedKmh);
            out.smoothedKmh = this.lastSmoothed;
            this.stats.accepted++;
        } else if (out.hardReject) this.stats.hardRejected++;
        else this.stats.rejected++;
        return out;
    },

    // Trip start: restart the average, keep the anchor (a fresh trip must not
    // lose teleport protection on its first fix).
    reset() { this.history = []; this.lastSmoothed = 0; this.pending = []; }
};

// Transparent 0..1 implausibility-aware confidence score. Not "spoof-proof" —
// nothing running in a browser tab honestly can be — this scores how much to
// trust a fix, and gates alerts/graph points on it rather than clamp-and-trust.
function gpsConfidence({ accuracyM, prevSpeedKmh, newSpeedKmh, dtSec, jumpDistanceKm }) {
    const acc = Number.isFinite(accuracyM) ? accuracyM : 100;
    const accScore = Math.max(0, 1 - acc / 100);
    let score = accScore;

    if (dtSec > 0) {
        const impliedAccel = Math.abs(newSpeedKmh - prevSpeedKmh) / 3.6 / dtSec;   // m/s^2
        const accelOk = impliedAccel < 8;
        if (!accelOk) score *= 0.2;

        const maxPlausibleKm = (300 / 3600) * dtSec;                               // 300 km/h hard ceiling
        const teleportOk = jumpDistanceKm < maxPlausibleKm;
        if (!teleportOk) score = 0;                                                // hard reject, not a clamp
    }
    return Math.max(0, Math.min(1, score));
}

let lastFixCoords = null, lastFixTime = 0;
let locationHistory = [];
try {
    const stored = localStorage.getItem("koraput_history");
    if (stored) locationHistory = JSON.parse(stored);
    if (!Array.isArray(locationHistory)) locationHistory = [];
} catch (e) { locationHistory = []; }

const p4LayerGroup = L.layerGroup().addTo(map);
const measureLayer = L.layerGroup().addTo(map);
const historyPolyline = L.polyline(locationHistory, { color: '#3b82f6', weight: 4, opacity: 0.8, dashArray: '5, 10' }).addTo(p4LayerGroup);
const navigationLayer = L.layerGroup().addTo(map);
const tripRoutesLayer = L.layerGroup().addTo(map);
const memoryLayer = L.layerGroup().addTo(map);
const meetupLayer = L.layerGroup().addTo(map);
const carpoolLayer = L.layerGroup().addTo(map);

const tripLastFetchedCoords = {};
let tripRoadStats = {};
const routeColors = ['#18d6a3', '#3b82f6', '#f59e0b', '#ec4899', '#8b5cf6'];

let mapActionMode = null;
let pendingMemoryImage = null;
let measurePoints = [];
let currentTrip = null;
let tripMarker = null;
let searchPlace = null;

let geoClickCount = 0, geoClickTimer = null;
let currentGeofences = [];
const memories = new Map();
let currentGalleryFilter = "all", currentGallerySearch = "", selectedMemoryId = null;

let searchMarker = null;
let offlineMessageQueue = [];
let offlineMemoryQueue = [];
let myOwnerKey = null;   // set from profileAccepted; identifies "my own" geofences across reconnects

const $ = id => document.getElementById(id);
const safeShow = (id, displayStyle = "flex") => { const el = $(id); if (el) el.style.display = displayStyle; };
const safeHide = (id) => { const el = $(id); if (el) el.style.display = "none"; };
const cleanName = v => String(v || "User").trim().replace(/\s+/g, " ").slice(0, MAX_NAME);
const validCoord = (lat, lng) => Number.isFinite(lat) && Number.isFinite(lng) && lat >= -90 && lat <= 90 && lng >= -180 && lng <= 180;

function distanceKm(a, b, c, d) {
    if (!validCoord(a, b) || !validCoord(c, d)) return "";
    const p = Math.PI / 180, a1 = 0.5 - Math.cos((c - a) * p) / 2 + Math.cos(a * p) * Math.cos(c * p) * Math.sin((d - b) * p / 2) ** 2;
    return (12742 * Math.asin(Math.sqrt(a1))).toFixed(2);
}
function escapeHTML(v) { return String(v ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#039;"); }

// Phase 4: a rider whose socket is gone but whose position still arrives over
// the radio relay counts as LIVE for the convoy loop, the trip panel, routes
// and "where is" — just not for calls.
const RADIO_FRESH_MS = 10 * 60 * 1000;
function friendIsLive(f) {
    if (!f) return false;
    if (f.online !== false) return true;
    return f.via === "radio" && Number.isFinite(f.viaAt) && Date.now() - f.viaAt < RADIO_FRESH_MS;
}
// "just now" / "4 min ago" for relayed positions.
function agoText(ts) {
    const s = Math.max(0, Math.round((Date.now() - Number(ts)) / 1000));
    if (!Number.isFinite(s) || s < 45) return "just now";
    if (s < 3600) return `${Math.round(s / 60)} min ago`;
    return `${Math.round(s / 3600)} h ago`;
}

// Small helper: a Promise-based confirm that prefers shell.js's sheet but
// degrades to window.confirm if shell.js hasn't loaded for some reason.
async function confirmDialog(opts) {
    if (window.MapUnite && typeof window.MapUnite.confirm === "function") return window.MapUnite.confirm(opts);
    return { ok: window.confirm(opts.body || opts.title || "Are you sure?"), checked: false };
}
function islandShow(spec) { if (window.StatusIsland) return window.StatusIsland.show(spec); }
function islandHide(id) { if (window.StatusIsland) window.StatusIsland.hide(id); }

// ---- Route options: avoid highways / tolls (roadmap Section 4) ------------
// One rider preference, applied to EVERY route this app draws — search route
// (Google avoidHighways/avoidTolls), navigation + its reroutes, voice
// "navigate to", route-to-friend, measurement, group trip, meetup routes,
// restored navigation and the carpool plan (OSRM `exclude=`).
//
// What OSRM can and can't do, stated plainly in the UI too:
//   - "highways" = OSM highway=motorway (expressways). Most Indian national
//     highways are tagged `trunk`, which OSRM's car profile has no class for,
//     so they are NOT avoided on OSRM routes. Google search routes use
//     Google's own, broader definition.
//   - Some OSRM servers can exclude motorway OR toll but not both at once.
//     Then we exclude one and pick an alternative whose steps carry none of
//     the other class (step intersections report `classes`).
//   - If no route avoids them, or the server can't exclude at all, the normal
//     route is used and the rider is TOLD — never a silent "no route".
// fetchRoute(url) is a drop-in for `fetch(url).then(r => r.json())` and adds
// `avoid: { requested, applied, reason }` to the JSON.
const RoutePrefs = {
    KEY: "mu_route_avoid",
    avoidHighways: false,
    avoidTolls: false,
    support: { exclude: null, combo: null },   // learned from the routing server this session
    lastNoticeAt: 0,
    NAMES: { motorway: "highways", toll: "tolls" },

    load() {
        try {
            const v = JSON.parse(localStorage.getItem(this.KEY) || "{}");
            this.avoidHighways = v.highways === true;
            this.avoidTolls = v.tolls === true;
        } catch (e) { /* storage blocked or corrupt — defaults */ }
    },
    save() {
        try { localStorage.setItem(this.KEY, JSON.stringify({ highways: this.avoidHighways, tolls: this.avoidTolls })); } catch (e) { /* ignore */ }
        document.dispatchEvent(new CustomEvent("mu:route-prefs", { detail: { highways: this.avoidHighways, tolls: this.avoidTolls } }));
    },
    classes() {
        const c = [];
        if (this.avoidHighways) c.push("motorway");
        if (this.avoidTolls) c.push("toll");
        return c;
    },
    describe(list = this.classes()) { return list.map((c) => this.NAMES[c] || c).join(" and "); },

    // Query params are appended as plain text: URLSearchParams would encode the
    // comma in "motorway,toll", and OSRM expects it literally.
    withParams(url, params) {
        let u = String(url);
        for (const k of Object.keys(params)) u = u.replace(new RegExp(`([?&])${k}=[^&]*&?`), "$1").replace(/[?&]$/, "");
        const q = Object.entries(params).map(([k, v]) => `${k}=${v}`).join("&");
        return u + (u.includes("?") ? "&" : "?") + q;
    },
    routeHas(route, cls) {
        return Boolean(route && Array.isArray(route.legs) && route.legs.some((l) => Array.isArray(l.steps) &&
            l.steps.some((s) => Array.isArray(s.intersections) && s.intersections.some((i) => Array.isArray(i.classes) && i.classes.includes(cls)))));
    },
    async getJson(url) {
        const r = await fetch(url);                   // network errors propagate, exactly like the old call sites
        try { return await r.json(); } catch (e) { return { code: r.ok ? "BadResponse" : `Http${r.status}` }; }
    },

    async fetchRoute(url) {
        const requested = this.classes();
        if (!requested.length) return this.done(await this.getJson(url), requested, [], null);
        const ok = (j) => j && j.code === "Ok" && Array.isArray(j.routes) && j.routes.length > 0;
        const unsupported = (j) => j && /^(InvalidValue|InvalidOptions|InvalidQuery)$/.test(j.code);

        // 1. Everything at once.
        if (this.support.exclude !== false && (requested.length === 1 || this.support.combo !== false)) {
            const j = await this.getJson(this.withParams(url, { exclude: requested.join(",") }));
            if (ok(j)) {
                this.support.exclude = true;
                if (requested.length > 1) this.support.combo = true;
                return this.done(j, requested, requested, null);
            }
            if (unsupported(j)) { if (requested.length > 1) this.support.combo = false; else this.support.exclude = false; }
            else if (requested.length === 1) return this.done(await this.getJson(url), requested, [], "no-route");
        }
        // 2. Server can't combine the two: exclude one, keep an alternative free of the other.
        if (requested.length > 1 && this.support.exclude !== false) {
            let partial = null;
            for (const cls of requested) {
                const j = await this.getJson(this.withParams(url, { exclude: cls, alternatives: "true", steps: "true" }));
                if (unsupported(j)) { this.support.exclude = false; break; }
                this.support.exclude = true;
                if (!ok(j)) continue;
                const others = requested.filter((c) => c !== cls);
                const clean = j.routes.find((r) => others.every((o) => !this.routeHas(r, o)));
                if (clean) { j.routes = [clean]; return this.done(j, requested, requested, null); }
                if (!partial) { j.routes = [j.routes[0]]; partial = { j, applied: [cls] }; }
            }
            if (partial) return this.done(partial.j, requested, partial.applied, "partial");
        }
        return this.done(await this.getJson(url), requested, [], this.support.exclude === false ? "unsupported" : "no-route");
    },

    done(json, requested, applied, reason) {
        const j = json && typeof json === "object" ? json : { code: "BadResponse" };
        j.avoid = { requested, applied, reason };
        if (reason && j.code === "Ok") this.notify(j.avoid);
        return j;
    },
    notify(a) {
        if (Date.now() - this.lastNoticeAt < 60000) return;       // once a minute, not once per rider route
        this.lastNoticeAt = Date.now();
        const missed = a.requested.filter((c) => !a.applied.includes(c));
        const msg = a.reason === "unsupported"
            ? `The routing server can't avoid ${this.describe(a.requested)} — showing the normal route.`
            : a.reason === "partial"
                ? `Avoided ${this.describe(a.applied)}, but no route here also avoids ${this.describe(missed)}.`
                : `No route here avoids ${this.describe(a.requested)} — showing the normal route.`;
        showToast(`🛣️ ${msg}`, 5000);
    },

    // Google DirectionsService request options for the search route.
    googleOptions() { return { avoidHighways: this.avoidHighways, avoidTolls: this.avoidTolls }; },

    bindUI() {
        const hw = $("avoid-highways-toggle"), tl = $("avoid-tolls-toggle");
        if (hw) { hw.checked = this.avoidHighways; hw.addEventListener("change", () => { this.avoidHighways = hw.checked; this.lastNoticeAt = 0; this.save(); }); }
        if (tl) { tl.checked = this.avoidTolls; tl.addEventListener("change", () => { this.avoidTolls = tl.checked; this.lastNoticeAt = 0; this.save(); }); }
        // Keep the switches truthful when the voice command changes the setting.
        document.addEventListener("mu:route-prefs", (e) => {
            if (hw) hw.checked = Boolean(e.detail.highways);
            if (tl) tl.checked = Boolean(e.detail.tolls);
        });
    }
};
RoutePrefs.load();

// ---- Voice bridge (Phase 3) ------------------------------------------------
// Every spoken cue in app.js goes through here. features.js's VoiceAssistant
// owns the policy (priority queue, mute, "spoken alerts" setting, echo guard
// for hands-free listening). If features.js failed to load, fall back to a
// plain utterance so safety-critical cues still get through.
//   opts: { priority 0..100, key (dedupe), cooldownMs, category,
//           drivingOnly (skip unless a drive is active), force (user-asked
//           replies / SOS: bypass the settings toggle and mute), maxAgeMs }
function voiceAnnounce(text, opts = {}) {
    if (window.VoiceAssistant && typeof window.VoiceAssistant.announce === "function") {
        return window.VoiceAssistant.announce(text, opts);
    }
    try {
        if (!("speechSynthesis" in window) || !text) return false;
        if ((opts.priority ?? 50) < 60 && !opts.force) return false;
        window.speechSynthesis.speak(new SpeechSynthesisUtterance(String(text)));
        return true;
    } catch (e) { return false; }
}

// Live navigation state, read by voice commands ("how far?") and by
// isDriving(). Updated only inside startSearchNavigation()/stopDrive().
const navState = { ready: false, active: false, destName: "", remainingM: null, etaSec: null, nextManeuver: "", routePath: null };

// Broadcast drive start/stop so features.js can arm hands-free listening and
// the convoy loop without app.js knowing about either.
function isDriving() {
    return Boolean((typeof SmartDrive !== "undefined" && SmartDrive.trip && SmartDrive.trip.active) || navState.active);
}
function emitDriveState() {
    document.dispatchEvent(new CustomEvent("mu:drive-state", { detail: { driving: isDriving(), navigating: navState.active } }));
}

// Spoken-distance/time helpers shared with features.js.
function spokenDistance(meters) {
    if (!Number.isFinite(meters)) return "";
    if (meters < 100) return `${Math.max(10, Math.round(meters / 10) * 10)} metres`;
    if (meters < 1000) return `${Math.round(meters / 50) * 50} metres`;
    const km = meters / 1000;
    return `${km >= 10 ? Math.round(km) : km.toFixed(1).replace(/\.0$/, "")} kilometres`;
}
function spokenMinutes(min) {
    const m = Math.max(0, Math.round(min));
    if (m < 1) return "less than a minute";
    if (m < 60) return `${m} minute${m === 1 ? "" : "s"}`;
    const h = Math.floor(m / 60), r = m % 60;
    return `${h} hour${h === 1 ? "" : "s"}${r ? ` ${r} minute${r === 1 ? "" : "s"}` : ""}`;
}

function ownIcon() {
    return L.divIcon({
        className: "custom-own-icon",
        html: `<div style="width:100%; height:100%; border-radius:50%; border:2.5px solid #18d6a3; overflow:hidden; background:#071018; box-sizing:border-box; box-shadow:0 0 10px rgba(24,214,163,0.5);"><img src="${escapeHTML(currentUser.avatar)}" style="width:100%; height:100%; object-fit:cover; display:block;"></div>`,
        iconSize: [38, 38], iconAnchor: [19, 19]
    });
}

function friendIcon(avatar) {
    return L.divIcon({
        className: "custom-friend-icon",
        html: `<div style="width:100%; height:100%; border-radius:50%; border:2px solid #60a5fa; overflow:hidden; background:#071018; box-sizing:border-box;"><img src="${escapeHTML(avatar)}" style="width:100%; height:100%; object-fit:cover; display:block;"></div>`,
        iconSize: [36, 36], iconAnchor: [18, 18]
    });
}

function weatherEmoji(code) {
    if (code === 0) return "☀️"; if ([1, 2, 3].includes(code)) return "⛅"; if ([45, 48].includes(code)) return "🌫️";
    if ([51, 53, 55, 56, 57, 61, 63, 65, 66, 67].includes(code)) return "🌧️"; if ([71, 73, 75, 77, 85, 86].includes(code)) return "❄️";
    if ([80, 81, 82].includes(code)) return "🌦️"; if ([95, 96, 99].includes(code)) return "⛈️"; return "🌤️";
}

async function fetchWeather(lat, lng) {
    try {
        const r = await fetch(`https://api.open-meteo.com/v1/forecast?latitude=${encodeURIComponent(lat)}&longitude=${encodeURIComponent(lng)}&current=temperature_2m,weather_code`);
        if (!r.ok) return ""; const d = await r.json();
        const t = Number(d?.current?.temperature_2m), code = Number(d?.current?.weather_code);
        return Number.isFinite(t) ? `${weatherEmoji(code)} ${Math.round(t)}°C` : "";
    } catch { return ""; }
}

async function fetchCity(lat, lng) {
    try {
        const r = await fetch(`https://api.bigdatacloud.net/data/reverse-geocode-client?latitude=${lat}&longitude=${lng}&localityLanguage=en`);
        if (r.ok) { const d = await r.json(); const c = d.city || d.locality || d.principalSubdivision; if (c) return c; }
    } catch (e) { /* fall through to Nominatim */ }
    try {
        const r = await fetch(`https://nominatim.openstreetmap.org/reverse?format=json&lat=${encodeURIComponent(lat)}&lon=${encodeURIComponent(lng)}&zoom=10`);
        if (r.ok) { const d = await r.json(); return d.address?.city || d.address?.town || d.address?.county || "Local Area"; }
    } catch { return "Local Area"; }
}

// ============================================================================
// SMARTDRIVE — speed-alert v2 (Section 8) + fuel model v2 (Section 9)
// ============================================================================
const IDLE_L_PER_HOUR = 0.4;          // assumed idle burn while stopped-but-active — labeled, not measured
const IDLE_CUTOFF_SEC = 180;          // beyond this we assume the engine's actually off, not idling

const SmartDrive = {
    isRecording: false,
    baseMileage: 18,
    speedHistory: [],
    trip: {
        active: false, startTime: 0, totalDist: 0, actualFuel: 0, maxSpeed: 0, sumSpeed: 0, ticks: 0,
        ranges: { efficient: 0, moderate: 0, inefficient: 0 },
        stoppedTimeSec: 0, points: [], lastPointTs: 0
    },
    audioCtx: null, overlayTimer: null,
    lastAlertTime: 0, lastAlertTier: 0,     // escalation-safe cooldown state (Section 8)
    wakeLock: null,

    init() {
        const savedMil = localStorage.getItem("sd_mileage");
        if (savedMil) this.baseMileage = parseFloat(savedMil);
        const fiv = $("fuel-input-val");
        if (fiv) fiv.value = this.baseMileage;

        const savedRec = localStorage.getItem("sd_record");
        this.isRecording = savedRec === "1";
        const srt = $("speed-record-toggle");
        if (srt) srt.checked = this.isRecording;

        const sgc = $("speed-graph-canvas");
        if (sgc) sgc.style.display = this.isRecording ? "block" : "none";

        if (fiv) fiv.addEventListener("change", (e) => { this.baseMileage = parseFloat(e.target.value) || 18; localStorage.setItem("sd_mileage", this.baseMileage); this.shareMileage(); });
        if (srt) srt.addEventListener("change", (e) => { this.isRecording = e.target.checked; localStorage.setItem("sd_record", this.isRecording ? "1" : "0"); const sgc2 = $("speed-graph-canvas"); if (sgc2) sgc2.style.display = this.isRecording ? "block" : "none"; if (!this.isRecording) this.speedHistory = []; });

        const pob = $("profile-open-btn");
        if (pob) pob.addEventListener("click", () => safeShow("profile-settings-modal", "flex"));
        const csb = $("close-settings-btn");
        if (csb) csb.addEventListener("click", () => safeHide("profile-settings-modal"));
        const crb = $("close-results-btn");
        if (crb) crb.addEventListener("click", () => safeHide("results-panel"));

        document.addEventListener("click", () => {
            if (!this.audioCtx) { const AudioContext = window.AudioContext || window.webkitAudioContext; if (AudioContext) this.audioCtx = new AudioContext(); }
            if (this.audioCtx && this.audioCtx.state === "suspended") this.audioCtx.resume();
        }, { passive: true });
    },

    beep(freq, ms) {
        if (!this.audioCtx) return;
        try {
            if (this.audioCtx.state === "suspended") this.audioCtx.resume();
            const osc = this.audioCtx.createOscillator(), gain = this.audioCtx.createGain();
            osc.type = "square"; osc.frequency.value = freq; gain.gain.value = 0.15;
            osc.connect(gain); gain.connect(this.audioCtx.destination);
            osc.start(); osc.stop(this.audioCtx.currentTime + ms / 1000);
        } catch (e) { /* AudioContext can throw pre-gesture on some browsers — non-fatal */ }
    },

    triggerRedMap() {
        const overlay = $("speed-danger-overlay");
        if (overlay) {
            overlay.classList.add("active"); clearTimeout(this.overlayTimer);
            this.overlayTimer = setTimeout(() => overlay.classList.remove("active"), 10000);
        }
    },

    // Tell the server this rider's stated km/L so the fuel-aware meetup can
    // cost THEIR leg with THEIR vehicle. null = never set: the server then
    // uses its default and names this rider as "assumed" in the result.
    shareMileage() {
        let stated = null;
        try { stated = localStorage.getItem("sd_mileage") !== null ? this.baseMileage : null; } catch (e) { /* storage blocked */ }
        const kmPerL = Number.isFinite(stated) && stated >= 1 && stated <= 100 ? stated : null;
        if (socket && socket.connected) socket.emit("setMileage", { kmPerL });
    },

    async requestWakeLock() {
        try { if ("wakeLock" in navigator) this.wakeLock = await navigator.wakeLock.request("screen"); } catch (e) { /* e.g. tab not visible — fine, not fatal */ }
    },
    releaseWakeLock() {
        try { if (this.wakeLock) { this.wakeLock.release(); this.wakeLock = null; } } catch (e) { /* ignore */ }
    },

    // --- Speed-alert v2: escalation-safe per-tier cooldown (Section 8) -----
    // The shipped build had one shared `lastAlertTime`: a 60 km/h alert could
    // suppress a 100 km/h critical alert 5s later, since the cooldown didn't
    // know the new alert was more severe. Fix: only a cooldown from an
    // EQUAL-OR-HIGHER tier blocks a new alert.
    checkSafetyLimits(speed, confidence) {
        const dial = $("speed-dial");
        if (dial) {
            if (speed > 3) {
                dial.style.display = "flex";
                const sn = $("speed-n"); if (sn) sn.textContent = Math.round(speed);
                dial.className = "speed-dial " + (speed >= 100 ? "danger" : (speed >= 80 ? "warn" : "")) + (confidence < 0.6 ? " lowconf" : "");
            } else { dial.style.display = "none"; }
        }

        if (confidence < 0.4) return;                    // don't act on low-confidence data — display only, above

        const tier = speed >= 100 ? 3 : speed >= 80 ? 2 : speed >= 60 ? 1 : 0;
        if (tier === 0) { this.lastAlertTier = 0; return; }

        const now = Date.now();
        if (tier <= this.lastAlertTier && now - this.lastAlertTime < 15000) return;

        // Spoken cue (Phase 3): the rider shouldn't have to look down to learn
        // why the phone beeped (roadmap Section 25). Tier 1 stays silent —
        // speaking every 60 km/h crossing would train riders to ignore voice.
        if (tier === 3) {
            showToast("🚨 DANGER: Speed 100+ km/h! Slow Down!", 5000);
            this.triggerRedMap();
            this.beep(800, 3000);
            islandShow({ id: "speed", kind: "speed-danger", title: "Slow down", sub: "Over 100 km/h", meta: `${Math.round(speed)}`, ttl: 8000 });
            voiceAnnounce("Slow down. You are over 100 kilometres per hour.", { priority: 90, key: "speed-3", cooldownMs: 15000, category: "speed", maxAgeMs: 4000 });
        } else if (tier === 2) {
            showToast("⚠️ WARNING: Crossing 80 km/h.", 4000);
            this.beep(600, 400);
            islandShow({ id: "speed", kind: "speed-warn", title: "Speed check", sub: "Over 80 km/h", meta: `${Math.round(speed)}`, ttl: 4500 });
            voiceAnnounce("Speed check. Over 80.", { priority: 62, key: "speed-2", cooldownMs: 15000, category: "speed", drivingOnly: true, maxAgeMs: 4000 });
        } else {
            showToast("🟢 Alert: Speed above 60 km/h.", 3000);
            islandShow({ id: "speed", kind: "info", title: "Speed", sub: "Over 60 km/h", meta: `${Math.round(speed)}`, ttl: 3000, haptic: false });
        }
        this.lastAlertTime = now;
        this.lastAlertTier = tier;
    },

    // `fix` is GpsFilter.assess()'s verdict for the real GPS fix from
    // startGPS(). Only an ACCEPTED fix reaches the average, the graph and the
    // trip stats; a rejected one only refreshes the dial (held speed, marked
    // low-confidence) so the rider can see the app isn't trusting it.
    tick(fix) {
        if (!fix) return;
        const smoothedSpeed = fix.smoothedKmh;
        const conf = fix.accepted ? fix.confidence : Math.min(fix.confidence, GpsFilter.GATE - 0.01);
        const dt = Number.isFinite(fix.dtSec) ? fix.dtSec : 1;
        const distKm = fix.distKm;
        const accuracyM = fix.accuracyM;

        const walking = typeof currentTravelMode !== "undefined" && currentTravelMode === "walk";
        if (!walking) this.checkSafetyLimits(smoothedSpeed, conf);

        // Low-confidence fixes don't get to shape the recorded graph either —
        // "feed it to the map for display, but don't let it drive an alert or
        // a graph point" (Section 14).
        if (!fix.accepted) return;                        // …nor the trip stats below
        if (this.isRecording) {
            this.speedHistory.push(smoothedSpeed);
            if (this.speedHistory.length > 120) this.speedHistory.shift();
            this.drawGraph();
        }

        if (!this.trip.active) return;

        this.trip.ticks += 1;
        if (distKm > 0) {
            this.trip.totalDist += distKm;
            this.trip.sumSpeed += smoothedSpeed;
            if (smoothedSpeed > this.trip.maxSpeed) this.trip.maxSpeed = smoothedSpeed;
            if (smoothedSpeed >= 40 && smoothedSpeed <= 60) this.trip.ranges.efficient++;
            else if (smoothedSpeed > 80) this.trip.ranges.inefficient++;
            else this.trip.ranges.moderate++;
        }

        // --- Fuel model v2: U-shaped curve + idle burn (Section 9) ---------
        let fuelBurned = 0;
        if (smoothedSpeed > 3) {
            this.trip.stoppedTimeSec = 0;
            let currentEff = this.baseMileage || 18;
            if (smoothedSpeed > 60) currentEff -= (smoothedSpeed - 60) * 0.005 * this.baseMileage;      // drag past 60
            else if (smoothedSpeed < 40) currentEff -= (40 - smoothedSpeed) * 0.004 * this.baseMileage;  // stop-start below 40
            currentEff = Math.max(5, currentEff);
            fuelBurned = distKm > 0 ? distKm / currentEff : 0;
        } else if (this.trip.active) {
            // Idling engine still burns fuel — the original model silently
            // credited a stop with zero consumption.
            this.trip.stoppedTimeSec += dt;
            fuelBurned = this.trip.stoppedTimeSec < IDLE_CUTOFF_SEC ? IDLE_L_PER_HOUR * (dt / 3600) : 0;
        }
        this.trip.actualFuel += fuelBurned;

        // Downsampled point log for Section 13's trip analytics — ~1 point/5s
        // even if ticks arrive faster, so a 2h ride is ~1,440 points, not 7,200.
        const nowTs = Date.now();
        if (myCoords && (nowTs - this.trip.lastPointTs >= 5000 || this.trip.points.length === 0)) {
            this.trip.points.push({ ts: nowTs, lat: myCoords.lat, lng: myCoords.lng, speedKmh: Math.round(smoothedSpeed * 10) / 10, accuracy: accuracyM ?? null });
            this.trip.lastPointTs = nowTs;
            if (this.trip.points.length > 2000) this.trip.points.shift();
        }
    },

    drawGraph() {
        const cvs = $("speed-graph-canvas"); if (!cvs || !this.isRecording) return;
        const ctx = cvs.getContext("2d"); const w = cvs.width = cvs.offsetWidth, h = cvs.height = cvs.offsetHeight;
        ctx.clearRect(0, 0, w, h);
        if (this.speedHistory.length < 2) return;
        const max = Math.max(60, ...this.speedHistory);
        ctx.beginPath(); ctx.strokeStyle = "#3b82f6"; ctx.lineWidth = 2;
        this.speedHistory.forEach((v, i) => {
            const x = (i / (this.speedHistory.length - 1)) * w; const y = h - (v / max) * h * 0.8;
            if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
        });
        ctx.stroke();
    },

    startTrip() {
        const saved = tripDbRestoreTrip();                // fixed: TripDB has no restoreTrip(), read via restoreAll()
        if (saved && saved.active) {
            this.trip = { stoppedTimeSec: 0, points: [], lastPointTs: 0, ...saved };
            console.log("[SmartDrive] Recovered an in-progress trip from local backup.");
        } else {
            this.trip = {
                active: true, startTime: Date.now(), totalDist: 0, actualFuel: 0, maxSpeed: 0, sumSpeed: 0, ticks: 0,
                ranges: { efficient: 0, moderate: 0, inefficient: 0 }, stoppedTimeSec: 0, points: [], lastPointTs: 0
            };
        }
        GpsFilter.reset();
        this.lastAlertTier = 0;
        if (typeof TripDB !== "undefined") TripDB.startAutoSave(this.trip);
        this.requestWakeLock();
        const mode = (typeof currentTravelMode !== "undefined" && currentTravelMode) || "drive";
        socket.emit("startSession", { mode: mode === "car" ? "drive" : mode });
        emitDriveState();
    },

    endTrip() {
        if (!this.trip.active) return;
        this.trip.active = false;
        this.releaseWakeLock();
        if (typeof TripDB !== "undefined") TripDB.clearBackup();
        socket.emit("endSession");

        const avg = this.trip.ticks > 0 ? this.trip.sumSpeed / this.trip.ticks : 0;
        const rated = this.baseMileage || 18;

        // "What if you'd driven efficiently the whole way" comparison (Section 9.2) —
        // labeled plainly as an estimate, not measured fuel.
        const potentialFuelL = this.trip.totalDist / rated;
        const extraFuelL = Math.max(0, this.trip.actualFuel - potentialFuelL);

        const rd = $("res-dist"); if (rd) rd.textContent = this.trip.totalDist.toFixed(2) + " km";
        const ras = $("res-avg-speed"); if (ras) ras.textContent = Math.round(avg) + " km/h";
        const rms = $("res-max-speed"); if (rms) rms.textContent = Math.round(this.trip.maxSpeed) + " km/h";
        const ret = $("res-eff-time"); if (ret) ret.textContent = Math.round(this.trip.ranges.efficient / 60) + " min";
        const rit = $("res-ineff-time"); if (rit) rit.textContent = Math.round(this.trip.ranges.inefficient / 60) + " min";
        const rbm = $("res-base-mlg"); if (rbm) rbm.textContent = rated + " km/L";
        const raf = $("res-actual-fuel"); if (raf) raf.textContent = this.trip.actualFuel.toFixed(2) + " L";
        const rex = $("res-extra-fuel");
        if (rex) rex.textContent = extraFuelL > 0.01 ? `~${extraFuelL.toFixed(2)} L more than an efficient drive (est.)` : "Right around an efficient drive — nice.";
        safeShow("results-panel", "flex");

        // Close the loop with the persistence layer — one compact record per
        // trip, not a stream per tick (Section 13). Phase 3: routed through
        // TripAnalytics' localStorage-backed queue, so a ride that ends in a
        // dead zone is saved once the socket is back and verified, instead
        // of being lost in a buffered emit that dies with the tab.
        if (this.trip.totalDist > 0.05) {
            const travelMode = (typeof currentTravelMode !== "undefined" && currentTravelMode) || "drive";
            TripAnalytics.submitFinishedTrip({
                name: cityName ? `Ride near ${cityName}` : "Ride",
                mode: travelMode === "car" ? "drive" : travelMode,
                startedAt: this.trip.startTime, endedAt: Date.now(),
                totalDistKm: this.trip.totalDist, avgSpeed: avg, maxSpeed: this.trip.maxSpeed,
                fuelUsedL: this.trip.actualFuel, points: this.trip.points
            });
        }
        emitDriveState();
    }
};

// TripDB (features.js) only exposes restoreAll() -> {username, nav, trip, group}.
// The shipped app.js called TripDB.restoreTrip()/restoreNavState(), which don't
// exist and threw. These two helpers read the SAME backing store correctly.
function tripDbRestoreTrip() {
    if (typeof TripDB === "undefined" || typeof TripDB.restoreAll !== "function") return null;
    try { return TripDB.restoreAll()?.trip || null; } catch { return null; }
}
function tripDbRestoreNav() {
    if (typeof TripDB === "undefined" || typeof TripDB.restoreAll !== "function") return null;
    try { return TripDB.restoreAll()?.nav || null; } catch { return null; }
}

// ============================================================================
// GROUP NAVIGATION — manual "everyone routes to a tapped point" (unchanged)
// ============================================================================
const GroupNavigation = {
    active: false, destination: null, selectedMembers: [], layerGroup: L.layerGroup().addTo(map),
    lastFetchedCoords: {}, colors: ['#18d6a3', '#3b82f6', '#f59e0b', '#ec4899', '#8b5cf6'], recalcTimer: null,
    // Phase 3: per-member road ETA ({distKm, timeMin, ts}) keyed like
    // selectedMembers ("me" for self) — the convoy loop's "falling behind"
    // signal reads this in meetup mode, as it reads tripRoadStats in trip mode.
    memberStats: {},

    openSetup() {
        const list = $("group-nav-friend-list");
        if (!list) return;
        list.innerHTML = "";
        const activeFriends = Object.values(friendData).filter(f => f.online !== false);
        if (activeFriends.length === 0) list.innerHTML = `<div style="color:var(--muted); font-size:11px;">No friends online.</div>`;
        else activeFriends.forEach(f => {
            list.innerHTML += `<label style="display:flex; align-items:center; gap:8px; font-size:13px; color:white; cursor:pointer;"><input type="checkbox" value="${f.id}" class="group-nav-cb"><img src="${escapeHTML(f.avatar)}" style="width:28px; height:28px; border-radius:50%; object-fit:cover;">${escapeHTML(f.name)}</label>`;
        });
        safeShow("group-nav-setup", "flex");
    },
    startSelection() {
        const cbs = document.querySelectorAll(".group-nav-cb:checked");
        if (cbs.length === 0) return showToast("Select at least 1 friend.");
        if (cbs.length > 7) return showToast("Select up to 7 friends only.");
        this.selectedMembers = ["me", ...Array.from(cbs).map(cb => cb.value)];
        safeHide("group-nav-setup");
        mapActionMode = 'group-nav';
        showToast("📍 Tap the map to set the common destination — or use “Find best meetup point” next time.", 5500);
    },
    async setDestination(latlng) {
        this.active = true; this.destination = latlng; this.layerGroup.clearLayers(); this.lastFetchedCoords = {}; this.memberStats = {};

        if (typeof TripDB !== "undefined" && typeof currentUser !== "undefined") {
            TripDB.saveSession(currentUser.name, { active: true, dest: latlng, members: this.selectedMembers });
        }

        L.marker(latlng, { icon: L.divIcon({ className: 'geofence-marker', html: '📍' }) }).bindTooltip("Group Destination", { permanent: true, direction: "top", className: "weather-badge" }).addTo(this.layerGroup);
        safeShow("group-nav-active", "flex");
        await this.calculateAll();
    },
    async calculateAll() {
        if (!this.active || !this.destination) return;
        const statsList = $("group-nav-stats-list");
        if (statsList) statsList.innerHTML = "<div style='color:var(--muted); font-size:11px; text-align:center;'>Calculating road paths...</div>";

        let statsHTML = "", validPaths = [];

        for (let i = 0; i < this.selectedMembers.length; i++) {
            const memberId = this.selectedMembers[i];
            const color = this.colors[i % this.colors.length];
            let name = "User", avatar = DEFAULT_AVATAR, coords = null;

            if (memberId === "me") {
                if (!myCoords) continue;
                name = "You"; avatar = currentUser.avatar; coords = myCoords;
            } else {
                const f = friendData[memberId];
                if (!f || f.online === false || !validCoord(f.lat, f.lng)) continue;
                name = f.name; avatar = f.avatar; coords = { lat: f.lat, lng: f.lng };
            }

            try {
                const data = await RoutePrefs.fetchRoute(`https://router.project-osrm.org/route/v1/driving/${coords.lng},${coords.lat};${this.destination.lng},${this.destination.lat}?overview=full&geometries=geojson&alternatives=true`);
                if (data.routes && data.routes.length > 0) {
                    const r = data.routes.reduce((a, b) => b.distance < a.distance ? b : a, data.routes[0]);
                    const pathCoords = r.geometry.coordinates.map(c => [c[1], c[0]]);

                    this.layerGroup.eachLayer(l => { if (l.memberId === memberId) this.layerGroup.removeLayer(l); });

                    const poly = L.polyline(pathCoords, { color: color, weight: 5, opacity: 0.8, className: 'nav-path-animated' });
                    poly.memberId = memberId;
                    poly.addTo(this.layerGroup);
                    validPaths.push(poly);

                    const distKm = (r.distance / 1000).toFixed(1);
                    const timeMin = Math.max(1, Math.round(r.duration / 60));

                    statsHTML += `
                    <div style="display:flex; justify-content:space-between; align-items:center; padding:10px; background:rgba(255,255,255,0.05); border-radius:10px; border-left:4px solid ${color};">
                        <div style="display:flex; align-items:center; gap:10px;">
                            <img src="${escapeHTML(avatar)}" style="width:30px; height:30px; border-radius:50%; object-fit:cover;">
                            <span style="color:white; font-size:13px; font-weight:bold;">${escapeHTML(name)}</span>
                        </div>
                        <div style="text-align:right;">
                            <div style="color:white; font-size:13px; font-weight:bold;">${distKm} km</div>
                            <div style="color:var(--muted); font-size:11px;">${timeMin} min</div>
                        </div>
                    </div>`;

                    this.lastFetchedCoords[memberId] = { lat: coords.lat, lng: coords.lng };
                    this.memberStats[memberId] = { distKm: r.distance / 1000, timeMin, ts: Date.now() };
                } else {
                    statsHTML += `<div style="color:#ef4444; font-size:11px; padding:10px;">No road route for ${escapeHTML(name)}</div>`;
                }
            } catch (e) { /* one member's route failing shouldn't blank the whole panel */ }
        }
        if (statsList) statsList.innerHTML = statsHTML;
        if (validPaths.length > 0) map.fitBounds(L.featureGroup(validPaths).getBounds(), { padding: [40, 40] });
        if (window.ConvoyIntelligence) window.ConvoyIntelligence.evaluateAll("routes");
    },
    onLiveUpdate() {
        if (!this.active || !this.destination) return;
        let needsRecalc = false;
        if (this.selectedMembers.includes("me") && myCoords) {
            const last = this.lastFetchedCoords["me"];
            if (!last || distanceKm(last.lat, last.lng, myCoords.lat, myCoords.lng) > 0.1) needsRecalc = true;
        }
        this.selectedMembers.forEach(id => {
            if (id !== "me" && friendData[id]) {
                const f = friendData[id]; const last = this.lastFetchedCoords[id];
                if (validCoord(f.lat, f.lng) && (!last || distanceKm(last.lat, last.lng, f.lat, f.lng) > 0.1)) needsRecalc = true;
            }
        });
        if (needsRecalc) {
            clearTimeout(this.recalcTimer);
            this.recalcTimer = setTimeout(() => this.calculateAll(), 3000);
        }
    },
    stop() {
        this.active = false; this.destination = null; this.selectedMembers = []; this.memberStats = {};
        this.layerGroup.clearLayers(); safeHide("group-nav-active");
        if (myCoords) map.flyTo([myCoords.lat, myCoords.lng], 16);
    }
};

let groupRouteUpdateTimer = null;
let isFetchingGroupRoutes = false;

function triggerGroupRouteUpdate() {
    clearTimeout(groupRouteUpdateTimer);
    groupRouteUpdateTimer = setTimeout(() => updateGroupTripRoutes(), 1000);
}

async function updateGroupTripRoutes() {
    if (!currentTrip || isFetchingGroupRoutes) return;
    isFetchingGroupRoutes = true;

    const promises = currentTrip.members.map(async (member, index) => {
        const color = routeColors[index % routeColors.length];
        let coords = null;

        if (member.id === socket.id && myCoords) coords = myCoords;
        // Phase 4: radio-relayed riders count. validCoord: a rider with no fix
        // yet (or sharing "off") has lat/lng null — the old code asked OSRM
        // for a route from "null,null".
        else if (friendIsLive(friendData[member.id]) && validCoord(friendData[member.id].lat, friendData[member.id].lng)) coords = friendData[member.id];

        if (coords) {
            const last = tripLastFetchedCoords[member.id];
            if (last && distanceKm(last.lat, last.lng, coords.lat, coords.lng) < 0.1) return;

            try {
                const data = await RoutePrefs.fetchRoute(`https://router.project-osrm.org/route/v1/driving/${coords.lng},${coords.lat};${currentTrip.lng},${currentTrip.lat}?geometries=geojson&alternatives=true`);

                if (data.routes && data.routes.length > 0) {
                    const r = data.routes.reduce((a, b) => b.distance < a.distance ? b : a, data.routes[0]);
                    const pathCoords = r.geometry.coordinates.map(c => [c[1], c[0]]);

                    tripRoutesLayer.eachLayer(l => { if (l.memberId === member.id) tripRoutesLayer.removeLayer(l); });

                    const poly = L.polyline(pathCoords, { color: color, weight: 5, opacity: 0.8, className: 'nav-path-animated' });
                    poly.memberId = member.id;
                    poly.addTo(tripRoutesLayer);

                    tripLastFetchedCoords[member.id] = { lat: coords.lat, lng: coords.lng };

                    const distKm = r.distance / 1000;
                    const timeMin = Math.max(1, Math.round(r.duration / 60));
                    const mileage = SmartDrive.baseMileage || 18;
                    const fuel = distKm / mileage;

                    tripRoadStats[member.id] = { dist: distKm.toFixed(1), time: timeMin, fuel: fuel.toFixed(2), ts: Date.now() };
                }
            } catch (e) { /* one member's fetch failing shouldn't stall the others */ }
        }
    });

    await Promise.all(promises);
    isFetchingGroupRoutes = false;
    // Fresh road ETAs are exactly what the convoy "falling behind" check
    // needs — evaluate before re-rendering so the badges are current.
    if (window.ConvoyIntelligence) window.ConvoyIntelligence.evaluateAll("routes");
    updateTripPanel();
}

function updateTripPanel() {
    if (!currentTrip) return;
    const list = $("trip-members-list"); if (!list) return;
    list.innerHTML = "";

    const isMember = currentTrip.members.some(m => m.id === socket.id);
    let totalGroupFuel = 0;
    const avatarStyle = "width:32px; height:32px; border-radius:50%; object-fit:cover; vertical-align:middle; margin-right:8px; border:2px solid #34e0b4;";

    if (myCoords && currentUser.name && isMember) {
        const stats = tripRoadStats[socket.id] || { dist: '--', time: '--', fuel: '--' };
        if (stats.fuel !== '--') totalGroupFuel += Number(stats.fuel);
        list.innerHTML += `<div class="trip-member" style="display:flex;justify-content:space-between;gap:8px;align-items:center;margin-bottom:8px;"><div><img src="${escapeHTML(currentUser.avatar)}" style="${avatarStyle}"> <b>You</b></div> <span style="text-align:right;">${stats.dist} km<br><small style="color:var(--muted)">${stats.time} min • ⛽ ${stats.fuel} L</small></span></div>`;
    }

    Object.values(friendData).filter(f => friendIsLive(f) && currentTrip.members.some(m => m.id === f.id)).forEach(f => {
        const stats = tripRoadStats[f.id] || { dist: '--', time: '--', fuel: '--' };
        if (stats.fuel !== '--') totalGroupFuel += Number(stats.fuel);
        // Phase 3: convoy badge (stopped / behind / off route / no signal) —
        // text + tone dot, never color alone.
        const badge = window.ConvoyIntelligence ? window.ConvoyIntelligence.badgeFor(f.id) : null;
        let badgeHtml = badge ? `<br><span class="chip ${badge.tone}" style="margin-top:4px;">${escapeHTML(badge.text)}</span>` : "";
        // Phase 4: say HOW we know where they are when it isn't a live socket.
        if (f.online === false && f.via === "radio") badgeHtml += `<br><span class="chip warn" style="margin-top:4px;">📻 via radio · ${escapeHTML(agoText(f.fixAt || f.viaAt))}</span>`;
        else if (f.est) badgeHtml += `<br><span class="chip" style="margin-top:4px;">≈ estimated ±${escapeHTML(formatDistanceShort(f.accuracy || 0))}</span>`;
        list.innerHTML += `<div class="trip-member" style="display:flex;justify-content:space-between;gap:8px;align-items:center;margin-bottom:8px;"><div><img src="${escapeHTML(f.avatar)}" style="${avatarStyle}"> ${escapeHTML(f.name)}${badgeHtml}</div> <span style="text-align:right;">${stats.dist} km<br><small style="color:var(--muted)">${stats.time} min • ⛽ ${stats.fuel} L</small></span></div>`;
    });

    if (list.innerHTML) list.innerHTML += `<div style="border-top:1px solid #333;margin-top:6px;padding-top:8px;font-size:12px;color:var(--mint);">Estimated group fuel: ${totalGroupFuel.toFixed(2)} L</div>`;
}

// ============================================================================
// MEETUP PLANNER (new) — roadmap Section 11
// ============================================================================
// Inserts a candidate-search-and-score step BEFORE GroupNavigation.setDestination()
// is called, instead of that destination always coming from a manual tap. Reuses
// GroupNavigation's existing per-member routing/rendering once a point is chosen —
// additive, not a rewrite, per the roadmap's own framing.
const MeetupPlanner = {
    lastResult: null,
    strategy: "sum",

    init() {
        const openBtn = $("meetup-find-btn");
        if (openBtn) openBtn.addEventListener("click", () => this.compute());
        const seg = document.querySelector('[data-segment="meetupStrategy"]');
        if (seg) seg.addEventListener("segment", (e) => { this.strategy = e.detail.value; if (this.lastResult) this.renderCandidates(); });
        const closeBtn = $("meetup-results-close");
        if (closeBtn) closeBtn.addEventListener("click", () => safeHide("meetup-results-sheet"));
    },

    async compute() {
        if (GroupNavigation.selectedMembers.length === 0) {
            const cbs = document.querySelectorAll(".group-nav-cb:checked");
            if (cbs.length === 0) return showToast("Select at least 1 friend first.");
            GroupNavigation.selectedMembers = ["me", ...Array.from(cbs).map(cb => cb.value)];
        }
        const memberIds = GroupNavigation.selectedMembers;
        if (memberIds.filter((id) => id === "me" ? !!myCoords : (friendData[id] && validCoord(friendData[id].lat, friendData[id].lng))).length < 2) {
            return showToast("Need at least 2 located members (only Exact-sharing riders count).");
        }

        safeHide("group-nav-setup");
        const resultsList = $("meetup-results-list");
        if (resultsList) resultsList.innerHTML = `<div style="color:var(--muted); font-size:12px; text-align:center; padding:20px 0;">Scoring nearby meetup points by real road time…</div>`;
        safeShow("meetup-results-sheet", "flex");

        socket.emit("computeMeetup", { memberIds, strategy: this.strategy }, (res) => {
            if (!res || !res.ok) {
                if (resultsList) resultsList.innerHTML = `<div style="color:#ef4444; font-size:12px; text-align:center; padding:20px 0;">${escapeHTML(res?.reason === "need-at-least-2-located-members" ? "Need at least 2 located members." : "Couldn't compute a meetup point right now.")}</div>`;
                return;
            }
            this.lastResult = res;
            this.renderCandidates();
        });
    },

    renderCandidates() {
        const resultsList = $("meetup-results-list");
        if (!resultsList || !this.lastResult) return;
        const candidates = this.lastResult.rankings?.[this.strategy] || this.lastResult.results || [];
        if (candidates.length === 0) { resultsList.innerHTML = `<div style="color:var(--muted); font-size:12px; text-align:center;">No reachable candidate found.</div>`; return; }

        meetupLayer.clearLayers();
        resultsList.innerHTML = "";
        const fuelMode = this.strategy === "fuel";
        if (fuelMode) {
            // Say what the estimate assumed, next to the numbers (roadmap Section 9).
            const a = this.lastResult.fuelAssumptions || {};
            const note = document.createElement("div");
            note.className = "meetup-fuel-note";
            let text = "⛽ Estimated fuel from road distance, average speed and each rider's km/L setting.";
            if (a.assumedFor && a.assumedFor.length) text += ` No km/L set for ${a.assumedFor.join(", ")} — assumed ${a.defaultKmPerL} km/L.`;
            if (a.walking && a.walking.length) text += ` ${a.walking.join(", ")} walking: no fuel.`;
            note.textContent = text;
            resultsList.appendChild(note);
        }
        const nameFor = (p) => (p.id === socket.id ? "You" : p.name);
        candidates.forEach((c, i) => {
            L.marker([c.lat, c.lng], { icon: L.divIcon({ className: 'geofence-marker', html: i === 0 ? '🏆' : '📍' }) })
                .bindTooltip(c.label, { permanent: false, direction: "top" }).addTo(meetupLayer);

            const card = document.createElement("div");
            card.className = "list-card" + (i === 0 ? " pick" : "");
            const worst = Math.round(c.maxSec / 60), total = Math.round(c.sumSec / 60);
            card.innerHTML = `<strong>${escapeHTML(c.label)}</strong>${c.kind === "venue" ? ' <span style="color:var(--muted);font-size:11px;">real venue</span>' : ''}
                <div style="margin-top:4px;color:var(--soft);font-size:12.5px;">
                    ${fuelMode && Number.isFinite(c.fuelL) ? `⛽ ${c.fuelL.toFixed(2)} L total · ${total} min` : this.strategy === "minimax" ? `Worst rider: ${worst} min` : `Total: ${total} min`} · Spread: ${Math.round(c.spreadSec / 60)} min
                </div>${fuelMode && Array.isArray(c.perMember) ? `<div class="meetup-fuel-split">${c.perMember.map((p) => `${escapeHTML(nameFor(p))} ${Number.isFinite(p.fuelL) ? p.fuelL.toFixed(2) : "?"} L`).join(" · ")}</div>` : ""}`;
            const pickBtn = document.createElement("button");
            pickBtn.type = "button"; pickBtn.className = "btn-primary-nav btn-block"; pickBtn.style.marginTop = "8px"; pickBtn.textContent = "Meet here";
            pickBtn.onclick = () => {
                safeHide("meetup-results-sheet");
                meetupLayer.clearLayers();
                GroupNavigation.setDestination({ lat: c.lat, lng: c.lng });
            };
            card.appendChild(pickBtn);
            resultsList.appendChild(card);
        });
        if (candidates.length) map.flyTo([candidates[0].lat, candidates[0].lng], 14);
    }
};

// ============================================================================
// CARPOOL PLANNER (new) — roadmap Section 12
// ============================================================================
// Server does the actual ordering (OSRM /trip, falling back to greedy+2-opt)
// and the fuel split; this module is just pickup selection + rendering.
const CarpoolPlanner = {
    pickups: [],           // [{id, name, lat, lng}]
    destination: null,
    lastResult: null,

    init() {
        const openBtn = $("carpool-open-btn");
        if (openBtn) openBtn.addEventListener("click", () => this.openSetup());
        const closeBtn = $("carpool-close-btn");
        if (closeBtn) closeBtn.addEventListener("click", () => this.closeSetup());
        const destBtn = $("carpool-pick-dest-btn");
        if (destBtn) destBtn.addEventListener("click", () => {
            showToast("🚗 Tap the map to set the drop-off point.", 4000);
            mapActionMode = "carpool-dest";
            safeHide("carpool-modal");
        });
        const runBtn = $("carpool-run-btn");
        if (runBtn) runBtn.addEventListener("click", () => this.compute());
    },

    openSetup() {
        const list = $("carpool-riders");
        if (!list) return;
        list.innerHTML = "";
        const online = Object.values(friendData).filter(f => f.online !== false && validCoord(f.lat, f.lng));
        if (online.length === 0) list.innerHTML = `<div style="color:var(--muted); font-size:11px;">No located friends online.</div>`;
        else online.forEach(f => {
            list.innerHTML += `<label style="display:flex; align-items:center; gap:8px; font-size:13px; color:white; cursor:pointer;"><input type="checkbox" value="${f.id}" class="carpool-cb"><img src="${escapeHTML(f.avatar)}" style="width:26px;height:26px;border-radius:50%;object-fit:cover;">${escapeHTML(f.name)}</label>`;
        });
        const destLbl = $("carpool-dest-label");
        if (destLbl) destLbl.textContent = this.destination ? `${this.destination.lat.toFixed(4)}, ${this.destination.lng.toFixed(4)}` : "Not set";
        safeShow("carpool-modal", "flex");
    },
    closeSetup() { safeHide("carpool-modal"); mapActionMode = null; },

    setDestination(latlng) {
        this.destination = latlng;
        carpoolLayer.clearLayers();
        L.marker(latlng, { icon: L.divIcon({ className: 'geofence-marker', html: '🏁' }) }).bindTooltip("Carpool drop-off", { permanent: true, direction: "top" }).addTo(carpoolLayer);
        showToast("🏁 Drop-off set.");
        this.openSetup();
    },

    compute() {
        if (!myCoords) return showToast("Waiting for your GPS fix…");
        if (!this.destination) return showToast("Set a drop-off point first.");
        const cbs = document.querySelectorAll(".carpool-cb:checked");
        if (cbs.length === 0) return showToast("Select at least 1 rider to pick up.");

        this.pickups = Array.from(cbs).map((cb) => {
            const f = friendData[cb.value];
            return { id: f.id, name: f.name, lat: f.lat, lng: f.lng };
        });

        const kmPerL = parseFloat($("carpool-kmpl")?.value) || SmartDrive.baseMileage || 15;
        const pricePerL = parseFloat($("carpool-price")?.value) || 0;

        const resultsBox = $("carpool-results");
        if (resultsBox) resultsBox.innerHTML = `<div style="color:var(--muted);font-size:12px;text-align:center;">Ordering pickups…</div>`;
        safeShow("carpool-modal", "flex");

        socket.emit("carpoolOptimize", {
            start: myCoords, destination: this.destination, pickups: this.pickups, kmPerL, fuelPricePerL: pricePerL,
            avoid: RoutePrefs.classes()            // the driver's avoid-highways/tolls setting
        }, (res) => {
            if (!res || !res.ok) { if (resultsBox) resultsBox.innerHTML = `<div style="color:#ef4444;font-size:12px;">Couldn't plan the carpool right now.</div>`; return; }
            this.lastResult = res;
            this.render(res);
        });
    },

    // Route-options outcome, only when the driver asked to avoid something.
    avoidLine(a) {
        if (!a || !Array.isArray(a.requested) || !a.requested.length) return "";
        const missed = a.requested.filter((c) => !(a.applied || []).includes(c));
        const text = missed.length === 0 ? `🛣️ Avoiding ${RoutePrefs.describe(a.requested)}`
            : (a.applied || []).length ? `🛣️ Avoided ${RoutePrefs.describe(a.applied)} — couldn't also avoid ${RoutePrefs.describe(missed)}`
                : `🛣️ Couldn't avoid ${RoutePrefs.describe(missed)} on this plan`;
        return `<div class="carpool-avoid${missed.length ? " warn" : ""}">${escapeHTML(text)}</div>`;
    },

    render(res) {
        carpoolLayer.clearLayers();
        if (myCoords) L.marker([myCoords.lat, myCoords.lng], { icon: L.divIcon({ className: 'geofence-marker', html: '🚗' }) }).addTo(carpoolLayer);
        if (res.geometry && Array.isArray(res.geometry.coordinates)) {
            const path = res.geometry.coordinates.map(c => [c[1], c[0]]);
            const line = L.polyline(path, { color: '#f59e0b', weight: 6, opacity: 0.85, className: 'nav-path-animated' }).addTo(carpoolLayer);
            map.fitBounds(line.getBounds(), { padding: [40, 40] });
        }
        res.pickupOrder.forEach((p, i) => {
            L.marker([p.lat, p.lng], { icon: L.divIcon({ className: 'geofence-marker', html: `${i + 1}️⃣` }) }).bindTooltip(p.name, { permanent: false }).addTo(carpoolLayer);
        });
        if (this.destination) L.marker([this.destination.lat, this.destination.lng], { icon: L.divIcon({ className: 'geofence-marker', html: '🏁' }) }).addTo(carpoolLayer);

        const resultsBox = $("carpool-results");
        if (!resultsBox) return;
        const order = res.pickupOrder.map((p) => escapeHTML(p.name)).join(" → ");
        let html = `<div class="list-card"><strong>Pickup order</strong><div style="margin-top:4px;color:var(--soft);font-size:12.5px;">You → ${order} → Drop-off</div>
            <div style="margin-top:6px;color:var(--soft);font-size:12.5px;">${res.totalDistanceKm} km${res.totalDurationMin != null ? ` · ${res.totalDurationMin} min` : ''}${res.approximate ? ' · <span style="color:var(--c-warn);">approximate ordering</span>' : ''}</div>${this.avoidLine(res.avoid)}</div>`;
        html += `<div class="list-card"><strong>You (driver)</strong><div style="margin-top:4px;color:var(--soft);font-size:12.5px;">${res.driver.distanceKm} km · ⛽ ${res.driver.fuelL} L${res.assumptions.fuelPricePerL ? ` · ${(res.driver.cost).toFixed(2)}` : ''}</div></div>`;
        res.riders.forEach((r) => {
            html += `<div class="list-card"><strong>${escapeHTML(r.name)}</strong><div style="margin-top:4px;color:var(--soft);font-size:12.5px;">${r.distanceKm} km ridden · ⛽ ${r.fuelL} L share${res.assumptions.fuelPricePerL ? ` · ${r.cost.toFixed(2)}` : ''}</div></div>`;
        });
        html += `<p class="field-hint">${escapeHTML(res.assumptions.note)}</p>`;
        resultsBox.innerHTML = html;
    }
};

// ============================================================================
// PRIVACY CONTROLS (new) — roadmap Section 15, wired to Step 1's sockets
// ============================================================================
const PrivacyControls = {
    mode: "exact",

    init() {
        const seg = document.querySelector('[data-segment="sharingMode"]');
        if (seg) seg.addEventListener("segment", (e) => this.setMode(e.detail.value));

        const exportBtn = $("export-data-btn");
        if (exportBtn) exportBtn.addEventListener("click", () => this.exportData());

        const clearBtn = $("clear-history-btn");
        if (clearBtn) clearBtn.addEventListener("click", () => this.clearHistory());
    },

    setMode(mode, { silent = false } = {}) {
        if (!["exact", "approx", "off"].includes(mode)) return;
        this.mode = mode;
        if (window.MapUnite) window.MapUnite.setSegment("sharingMode", mode);
        if (!silent) socket.emit("setSharing", { mode });
        if (mode === "off") {
            islandShow({ id: "privacy", kind: "sensor", title: "Location sharing off", sub: "You appear offline to others", ttl: 4500 });
        } else if (mode === "approx") {
            islandShow({ id: "privacy", kind: "sensor", title: "Sharing approximate location", sub: "Rounded to ~1 km outside active trips", ttl: 4500 });
        }
    },

    async exportData() {
        socket.emit("exportMyData", {}, (res) => {
            if (!res || !res.ok) return showToast("Couldn't export your data right now.");
            const blob = new Blob([JSON.stringify(res, null, 2)], { type: "application/json" });
            const url = URL.createObjectURL(blob);
            const a = document.createElement("a");
            a.href = url; a.download = `mapunite-export-${new Date().toISOString().slice(0, 10)}.json`;
            document.body.appendChild(a); a.click(); a.remove();
            setTimeout(() => URL.revokeObjectURL(url), 4000);
            showToast("📥 Export downloaded.");
        });
    },

    async clearHistory() {
        const { ok, checked } = await confirmDialog({
            title: "Clear your history?",
            body: "This permanently deletes your trips, breadcrumbs, memories and geofences from this server. It cannot be undone.",
            okLabel: "Delete everything", cancelLabel: "Cancel", danger: true,
            checkboxLabel: "Also remove my device identity (you'll appear as a new rider next time)"
        });
        if (!ok) return;
        socket.emit("deleteMyHistory", { includeIdentity: checked }, (res) => {
            if (!res || !res.ok) return showToast("Couldn't clear your history right now.");
            locationHistory = [];
            try { localStorage.removeItem("koraput_history"); } catch (e) { /* ignore */ }
            historyPolyline.setLatLngs([]);
            // Phase 3: zero-trace also means the not-yet-uploaded ride queue,
            // the cached rollups and any replay on screen.
            TripAnalytics.clearLocal();
            DeadReckoning.clearLocal();        // Phase 4: the GPS-outage log is location history too
            if (checked) DeviceIdentity.resetAfterRejection();
            showToast(`🗑️ Cleared ${res.tripsDeleted} trip(s), ${res.memoriesDeleted} memor${res.memoriesDeleted === 1 ? 'y' : 'ies'}, ${res.geofencesDeleted} geofence(s).`, 6000);
        });
    }
};

// ============================================================================
// TRIP ANALYTICS (Phase 3) — roadmap Section 13
// ============================================================================
// Server contract (server.js + Phase 3 server additions):
//   tripFinished    {name, mode, startedAt, endedAt, totalDistKm, avgSpeed,
//                    maxSpeed, fuelUsedL, points:[{ts,lat,lng,speedKmh,accuracy}]}
//                   -> ack {ok, tripId, points} | {ok:false, reason}
//   getTripRollups  {period:"day"|"week"|"month", tzOffsetMin, limit}
//                   -> ack {ok, period, rows:[{bucket, trips, distanceKm,
//                      durationMin, avgSpeed, maxSpeed, fuelL}], retentionDays}
//   listMyTrips     {limit} -> ack {ok, trips:[{id, name, mode, started_at,
//                      ended_at, total_dist_km, avg_speed, max_speed, fuel_used_l}]}
//   getTripPoints   {tripId} -> ack {ok, points:[{ts, lat, lng, speed_kmh, accuracy}]}
//
// Buckets are computed server-side in the rider's LOCAL time: the server adds
// tzOffsetMin to UTC, so tzOffsetMin must be minutes EAST of UTC (+330 for
// IST) — the NEGATION of Date.getTimezoneOffset(). The client rebuilds the
// same bucket keys (localDateKey / weekKeyFor / monthKeyFor) so empty days
// show as zero-height bars instead of silently closing the gap.

// Speed tiers for ride replay — the same thresholds as the speed alerts, so
// the colors mean what the alerts meant. Validated palette (dataviz
// validator, dark surface #0e1724): lightness band, chroma floor, CVD ΔE 8.6,
// normal-vision ΔE 15.5, contrast ≥ 3:1 — all pass. Always shown with a text
// legend, never color alone.
const SPEED_BANDS = [
    { label: "Under 80 km/h", color: "#24a684" },
    { label: "80–100 km/h", color: "#ac8b26" },
    { label: "100+ km/h", color: "#c2555a" }
];
const NO_SPEED_COLOR = "#8b9bab";
const CHART_BAR_COLOR = "#34e0b4";        // single series -> the app accent
const CHART_BAR_SELECTED = "#8ff2d6";

// Ack-based emit with a timeout that works on any socket.io 4.x client
// (socket.timeout() only exists from 4.4 on).
function emitWithAck(event, payload, timeoutMs, cb) {
    let done = false;
    const timer = setTimeout(() => { if (!done) { done = true; cb(new Error("timeout")); } }, timeoutMs);
    socket.emit(event, payload, (res) => { if (!done) { done = true; clearTimeout(timer); cb(null, res); } });
}

const pad2 = (n) => String(n).padStart(2, "0");
// "YYYY-MM-DD" in LOCAL time — mirrors date(started_at/1000 + tz, 'unixepoch').
function localDateKey(d) { return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`; }
// Monday on/before d, local — mirrors "... '-6 days', 'weekday 1'".
function weekKeyFor(d) {
    const monday = new Date(d.getFullYear(), d.getMonth(), d.getDate() - ((d.getDay() + 6) % 7));
    return localDateKey(monday);
}
// "YYYY-MM" local — mirrors strftime('%Y-%m', ...).
function monthKeyFor(d) { return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}`; }

// The `count` most recent bucket keys ending with the one containing `now`,
// oldest first.
function analyticsBucketKeys(period, count, now = new Date()) {
    const keys = [];
    for (let i = count - 1; i >= 0; i--) {
        if (period === "month") keys.push(monthKeyFor(new Date(now.getFullYear(), now.getMonth() - i, 1)));
        else if (period === "week") {
            const monday = new Date(now.getFullYear(), now.getMonth(), now.getDate() - ((now.getDay() + 6) % 7) - 7 * i);
            keys.push(localDateKey(monday));
        } else keys.push(localDateKey(new Date(now.getFullYear(), now.getMonth(), now.getDate() - i)));
    }
    return keys;
}

function bucketLabel(period, key, style = "short") {
    const parts = String(key).split("-").map(Number);
    if (period === "month") {
        const d = new Date(parts[0], parts[1] - 1, 1);
        return style === "short" ? d.toLocaleDateString(undefined, { month: "short" }) : d.toLocaleDateString(undefined, { month: "long", year: "numeric" });
    }
    const d = new Date(parts[0], parts[1] - 1, parts[2]);
    if (period === "week") {
        return style === "short" ? d.toLocaleDateString(undefined, { day: "numeric", month: "short" }) : `Week of ${d.toLocaleDateString(undefined, { day: "numeric", month: "long" })}`;
    }
    return style === "short" ? d.toLocaleDateString(undefined, { weekday: "short", day: "numeric" }) : d.toLocaleDateString(undefined, { weekday: "long", day: "numeric", month: "long" });
}

const fmtNum = (v, digits) => Number(v || 0).toLocaleString(undefined, { maximumFractionDigits: digits, minimumFractionDigits: 0 });
function fmtDuration(min) {
    const m = Math.max(0, Math.round(min || 0));
    if (m < 60) return `${m}m`;
    return `${Math.floor(m / 60)}h ${pad2(m % 60)}m`;
}

// A round axis maximum with three gridlines (0, max/2, max).
function niceAxisMax(maxValue, fallback) {
    if (!(maxValue > 0)) return fallback;
    const half = maxValue / 2;
    const pow = Math.pow(10, Math.floor(Math.log10(half)));
    for (const m of [1, 2, 2.5, 5, 10]) {
        if (m * pow >= half) return 2 * m * pow;
    }
    return 2 * 10 * pow;
}

const TripAnalytics = {
    PENDING_KEY: "mu_pending_trips",
    MAX_PENDING: 5,
    PENDING_MAX_AGE_MS: 7 * 86400000,       // same 7-day horizon as TripDB's local backup
    PERIODS: {
        day: { count: 14, windowLabel: "Last 14 days" },
        week: { count: 8, windowLabel: "Last 8 weeks" },
        month: { count: 6, windowLabel: "Last 6 months" }
    },
    METRICS: {
        distance: { label: "Distance", pick: (r) => r.distanceKm, fmt: (v) => `${fmtNum(v, 1)} km`, axis: (v) => `${fmtNum(v, 0)}`, fallbackMax: 10 },
        duration: { label: "Ride time", pick: (r) => r.durationMin, fmt: (v) => fmtDuration(v), axis: (v) => (v >= 60 ? `${fmtNum(v / 60, 1)}h` : `${fmtNum(v, 0)}m`), fallbackMax: 60 },
        fuel: { label: "Fuel (est.)", pick: (r) => r.fuelL, fmt: (v) => `${fmtNum(v, 2)} L`, axis: (v) => `${fmtNum(v, 1)}`, fallbackMax: 1 }
    },
    period: "day",
    metric: "distance",
    rows: [],
    trips: [],
    retentionDays: null,
    selectedKey: null,
    loadingSeq: 0,
    tripsSeq: 0,
    profileVerified: false,
    flushing: false,
    flushTimer: null,
    replayLayer: null,
    resizeTimer: null,

    init() {
        this.replayLayer = L.layerGroup().addTo(map);

        const openBtn = $("analytics-btn");
        if (openBtn) openBtn.addEventListener("click", () => this.open());
        const closeBtn = $("analytics-close");
        if (closeBtn) closeBtn.addEventListener("click", () => this.close());

        const periodSeg = document.querySelector('[data-segment="analyticsPeriod"]');
        if (periodSeg) periodSeg.addEventListener("segment", (e) => {
            if (!this.PERIODS[e.detail.value]) return;
            this.period = e.detail.value;
            this.selectedKey = null;
            this.loadRollups();
        });
        const metricSeg = document.querySelector('[data-segment="analyticsMetric"]');
        if (metricSeg) metricSeg.addEventListener("segment", (e) => {
            if (!this.METRICS[e.detail.value]) return;
            this.metric = e.detail.value;
            this.renderChart();
            this.renderDetail();
        });

        const clearReplayBtn = $("replay-clear-btn");
        if (clearReplayBtn) clearReplayBtn.addEventListener("click", () => this.clearReplay());

        // The server persists trips only for a verified device; losing the
        // socket means waiting for the next profileAccepted before flushing.
        socket.on("disconnect", () => { this.profileVerified = false; });

        window.addEventListener("resize", () => {
            clearTimeout(this.resizeTimer);
            this.resizeTimer = setTimeout(() => { if (this.isOpen()) this.renderChart(); }, 150);
        }, { passive: true });
    },

    tzOffsetMin() { return -new Date().getTimezoneOffset(); },
    isOpen() { const m = $("analytics-modal"); return Boolean(m && m.style.display === "flex"); },

    open() {
        safeShow("analytics-modal", "flex");
        this.render();              // paint whatever we already have (keeps the frame)
        this.refresh();
    },
    close() { safeHide("analytics-modal"); this.hideTip(); },

    refresh() {
        this.loadRollups();
        this.loadTrips();
    },

    setLoading(on) {
        const host = $("analytics-chart");
        if (host) host.classList.toggle("is-loading", Boolean(on));
    },
    setNotice(text) {
        const el = $("analytics-notice");
        if (!el) return;
        el.textContent = text || "";
        el.hidden = !text;
    },

    loadRollups(retriesLeft = 2) {
        const seq = ++this.loadingSeq;
        const cfg = this.PERIODS[this.period];
        if (!socket.connected) {
            this.setNotice("You're offline — showing the last numbers loaded.");
            this.render();
            return;
        }
        this.setLoading(true);
        emitWithAck("getTripRollups", { period: this.period, tzOffsetMin: this.tzOffsetMin(), limit: cfg.count }, 8000, (err, res) => {
            if (seq !== this.loadingSeq) return;            // a newer period click superseded this one
            if (err) { this.setLoading(false); this.setNotice("Couldn't reach the server — try again in a moment."); return; }
            if (!res || !res.ok) {
                const reason = res && res.reason;
                if ((reason === "too-frequent" || reason === "rate-limited") && retriesLeft > 0) {
                    // Server throttles rollups to 1/s per socket; quick
                    // period switches (or a laggy link bunching requests)
                    // shouldn't surface as an error.
                    setTimeout(() => { if (seq === this.loadingSeq) this.loadRollups(retriesLeft - 1); }, 1100);
                    return;
                }
                this.setLoading(false);
                this.setNotice(reason === "no-device-identity" ? "Join the map to start building your ride history." : "Couldn't load your ride stats right now.");
                return;
            }
            this.setLoading(false);
            this.rows = Array.isArray(res.rows) ? res.rows : [];
            if (Number.isFinite(res.retentionDays)) this.retentionDays = res.retentionDays;
            this.setNotice("");
            this.render();
        });
    },

    loadTrips() {
        const seq = ++this.tripsSeq;
        if (!socket.connected) { this.renderTrips(); return; }
        emitWithAck("listMyTrips", { limit: 10 }, 8000, (err, res) => {
            if (seq !== this.tripsSeq) return;
            if (!err && res && res.ok && Array.isArray(res.trips)) this.trips = res.trips;
            this.renderTrips();
        });
    },

    // Window of bucket keys (oldest -> newest) joined with the server rows.
    series() {
        const cfg = this.PERIODS[this.period];
        const metric = this.METRICS[this.metric];
        const byKey = new Map(this.rows.map((r) => [r.bucket, r]));
        return analyticsBucketKeys(this.period, cfg.count).map((key) => {
            const row = byKey.get(key) || null;
            return { key, row, value: row ? Number(metric.pick(row)) || 0 : 0 };
        });
    },

    render() {
        this.renderTotals();
        this.renderChart();
        this.renderDetail();
        this.renderTable();
        this.renderFootnote();
    },

    renderTotals() {
        const host = $("analytics-totals");
        if (!host) return;
        const data = this.series();
        const sum = (f) => data.reduce((a, d) => a + (d.row ? Number(f(d.row)) || 0 : 0), 0);
        const tiles = [
            ["Rides", fmtNum(sum((r) => r.trips), 0)],
            ["Distance", `${fmtNum(sum((r) => r.distanceKm), 1)} km`],
            ["Ride time", fmtDuration(sum((r) => r.durationMin))],
            ["Fuel (est.)", `${fmtNum(sum((r) => r.fuelL), 1)} L`]
        ];
        host.textContent = "";
        tiles.forEach(([label, value]) => {
            const card = document.createElement("div");
            card.className = "list-card";
            const l = document.createElement("span"); l.className = "l"; l.textContent = label;
            const v = document.createElement("span"); v.className = "v"; v.textContent = value;
            card.appendChild(l); card.appendChild(v);
            host.appendChild(card);
        });
        const win = $("analytics-window");
        if (win) win.textContent = this.PERIODS[this.period].windowLabel;
    },

    renderChart() {
        const host = $("analytics-chart");
        if (!host) return;
        const data = this.series();
        const metric = this.METRICS[this.metric];
        const NS = "http://www.w3.org/2000/svg";
        const W = Math.max(260, Math.floor(host.clientWidth || 320));
        const H = 196, padL = 38, padR = 8, padT = 24, padB = 26;
        const plotW = W - padL - padR, plotH = H - padT - padB;
        const maxV = Math.max(0, ...data.map((d) => d.value));
        const yMax = niceAxisMax(maxV, metric.fallbackMax);
        const y = (v) => padT + plotH - (v / yMax) * plotH;
        const slot = plotW / data.length;
        const barW = Math.min(24, Math.max(4, slot * 0.62));

        const svg = document.createElementNS(NS, "svg");
        svg.setAttribute("viewBox", `0 0 ${W} ${H}`);
        svg.setAttribute("width", String(W));
        svg.setAttribute("height", String(H));
        svg.setAttribute("role", "group");
        svg.setAttribute("aria-label", `${metric.label} per ${this.period}, ${this.PERIODS[this.period].windowLabel.toLowerCase()}`);

        const mk = (tag, attrs) => { const el = document.createElementNS(NS, tag); Object.entries(attrs).forEach(([k, v]) => el.setAttribute(k, String(v))); return el; };
        const txt = (x, yy, s, attrs = {}) => { const t = mk("text", { x, y: yy, ...attrs }); t.textContent = s; return t; };

        // Recessive solid hairline grid + tick labels (0, half, max).
        [0, yMax / 2, yMax].forEach((v) => {
            const yy = Math.round(y(v)) + 0.5;
            svg.appendChild(mk("line", { x1: padL, x2: W - padR, y1: yy, y2: yy, stroke: v === 0 ? "rgba(255,255,255,.22)" : "rgba(255,255,255,.08)", "stroke-width": 1 }));
            svg.appendChild(txt(padL - 6, yy + 3.5, metric.axis(v), { "text-anchor": "end", class: "an-tick" }));
        });

        // X labels: thin them so they never collide; the newest bucket is always labeled.
        const every = Math.max(1, Math.ceil(data.length / Math.max(1, Math.floor(plotW / 40))));
        let maxIdx = -1;
        data.forEach((d, i) => { if (d.value > 0 && (maxIdx < 0 || d.value > data[maxIdx].value)) maxIdx = i; });

        data.forEach((d, i) => {
            const cx = padL + slot * i + slot / 2;
            const g = mk("g", { class: "an-bar", tabindex: 0, role: "button", "data-idx": i });
            const label = bucketLabel(this.period, d.key, "long");
            const rides = d.row ? d.row.trips : 0;
            g.setAttribute("aria-label", `${label}: ${rides ? `${rides} ride${rides === 1 ? "" : "s"}, ${metric.fmt(d.value)}` : "no rides"}`);
            if (this.selectedKey === d.key) g.setAttribute("aria-pressed", "true");

            // Hit target: the whole column slot, bigger than the painted bar.
            g.appendChild(mk("rect", { x: padL + slot * i, y: padT, width: slot, height: plotH, fill: "transparent" }));

            if (d.value > 0) {
                const top = y(d.value);
                const h = Math.max(2, padT + plotH - top);
                const x0 = cx - barW / 2, x1 = cx + barW / 2, yb = padT + plotH, yt = yb - h;
                const r = Math.min(4, h, barW / 2);
                // 4px rounded data-end, square at the baseline.
                const path = `M${x0},${yb} L${x0},${yt + r} Q${x0},${yt} ${x0 + r},${yt} L${x1 - r},${yt} Q${x1},${yt} ${x1},${yt + r} L${x1},${yb} Z`;
                g.appendChild(mk("path", { d: path, fill: this.selectedKey === d.key ? CHART_BAR_SELECTED : CHART_BAR_COLOR, class: "an-mark" }));
            }
            if (i === maxIdx) {
                // Selective direct label: the peak only, in text ink.
                g.appendChild(txt(cx, y(d.value) - 6, metric.fmt(d.value), { "text-anchor": "middle", class: "an-peak" }));
            }
            if ((data.length - 1 - i) % every === 0) {
                g.appendChild(txt(cx, H - 8, bucketLabel(this.period, d.key, "short"), { "text-anchor": "middle", class: "an-xlabel" }));
            }

            const show = () => this.showTip(i, cx, d.value > 0 ? y(d.value) : padT + plotH);
            g.addEventListener("pointerenter", show);
            g.addEventListener("focus", show);
            g.addEventListener("pointerleave", () => this.hideTip());
            g.addEventListener("blur", () => this.hideTip());
            g.addEventListener("click", () => this.select(d.key));
            g.addEventListener("keydown", (e) => {
                if (e.key === "Enter" || e.key === " ") { e.preventDefault(); this.select(d.key); }
                else if (e.key === "ArrowRight" || e.key === "ArrowLeft") {
                    e.preventDefault();
                    const nextIdx = i + (e.key === "ArrowRight" ? 1 : -1);
                    const target = host.querySelector(`.an-bar[data-idx="${nextIdx}"]`);
                    if (target) target.focus();
                }
            });
            svg.appendChild(g);
        });

        if (maxV === 0) {
            svg.appendChild(txt(padL + plotW / 2, padT + plotH / 2, "No rides in this period yet", { "text-anchor": "middle", class: "an-empty" }));
        }

        host.querySelectorAll("svg").forEach((s) => s.remove());
        host.insertBefore(svg, host.firstChild);
        this._chartData = data;
        this._chartW = W;
    },

    showTip(i, cx, topY) {
        const tip = $("analytics-tip");
        const d = this._chartData && this._chartData[i];
        if (!tip || !d) return;
        const metric = this.METRICS[this.metric];
        tip.textContent = "";
        const v = document.createElement("strong");
        v.textContent = d.row ? metric.fmt(d.value) : "No rides";
        const s = document.createElement("span");
        const rides = d.row ? d.row.trips : 0;
        s.textContent = `${bucketLabel(this.period, d.key, "long")}${rides ? ` · ${rides} ride${rides === 1 ? "" : "s"}` : ""}`;
        tip.appendChild(v); tip.appendChild(s);
        tip.hidden = false;
        const tipW = tip.offsetWidth || 160;
        const left = Math.min(Math.max(4, cx - tipW / 2), (this._chartW || 320) - tipW - 4);
        tip.style.left = `${left}px`;
        tip.style.top = `${Math.max(0, topY - 50)}px`;
    },
    hideTip() { const tip = $("analytics-tip"); if (tip) tip.hidden = true; },

    select(key) {
        this.selectedKey = this.selectedKey === key ? null : key;
        this.renderChart();
        this.renderDetail();
        const again = $("analytics-chart")?.querySelector(`.an-bar[aria-pressed="true"]`);
        if (again) again.focus({ preventScroll: true });
    },

    renderDetail() {
        const el = $("analytics-detail");
        if (!el) return;
        const d = this.selectedKey && this.series().find((x) => x.key === this.selectedKey);
        if (!d) { el.textContent = "Tap a bar for that period's details."; return; }
        const label = bucketLabel(this.period, d.key, "long");
        if (!d.row) { el.textContent = `${label} · no rides`; return; }
        const r = d.row;
        el.textContent = `${label} · ${r.trips} ride${r.trips === 1 ? "" : "s"} · ${fmtNum(r.distanceKm, 1)} km · ${fmtDuration(r.durationMin)} · avg ${fmtNum(r.avgSpeed, 0)} km/h · top ${fmtNum(r.maxSpeed, 0)} km/h · ~${fmtNum(r.fuelL, 2)} L fuel (est.)`;
    },

    // Table twin of the chart — every value reachable without hover.
    renderTable() {
        const table = $("analytics-table");
        if (!table) return;
        table.textContent = "";
        const head = table.createTHead().insertRow();
        ["Period", "Rides", "Distance", "Time", "Avg", "Top", "Fuel (est.)"].forEach((h) => {
            const th = document.createElement("th"); th.scope = "col"; th.textContent = h; head.appendChild(th);
        });
        const body = table.createTBody();
        this.series().slice().reverse().forEach((d) => {
            const tr = body.insertRow();
            const r = d.row;
            [bucketLabel(this.period, d.key, "long"),
                r ? fmtNum(r.trips, 0) : "0",
                r ? `${fmtNum(r.distanceKm, 1)} km` : "—",
                r ? fmtDuration(r.durationMin) : "—",
                r ? `${fmtNum(r.avgSpeed, 0)} km/h` : "—",
                r ? `${fmtNum(r.maxSpeed, 0)} km/h` : "—",
                r ? `${fmtNum(r.fuelL, 2)} L` : "—"].forEach((c, idx) => {
                    const cell = idx === 0 ? document.createElement("th") : tr.insertCell();
                    if (idx === 0) { cell.scope = "row"; tr.appendChild(cell); }
                    cell.textContent = c;
                });
        });
    },

    renderFootnote() {
        const el = $("analytics-footnote");
        if (!el) return;
        const keep = this.retentionDays > 0 ? `Rides are kept on the server for ${this.retentionDays} days.` : "Rides are kept until you clear your history.";
        el.textContent = `Distances and fuel come from GPS speed samples and your km/L setting — they're estimates, not odometer readings. ${keep}`;
    },

    renderTrips() {
        const host = $("analytics-trips");
        if (!host) return;
        host.textContent = "";
        const pending = this.loadPending().length;
        if (pending) {
            const p = document.createElement("div");
            p.className = "list-card";
            p.textContent = `⏳ ${pending} finished ride${pending === 1 ? "" : "s"} waiting to upload — they'll save automatically when you're back online.`;
            host.appendChild(p);
        }
        if (!this.trips.length) {
            const empty = document.createElement("p");
            empty.className = "field-hint";
            empty.textContent = "No saved rides yet. A ride is saved when a navigation drive or a group trip ends.";
            host.appendChild(empty);
            return;
        }
        const modeIcon = { drive: "🚗", bike: "🏍️", walk: "🚶" };
        this.trips.forEach((t) => {
            const btn = document.createElement("button");
            btn.type = "button";
            btn.className = "list-card trip-row";
            const left = document.createElement("div");
            const name = document.createElement("strong");
            name.textContent = `${modeIcon[t.mode] || "🚗"} ${t.name || "Ride"}`;
            const when = document.createElement("div");
            when.className = "field-hint";
            when.style.margin = "2px 0 0";
            const started = new Date(t.started_at);
            const mins = t.ended_at ? Math.round((t.ended_at - t.started_at) / 60000) : 0;
            when.textContent = `${started.toLocaleDateString(undefined, { day: "numeric", month: "short" })}, ${started.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })} · ${fmtDuration(mins)}`;
            left.appendChild(name); left.appendChild(when);
            const right = document.createElement("div");
            right.style.textAlign = "right";
            const dist = document.createElement("strong");
            dist.textContent = `${fmtNum(t.total_dist_km, 1)} km`;
            const sp = document.createElement("div");
            sp.className = "field-hint";
            sp.style.margin = "2px 0 0";
            sp.textContent = `avg ${fmtNum(t.avg_speed, 0)} · top ${fmtNum(t.max_speed, 0)} km/h`;
            right.appendChild(dist); right.appendChild(sp);
            btn.appendChild(left); btn.appendChild(right);
            btn.setAttribute("aria-label", `Replay ${t.name || "ride"} from ${started.toLocaleString()}`);
            btn.addEventListener("click", () => this.replay(t));
            host.appendChild(btn);
        });
    },

    // ---- Ride replay ---------------------------------------------------------
    replay(trip) {
        emitWithAck("getTripPoints", { tripId: trip.id }, 10000, (err, res) => {
            if (err || !res || !res.ok) { showToast("Couldn't load that ride's route."); return; }
            const pts = (res.points || []).filter((p) => validCoord(p.lat, p.lng));
            if (!pts.length) { showToast("This ride has no saved route points."); return; }
            this.drawReplay(trip, pts);
        });
    },

    drawReplay(trip, pts) {
        this.replayLayer.clearLayers();
        const latlngs = pts.map((p) => [p.lat, p.lng]);
        const bandOf = (s) => (s == null || !Number.isFinite(Number(s)) ? -1 : Number(s) >= 100 ? 2 : Number(s) >= 80 ? 1 : 0);

        // Each segment takes the band of the speed recorded at its END point;
        // consecutive same-band segments merge into one polyline.
        const segs = [];
        for (let i = 1; i < pts.length; i++) {
            const b = bandOf(pts[i].speed_kmh);
            const last = segs[segs.length - 1];
            if (last && last.band === b) last.latlngs.push(latlngs[i]);
            else segs.push({ band: b, latlngs: [latlngs[i - 1], latlngs[i]] });
        }
        if (latlngs.length >= 2) {
            // Dark casing so the colored line reads on satellite AND street tiles.
            L.polyline(latlngs, { color: "#0b1220", weight: 8, opacity: 0.85, interactive: false, lineCap: "round", lineJoin: "round" }).addTo(this.replayLayer);
        }
        const present = new Set();
        segs.forEach((s) => {
            present.add(s.band);
            L.polyline(s.latlngs, { color: s.band < 0 ? NO_SPEED_COLOR : SPEED_BANDS[s.band].color, weight: 4.5, opacity: 1, interactive: false, lineCap: "round", lineJoin: "round" }).addTo(this.replayLayer);
        });
        L.circleMarker(latlngs[0], { radius: 6, color: "#0b1220", weight: 2, fillColor: "#ffffff", fillOpacity: 1 }).bindTooltip("Start").addTo(this.replayLayer);
        L.marker(latlngs[latlngs.length - 1], { icon: L.divIcon({ className: "geofence-marker", html: "🏁" }) }).bindTooltip("Finish").addTo(this.replayLayer);

        if (latlngs.length >= 2) map.fitBounds(L.latLngBounds(latlngs), { padding: [60, 60] });
        else map.flyTo(latlngs[0], 16);
        this.close();

        // Legend: swatch + text for every band actually on the map.
        const title = $("replay-title");
        if (title) {
            const started = new Date(trip.started_at);
            title.textContent = `${trip.name || "Ride"} · ${started.toLocaleDateString(undefined, { day: "numeric", month: "short" })} · top ${fmtNum(trip.max_speed, 0)} km/h`;
        }
        const list = $("replay-bands");
        if (list) {
            list.textContent = "";
            const rows = SPEED_BANDS.map((b, i) => ({ ...b, i })).filter((b) => present.has(b.i));
            if (present.has(-1)) rows.push({ label: "No speed data", color: NO_SPEED_COLOR, i: -1 });
            rows.forEach((b) => {
                const li = document.createElement("li");
                const sw = document.createElement("span");
                sw.className = "swatch";
                sw.style.background = b.color;
                const t = document.createElement("span");
                t.textContent = b.label;
                li.appendChild(sw); li.appendChild(t);
                list.appendChild(li);
            });
        }
        safeShow("replay-legend", "flex");
    },

    clearReplay() {
        if (this.replayLayer) this.replayLayer.clearLayers();
        safeHide("replay-legend");
    },

    // ---- Offline-safe tripFinished queue ------------------------------------
    // Duplicate risk, stated honestly: if the server saves a ride but the ack
    // is lost (disconnect in that instant), the retry saves it again — the
    // server has no idempotency key for tripFinished. Rare, and preferable
    // to silently losing rides that end in a dead zone.
    loadPending() {
        try {
            const q = JSON.parse(localStorage.getItem(this.PENDING_KEY) || "[]");
            if (!Array.isArray(q)) return [];
            return q.filter((i) => i && i.payload && Date.now() - (i.queuedAt || 0) < this.PENDING_MAX_AGE_MS);
        } catch (e) { return []; }
    },

    savePending(q) {
        for (let attempt = 0; attempt < 4; attempt++) {
            try {
                if (q.length) localStorage.setItem(this.PENDING_KEY, JSON.stringify(q));
                else localStorage.removeItem(this.PENDING_KEY);
                return true;
            } catch (e) {
                // Storage full: shed breadcrumbs from the oldest ride first —
                // the summary row is what the rollups need.
                const victim = q.find((i) => Array.isArray(i.payload.points) && i.payload.points.length > 0);
                if (!victim) return false;
                victim.payload.points = victim.payload.points.length > 200 ? victim.payload.points.filter((_, idx) => idx % 4 === 0) : [];
            }
        }
        return false;
    },

    submitFinishedTrip(payload) {
        const q = this.loadPending();
        const qid = (window.crypto && crypto.randomUUID) ? crypto.randomUUID() : DeviceIdentity._fallbackUuid();
        q.push({ qid, queuedAt: Date.now(), attempts: 0, payload });
        while (q.length > this.MAX_PENDING) q.shift();
        this.savePending(q);
        if (!socket.connected || !this.profileVerified) showToast("📴 Ride saved on this phone — it'll upload when you're back online.", 4500);
        this.flushPending();
    },

    flushPending() {
        if (this.flushing || !this.profileVerified || !socket.connected) return;
        const q = this.loadPending();
        if (!q.length) return;
        const item = q[0];
        this.flushing = true;
        emitWithAck("tripFinished", item.payload, 15000, (err, res) => {
            this.flushing = false;
            if (err) return;                                   // no ack: keep it, retry on next profileAccepted
            const q2 = this.loadPending();
            const idx = q2.findIndex((i) => i.qid === item.qid);
            if (res && res.ok) {
                if (idx >= 0) q2.splice(idx, 1);
                this.savePending(q2);
                showToast(`💾 Ride saved to your history${Number.isFinite(res.points) ? ` (${res.points} route point${res.points === 1 ? "" : "s"})` : ""}.`, 3500);
                if (this.isOpen()) this.refresh();
                // The server throttles tripFinished to one per 5 s per socket.
                if (q2.length) { clearTimeout(this.flushTimer); this.flushTimer = setTimeout(() => this.flushPending(), 5500); }
                return;
            }
            const reason = res && res.reason;
            if (reason === "too-frequent" || reason === "rate-limited") {
                clearTimeout(this.flushTimer);
                this.flushTimer = setTimeout(() => this.flushPending(), 5500);
                return;
            }
            if (reason === "no-device-identity") { this.profileVerified = false; return; }
            // Anything else (e.g. internal-error): count attempts so one bad
            // record can't block the queue forever.
            if (idx >= 0) {
                q2[idx].attempts = (q2[idx].attempts || 0) + 1;
                if (q2[idx].attempts >= 3) { q2.splice(idx, 1); showToast("A ride couldn't be saved to the server and was dropped.", 5000); }
                this.savePending(q2);
                if (q2.length) { clearTimeout(this.flushTimer); this.flushTimer = setTimeout(() => this.flushPending(), 5500); }
            }
        });
    },

    // Zero-trace: called after "Clear my history" succeeds.
    clearLocal() {
        try { localStorage.removeItem(this.PENDING_KEY); } catch (e) { /* ignore */ }
        this.rows = [];
        this.trips = [];
        this.selectedKey = null;
        this.clearReplay();
        if (this.isOpen()) { this.render(); this.renderTrips(); }
    }
};

// ============================================================================
// PHASE 4 — IMU DEAD RECKONING (roadmap Sections 5 + 14)
// ============================================================================
// Keeps the rider's marker moving through tunnels, deep cuttings and canopy
// when GPS drops out, and says honestly how wrong it might be.
//
// Why NOT "integrate the accelerometer twice": a phone accelerometer's bias
// after gravity removal is ~0.05–0.2 m/s². Integrated twice, 0.1 m/s² is
// already 180 m off after 60 s, and the mount's tilt error makes it worse.
// Every production sat-nav does something narrower instead, and so does this:
//
//   HEADING  — the browser's relative `deviceorientation` (the OS's own
//              gyro+accelerometer fusion, no magnetometer, so steel and
//              rebar in a tunnel can't pull it) gives the heading CHANGE of a
//              device-fixed horizontal axis. Anchored to the last GPS course,
//              that is the vehicle heading. Fallback: the raw gyro rate
//              projected on gravity, with sign/scale/bias fitted against GPS
//              course changes (handles iOS's inverted gravity sign and
//              browsers that report rad/s). Last resort: hold the heading.
//   SPEED    — last GPS speed, adjusted only by clear accelerations along the
//              vehicle's forward axis. Which way is "forward" in the phone
//              depends on how it's mounted, so it's LEARNED: a small
//              recursive least-squares fit of GPS acceleration against the
//              horizontal accelerometer components while GPS is good.
//              Accelerations inside a ±0.35 m/s² deadband are treated as bias.
//   ROUTE    — when a route is known (navigation, or your leg of a group
//              trip) the estimate advances ALONG the route line instead of
//              free-flying, which is how car sat-navs handle tunnels. The
//              inertial heading still watches: a sustained turn the route
//              doesn't have means you left it, and the estimate unsnaps.
//   HONESTY  — the uncertainty radius grows with time, speed and heading
//              source, a coarse network fix pulls the estimate in (1-D
//              Kalman blend), and at 5 min or 1.5 km of uncertainty it stops
//              pretending. When GPS returns, the real error is measured and
//              logged ("estimate was 38 m off after 1:12").
//
// The core below is DOM-free (createDeadReckoner) so the same code runs in
// the tunnel simulation used to test it; DeadReckoning further down is the
// browser glue (sensors, permission, map, island, voice, server).
const DR_CFG = Object.freeze({
    goodFixAccM: 35,          // a fix this accurate ends an outage and feeds calibration
    coarseFixAccM: 60,        // worse than this during a drive = "no real GPS"
    outageAfterMs: 4000,      // no good fix for this long while moving = GPS outage
    minSpeedKmh: 12,          // don't dead-reckon a parked car or a walk
    maxDurationMs: 300000,    // after 5 min an estimate is fiction — stop
    maxRadiusM: 1500,         // ...or once the uncertainty is this large
    calWindowMs: 1800,        // calibration sample length (GPS accel from ~2 s of speed change)
    snapMaxM: 40,             // last fix must be this close to the route to snap to it
    snapHeadingDeg: 50,       // ...and heading the same way
    unsnapTurnDeg: 55,        // inertial turn the route doesn't have -> leave the route
    unsnapHoldMs: 4000,
    accelDeadbandMs2: 0.35,   // forward accel below this is treated as sensor bias
    basisTiltDeg: 25,         // phone re-mounted -> relearn its axes
    orientStdDeg: 12,         // orientation heading trusted when offset spread is below this
    logMax: 10
});

const DRMath = {
    D2R: Math.PI / 180,
    wrap180(d) { return ((((d + 180) % 360) + 360) % 360) - 180; },
    wrap360(d) { return ((d % 360) + 360) % 360; },
    dot(a, b) { return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]; },
    cross(a, b) { return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]; },
    unit(a) { const n = Math.hypot(a[0], a[1], a[2]); return n > 1e-9 ? [a[0] / n, a[1] / n, a[2] / n] : null; },
    vec(o) { return o && Number.isFinite(o.x) && Number.isFinite(o.y) && Number.isFinite(o.z) ? [o.x, o.y, o.z] : null; },
    // W3C DeviceOrientation: R = Rz(alpha)·Rx(beta)·Ry(gamma) maps DEVICE
    // coordinates to the EARTH frame (x = east, y = north, z = up). The same
    // matrix works for the relative frame, whose "north" is arbitrary.
    rotation(alpha, beta, gamma) {
        const r = DRMath.D2R;
        const cX = Math.cos(beta * r), sX = Math.sin(beta * r);
        const cY = Math.cos(gamma * r), sY = Math.sin(gamma * r);
        const cZ = Math.cos(alpha * r), sZ = Math.sin(alpha * r);
        return [
            cZ * cY - sZ * sX * sY, -cX * sZ, cY * sZ * sX + cZ * sY,
            cY * sZ + cZ * sX * sY, cZ * cX, sZ * sY - cZ * cY * sX,
            -cX * sY, sX, cX * cY
        ];
    },
    // Compass-style heading (clockwise from the frame's north) of a device-fixed vector.
    headingOf(R, v) {
        const e = R[0] * v[0] + R[1] * v[1] + R[2] * v[2];
        const n = R[3] * v[0] + R[4] * v[1] + R[5] * v[2];
        if (Math.hypot(e, n) < 0.5) return null;          // vector nearly vertical: heading undefined
        return DRMath.wrap360(Math.atan2(e, n) / DRMath.D2R);
    },
    distM(lat1, lng1, lat2, lng2) {
        const r = DRMath.D2R;
        const x = Math.sin((lat2 - lat1) * r / 2) ** 2 + Math.cos(lat1 * r) * Math.cos(lat2 * r) * Math.sin((lng2 - lng1) * r / 2) ** 2;
        return 12742000 * Math.asin(Math.sqrt(Math.min(1, x)));
    },
    bearing(lat1, lng1, lat2, lng2) {
        const r = DRMath.D2R;
        const y = Math.sin((lng2 - lng1) * r) * Math.cos(lat2 * r);
        const x = Math.cos(lat1 * r) * Math.sin(lat2 * r) - Math.sin(lat1 * r) * Math.cos(lat2 * r) * Math.cos((lng2 - lng1) * r);
        return DRMath.wrap360(Math.atan2(y, x) / r);
    },
    // Short-step move (a 1 s step is metres to tens of metres — planar is exact enough).
    move(lat, lng, headingDeg, distM) {
        const r = DRMath.D2R;
        const dN = distM * Math.cos(headingDeg * r), dE = distM * Math.sin(headingDeg * r);
        return { lat: lat + dN / 111320, lng: lng + dE / (111320 * Math.max(0.01, Math.cos(lat * r))) };
    },
    // Recursive least squares with exponential forgetting: y ≈ θ·x.
    rls(n, lambda, p0 = 1000) {
        const P = []; for (let i = 0; i < n; i++) { P.push(new Array(n).fill(0)); P[i][i] = p0; }
        return { n, lambda, p0, theta: new Array(n).fill(0), P, count: 0, mse: null };
    },
    rlsUpdate(m, x, y) {
        const n = m.n, P = m.P;
        const Px = new Array(n).fill(0);
        for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) Px[i] += P[i][j] * x[j];
        let denom = m.lambda, pred = 0;
        for (let i = 0; i < n; i++) { denom += x[i] * Px[i]; pred += m.theta[i] * x[i]; }
        const err = y - pred;
        for (let i = 0; i < n; i++) m.theta[i] += (Px[i] / denom) * err;
        let trace = 0;
        for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) { P[i][j] = (P[i][j] - (Px[i] * Px[j]) / denom) / m.lambda; if (i === j) trace += P[i][j]; }
        // Forgetting without excitation lets P blow up ("wind-up"): cap it.
        if (trace > m.p0 * n) { const k = (m.p0 * n) / trace; for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) P[i][j] *= k; }
        m.count++;
        m.mse = m.mse == null ? err * err : 0.92 * m.mse + 0.08 * err * err;
        return err;
    },
    // Route polyline [[lat,lng],...] -> cumulative metres, for arc-length moves.
    prepareRoute(path) {
        if (!Array.isArray(path) || path.length < 2) return null;
        const pts = path.map((p) => (Array.isArray(p) ? { lat: p[0], lng: p[1] } : { lat: p.lat, lng: p.lng })).filter((p) => Number.isFinite(p.lat) && Number.isFinite(p.lng));
        if (pts.length < 2) return null;
        const cum = [0];
        for (let i = 1; i < pts.length; i++) cum.push(cum[i - 1] + DRMath.distM(pts[i - 1].lat, pts[i - 1].lng, pts[i].lat, pts[i].lng));
        return { pts, cum, total: cum[cum.length - 1] };
    },
    projectOnRoute(route, lat, lng) {
        const r = DRMath.D2R, cosLat = Math.cos(lat * r);
        const X = (p) => [(p.lng - lng) * 111320 * cosLat, (p.lat - lat) * 110540];
        let best = null;
        for (let i = 0; i < route.pts.length - 1; i++) {
            const [ax, ay] = X(route.pts[i]), [bx, by] = X(route.pts[i + 1]);
            const dx = bx - ax, dy = by - ay, L2 = dx * dx + dy * dy;
            let t = L2 > 0 ? -(ax * dx + ay * dy) / L2 : 0;
            t = Math.max(0, Math.min(1, t));
            const d = Math.hypot(ax + t * dx, ay + t * dy);
            if (!best || d < best.d) best = { d, i, t };
        }
        const segLen = route.cum[best.i + 1] - route.cum[best.i];
        return { distM: best.d, s: route.cum[best.i] + best.t * segLen, idx: best.i };
    },
    pointAtS(route, s) {
        const S = Math.max(0, Math.min(route.total, s));
        let i = 0;
        while (i < route.cum.length - 2 && route.cum[i + 1] < S) i++;
        const a = route.pts[i], b = route.pts[i + 1];
        const seg = route.cum[i + 1] - route.cum[i];
        const t = seg > 0 ? (S - route.cum[i]) / seg : 0;
        return { lat: a.lat + (b.lat - a.lat) * t, lng: a.lng + (b.lng - a.lng) * t, bearing: DRMath.bearing(a.lat, a.lng, b.lat, b.lng), atEnd: S >= route.total - 0.5 };
    }
};

// env: { routeProvider(): [[lat,lng],...] | null, allowed(): boolean }
function createDeadReckoner(env = {}) {
    const M = DRMath, C = DR_CFG;
    const routeProvider = typeof env.routeProvider === "function" ? env.routeProvider : () => null;
    const allowed = typeof env.allowed === "function" ? env.allowed : () => true;
    const newAcc = () => ({ dt: 0, h1: 0, h2: 0, yaw: 0, yawDt: 0 });

    const st = {
        g: null, lastMotionT: 0, basis: null, driftSince: null, motionSamples: 0, hasLinear: false, hasGyro: false,
        orient: null,
        calAcc: newAcc(), tickAcc: newAcc(), calStart: null,
        fwd: M.rls(3, 0.995), fwdExcite: 0,
        gyro: M.rls(2, 0.995), gyroExcite: 0,
        off: { c: 0, s: 0, n: 0, varDeg: 900 },
        lastGood: null, speeds: [],
        outage: null, log: []
    };

    // ---- sensors -------------------------------------------------------------
    function buildBasis(up) {
        // Reference = the device axis most perpendicular to gravity, projected
        // onto the horizontal plane. Fixed in the DEVICE, so it turns with the
        // vehicle as long as the mount doesn't change.
        const absU = up.map(Math.abs);
        const k = absU.indexOf(Math.min(...absU));
        const ref = [0, 0, 0]; ref[k] = 1;
        const d = M.dot(ref, up);
        const e1 = M.unit([ref[0] - d * up[0], ref[1] - d * up[1], ref[2] - d * up[2]]);
        st.basis = { up: up.slice(), e1, e2: M.cross(up, e1) };
    }
    function resetMountCalibration() {
        st.fwd = M.rls(3, 0.995); st.fwdExcite = 0;
        st.off = { c: 0, s: 0, n: 0, varDeg: 900 };
    }
    function onMotion(ev) {
        const t = ev.t;
        let dt = st.lastMotionT ? (t - st.lastMotionT) / 1000 : 0;
        st.lastMotionT = t;
        if (!(dt > 0 && dt < 0.25)) dt = 0;                   // first sample or a gap: don't integrate across it
        const aig = M.vec(ev.aig);
        if (!aig) return;
        const lin = M.vec(ev.lin);
        st.hasLinear = st.hasLinear || Boolean(lin);
        const gRaw = lin ? [aig[0] - lin[0], aig[1] - lin[1], aig[2] - lin[2]] : aig;
        if (!st.g) st.g = gRaw.slice();
        else {
            const a = dt / ((lin ? 0.25 : 1.5) + dt);
            for (let i = 0; i < 3; i++) st.g[i] += a * (gRaw[i] - st.g[i]);
        }
        const up = M.unit(st.g);
        if (!up) return;
        if (!st.basis) buildBasis(up);
        else {
            const ang = Math.acos(Math.max(-1, Math.min(1, M.dot(up, st.basis.up)))) / M.D2R;
            if (ang > C.basisTiltDeg) {
                if (!st.driftSince) st.driftSince = t;
                else if (t - st.driftSince > 3000) { buildBasis(up); resetMountCalibration(); st.driftSince = null; }
            } else st.driftSince = null;
        }
        const la = lin || [aig[0] - st.g[0], aig[1] - st.g[1], aig[2] - st.g[2]];
        const h1 = M.dot(la, st.basis.e1), h2 = M.dot(la, st.basis.e2);
        const rr = ev.rr;
        const yaw = rr && Number.isFinite(rr.alpha) && Number.isFinite(rr.beta) && Number.isFinite(rr.gamma)
            ? rr.beta * up[0] + rr.gamma * up[1] + rr.alpha * up[2] : null;   // spec: alpha about z, beta about x, gamma about y
        if (yaw != null) st.hasGyro = true;
        st.motionSamples++;
        for (const acc of [st.calAcc, st.tickAcc]) {
            acc.dt += dt; acc.h1 += h1 * dt; acc.h2 += h2 * dt;
            if (yaw != null) { acc.yaw += yaw * dt; acc.yawDt += dt; }
        }
    }
    function onOrientation(ev) {
        if (![ev.alpha, ev.beta, ev.gamma].every(Number.isFinite)) return;
        st.orient = { alpha: ev.alpha, beta: ev.beta, gamma: ev.gamma, t: ev.t };
    }
    function psiO(t) {
        if (!st.orient || !st.basis || t - st.orient.t > 1500) return null;
        return M.headingOf(M.rotation(st.orient.alpha, st.orient.beta, st.orient.gamma), st.basis.e1);
    }

    // ---- calibration status --------------------------------------------------
    function fwdReady() {
        const th = st.fwd.theta, gain = Math.hypot(th[0], th[1]);
        // Needs the browser's gravity-free `acceleration`: with only
        // accelerationIncludingGravity, a low-passed gravity estimate absorbs
        // sustained braking and the fit can't be trusted (simulated: 7x worse).
        return st.hasLinear && st.fwdExcite >= 8 && gain > 0.5 && gain < 2 && st.fwd.mse != null && st.fwd.mse < 0.5;
    }
    function gyroReady() {
        const k = Math.abs(st.gyro.theta[0]);
        const plausible = (k > 0.5 && k < 2) || (k > 28 && k < 115);   // deg/s, or a browser reporting rad/s
        return st.gyroExcite >= 6 && plausible && st.gyro.mse != null && st.gyro.mse < 9;
    }
    function orientReady() {
        return st.off.n >= 12 && Math.sqrt(st.off.varDeg) < C.orientStdDeg;
    }
    function headingSource() {
        return orientReady() ? "orientation" : gyroReady() ? "gyro" : "hold";
    }

    // ---- GPS side ----------------------------------------------------------------
    function describeFix(fix) {
        const prev = st.lastGood;
        let speed = Number.isFinite(fix.speed) && fix.speed >= 0 ? fix.speed : null;
        let course = Number.isFinite(fix.heading) && speed != null && speed > 1.5 ? M.wrap360(fix.heading) : null;
        if (prev) {
            const dt = (fix.t - prev.t) / 1000;
            const d = M.distM(prev.lat, prev.lng, fix.lat, fix.lng);
            if (speed == null && dt > 0.4 && dt < 6) speed = d / dt;
            if (course == null && d > 6 && dt < 6) course = M.bearing(prev.lat, prev.lng, fix.lat, fix.lng);
        }
        return { lat: fix.lat, lng: fix.lng, acc: fix.acc, t: fix.t, speed, course, psiO: psiO(fix.t) };
    }
    function calibrate(g) {
        // Orientation-heading consistency: offset = GPS course - device heading.
        if (g.course != null && g.speed != null && g.speed > 4 && g.psiO != null) {
            const o = M.wrap180(g.course - g.psiO) * M.D2R;
            const w = st.off.n < 10 ? 1 / (st.off.n + 1) : 0.1;
            st.off.c = (1 - w) * st.off.c + w * Math.cos(o);
            st.off.s = (1 - w) * st.off.s + w * Math.sin(o);
            const mean = Math.atan2(st.off.s, st.off.c);
            const resid = M.wrap180((o - mean) / M.D2R);
            st.off.varDeg = st.off.n === 0 ? 400 : (1 - w) * st.off.varDeg + w * resid * resid;
            st.off.n++;
        }
        const s0 = st.calStart;
        if (!s0) { st.calStart = g; st.calAcc = newAcc(); return; }
        const win = g.t - s0.t;
        if (win < C.calWindowMs) return;
        const acc = st.calAcc;
        if (win < 6000 && acc.dt > 0.5 * (win / 1000) && g.speed != null && s0.speed != null) {
            const aGps = (g.speed - s0.speed) / (win / 1000);
            M.rlsUpdate(st.fwd, [acc.h1 / acc.dt, acc.h2 / acc.dt, 1], aGps);
            if (Math.abs(aGps) > 0.6) st.fwdExcite++;
            if (acc.yawDt > 0.5 * (win / 1000) && g.course != null && s0.course != null && g.speed > 4 && s0.speed > 4) {
                const rate = M.wrap180(g.course - s0.course) / (win / 1000);
                M.rlsUpdate(st.gyro, [acc.yaw / acc.yawDt, 1], rate);
                if (Math.abs(rate) > 3) st.gyroExcite++;
            }
        }
        st.calStart = g;
        st.calAcc = newAcc();
    }
    // Speed at the tunnel mouth: the LATEST GPS speed (a median of recent
    // speeds lags while accelerating — simulated: 1.8 m/s low = 300 m over
    // 3 min), unless it disagrees with that median by more than 2 m/s.
    function movingSpeed() {
        if (!st.speeds.length) return 0;
        const s = st.speeds.slice().sort((a, b) => a - b);
        const med = s[Math.floor(s.length / 2)], last = st.speeds[st.speeds.length - 1];
        return Math.abs(last - med) <= 2 ? last : med;
    }

    // ---- outage lifecycle ------------------------------------------------------
    function startOutage(t, reason) {
        const g = st.lastGood;
        if (!g || !allowed() || t - g.t > 60000) return false;
        // No live motion data (no sensors, page in the background, desktop):
        // that would be blind extrapolation, not dead reckoning — don't.
        if (!st.lastMotionT || t - st.lastMotionT > 5000) return false;
        const v0 = movingSpeed();
        if (v0 * 3.6 < C.minSpeedKmh) return false;
        let psi0 = g.course;
        if (psi0 == null) { for (let i = st.recent.length - 1; i >= 0 && psi0 == null; i--) psi0 = st.recent[i].course; }
        const o = {
            reason, startT: g.t, lastT: g.t, lat: g.lat, lng: g.lng, v: v0, v0, psi: psi0, psi0,
            aLp: 0, dist: 0, rBase: Math.max(5, g.acc || 10), tBase: g.t, distBase: 0,
            inertial: 0, psiO0: g.psiO, offset: st.off.n ? Math.atan2(st.off.s, st.off.c) / M.D2R : null, route: null, s: 0, routePsi0: null, mismatchSince: null, trail: [],
            source: headingSource(), fwd: fwdReady(), lost: false, lostAt: null, radius: Math.max(5, g.acc || 10), endOfRoute: false
        };
        const path = routeProvider();
        const route = path ? M.prepareRoute(path) : null;
        if (route) {
            const pr = M.projectOnRoute(route, g.lat, g.lng);
            const segB = M.pointAtS(route, pr.s + 0.5).bearing;
            if (pr.distM <= C.snapMaxM && (psi0 == null || Math.abs(M.wrap180(segB - psi0)) <= C.snapHeadingDeg)) {
                o.route = route; o.s = pr.s; o.routePsi0 = segB; o.psi = segB;
                const p = M.pointAtS(route, pr.s);
                o.lat = p.lat; o.lng = p.lng;
            }
        }
        if (o.psi == null) return false;                       // no direction known and no route: can't estimate
        // st.tickAcc already holds the motion since the last good fix (reset
        // there), which is exactly the span the first propagate() covers.
        st.outage = o;
        return true;
    }
    function inertialDelta(o, acc, t, dt) {
        // Heading CHANGE since the outage began, from the best inertial source.
        if (o.source === "orientation") {
            // psiO + the offset learned over many fixes is a better absolute
            // heading than one noisy GPS course at the tunnel mouth.
            const now = psiO(t);
            if (now != null && o.offset != null && o.psi0 != null) return { ok: true, delta: M.wrap180(now + o.offset - o.psi0) };
            if (now != null && o.psiO0 != null) return { ok: true, delta: M.wrap180(now - o.psiO0) };
        }
        if ((o.source === "gyro" || o.source === "orientation") && gyroReady() && acc.yawDt > 0.2) {
            const [k, c] = st.gyro.theta;
            o.inertial += (k * (acc.yaw / acc.yawDt) + c) * dt;
            return { ok: true, delta: o.inertial };
        }
        return { ok: false, delta: 0 };
    }
    function grow(o, T) {
        // ~1-sigma growth model, tuned in the tunnel simulation (see tests).
        const sv = o.fwd ? 0.3 + 0.04 * o.v0 : 1.0 + 0.12 * o.v0;          // m/s speed error
        const along = sv * T;
        let cross;
        if (o.route) cross = 10;
        else {
            const sPsi = Math.min(90, o.source === "orientation" ? 3 + 0.05 * T : o.source === "gyro" ? 5 + 0.1 * T : 8 + 1.2 * T);
            cross = (o.dist - o.distBase) * Math.sin(sPsi * M.D2R) * 0.7;
        }
        return Math.hypot(o.rBase, along, cross);
    }
    function propagate(t) {
        const o = st.outage;
        const dt = (t - o.lastT) / 1000;
        if (!(dt > 0)) return;
        o.lastT = t;
        const acc = st.tickAcc; st.tickAcc = newAcc();

        // Speed: hold, adjusted by clear forward accelerations.
        if (o.fwd && acc.dt > 0.2) {
            const th = st.fwd.theta;
            const aF = th[0] * (acc.h1 / acc.dt) + th[1] * (acc.h2 / acc.dt) + th[2];
            o.aLp += (Math.min(1, dt) / (1 + Math.min(1, dt))) * (aF - o.aLp);
            if (Math.abs(o.aLp) > C.accelDeadbandMs2) o.v += o.aLp * dt;
        }
        o.v = Math.max(0, Math.min(o.v, 45, Math.max(o.v0 * 1.6, o.v0 + 8)));

        const inert = inertialDelta(o, acc, t, dt);
        const step = o.v * dt;
        o.dist += step;
        if (o.route) {
            const from = { lat: o.lat, lng: o.lng };
            o.s += step;
            const p = M.pointAtS(o.route, o.s);
            o.lat = p.lat; o.lng = p.lng; o.psi = p.bearing; o.endOfRoute = p.atEnd;
            if (inert.ok) {
                const routeDelta = M.wrap180(p.bearing - o.routePsi0);
                const diff = Math.abs(M.wrap180(inert.delta - routeDelta));
                // Short trail of (position, step, inertial heading) so an
                // unsnap can rewind to where the paths actually split.
                o.trail.push({ from, step, delta: inert.delta, diff });
                if (o.trail.length > 40) o.trail.shift();
                if (diff > C.unsnapTurnDeg) {
                    if (!o.mismatchSince) o.mismatchSince = t;
                    else if (t - o.mismatchSince > C.unsnapHoldMs) {
                        // The route says straight, the vehicle turned: we left
                        // the route. Rewind to the last step where route and
                        // inertial heading still agreed and re-fly from there.
                        let k = o.trail.length - 1;
                        while (k > 0 && o.trail[k].diff > 10) k--;
                        let pos = o.trail[k].from;
                        for (let j = k; j < o.trail.length; j++) pos = M.move(pos.lat, pos.lng, M.wrap360(o.psi0 + o.trail[j].delta), o.trail[j].step);
                        o.lat = pos.lat; o.lng = pos.lng;
                        o.route = null; o.trail = []; o.psi = M.wrap360(o.psi0 + inert.delta);
                        o.rBase = Math.max(25, o.radius); o.tBase = t; o.distBase = o.dist;
                    }
                } else o.mismatchSince = null;
            }
        } else {
            if (inert.ok && o.psi0 != null) o.psi = M.wrap360(o.psi0 + inert.delta);
            const p = M.move(o.lat, o.lng, o.psi, step);
            o.lat = p.lat; o.lng = p.lng;
        }
        o.radius = grow(o, (t - o.tBase) / 1000);
        // On a known route only the along-track error grows, so a long
        // highway tunnel (Atal, Chenani–Nashri: ~9 km) can be followed longer.
        const maxMs = o.route ? C.maxDurationMs * 3 : C.maxDurationMs;
        if (t - o.startT > maxMs || o.radius > C.maxRadiusM) { o.lost = true; o.lostAt = t; }
    }
    function measurementUpdate(fix) {
        // A coarse (cell/Wi-Fi) fix is still information: blend it in when
        // it's tighter than the estimate (isotropic 1-D Kalman update).
        const o = st.outage;
        const r = o.radius, a = Math.max(1, fix.acc);
        if (!(a < r * 1.5)) return;
        const w = (r * r) / (r * r + a * a);
        o.lat += w * (fix.lat - o.lat);
        o.lng += w * (fix.lng - o.lng);
        o.rBase = Math.sqrt((r * r * a * a) / (r * r + a * a));
        o.tBase = fix.t; o.distBase = o.dist; o.radius = o.rBase;
        if (o.route) {
            const pr = M.projectOnRoute(o.route, o.lat, o.lng);
            if (pr.distM > 60) o.route = null;
            else { o.s = pr.s; const p = M.pointAtS(o.route, o.s); o.lat = p.lat; o.lng = p.lng; }
        }
        if (o.lost && o.radius < C.maxRadiusM) { o.lost = false; o.lostAt = null; }
    }
    function endOutage(g) {
        const o = st.outage;
        const summary = {
            at: g.t, startedAt: o.startT, durationMs: g.t - o.startT,
            errorM: Math.round(M.distM(o.lat, o.lng, g.lat, g.lng)), radiusM: Math.round(o.radius),
            distanceM: Math.round(o.dist), source: o.route ? "route" : o.source, lost: o.lost, reason: o.reason
        };
        st.log.unshift(summary);
        if (st.log.length > C.logMax) st.log.length = C.logMax;
        st.outage = null;
        return summary;
    }
    function estimate(t) {
        const o = st.outage;
        if (!o) return null;
        return {
            lat: o.lat, lng: o.lng, radius: Math.round(o.radius), speedKmh: Math.round(o.v * 3.6 * 10) / 10,
            heading: o.psi == null ? null : Math.round(o.psi), source: o.route ? "route" : o.source,
            elapsedMs: t - o.startT, lost: o.lost, endOfRoute: Boolean(o.endOfRoute)
        };
    }

    st.recent = [];
    return {
        onMotion, onOrientation,
        // fix: {lat, lng, acc, speed (m/s|null), heading (deg|null), t}
        onFix(fix) {
            if (!Number.isFinite(fix.lat) || !Number.isFinite(fix.lng)) return { verdict: "use" };
            const acc = Number.isFinite(fix.acc) ? fix.acc : 9999;
            if (acc <= C.goodFixAccM) {
                const g = describeFix({ ...fix, acc });
                const ended = st.outage ? endOutage(g) : null;
                calibrate(g);
                st.lastGood = g;
                st.recent.push(g); if (st.recent.length > 5) st.recent.shift();
                if (g.speed != null) { st.speeds.push(g.speed); if (st.speeds.length > 3) st.speeds.shift(); }
                st.tickAcc = newAcc();
                return { verdict: "use", ended };
            }
            if (st.outage) { measurementUpdate({ ...fix, acc }); return { verdict: "suppress" }; }
            if (acc > C.coarseFixAccM && startOutage(fix.t, "coarse-fix")) {
                propagate(fix.t);
                measurementUpdate({ ...fix, acc });
                return { verdict: "suppress", started: true };
            }
            return { verdict: "use" };
        },
        tick(t) {
            const o = st.outage;
            if (o) {
                if (!o.lost) propagate(t);
                return { estimate: estimate(t) };
            }
            const g = st.lastGood;
            if (g && t - g.t > C.outageAfterMs && startOutage(t, "no-fix")) {
                propagate(t);
                return { started: true, estimate: estimate(t) };
            }
            return {};
        },
        active() { return Boolean(st.outage); },
        cancel() { st.outage = null; },
        estimate,
        status() {
            return {
                sensors: { motion: st.motionSamples > 0, linear: st.hasLinear, gyro: st.hasGyro, orientation: Boolean(st.orient) },
                heading: headingSource(), speed: fwdReady() ? "accelerometer" : "hold",
                orientStdDeg: st.off.n ? Math.round(Math.sqrt(st.off.varDeg)) : null, orientSamples: st.off.n,
                fwdExcite: st.fwdExcite, gyroExcite: st.gyroExcite,
                gyroGain: gyroReady() ? Math.round(st.gyro.theta[0] * 100) / 100 : null
            };
        },
        log() { return st.log.slice(); },
        setLog(l) { if (Array.isArray(l)) st.log = l.slice(0, C.logMax); },
        _state: st
    };
}
// ---- end dead-reckoning core ----

// Browser glue: sensors, iOS permission, the 1 Hz loop, and what the rider
// sees and hears. Sensors only run during a drive / group trip in a vehicle
// mode — never in the background of a walk or a parked phone.
const DeadReckoning = {
    KEY_ENABLED: "mu_dr_enabled",
    KEY_LOG: "mu_dr_log",
    enabled: true,
    core: null,
    listening: false,
    permission: "unknown",            // "unknown" | "granted" | "denied" | "not-needed"
    tickTimer: null,
    motionEvents: 0,
    listenStartedAt: 0,
    lastEmitTs: 0,
    lastPointTs: 0,
    lastEstimate: null,
    lostAnnounced: false,
    permissionOffered: false,

    init() {
        try { this.enabled = localStorage.getItem(this.KEY_ENABLED) !== "0"; } catch (e) { /* storage blocked: keep default */ }
        this.permission = this.needsPermission() ? "unknown" : "not-needed";
        this.core = createDeadReckoner({
            routeProvider: () => this.routePath(),
            allowed: () => this.enabled && this.listening && this.vehicleMode()
        });
        try { this.core.setLog(JSON.parse(localStorage.getItem(this.KEY_LOG) || "[]")); } catch (e) { /* corrupt log: start fresh */ }
        this.handleMotion = this.handleMotion.bind(this);
        this.handleOrientation = this.handleOrientation.bind(this);
        this.bindUI();
        document.addEventListener("mu:drive-state", () => this.updateSensors());
        this.updateSensors();
    },

    supported() { return typeof window.DeviceMotionEvent !== "undefined"; },
    needsPermission() { return typeof window.DeviceMotionEvent !== "undefined" && typeof window.DeviceMotionEvent.requestPermission === "function"; },
    vehicleMode() { return (window.currentTravelMode || "bike") !== "walk"; },
    wanted() { return this.enabled && this.supported() && this.vehicleMode() && isDriving(); },

    updateSensors() {
        if (this.wanted() && this.permission !== "denied") {
            if (this.permission === "unknown") { this.offerPermission(); return; }
            this.startSensors();
        } else {
            this.stopSensors();
        }
        this.renderStatus();
    },

    startSensors() {
        if (this.listening) return;
        window.addEventListener("devicemotion", this.handleMotion);
        window.addEventListener("deviceorientation", this.handleOrientation);
        this.listening = true;
        this.listenStartedAt = Date.now();
        clearInterval(this.tickTimer);
        this.tickTimer = setInterval(() => this.tick(), 1000);
    },

    stopSensors() {
        if (!this.listening) return;
        window.removeEventListener("devicemotion", this.handleMotion);
        window.removeEventListener("deviceorientation", this.handleOrientation);
        this.listening = false;
        clearInterval(this.tickTimer);
        this.tickTimer = null;
        // Drive over mid-tunnel: drop the estimate rather than leave a
        // "GPS lost" state nobody will ever clear.
        if (this.core && this.core.active()) {
            this.core.cancel();
            this.finishUi();
            islandHide("dr");
        }
    },

    // iOS 13+: motion access must be requested from a tap. Offer it on the
    // island when a drive starts (and from settings) — never nag in a loop.
    offerPermission() {
        if (this.permissionOffered) return;
        this.permissionOffered = true;
        islandShow({
            id: "dr-perm", kind: "info", icon: "🧭", title: "Allow motion access?",
            sub: "Keeps your position moving in tunnels when GPS drops", ttl: 12000, haptic: false,
            action: { label: "Allow", onClick: () => this.requestPermission() }
        });
    },

    async requestPermission() {
        try {
            const m = await window.DeviceMotionEvent.requestPermission();
            let o = "granted";
            if (window.DeviceOrientationEvent && typeof window.DeviceOrientationEvent.requestPermission === "function") {
                o = await window.DeviceOrientationEvent.requestPermission();
            }
            this.permission = m === "granted" ? "granted" : "denied";
            if (o !== "granted" && m === "granted") console.warn("[DR] orientation denied — heading falls back to the gyroscope");
        } catch (e) {
            this.permission = "denied";
        }
        islandHide("dr-perm");
        this.updateSensors();
    },

    handleMotion(e) {
        this.motionEvents++;
        this.core.onMotion({ t: Date.now(), aig: e.accelerationIncludingGravity, lin: e.acceleration, rr: e.rotationRate });
    },

    handleOrientation(e) {
        this.core.onOrientation({ t: Date.now(), alpha: e.alpha, beta: e.beta, gamma: e.gamma });
    },

    // The route to snap to while GPS is gone: active navigation first, then
    // my own leg of the group trip, then my meetup route.
    routePath() {
        if (navState.active && Array.isArray(navState.routePath) && navState.routePath.length > 1) return navState.routePath;
        const mine = (layer, id) => {
            let found = null;
            layer.eachLayer((l) => {
                if (!found && l.memberId === id && typeof l.getLatLngs === "function") {
                    const ll = l.getLatLngs();
                    if (Array.isArray(ll) && ll.length > 1) found = ll.map((p) => [p.lat, p.lng]);
                }
            });
            return found;
        };
        if (currentTrip && Array.isArray(currentTrip.members) && currentTrip.members.some((m) => m.id === socket.id)) {
            const r = mine(tripRoutesLayer, socket.id);
            if (r) return r;
        }
        if (GroupNavigation.active) return mine(GroupNavigation.layerGroup, "me");
        return null;
    },

    // Called from startGPS() for EVERY fix. "suppress" = a coarse fix during
    // an outage: the estimate already absorbed it, don't jump the marker.
    onGpsFix(p) {
        if (!this.core || !this.enabled) return "use";
        const c = p && p.coords;
        if (!c) return "use";
        const res = this.core.onFix({
            lat: Number(c.latitude), lng: Number(c.longitude), acc: Number(c.accuracy),
            speed: c.speed == null ? null : Number(c.speed), heading: c.heading == null ? null : Number(c.heading), t: Date.now()
        });
        if (res.ended) this.onOutageEnd(res.ended);
        if (res.verdict === "suppress") {
            const est = this.core.estimate(Date.now());
            if (res.started) this.onOutageStart(est);
            if (est) this.apply(est);
        }
        return res.verdict;
    },

    // The navigation watch sees the same raw fixes: while estimating (or at
    // speed), a coarse network fix must not yank the nav marker or trigger
    // a reroute off a 900 m error circle.
    shouldIgnoreNavFix(pos) {
        const acc = pos && pos.coords ? Number(pos.coords.accuracy) : NaN;
        if (!this.core || !this.enabled) return false;
        if (this.core.active()) return !(acc <= DR_CFG.goodFixAccM);
        return this.listening && acc > DR_CFG.coarseFixAccM;
    },

    tick() {
        if (!this.core) return;
        const res = this.core.tick(Date.now());
        if (res.started) this.onOutageStart(res.estimate);
        if (res.estimate) this.apply(res.estimate);
    },

    apply(est) {
        this.lastEstimate = est;
        applyEstimatedPosition(est);
        if (est.lost && !this.lostAnnounced) {
            this.lostAnnounced = true;
            islandShow({ id: "dr", kind: "sensor", icon: "❓", title: "Position uncertain", sub: `No GPS for ${fmtClock(est.elapsedMs)} — last estimate shown`, ttl: 0, sticky: true, priority: 52, haptic: false });
            voiceAnnounce("Still no GPS. Your position on the map is only a rough guess now.", { priority: 45, key: "dr-lost", cooldownMs: 300000, category: "nav", drivingOnly: true });
        } else if (!est.lost) {
            islandShow({ id: "dr", kind: "sensor", icon: "🛰", title: "GPS lost — estimating", sub: this.subFor(est), meta: fmtClock(est.elapsedMs), ttl: 0, sticky: true, priority: 50, haptic: false });
        }
        const chip = $("dr-chip");
        if (chip) {
            chip.hidden = false;
            const t = $("dr-chip-text");
            if (t) t.textContent = est.lost ? "Position uncertain" : `Estimated · ±${formatDistanceShort(est.radius)}`;
            chip.dataset.state = est.lost ? "lost" : "est";
        }
    },

    subFor(est) {
        const r = `±${formatDistanceShort(est.radius)}`;
        if (est.source === "route") return `Following your route · ${r}`;
        if (est.source === "orientation" || est.source === "gyro") return `Motion sensors · ${r}`;
        return `Last speed & heading · ${r}`;
    },

    onOutageStart(est) {
        this.lostAnnounced = false;
        voiceAnnounce("GPS signal lost. Estimating your position.", { priority: 45, key: "dr-start", cooldownMs: 120000, category: "nav", drivingOnly: true });
        if (est) this.apply(est);
    },

    onOutageEnd(summary) {
        this.finishUi();
        this.persistLog();
        const offBy = summary.lost ? "Estimate had given up" : `Estimate was ${formatDistanceShort(summary.errorM)} off`;
        islandShow({ id: "dr", kind: "safe", icon: "🛰", title: "GPS back", sub: `${offBy} after ${fmtClock(summary.durationMs)}`, ttl: 5000, sticky: false, haptic: false });
        voiceAnnounce("GPS is back.", { priority: 35, key: "dr-end", cooldownMs: 60000, category: "nav", drivingOnly: true });
        this.renderStatus();
    },

    finishUi() {
        this.lastEstimate = null;
        this.lostAnnounced = false;
        setOwnMarkerEstimated(false);
        const chip = $("dr-chip");
        if (chip) chip.hidden = true;
        if (myCoords && myCoords.est) { myCoords.est = false; }
    },

    persistLog() {
        try { localStorage.setItem(this.KEY_LOG, JSON.stringify(this.core.log())); } catch (e) { /* quota: the log is a nicety */ }
    },

    clearLocal() {
        try { localStorage.removeItem(this.KEY_LOG); } catch (e) { /* ignore */ }
        if (this.core) this.core.setLog([]);
        this.renderStatus();
    },

    bindUI() {
        const toggle = $("dr-toggle");
        if (toggle) {
            toggle.checked = this.enabled;
            toggle.addEventListener("change", () => {
                this.enabled = toggle.checked;
                try { localStorage.setItem(this.KEY_ENABLED, this.enabled ? "1" : "0"); } catch (e) { /* ignore */ }
                this.updateSensors();
            });
        }
        const perm = $("dr-permission-btn");
        if (perm) perm.addEventListener("click", () => this.requestPermission());
        const settingsBtn = $("profile-open-btn");
        if (settingsBtn) settingsBtn.addEventListener("click", () => setTimeout(() => this.renderStatus(), 0));
    },

    statusText() {
        if (!this.supported()) return "This browser has no motion sensors, so tunnel mode isn't available here.";
        if (!this.enabled) return "Off — the map freezes at your last GPS fix when the signal drops.";
        if (this.permission === "denied") return "Motion access was declined. On iPhone: Settings › Safari › Motion & Orientation Access, then reopen the app.";
        if (!this.listening) return this.vehicleMode() ? "Starts on its own when a drive or group trip begins." : "Off while walking — it models a vehicle, not footsteps.";
        if (!this.motionEvents) return Date.now() - this.listenStartedAt > 3000 ? "No motion data from this device — tunnel mode will hold your last speed and heading." : "Starting motion sensors…";
        const s = this.core.status();
        const heading = s.heading === "orientation" ? "heading from motion sensors ✓" : s.heading === "gyro" ? "heading from gyroscope ✓" : "heading: still learning (a few turns at speed)";
        const speed = s.speed === "accelerometer" ? "speed from accelerometer ✓" : !s.sensors.linear ? "speed: last GPS speed (no linear-acceleration sensor)" : "speed: still learning (a few speed-ups and stops)";
        return `Ready — ${heading}; ${speed}.`;
    },

    renderStatus() {
        const st = $("dr-status");
        if (st) st.textContent = this.statusText();
        const perm = $("dr-permission-btn");
        if (perm) perm.hidden = !(this.needsPermission() && this.permission !== "granted" && this.enabled);
        const list = $("dr-log");
        if (!list || !this.core) return;
        list.textContent = "";
        const log = this.core.log().slice(0, 5);
        if (!log.length) {
            const li = document.createElement("li");
            li.className = "dr-log-empty";
            li.textContent = "No GPS outages recorded yet.";
            list.appendChild(li);
            return;
        }
        log.forEach((e) => {
            const li = document.createElement("li");
            const when = new Date(e.at);
            const day = localDateKey(when) === localDateKey(new Date()) ? "Today" : when.toLocaleDateString([], { day: "numeric", month: "short" });
            const b = document.createElement("b");
            b.textContent = e.lost ? "gave up" : `off by ${formatDistanceShort(e.errorM)}`;
            li.append(`${day} ${when.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })} · ${fmtClock(e.durationMs)} without GPS · ${formatDistanceShort(e.distanceM)} · `, b);
            list.appendChild(li);
        });
    }
};

// "1:07" / "12 s" — elapsed time for the island meta and the outage log.
function fmtClock(ms) {
    const s = Math.max(0, Math.round((Number(ms) || 0) / 1000));
    if (s < 60) return `${s} s`;
    return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

// ---- estimated-position rendering ------------------------------------------
// A dead-reckoned position moves the marker, the speed dial, the ride log and
// the squad's view of you — but NOT the persisted breadcrumb trail
// (koraput_history), which stays GPS-only.
let ownMarkerEstimated = false;
function setOwnMarkerEstimated(on) {
    if (ownMarkerEstimated === on) return;
    ownMarkerEstimated = on;
    const el = ownMarker && typeof ownMarker.getElement === "function" ? ownMarker.getElement() : null;
    if (el) el.classList.toggle("dr-est", on);
    if (accuracyCircle && typeof accuracyCircle.setStyle === "function") {
        accuracyCircle.setStyle(on
            ? { color: "#ff9f0a", weight: 2, dashArray: "6 6", fillOpacity: 0.07 }
            : { color: "#10b981", weight: 2, dashArray: null, fillOpacity: 0.15 });
    }
}

function applyEstimatedPosition(est) {
    if (!est || !validCoord(est.lat, est.lng)) return;
    const alt = myCoords ? myCoords.alt : null;
    myCoords = { lat: est.lat, lng: est.lng, alt, speedKmh: est.speedKmh, est: true, accuracy: est.radius, heading: est.heading };
    if (!ownMarker) ownMarker = L.marker([est.lat, est.lng], { icon: ownIcon(), zIndexOffset: 1000 }).addTo(map);
    else ownMarker.setLatLng([est.lat, est.lng]);
    if (!accuracyCircle) accuracyCircle = L.circle([est.lat, est.lng], { radius: est.radius, color: "#ff9f0a", weight: 2, dashArray: "6 6", fillOpacity: 0.07 }).addTo(map);
    else { accuracyCircle.setLatLng([est.lat, est.lng]); accuracyCircle.setRadius(est.radius); }
    setOwnMarkerEstimated(true);
    followIfOn(est.lat, est.lng);

    // Speed dial shows the estimate, flagged low-confidence; no alerts fire on it.
    if (!est.lost) SmartDrive.checkSafetyLimits(est.speedKmh, 0.3);

    const now = Date.now();
    if (SmartDrive.trip.active && !est.lost && now - SmartDrive.trip.lastPointTs >= 5000) {
        SmartDrive.trip.points.push({ ts: now, lat: est.lat, lng: est.lng, speedKmh: est.speedKmh, accuracy: est.radius });
        SmartDrive.trip.lastPointTs = now;
        if (SmartDrive.trip.points.length > 2000) SmartDrive.trip.points.shift();
    }
    // Urban tunnels often keep mobile data: the squad sees the estimate,
    // marked as one (server: est + accuracy; geofences skip estimates).
    if (socket.connected && !est.lost && now - DeadReckoning.lastEmitTs >= 3000) {
        DeadReckoning.lastEmitTs = now;
        socket.emit("updateLocation", { lat: est.lat, lng: est.lng, alt, speedKmh: est.speedKmh, accuracy: est.radius, weather: myWeather, est: true });
    }
    document.dispatchEvent(new CustomEvent("mu:dr-position", { detail: est }));
    updateFriendBadges();
}

// ============================================================================
// SOCKET CONNECTION LIFECYCLE + IDENTITY HANDSHAKE
// ============================================================================
socket.on("connect", () => {
    if (currentUser.name) {
        socket.emit("profileReady", { name: currentUser.name, avatar: currentUser.avatar, deviceId: DeviceIdentity.id, deviceToken: DeviceIdentity.token });
    }
    if (offlineMessageQueue.length > 0) {
        offlineMessageQueue.forEach(msg => socket.emit("chatMessage", msg));
        offlineMessageQueue = [];
        showToast("📶 Back online! Sent queued messages.");
    }
    if (offlineMemoryQueue.length > 0) {
        offlineMemoryQueue.forEach(mem => socket.emit("uploadMemoryPhoto", mem));
        offlineMemoryQueue = [];
        showToast("📶 Back online! Pinned queued memories.");
    }
});

socket.on("profileAccepted", (data) => {
    if (data?.deviceToken) DeviceIdentity.storeIssuedToken(data.deviceToken);
    if (data?.sharingMode) PrivacyControls.setMode(data.sharingMode, { silent: true });
    if (data?.ownerKey) myOwnerKey = data.ownerKey;    // used to tell "my own geofence" apart, see renderGeofenceList()
    if (Number.isFinite(data?.tripRetentionDays)) TripAnalytics.retentionDays = data.tripRetentionDays;
    // The server only persists trips for a VERIFIED device, so this — not
    // "connect" — is the moment queued rides can be uploaded.
    TripAnalytics.profileVerified = true;
    TripAnalytics.flushPending();
    SmartDrive.shareMileage();                          // fuel-aware meetup needs each rider's own km/L
    // Fixed: a fix taken before the socket was identified was dropped by the
    // server (unknown socket), so a rider standing still showed NO position
    // to the squad until they moved. Re-send the current fix now.
    if (myCoords && !myCoords.est && validCoord(myCoords.lat, myCoords.lng)) {
        socket.emit("updateLocation", { lat: myCoords.lat, lng: myCoords.lng, alt: myCoords.alt ?? null, speedKmh: myCoords.speedKmh || 0, weather: myWeather });
    }
    // Phase 4: an SOS pressed with no connection goes out NOW, with the
    // current position. Not via Socket.IO's send buffer: that flushes on
    // reconnect BEFORE profileReady, and the server drops an SOS from a
    // socket it doesn't know yet — the emergency would be silently lost.
    if (pendingSos) {
        const age = Date.now() - pendingSos.queuedAt;
        pendingSos = null;
        if (age < 30 * 60 * 1000 && myCoords) {
            socket.emit("sos-alert", { name: currentUser.name, lat: myCoords.lat, lng: myCoords.lng, alt: myCoords.alt ?? null });
            showToast("🚨 Back online — your queued SOS has now been sent to everyone online.", 8000);
            islandShow({ id: "sos", kind: "sos", title: "Queued SOS sent", sub: "Back online — your friends were alerted", ttl: 8000 });
        }
    }
});

socket.on("profileRejected", () => {
    console.warn("[identity] Server rejected our device token — minting a new identity.");
    DeviceIdentity.resetAfterRejection();
    socket.emit("profileReady", { name: currentUser.name, avatar: currentUser.avatar, deviceId: DeviceIdentity.id, deviceToken: null });
    showToast("Your device identity was reset — you'll appear as a fresh rider.", 5000);
});

socket.on("locationRejected", (data) => {
    if (data?.reason === "implausible-jump") console.warn("[gps] Server flagged an implausible jump; strike", data.strikes);
});

socket.on("sharingChanged", (data) => { if (data?.mode) PrivacyControls.setMode(data.mode, { silent: true }); });

function showToast(message, duration = 4000) {
    if (window.MapUnite && typeof window.MapUnite.toast === "function") { window.MapUnite.toast(message, duration); return; }
    const container = $("toast-container"); if (!container) return;
    const toast = document.createElement("div"); toast.className = "toast"; toast.textContent = message;
    container.appendChild(toast);
    setTimeout(() => { toast.style.opacity = '0'; setTimeout(() => toast.remove(), 300); }, duration);
}

socket.on("geofenceAlert", (data) => {
    const action = data.type === "enter" ? "entered" : "left";
    showToast(`🔔 ${data.user} has ${action} ${data.fence}!`);
    // StatusIsland renders via textContent — pass raw strings (escaping here
    // made "Tom & Jerry" display as "Tom &amp; Jerry").
    islandShow({ id: "geo", kind: "geofence", title: String(data.fence || ""), sub: `${data.user || "Someone"} ${action}`, ttl: 5500 });
    voiceAnnounce(`${data.user || "Someone"} ${action} ${data.fence || "a geofence"}.`, { priority: 40, key: `geo-${data.user}-${data.fence}-${data.type}`, cooldownMs: 60000, category: "hazard", drivingOnly: true });
});

function startGPS() {
    if (!navigator.geolocation) {
        showToast("❌ Browser does not support GPS");
        return;
    }

    const processLocation = async (p) => {
        // Phase 4: during a GPS outage a coarse network fix is absorbed by the
        // dead-reckoning estimate instead of yanking the marker ~1 km away.
        if (DeadReckoning.onGpsFix(p) === "suppress") return;
        const lat = Number(p.coords.latitude), lng = Number(p.coords.longitude), acc = Number(p.coords.accuracy);
        const alt = p.coords.altitude ? Math.round(p.coords.altitude) : null;
        if (!validCoord(lat, lng)) return;

        // Score the fix BEFORE it touches anything (audit fix, Phase 1). A zero
        // device speed is treated as "not reported" and derived from movement,
        // as the original build did.
        const fix = GpsFilter.assess({
            lat, lng, accuracyM: acc, t: GpsFilter.fixTime(p),
            gpsSpeedKmh: p.coords.speed != null && p.coords.speed > 0 ? p.coords.speed * 3.6 : null
        });
        if (fix.hardReject) {
            // Physically impossible from the last good fix: the dial shows the
            // held speed as low-confidence; the marker, trail, broadcast and
            // stats all stay where the last good fix put them.
            SmartDrive.tick(fix);
            return;
        }
        if (fix.accepted) { lastFixCoords = { lat, lng }; lastFixTime = Date.now(); }
        // Everything downstream (friends, convoy, radar, voice) gets the
        // filtered speed, never a raw spike.
        const speedKmh = fix.smoothedKmh;
        myCoords = { lat, lng, alt, speedKmh };

        locationHistory.push([lat, lng]);
        if (locationHistory.length > 1000) locationHistory.shift();
        historyPolyline.setLatLngs(locationHistory);
        localStorage.setItem("koraput_history", JSON.stringify(locationHistory));

        if (!ownMarker) {
            ownMarker = L.marker([lat, lng], { icon: ownIcon(), zIndexOffset: 1000 }).addTo(map);
            map.flyTo([lat, lng], 16, { animate: true, duration: 1.5 });
        } else {
            ownMarker.setLatLng([lat, lng]);
        }
        setOwnMarkerEstimated(false);          // a real fix: back to the solid marker + green circle
        followIfOn(lat, lng);

        if (acc > 0 && acc < 100000) {
            if (!accuracyCircle) accuracyCircle = L.circle([lat, lng], { radius: acc, color: "#10b981", weight: 2, fillOpacity: .15 }).addTo(map);
            else { accuracyCircle.setLatLng([lat, lng]); accuracyCircle.setRadius(acc); }
        }

        if (!cityName) {
            fetchCity(lat, lng).then(c => {
                if (c) {
                    cityName = c;
                    const hat = $("header-app-title"); if (hat) hat.textContent = `${cityName} Tracker`;
                    const cnt = $("city-name-text"); if (cnt) cnt.textContent = cityName;
                    else { const pc = $("pill-city"); if (pc) pc.innerHTML = `<svg class="i"><use href="#i-pin"/></svg><span>${cityName}</span>`; }
                }
            });
        }

        if (!myWeather || Date.now() - lastWeatherFetch > 180000) {
            fetchWeather(lat, lng).then(w => {
                if (w) {
                    myWeather = w;
                    lastWeatherFetch = Date.now();
                    const mtd = $("map-temp-display"); if (mtd) mtd.textContent = w;
                    // Step 2 gave #top-weather a child #top-weather-text so the
                    // pill's icon survives updates — setting textContent on the
                    // container directly (the old behavior) would wipe the icon.
                    const twt = $("top-weather-text");
                    if (twt) { safeShow("top-weather", "flex"); twt.textContent = w; }
                    else { const tw = $("top-weather"); if (tw) { safeShow("top-weather", "flex"); tw.textContent = w; } }

                    const badgeText = alt !== null ? `${w} | ⛰️${alt}m` : w;
                    if (ownMarker) ownMarker.unbindTooltip().bindTooltip(badgeText, { permanent: true, direction: "right", className: "weather-badge", offset: [15, 0] });
                }
            });
        }

        // The verdict carries the real accuracy/dt/distance from the last GOOD fix.
        SmartDrive.tick(fix);

        socket.emit("updateLocation", { lat, lng, alt, speedKmh, accuracy: acc, weather: myWeather });
        updateFriendBadges();

        if (typeof triggerGroupRouteUpdate === 'function') triggerGroupRouteUpdate();
        if (typeof GroupNavigation !== 'undefined') GroupNavigation.onLiveUpdate();
    };

    let lastGpsErrorToast = 0;
    const handleGpsError = (e) => {
        console.warn("GPS error", e);
        if (e.code === 1) { showToast("⚠️ GPS Permission Denied! Please enable location.", 6000); return; }
        // Phase 4: while tunnel mode is estimating, the island already says
        // GPS is gone — a toast every 15 s on top of it is noise. Otherwise
        // at most one "weak signal" toast a minute.
        if (DeadReckoning.core && DeadReckoning.core.active()) return;
        if (Date.now() - lastGpsErrorToast < 60000) return;
        lastGpsErrorToast = Date.now();
        showToast("⚠️ GPS Signal Lost or Weak. Trying again...", 4000);
    };

    navigator.geolocation.getCurrentPosition(processLocation, (e) => { console.warn("Fast GPS fetch failed", e); }, { enableHighAccuracy: false, timeout: 7000, maximumAge: Infinity });
    navigator.geolocation.watchPosition(processLocation, handleGpsError, { enableHighAccuracy: true, timeout: 15000, maximumAge: 2000 });
}

function updateFriendBadges() {
    Object.keys(friendMarkers).forEach(id => {
        const f = friendData[id], m = friendMarkers[id]; if (!f || !m) return;
        let text;
        if (f.online === false && f.via === "radio" && friendIsLive(f)) text = `📻 via radio · ${agoText(f.fixAt || f.viaAt)}`;
        else text = f.online === false ? "Offline" : (f.approx ? "📶 Approx. location" : f.weather);
        if (f.est && Number.isFinite(f.accuracy)) text += `${text ? " | " : ""}≈ ±${formatDistanceShort(f.accuracy)}`;
        if (f.alt) text += ` | ⛰️${f.alt}m`;
        if (myCoords && validCoord(f.lat, f.lng)) text += ` | 📍 ${distanceKm(myCoords.lat, myCoords.lng, f.lat, f.lng)} km away`;
        m.unbindTooltip(); if (text) m.bindTooltip(text, { permanent: true, direction: "right", className: "weather-badge", offset: [15, 0] });
    });
}

socket.on("onlineUsers", list => { if (Array.isArray(list)) list.forEach(u => { if (u.id !== socket.id) { friendData[u.id] = { ...(friendData[u.id] || {}), ...u, online: true }; createOrUpdateFriendMarker(u); } }); updateOnlineUI(); });
socket.on("userOnline", u => { if (u.id !== socket.id) { friendData[u.id] = { ...(friendData[u.id] || {}), ...u, online: true }; createOrUpdateFriendMarker(u); } updateOnlineUI(); });
socket.on("userOffline", d => { if (d?.id && friendData[d.id]) { friendData[d.id].online = false; if (friendMarkers[d.id]) friendMarkers[d.id].setOpacity(0.45); } updateOnlineUI(); });
socket.on("friendMoved", u => {
    // Fixed: trip start/join re-broadcasts the rider's own state to EVERYONE
    // (server broadcastUserState), and this handler used to add YOU to your
    // own friend list — a second marker, "you" in the online list.
    if (!u?.id || u.id === socket.id) return;
    if (u.lat == null || u.lng == null) {                         // sharing set to "off" — remove the marker, don't misplace it
        if (friendMarkers[u.id]) { map.removeLayer(friendMarkers[u.id]); delete friendMarkers[u.id]; }
        removeFriendAccuracy(u.id);
        friendData[u.id] = { ...(friendData[u.id] || {}), ...u, online: u.online !== false };
        updateOnlineUI();
        return;
    }
    // Phase 4: a radio-relayed position (their socket is gone) is not "online";
    // one older than what we already show (e.g. heard first over our own
    // radio) is dropped.
    const cur = friendData[u.id];
    if (u.via === "radio" && cur && Number.isFinite(cur.fixAt) && Number.isFinite(u.fixAt) && u.fixAt <= cur.fixAt) return;
    createOrUpdateFriendMarker({ ...u, online: u.via !== "radio" });
    updateOnlineUI();
    if (typeof triggerGroupRouteUpdate === 'function') triggerGroupRouteUpdate();
});
socket.on("friendDisconnected", id => { if (friendMarkers[id]) { map.removeLayer(friendMarkers[id]); delete friendMarkers[id]; } removeFriendAccuracy(id); delete friendData[id]; updateOnlineUI(); });

// Phase 4: dashed uncertainty ring for a friend whose position is an estimate.
const friendAccuracyCircles = Object.create(null);
function removeFriendAccuracy(id) {
    if (friendAccuracyCircles[id]) { map.removeLayer(friendAccuracyCircles[id]); delete friendAccuracyCircles[id]; }
}

function createOrUpdateFriendMarker(u) {
    if (!u?.id || !validCoord(u.lat, u.lng)) return;
    const prev = friendData[u.id] || {};
    const via = u.via === "radio" ? "radio" : null;
    friendData[u.id] = {
        id: u.id, name: u.name || prev.name || "Friend", avatar: u.avatar || prev.avatar || DEFAULT_AVATAR, lat: u.lat, lng: u.lng, alt: u.alt,
        speedKmh: u.speedKmh, weather: u.weather || "", online: u.online !== false, approx: Boolean(u.approx),
        // Phase 4 — kept so the radio relay can find this rider by ownerKey,
        // and so the UI can say how the position was obtained.
        ownerKey: u.ownerKey || prev.ownerKey || null,
        accuracy: Number.isFinite(u.accuracy) ? u.accuracy : null, est: Boolean(u.est), via,
        viaAt: via ? Date.now() : null, fixAt: Number.isFinite(u.fixAt) ? u.fixAt : null,
        relayedBy: via ? (u.relayedBy || null) : null, updatedAt: Date.now()
    };
    const f = friendData[u.id];
    const opacity = f.online ? 1 : via ? 0.9 : 0.45;
    let m = friendMarkers[u.id];
    // Fixed: the click handler used to capture `u` at creation, so the popup
    // showed the rider's FIRST position/status forever. Read the live record.
    if (!m) { m = L.marker([u.lat, u.lng], { icon: friendIcon(f.avatar) }).addTo(map); m.on("click", () => showProfilePopup(friendData[u.id] || u)); friendMarkers[u.id] = m; }
    else { m.setLatLng([u.lat, u.lng]); }
    m.setIcon(friendIcon(f.avatar));
    m.setOpacity(opacity);
    const el = m.getElement ? m.getElement() : null;
    if (el) {
        el.classList.toggle("approx-marker", f.approx);
        el.classList.toggle("est-marker", f.est);
        el.classList.toggle("radio-marker", Boolean(via));
    }
    if (f.est && Number.isFinite(f.accuracy) && f.accuracy >= 30) {
        if (!friendAccuracyCircles[u.id]) friendAccuracyCircles[u.id] = L.circle([u.lat, u.lng], { radius: f.accuracy, color: "#ff9f0a", weight: 1.5, dashArray: "5 6", fillOpacity: 0.05, interactive: false }).addTo(map);
        else { friendAccuracyCircles[u.id].setLatLng([u.lat, u.lng]); friendAccuracyCircles[u.id].setRadius(f.accuracy); }
    } else removeFriendAccuracy(u.id);
    updateFriendBadges();
}

function updateOnlineUI() {
    const cs = $("chat-subtitle"); if (cs) cs.textContent = `${currentUser.name ? 1 : 0} online`;
    const box = $("online-list"); if (!box) return; box.innerHTML = "";
    Object.values(friendData).filter(f => friendIsLive(f)).forEach(u => {
        const btn = document.createElement("button"); btn.className = "online-friend";
        const radio = u.online === false;   // live only via the radio relay
        btn.innerHTML = `<img src="${escapeHTML(u.avatar)}"><span><b>${escapeHTML(u.name)}</b>${radio ? " <small>📻 radio</small>" : ""}</span><div class="status-dot${radio ? " radio" : ""}"></div>`;
        btn.onclick = () => { if (validCoord(u.lat, u.lng)) map.flyTo([u.lat, u.lng], 16); showProfilePopup(u); }; box.appendChild(btn);
    });
}

function showProfilePopup(u) {
    const ppa = $("profile-popup-avatar"); if (ppa) ppa.src = u.avatar;
    const ppn = $("profile-popup-name"); if (ppn) ppn.textContent = u.name;
    const st = $("profile-popup-status");
    if (st) {
        const radio = u.online === false && friendIsLive(u);
        st.textContent = u.online !== false
            ? (u.approx ? "● Approx. location" : u.est ? `● Estimated position (±${formatDistanceShort(u.accuracy || 0)})` : "● Online")
            : radio ? `● Via radio relay · ${agoText(u.fixAt || u.viaAt)}` : "● Offline";
        st.style.color = u.online !== false ? "#18d6a3" : radio ? "#ff9f0a" : "#8fa1aa";
    }
    const ppd = $("profile-popup-distance");
    if (ppd) ppd.textContent = (myCoords && validCoord(u.lat, u.lng)) ? `${distanceKm(myCoords.lat, myCoords.lng, u.lat, u.lng)} km away` : "--";
    const ppw = $("profile-popup-weather");
    if (ppw) ppw.textContent = u.weather || "--";

    const pnb = $("profile-nav-btn");
    if (pnb) {
        pnb.onclick = () => {
            if (validCoord(u.lat, u.lng) && myCoords) {
                safeHide("profile-popup");
                RoutePrefs.fetchRoute(`https://router.project-osrm.org/route/v1/driving/${myCoords.lng},${myCoords.lat};${u.lng},${u.lat}?steps=true&geometries=geojson&overview=full`)
                    .then(data => {
                        if (data.routes && data.routes.length > 0) {
                            startSearchNavigation(u.lat, u.lng, u.name, data.routes[0]);
                        }
                    });
            } else if (!validCoord(u.lat, u.lng)) {
                showToast("This rider's exact location isn't shared right now.");
            }
        };
    }

    if (typeof initCallButton === "function") initCallButton(u);

    // Phase 5: live relative-motion line (features.js keeps it fresh while open).
    const pp = $("profile-popup");
    if (pp) pp.dataset.friendId = u.id || "";
    if (window.Phase5UI) window.Phase5UI.fillPopup(u.id);

    safeShow("profile-popup", "flex");
    const fb = $("profile-focus-btn");
    if (fb) fb.onclick = () => { if (validCoord(u.lat, u.lng)) map.flyTo([u.lat, u.lng], 16); safeHide("profile-popup"); };
}
const ppc = $("profile-popup-close");
if (ppc) ppc.addEventListener("click", () => safeHide("profile-popup"));

function renderGeofenceList() {
    const list = $("geofence-items"); if (!list) return; list.innerHTML = "";
    if (currentGeofences.length === 0) {
        list.innerHTML = "<div style='color:var(--muted); font-size:12px; text-align:center;'>No active geofences.</div>";
    } else {
        currentGeofences.forEach(f => {
            // Ownership now comes from the server as ownerKey (a per-device HMAC),
            // which survives reconnects — the old ownerId===socket.id check broke
            // on every reconnect since socket ids aren't stable.
            const isOwner = f.ownerKey && f.ownerKey === myOwnerKey;
            const actionBtn = isOwner
                ? `<button data-remove-geofence="${escapeHTML(f.id)}" style="background:rgba(239, 68, 68, 0.2); color:#ef4444; border:none; padding:6px 12px; border-radius:8px; font-weight:bold; font-size:11px; cursor:pointer;">Remove</button>`
                : `<span style="font-size:10px; color:var(--muted); font-weight:bold;">Owner: ${escapeHTML(f.ownerName || "Someone")}</span>`;

            list.innerHTML += `
            <div style="display:flex; justify-content:space-between; align-items:center; background:rgba(255,255,255,0.05); padding:10px; border-radius:10px; margin-bottom:8px;">
                <div><div style="color:white; font-size:13px; font-weight:bold;">${escapeHTML(f.name)}</div><div style="color:var(--muted); font-size:11px;">Radius: ${f.radius}m</div></div>${actionBtn}
            </div>`;
        });
        list.querySelectorAll("[data-remove-geofence]").forEach((btn) => {
            btn.addEventListener("click", () => socket.emit("removeGeofence", btn.dataset.removeGeofence));
        });
    }
    const modal = $("geofence-list-modal"); if (modal) modal.style.display = "flex";
}
const gflc = $("geofence-list-close");
if (gflc) gflc.addEventListener("click", () => safeHide("geofence-list-modal"));

// myOwnerKey (declared in part 1) is set from profileAccepted — the server's
// stable, non-reversible per-device tag, so "is this mine?" survives socket
// reconnects, unlike the old ownerId===socket.id check.

let followMe = false;
function setFollowMe(on, { quiet = false } = {}) {
    followMe = Boolean(on);
    const b = $("compass-btn");
    if (b) { b.setAttribute("aria-pressed", followMe ? "true" : "false"); b.title = followMe ? "Following you — tap to stop" : "Follow me"; }
    if (!quiet) islandShow({ id: "follow", kind: "info", icon: "➤", title: followMe ? "Following you" : "Follow off", sub: followMe ? "Drag the map to stop" : "", ttl: 2500, haptic: false });
}
function followIfOn(lat, lng) {
    if (followMe && !navState.active && validCoord(lat, lng)) map.panTo([lat, lng], { animate: true });
}

function setupBasicControlsSafe() {
    const locBtn = $("my-location-btn");
    if (locBtn) locBtn.onclick = () => {
        if (myCoords) map.flyTo([myCoords.lat, myCoords.lng], 16, { animate: true, duration: .8 });
        else showToast("📍 Waiting for GPS location...");
    };

    // "Follow me" (was a compass whose "reset bearing" did nothing — this
    // map never rotates). On: the map re-centres on every new position (GPS
    // or tunnel-mode estimate). Dragging the map turns it off, as in any
    // navigation app. Navigation keeps its own camera, so it's skipped there.
    const compassBtn = $("compass-btn");
    if (compassBtn) compassBtn.onclick = () => {
        setFollowMe(!followMe);
        if (followMe && myCoords) map.flyTo([myCoords.lat, myCoords.lng], Math.max(map.getZoom(), 16), { animate: true, duration: .8 });
        else if (followMe) showToast("📍 Waiting for GPS location...");
    };
    map.on("dragstart", () => { if (followMe) setFollowMe(false, { quiet: true }); });

    // Tool rail: fade the bottom edge while more buttons are scrolled out of view.
    const rail = $("map-tools");
    if (rail) {
        const updateRailFade = () => rail.classList.toggle("more-below", rail.scrollTop + rail.clientHeight < rail.scrollHeight - 4);
        rail.addEventListener("scroll", updateRailFade, { passive: true });
        window.addEventListener("resize", updateRailFade, { passive: true });
        setTimeout(updateRailFade, 0);
    }

    const styleBtn = $("map-style-btn");
    const sm = $("map-style-menu");
    if (styleBtn && sm) {
        styleBtn.onclick = e => {
            e.stopPropagation();
            const willOpen = sm.style.display !== "flex";
            sm.style.display = willOpen ? "flex" : "none";
            styleBtn.setAttribute("aria-expanded", willOpen ? "true" : "false");
        };
        sm.onclick = e => {
            const b = e.target.closest("[data-style]"); if (!b) return;
            const s = b.dataset.style;
            [satelliteLayer, streetLayer, darkLayer, terrainLayer].forEach(l => {
                if (map.hasLayer(l)) map.removeLayer(l);
            });
            const layers = { satellite: satelliteLayer, street: streetLayer, dark: darkLayer, terrain: terrainLayer };
            if (layers[s]) layers[s].addTo(map);
            document.querySelectorAll("#map-style-menu button").forEach(x => { const active = x.dataset.style === s; x.classList.toggle("active", active); x.setAttribute("aria-checked", active ? "true" : "false"); });
            safeHide("map-style-menu");
        };
    }


    window.addEventListener("offline", () => showToast("📶 You are offline. Data saved locally."));
    window.addEventListener("online", () => {
        showToast("📶 Back online!");
        if (offlineMessageQueue.length) {
            offlineMessageQueue.forEach(msg => socket.emit("chatMessage", msg));
            offlineMessageQueue = [];
        }
        if (typeof offlineMemoryQueue !== "undefined" && offlineMemoryQueue.length) {
            offlineMemoryQueue.forEach(mem => socket.emit("uploadMemoryPhoto", mem));
            offlineMemoryQueue = [];
        }
    });

    // Battery: don't run the chat's typing-indicator/presence chatter while
    // the tab is hidden (roadmap Section 24).
    document.addEventListener("visibilitychange", () => {
        if (document.visibilityState === "hidden") { clearTimeout(typingTimerRef.id); socket.emit("typing", false); }
    });
}

function clearActiveToolButtons(except) {
    ["measure-btn", "geofence-btn", "trip-btn", "group-nav-btn"].forEach((id) => { if (id !== except) { const b = $(id); if (b) b.classList.remove("active-tool"); } });
}

function setupAdvancedToolsSafe() {
    const mb = $("measure-btn");
    if (mb) mb.onclick = () => {
        mapActionMode = mapActionMode === 'measure' ? null : 'measure';
        mb.classList.toggle("active-tool", mapActionMode === 'measure');
        clearActiveToolButtons("measure-btn");
        if (mapActionMode !== 'measure') {
            measureLayer.clearLayers();
            measurePoints = [];
            const mr = $("measure-result-panel"); if (mr) mr.style.display = "none";
        }
        else showToast("📍 Tap two points on the map to measure road distance");
    };

    const gb = $("geofence-btn");
    if (gb) gb.onclick = () => {
        geoClickCount++;
        if (geoClickCount === 3) {
            clearTimeout(geoClickTimer); geoClickCount = 0; renderGeofenceList(); return;
        }
        clearTimeout(geoClickTimer);
        geoClickTimer = setTimeout(() => {
            geoClickCount = 0; mapActionMode = mapActionMode === 'geofence' ? null : 'geofence';
            gb.classList.toggle("active-tool", mapActionMode === 'geofence');
            clearActiveToolButtons("geofence-btn");
            if (mapActionMode === 'geofence') showToast("⭕ Tap map to set Geofence. (Tap button 3 times to view/delete)");
        }, 900);
    };

    const tb = $("trip-btn");
    if (tb) tb.onclick = () => {
        mapActionMode = mapActionMode === 'trip' ? null : 'trip';
        tb.classList.toggle("active-tool", mapActionMode === 'trip');
        clearActiveToolButtons("trip-btn");
        if (mapActionMode === 'trip') showToast("🚗 Tap the map to set Group Trip Destination");
    };

    const gnb = $("group-nav-btn");
    if (gnb) gnb.onclick = () => {
        mapActionMode = mapActionMode === 'group-nav' ? null : 'group-nav';
        gnb.classList.toggle("active-tool", mapActionMode === 'group-nav');
        clearActiveToolButtons("group-nav-btn");
        if (mapActionMode === 'group-nav') { if (typeof GroupNavigation !== 'undefined') GroupNavigation.openSetup(); }
        else safeHide("group-nav-setup");
    };

    const gNCB = $("group-nav-close-btn");
    if (gNCB) gNCB.onclick = () => { safeHide("group-nav-setup"); mapActionMode = null; const btn = $("group-nav-btn"); if (btn) btn.classList.remove("active-tool"); };

    const gNNB = $("group-nav-next-btn");
    if (gNNB) gNNB.onclick = () => { if (typeof GroupNavigation !== 'undefined') GroupNavigation.startSelection(); };

    const gNSB = $("group-nav-stop-btn");
    if (gNSB) gNSB.onclick = () => { if (typeof GroupNavigation !== 'undefined') GroupNavigation.stop(); };

    map.on('click', (e) => {
        if (mapActionMode === 'measure') {
            measurePoints.push(e.latlng);
            L.circleMarker(e.latlng, { color: '#f59e0b', radius: 5, fillOpacity: 1 }).addTo(measureLayer);

            if (measurePoints.length === 2) {
                const p1 = measurePoints[0], p2 = measurePoints[1];
                showToast("📏 Calculating road distance...", 2000);

                RoutePrefs.fetchRoute(`https://router.project-osrm.org/route/v1/driving/${p1.lng},${p1.lat};${p2.lng},${p2.lat}?overview=full&geometries=geojson&alternatives=true`)
                    .then(data => {
                        measureLayer.clearLayers();
                        if (data.routes && data.routes.length > 0) {
                            const r = data.routes.reduce((a, b) => b.distance < a.distance ? b : a, data.routes[0]);
                            const coords = r.geometry.coordinates.map(c => [c[1], c[0]]);
                            L.polyline(coords, { color: '#f59e0b', weight: 6, className: 'nav-path-animated' }).addTo(measureLayer);
                            L.marker(p1, { icon: L.divIcon({ className: 'measure-point', html: 'A', iconSize: [24, 24], iconAnchor: [12, 12] }) }).addTo(measureLayer);
                            L.marker(p2, { icon: L.divIcon({ className: 'measure-point', html: 'B', iconSize: [24, 24], iconAnchor: [12, 12] }) }).addTo(measureLayer);

                            const distKm = (r.distance / 1000).toFixed(2);
                            const timeMin = Math.max(1, Math.round(r.duration / 60));

                            let panel = $("measure-result-panel");
                            if (!panel) {
                                panel = document.createElement("div");
                                panel.id = "measure-result-panel";
                                panel.style.cssText = "position:fixed;left:50%;bottom:72px;transform:translateX(-50%);z-index:4500;background:rgba(10,17,28,.96);border:1px solid rgba(255,255,255,.14);border-radius:16px;padding:12px 16px;color:#fff;box-shadow:0 15px 40px rgba(0,0,0,.45);font-size:13px;text-align:center;min-width:220px;";
                                document.body.appendChild(panel);
                            }
                            panel.innerHTML = `<b style="color:#f59e0b">📏 Shortest road route</b><br><strong>${distKm} km</strong> &nbsp;•&nbsp; <strong>${timeMin} min</strong>`;
                            panel.style.display = "block";
                            showToast(`📏 Shortest: ${distKm} km • ⏱️ ${timeMin} min`, 5000);
                        } else showToast("❌ Road route unavailable. Try again.");
                    }).catch(() => showToast("❌ Road route unavailable. Try again."));
            }
        }
        else if (mapActionMode === 'geofence') {
            const name = prompt("Enter Geofence Name:");
            if (name && name.trim()) {
                const radius = Number(prompt("Enter Radius in meters (10 to 50000):", "500"));
                if (Number.isFinite(radius) && radius >= 10 && radius <= 50000) { socket.emit("addGeofence", { name: name.trim(), lat: e.latlng.lat, lng: e.latlng.lng, radius: radius }); showToast(`⭕ Geofence created!`); }
            }
            mapActionMode = null; const gb2 = $("geofence-btn"); if (gb2) gb2.classList.remove("active-tool");
        }
        else if (mapActionMode === 'trip') {
            const name = prompt("Enter Trip Destination Name:");
            if (name && name.trim()) { socket.emit("startTrip", { name: name.trim(), lat: e.latlng.lat, lng: e.latlng.lng }); showToast(`🚗 Trip started!`); }
            mapActionMode = null; const tb2 = $("trip-btn"); if (tb2) tb2.classList.remove("active-tool");
        }
        else if (mapActionMode === 'memory') {
            if (pendingMemoryImage) {
                const payload = { name: currentUser.name, lat: e.latlng.lat, lng: e.latlng.lng, image: pendingMemoryImage, time: new Date().toISOString() };
                if (navigator.onLine) { socket.emit("uploadMemoryPhoto", payload); showToast("✅ Memory pinned successfully!"); }
                else { offlineMemoryQueue.push(payload); showToast("📶 Offline: Memory saved. Will sync when reconnected."); }
            }
            mapActionMode = null; pendingMemoryImage = null;
        }
        else if (mapActionMode === 'group-nav') {
            if (typeof GroupNavigation !== 'undefined') {
                GroupNavigation.setDestination(e.latlng);
                mapActionMode = null;
            }
        }
        else if (mapActionMode === 'carpool-dest') {
            CarpoolPlanner.setDestination(e.latlng);
            mapActionMode = null;
        }
    });

    socket.on("loadGeofences", fences => {
        currentGeofences = fences;
        p4LayerGroup.eachLayer(l => { if (l.options?.isGeofence) map.removeLayer(l); });
        fences.forEach(f => {
            L.circle([f.lat, f.lng], { radius: f.radius, color: "#8b5cf6", weight: 2, fillOpacity: 0.1, isGeofence: true }).addTo(p4LayerGroup);
            L.marker([f.lat, f.lng], { icon: L.divIcon({ className: 'geofence-marker', html: '📍' }), isGeofence: true }).bindTooltip(f.name, { permanent: true, direction: "top", className: "weather-badge" }).addTo(p4LayerGroup);
        });
        const geoModal = $("geofence-list-modal"); if (geoModal && geoModal.style.display === "flex") renderGeofenceList();
    });

    socket.on("tripData", trip => {
        currentTrip = trip;
        if (tripMarker) { map.removeLayer(tripMarker); tripMarker = null; }
        if (trip) {
            safeShow("trip-panel", "flex");
            const tt = $("trip-title"); if (tt) tt.textContent = `Trip to ${trip.name}`;
            tripMarker = L.marker([trip.lat, trip.lng], { icon: L.divIcon({ className: 'geofence-marker', html: '🏁' }) }).addTo(map);

            const isMember = trip.members.some(m => m.id === socket.id);
            const isHost = trip.hostId === socket.id;
            const actionBtn = $("trip-action-btn");

            if (actionBtn) {
                if (isHost) {
                    actionBtn.textContent = "End Trip"; actionBtn.style.color = "#ef4444"; actionBtn.style.background = "rgba(239, 68, 68, 0.2)";
                    actionBtn.onclick = () => { if (typeof SmartDrive != "undefined" && SmartDrive.trip.active) SmartDrive.endTrip(); socket.emit("leaveTrip"); };
                } else if (isMember) {
                    actionBtn.textContent = "Leave Trip"; actionBtn.style.color = "#f59e0b"; actionBtn.style.background = "rgba(245, 158, 11, 0.2)";
                    actionBtn.onclick = () => { if (typeof SmartDrive != "undefined" && SmartDrive.trip.active) SmartDrive.endTrip(); socket.emit("leaveTrip"); };
                } else {
                    actionBtn.textContent = "Join Trip"; actionBtn.style.color = "#10b981"; actionBtn.style.background = "rgba(16, 185, 129, 0.2)"; actionBtn.onclick = () => socket.emit("joinTrip");
                }
            }
            if (typeof SmartDrive !== "undefined" && isMember && !SmartDrive.trip.active) SmartDrive.startTrip();
            if (typeof triggerGroupRouteUpdate === 'function') triggerGroupRouteUpdate();
            if (window.TripChecklist) window.TripChecklist.render();
        } else {
            if (typeof SmartDrive !== "undefined" && SmartDrive.trip.active) SmartDrive.endTrip();
            tripRoutesLayer.clearLayers(); tripRoadStats = {}; safeHide("trip-panel");
        }
    });
}

// ==========================================
// CHAT
// ==========================================
const typingTimerRef = { id: null };

function setupChatSafe() {
    const cc = $("chat-container"), inp = $("chatInput"), send = $("chat-send"), vb = $("voiceButton");
    const emojis = ["👍", "❤️", "😂", "😮", "😢", "🔥"];
    const msgStore = new Map();
    let unread = 0, replyTo = null, reactingId = null;

    function updateUnreadBadge() { const b = $("chat-unread-badge"); if (b) { b.textContent = unread > 99 ? "99+" : unread; b.style.display = unread > 0 ? "flex" : "none"; } }

    const ctb = $("chat-toggle-btn");
    if (ctb) ctb.onclick = () => { safeShow("chat-container", "flex"); safeHide("chat-toggle-btn"); unread = 0; updateUnreadBadge(); if (inp) inp.focus(); };

    const cmb = $("chat-minimize-btn");
    if (cmb) cmb.onclick = () => { safeHide("chat-container"); safeShow("chat-toggle-btn", "flex"); };

    const ob = $("online-btn");
    if (ob) ob.onclick = (e) => { e.stopPropagation(); const l = $("online-list"); if (l) l.style.display = l.style.display === "flex" ? "none" : "flex"; updateOnlineUI(); };

    document.addEventListener("click", e => {
        const ol = $("online-list");
        const obtn = $("online-btn");
        if (ol && obtn && !ol.contains(e.target) && e.target !== obtn) safeHide("online-list");
    });

    if (inp) {
        inp.oninput = () => { socket.emit("typing", true); clearTimeout(typingTimerRef.id); typingTimerRef.id = setTimeout(() => socket.emit("typing", false), 1200); if (send && vb) { send.style.display = inp.value.trim() ? "flex" : "none"; vb.style.display = inp.value.trim() ? "none" : "flex"; } };
    }
    socket.on("typing", d => { const t = $("typing-indicator"); if (t) { if (d.id !== socket.id && d.isTyping) { t.textContent = `${escapeHTML(d.name)} is typing…`; t.style.display = "block"; } else t.style.display = "none"; } });

    const rc = $("reply-cancel"); if (rc) rc.onclick = () => { replyTo = null; safeHide("reply-bar"); };

    const eb = $("emojiButton"); if (eb) eb.onclick = (e) => { e.stopPropagation(); safeHide("attachment-menu"); const ec = $("emoji-picker-container"); if (ec) ec.style.display = ec.style.display === "block" ? "none" : "block"; };

    const ep = $("emojiPicker");
    if (ep) { ep.addEventListener("emoji-click", e => { const em = e.detail.unicode; if (reactingId) { socket.emit("messageReaction", { messageId: reactingId, emoji: em }); safeHide("emoji-picker-container"); reactingId = null; } else if (inp) { inp.value += em; inp.focus(); if (send) send.style.display = "flex"; if (vb) vb.style.display = "none"; } }); }

    const cab = $("chat-attach-btn"); if (cab) cab.onclick = (e) => { e.stopPropagation(); safeHide("emoji-picker-container"); const am = $("attachment-menu"); if (am) am.style.display = am.style.display === "flex" ? "none" : "flex"; };

    const fInp = $("chatFileInput");
    const atm = $("att-media"); if (atm) atm.onclick = () => { if (fInp) { fInp.accept = "image/*,video/*"; fInp.click(); safeHide("attachment-menu"); } };
    const atd = $("att-doc"); if (atd) atd.onclick = () => { if (fInp) { fInp.accept = ".pdf,.doc,.txt,.zip"; fInp.click(); safeHide("attachment-menu"); } };
    const ata = $("att-audio"); if (ata) ata.onclick = () => { if (fInp) { fInp.accept = "audio/*"; fInp.click(); safeHide("attachment-menu"); } };

    if (fInp) {
        fInp.onchange = () => {
            const f = fInp.files?.[0]; if (!f) return; const r = new FileReader(); r.onload = () => {
                const payload = { name: currentUser.name, type: f.type.split('/')[0] === "image" ? "image" : f.type.split('/')[0] === "video" ? "video" : f.type.split('/')[0] === "audio" ? "audio" : "document", data: r.result, replyTo };
                if (navigator.onLine) socket.emit("chatMessage", payload);
                else { offlineMessageQueue.push(payload); showToast("📶 Offline: Message queued"); }
                const rcb = $("reply-cancel"); if (rcb) rcb.click();
            }; r.readAsDataURL(f); fInp.value = "";
        };
    }

    const cForm = $("chatForm");
    if (cForm) {
        cForm.onsubmit = e => {
            e.preventDefault(); if (!inp) return;
            const t = inp.value.trim();
            if (t) {
                const payload = { name: currentUser.name, type: "text", data: t, replyTo };
                if (navigator.onLine) socket.emit("chatMessage", payload);
                else { offlineMessageQueue.push(payload); showToast("📶 Offline: Message queued"); }
                inp.value = ""; const rcb = $("reply-cancel"); if (rcb) rcb.click(); if (send) send.style.display = "none"; if (vb) vb.style.display = "flex"; inp.focus();
            }
        };
    }

    function renderMsg(m) {
        if (msgStore.has(m.id)) return;
        const w = document.createElement("div"); w.className = "chat-row " + (m.senderId === socket.id ? "mine" : "");
        const b = document.createElement("div"); b.className = "chat-message " + (m.senderId === socket.id ? "msg-mine" : "msg-theirs");
        if (m.senderId !== socket.id) b.innerHTML += `<div class="msg-sender">${escapeHTML(m.name)}</div>`;
        if (m.replyTo) b.innerHTML += `<div class="reply-quote"><b>${escapeHTML(m.replyTo.name)}</b><br>${escapeHTML(m.replyTo.preview)}</div>`;

        if (m.type === "text") b.innerHTML += `<div style="word-wrap:break-word;word-break:break-word;">${escapeHTML(m.data)}</div>`;
        else if (m.type === "image") b.innerHTML += `<img class="chat-media" src="${m.data}">`;
        else if (m.type === "video") b.innerHTML += `<video class="chat-media" controls src="${m.data}"></video>`;
        else if (m.type === "audio") b.innerHTML += `<audio class="chat-audio" controls src="${m.data}"></audio>`;
        else if (m.type === "document") b.innerHTML += `<a class="chat-document" href="${m.data}" download>📄 Download File</a>`;

        b.innerHTML += `<div class="message-meta">${new Date(m.time).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</div>`;

        const a = document.createElement("div"); a.className = "message-actions";
        emojis.forEach(e => { const btn = document.createElement("button"); btn.className = "action-btn"; btn.textContent = e; btn.onclick = () => socket.emit("messageReaction", { messageId: m.id, emoji: e }); a.appendChild(btn); });
        const rep = document.createElement("button"); rep.className = "action-btn"; rep.textContent = "↩ Reply"; rep.onclick = () => { replyTo = { id: m.id, name: m.name, type: m.type, preview: m.type === "text" ? m.data.slice(0, 50) : "Attachment" }; const rp = $("reply-preview"); if (rp) rp.textContent = `↩ ${m.name}`; safeShow("reply-bar", "flex"); if (inp) inp.focus(); }; a.appendChild(rep);
        b.appendChild(a); const rr = document.createElement("div"); rr.className = "reaction-row"; b.appendChild(rr); w.appendChild(b);

        const chatMsgs = $("chat-messages");
        if (chatMsgs) { chatMsgs.appendChild(w); chatMsgs.scrollTop = chatMsgs.scrollHeight; }
        msgStore.set(m.id, { msg: m, el: w });
        if (m.senderId !== socket.id && cc && cc.style.display !== "flex") { unread++; updateUnreadBadge(); }
    }
    socket.on("chatHistory", l => l.forEach(renderMsg)); socket.on("chatMessage", renderMsg);
    socket.on("messageReaction", (data) => {
        const entry = msgStore.get(data.messageId); if (!entry) return;
        const rr = entry.el.querySelector(".reaction-row"); if (!rr) return;
        rr.innerHTML = "";
        Object.entries(data.reactions || {}).forEach(([emoji, ids]) => {
            if (!ids || ids.length === 0) return;
            const chip = document.createElement("span"); chip.textContent = `${emoji} ${ids.length}`;
            chip.style.cssText = "background:rgba(255,255,255,.08);border-radius:10px;padding:2px 7px;margin-right:4px;";
            rr.appendChild(chip);
        });
    });
}

// ==========================================
// MEMORIES — canvas downscale + JPEG compress before upload
// ==========================================
function setupMemoriesSafe() {
    const pgb = $("phase3-gallery-btn");
    if (pgb) pgb.onclick = () => { safeShow("phase3-memory-overlay", "block"); renderMemGallery(); };
    const pmc = $("phase3-memory-close");
    if (pmc) pmc.onclick = () => safeHide("phase3-memory-overlay");
    const pvc = $("p3-view-close");
    if (pvc) pvc.onclick = () => safeHide("phase3-photo-viewer");

    document.querySelectorAll(".phase3-filter").forEach(b => {
        b.onclick = () => { document.querySelectorAll(".phase3-filter").forEach(x => x.classList.remove("active")); b.classList.add("active"); currentGalleryFilter = b.dataset.filter; renderMemGallery(); };
    });

    const pms = $("phase3-memory-search");
    if (pms) pms.oninput = e => { currentGallerySearch = e.target.value.toLowerCase(); renderMemGallery(); };

    const pvf = $("p3-view-focus");
    if (pvf) pvf.onclick = () => { const m = memories.get(selectedMemoryId); if (m) map.flyTo([m.lat, m.lng], 17); safeHide("phase3-photo-viewer"); safeHide("phase3-memory-overlay"); };

    function openViewer(m) {
        selectedMemoryId = m.id;
        const pvi = $("p3-view-image"); if (pvi) pvi.src = m.image;
        const pvn = $("p3-view-name"); if (pvn) pvn.textContent = m.name;
        const pvd = $("p3-view-date"); if (pvd) pvd.textContent = new Date(m.time).toLocaleString();
        safeShow("phase3-photo-viewer", "flex");
    }

    function renderMemGallery() {
        let arr = Array.from(memories.values());
        if (currentGalleryFilter === "today") arr = arr.filter(m => new Date(m.time) >= new Date().setHours(0, 0, 0, 0));
        else if (currentGalleryFilter === "mine") arr = arr.filter(m => m.ownerKey && m.ownerKey === myOwnerKey);
        if (currentGallerySearch) arr = arr.filter(m => cleanName(m.name).toLowerCase().includes(currentGallerySearch));
        arr.sort((a, b) => new Date(b.time) - new Date(a.time));

        const pmc2 = $("phase3-memory-count"); if (pmc2) pmc2.textContent = `${arr.length} memories`;
        const grid = $("phase3-memory-grid"), time = $("phase3-timeline-list"), emp = $("phase3-memory-empty");
        if (grid) grid.innerHTML = ""; if (time) time.innerHTML = ""; if (emp) emp.style.display = arr.length ? "none" : "block";

        arr.forEach(m => {
            if (grid) {
                const c = document.createElement("div"); c.className = "p3-card";
                c.innerHTML = `<img src="${escapeHTML(m.image)}" loading="lazy"><div class="p3-card-info"><b>${escapeHTML(m.name)}</b><span>${new Date(m.time).toLocaleDateString()}</span></div>`;
                c.onclick = () => openViewer(m);
                grid.appendChild(c);
            }
            if (time) {
                const t = document.createElement("div"); t.className = "p3-time-item";
                t.innerHTML = `<div class="p3-time-thumb"><img src="${escapeHTML(m.image)}" loading="lazy"></div><div class="p3-time-info"><b>${escapeHTML(m.name)}</b><span>${new Date(m.time).toLocaleString()}</span></div>`;
                t.onclick = () => openViewer(m);
                time.appendChild(t);
            }
        });
    }

    function renderPins() {
        memoryLayer.clearLayers();
        memories.forEach(m => {
            const icon = L.divIcon({ className: "p3-memory-marker", html: `<div style="width:46px;height:46px;border-radius:50%;overflow:hidden;border:2px solid #fff;background:#071018;box-shadow:0 4px 15px rgba(0,0,0,.65)"><img src="${escapeHTML(m.image)}" style="width:100%;height:100%;object-fit:cover;"></div>`, iconSize: [46, 46], iconAnchor: [23, 23] });
            const marker = L.marker([m.lat, m.lng], { icon }).addTo(memoryLayer);
            marker.bindPopup(`<div class="p3-map-popup" style="width:220px; text-align:center;"><img src="${escapeHTML(m.image)}" style="width:100%; height:140px; object-fit:cover; border-radius:8px; margin-bottom:8px; box-shadow:0 4px 10px rgba(0,0,0,0.2);"><br><b style="color:var(--mint); font-size:14px;">📸 ${escapeHTML(m.name)}</b><br><small style="color:#aaa;">${new Date(m.time).toLocaleString()}</small><br><button class="p3-open-map-memory" style="margin-top:8px;padding:8px;width:100%;background:#34e0b4;color:#000;border:none;border-radius:6px;font-weight:bold;cursor:pointer;">View Detail</button></div>`);
            marker.on("popupopen", e => { const b = e.popup.getElement()?.querySelector(".p3-open-map-memory"); if (b) b.onclick = () => openViewer(m); });
        });
    }
    socket.on("loadMemoryPhotos", l => { memories.clear(); l.forEach(m => memories.set(m.id, m)); renderPins(); });
    socket.on("newMemoryPin", m => { memories.set(m.id, m); renderPins(); const pmo = $("phase3-memory-overlay"); if (pmo && pmo.style.display === "block") renderMemGallery(); });

    const mInp = $("memoryPhotoInput");
    const mb = $("memoryButton");
    if (mb) mb.onclick = () => { if (!currentUser.name) return showToast("❌ Please Join map first."); if (mInp) mInp.click(); };

    const addMemBtn = $("p3-add-memory-btn");
    if (addMemBtn) addMemBtn.onclick = () => { safeHide("phase3-memory-overlay"); setTimeout(() => { if (mInp) mInp.click(); }, 300); };

    if (mInp) {
        mInp.onchange = (e) => {
            const f = e.target.files?.[0];
            if (!f) return;
            if (!f.type.startsWith("image/") && !f.name.match(/\.(jpg|jpeg|png|gif|webp|heic)$/i)) {
                showToast("❌ Invalid format! Please select an image file.");
                mInp.value = "";
                return;
            }
            showToast("⏳ Processing high-quality photo...", 2000);
            const reader = new FileReader();
            reader.onload = (ev) => {
                const img = new Image();
                img.onload = () => {
                    const canvas = document.createElement("canvas");
                    const MAX_SIZE = 1000;
                    let w = img.width, h = img.height;
                    if (w > h && w > MAX_SIZE) { h *= MAX_SIZE / w; w = MAX_SIZE; }
                    else if (h > MAX_SIZE) { w *= MAX_SIZE / h; h = MAX_SIZE; }
                    canvas.width = w; canvas.height = h;
                    const ctx = canvas.getContext("2d");
                    ctx.drawImage(img, 0, 0, w, h);
                    pendingMemoryImage = canvas.toDataURL("image/jpeg", 0.7);
                    mapActionMode = 'memory';
                    showToast("✅ Photo Ready! TAP ANYWHERE on the map to pin it.", 6000);
                };
                img.onerror = () => {
                    pendingMemoryImage = ev.target.result;
                    mapActionMode = 'memory';
                    showToast("✅ Photo Ready! TAP ANYWHERE on the map to pin it.", 6000);
                };
                img.src = ev.target.result;
                mInp.value = "";
            };
            reader.readAsDataURL(f);
        };
    }
}

function setupJoin() {
    if (currentUser.name) {
        safeHide("join-screen");
        const hAv = $("header-avatar");
        if (hAv) { hAv.style.display = "block"; hAv.src = currentUser.avatar; }
        socket.emit("profileReady", { name: currentUser.name, avatar: currentUser.avatar, deviceId: DeviceIdentity.id, deviceToken: DeviceIdentity.token });
    }

    const jForm = $("join-form") || document.querySelector("form");

    const handleJoin = (e) => {
        if (e) e.preventDefault();

        const nInp = $("nameInput") || document.querySelector("input[type='text']");
        if (nInp && nInp.value.trim()) currentUser.name = cleanName(nInp.value);
        else currentUser.name = "Explorer";

        localStorage.setItem("koraput_name", currentUser.name);
        if (typeof TripDB !== "undefined") TripDB.saveSession(currentUser.name, null);

        const aInp = $("avatarInput") || document.querySelector("input[type='file']");
        const f = aInp ? aInp.files?.[0] : null;

        if (f) {
            const r = new FileReader();
            r.onload = () => {
                currentUser.avatar = r.result;
                localStorage.setItem("koraput_avatar", r.result);
                done();
            };
            r.readAsDataURL(f);
        } else {
            done();
        }
    };

    if (jForm) jForm.addEventListener("submit", handleJoin);

    function done() {
        safeHide("join-screen");
        const hAv2 = $("header-avatar");
        if (hAv2) { hAv2.style.display = "block"; hAv2.src = currentUser.avatar; }
        socket.emit("profileReady", { name: currentUser.name, avatar: currentUser.avatar, deviceId: DeviceIdentity.id, deviceToken: DeviceIdentity.token });
        if (typeof updateOnlineUI === 'function') updateOnlineUI();
    }
}

// ==========================================
// GOOGLE PLACES SEARCH  (unchanged — script tag kept per explicit instruction,
// secured via HTTP-referrer restriction in Google Cloud Console rather than a
// server-side proxy)
// ==========================================
function setupGoogleSearch() {
    const input = $("location-search-input");
    if (!input) return;
    const clearBtn = $("location-search-clear");

    const style = document.createElement('style');
    style.innerHTML = `
        .pac-container { background-color: rgba(10,17,28,0.98); border: 1px solid rgba(255,255,255,0.14); border-radius: 16px; box-shadow: 0 20px 50px rgba(0,0,0,0.5); margin-top: 10px; padding: 6px; font-family: 'Inter', sans-serif; z-index: 9999 !important; }
        .pac-item { color: #8b9bab; padding: 10px; border-top: 1px solid rgba(255,255,255,0.05); cursor: pointer; transition: 0.2s; }
        .pac-item:hover { background: rgba(52,224,180,0.1); }
        .pac-item-query { font-size: 15px; color: #fff; font-weight: 600; padding-right: 5px; }
        .pac-icon { display: none; }
        .pac-matched { color: #34e0b4; }
        .hdpi.pac-logo:after { display: none; }
    `;
    document.head.appendChild(style);

    const clearSearch = () => {
        input.value = "";
        if (clearBtn) clearBtn.style.display = "none";
        if (searchMarker) { map.removeLayer(searchMarker); searchMarker = null; }
        if (typeof searchLayer !== "undefined") searchLayer.clearLayers();
        if (typeof navigationLayer !== "undefined") navigationLayer.clearLayers();
        safeHide("premium-nav-ui");
        safeHide("nav-bottom-sheet");
        if (myCoords) map.flyTo([myCoords.lat, myCoords.lng], 16);
    };
    if (clearBtn) clearBtn.onclick = clearSearch;

    input.addEventListener('input', () => {
        if (clearBtn) clearBtn.style.display = input.value.length > 0 ? "block" : "none";
    });

    let searchLayer = L.layerGroup().addTo(map);

    const checkGoogle = setInterval(() => {
        if (window.google && window.google.maps && window.google.maps.places) {
            clearInterval(checkGoogle);

            const oldResultBox = document.getElementById("search-results-box");
            if (oldResultBox) oldResultBox.remove();

            const autocomplete = new google.maps.places.Autocomplete(input, {
                componentRestrictions: { country: "in" },
                fields: ["geometry", "name", "formatted_address"]
            });

            function updateSearchBounds() {
                const centerLat = myCoords ? myCoords.lat : map.getCenter().lat;
                const centerLng = myCoords ? myCoords.lng : map.getCenter().lng;
                const circle = new google.maps.Circle({
                    center: new google.maps.LatLng(centerLat, centerLng),
                    radius: 50000
                });
                autocomplete.setBounds(circle.getBounds());
                autocomplete.setOptions({ strictBounds: false });
            }

            input.addEventListener('focus', updateSearchBounds);
            map.on('moveend', updateSearchBounds);

            autocomplete.addListener("place_changed", () => {
                const place = autocomplete.getPlace();
                if (!place.geometry || !place.geometry.location) {
                    showToast("❌ Please select a location from the dropdown list.");
                    return;
                }

                const destLat = place.geometry.location.lat();
                const destLng = place.geometry.location.lng();
                const placeName = place.name;

                searchLayer.clearLayers();
                if (typeof navigationLayer !== "undefined") navigationLayer.clearLayers();
                safeHide("nav-panel");
                safeHide("nav-bottom-sheet");
                safeHide("premium-nav-ui");

                map.flyTo([destLat, destLng], 15);

                const popupContent = `
                    <div style="text-align:center; padding:6px; min-width:180px;">
                        <strong style="color:#065f46; font-size:16px; display:block; margin-bottom:8px;">📍 ${escapeHTML(placeName)}</strong>
                        <div id="search-route-info" style="font-size:13px; color:#333; margin-bottom:12px; background:#f3f4f6; padding:8px; border-radius:10px; border: 1px solid #ccc;">
                            <i>Calculating route... ⏳</i>
                        </div>
                        <button id="search-nav-btn" style="width:100%; padding:10px; border:none; border-radius:10px; background:#34e0b4; color:#000; font-weight:900; font-size:14px; cursor:pointer; opacity:0.5; transition:0.3s;" disabled>
                            ▶ Start Navigation
                        </button>
                    </div>
                `;

                searchMarker = L.marker([destLat, destLng], {
                    icon: L.divIcon({ className: 'geofence-marker', html: '📍', iconSize: [30, 30], iconAnchor: [15, 30] })
                }).addTo(searchLayer);

                searchMarker.bindPopup(popupContent).openPopup();
                if (clearBtn) safeShow("location-search-clear", "block");

                if (myCoords && window.google) {
                    const ds = new google.maps.DirectionsService();
                    ds.route({
                        origin: new google.maps.LatLng(myCoords.lat, myCoords.lng),
                        destination: new google.maps.LatLng(destLat, destLng),
                        travelMode: 'DRIVING',
                        ...RoutePrefs.googleOptions()
                    }, (res, status) => {
                        const infoDiv = document.getElementById("search-route-info");
                        const navBtn = document.getElementById("search-nav-btn");

                        if (status === 'OK' && res.routes.length > 0 && infoDiv && navBtn) {
                            const route = res.routes[0];
                            const leg = route.legs[0];

                            const coords = route.overview_path.map(p => [p.lat(), p.lng()]);
                            L.polyline(coords, { color: '#34e0b4', weight: 6, opacity: 0.8, className: 'nav-path-animated' }).addTo(navigationLayer);
                            map.fitBounds(L.polyline(coords).getBounds(), { padding: [50, 50] });

                            const avoiding = RoutePrefs.describe();
                            infoDiv.innerHTML = `<span style="color:#000; font-size:15px; font-weight:900;">🚗 ${leg.distance.text}</span> <br> <span style="color:#000; font-size:15px; font-weight:900;">⏱️ ${leg.duration.text}</span>` +
                                (avoiding ? `<br><span class="route-avoid-note">🛣️ Avoiding ${escapeHTML(avoiding)}</span>` : "");
                            navBtn.style.opacity = "1";
                            navBtn.disabled = false;

                            navBtn.onclick = () => {
                                searchMarker.closePopup();

                                const mockRouteData = {
                                    geometry: { coordinates: coords.map(c => [c[1], c[0]]) },
                                    distance: leg.distance.value,
                                    duration: leg.duration.value,
                                    legs: [{
                                        // Phase 3: carry each step's start point as the
                                        // maneuver location (a Google step's instruction
                                        // describes the maneuver at its START), so turn-
                                        // by-turn can advance and speak on Google routes
                                        // too, not only on OSRM-sourced ones.
                                        steps: leg.steps.map(s => ({
                                            maneuver: {
                                                type: s.instructions.replace(/<[^>]*>?/gm, '').replace(/\s+/g, ' ').trim(),
                                                modifier: googleManeuverModifier(s.maneuver),
                                                location: s.start_location ? [s.start_location.lng(), s.start_location.lat()] : null
                                            },
                                            distance: s.distance.value
                                        }))
                                    }]
                                };
                                startSearchNavigation(destLat, destLng, placeName, mockRouteData);
                            };
                        } else if (infoDiv) {
                            infoDiv.innerHTML = "<span style='color:#ef4444; font-weight:bold;'>No driving route found.</span>";
                        }
                    });
                } else {
                    if (document.getElementById("search-route-info")) document.getElementById("search-route-info").innerHTML = "<span style='color:#f59e0b; font-weight:bold;'>GPS required.</span>";
                }
            });
        }
    }, 500);
}

let navWatchId = null;
let navDrListener = null;      // Phase 4: follows dead-reckoned estimates during navigation

// ---- Maneuver text (roadmap Section 7) -------------------------------------
// Google's DirectionsService already returns plain-English instructions (we
// strip its HTML at the call site). OSRM's `steps=true` instead returns
// maneuver.type/modifier codes — map those through a small phrase table so
// OSRM-sourced routes (e.g. "Route to friend") get readable turn text too.
const MANEUVER_PHRASES = {
    "turn|left": "Turn left", "turn|right": "Turn right", "turn|straight": "Continue straight",
    "turn|slight left": "Bear left", "turn|slight right": "Bear right",
    "turn|sharp left": "Sharp left", "turn|sharp right": "Sharp right",
    "new name|": "Continue", "depart|": "Head out", "arrive|": "You have arrived",
    "merge|left": "Merge left", "merge|right": "Merge right",
    "roundabout|": "Enter the roundabout", "rotary|": "Enter the roundabout",
    "fork|left": "Keep left", "fork|right": "Keep right",
    "end of road|left": "Turn left", "end of road|right": "Turn right",
    "on ramp|": "Take the ramp", "off ramp|": "Take the exit", "continue|": "Continue"
};
const ORDINALS = ["", "1st", "2nd", "3rd", "4th", "5th", "6th", "7th", "8th"];
const KNOWN_OSRM_TYPES = new Set(["turn", "new name", "depart", "arrive", "merge", "on ramp", "off ramp", "fork",
    "end of road", "continue", "roundabout", "rotary", "roundabout turn", "exit roundabout", "exit rotary", "notification", "use lane"]);

function maneuverPhrase(step) {
    const type = step?.maneuver?.type || "";
    const modifier = step?.maneuver?.modifier || "";
    // Google path: the "type" slot already holds a plain-English instruction.
    if (type && !KNOWN_OSRM_TYPES.has(type)) return type;
    if (type === "arrive") return "Arrive at your destination";
    if (type === "roundabout" || type === "rotary") {
        const exit = step?.maneuver?.exit;
        const base = exit && ORDINALS[exit] ? `At the roundabout, take the ${ORDINALS[exit]} exit` : "Enter the roundabout";
        return step?.name ? `${base} onto ${step.name}` : base;
    }
    const phrase = MANEUVER_PHRASES[`${type}|${modifier}`] || MANEUVER_PHRASES[`${type}|`] || (type ? `${type} ${modifier}`.trim() : "Continue on route");
    // OSRM gives the road name separately — worth hearing ("onto NH-26").
    return step?.name && type !== "depart" ? `${phrase} onto ${step.name}` : phrase;
}

// Rotation for the banner's single up-arrow glyph, from an OSRM-style modifier.
function maneuverRotation(step) {
    const type = step?.maneuver?.type || "";
    const m = step?.maneuver?.modifier || "";
    if (type === "arrive") return 0;
    return ({ "left": -90, "right": 90, "slight left": -40, "slight right": 40, "sharp left": -135, "sharp right": 135, "uturn": 180, "straight": 0 })[m] ?? 0;
}

// Google DirectionsStep.maneuver ("turn-slight-left", "roundabout-right",
// "uturn-left", "keep-right", ...) -> the OSRM-style modifier used above.
function googleManeuverModifier(g) {
    const s = String(g || "");
    if (!s) return "";
    if (s.startsWith("uturn")) return "uturn";
    if (s.includes("sharp-left")) return "sharp left";
    if (s.includes("sharp-right")) return "sharp right";
    if (s.includes("slight-left") || s === "keep-left" || s === "fork-left" || s === "ramp-left") return "slight left";
    if (s.includes("slight-right") || s === "keep-right" || s === "fork-right" || s === "ramp-right") return "slight right";
    if (s.endsWith("left")) return "left";
    if (s.endsWith("right")) return "right";
    return "straight";
}

// Perpendicular (great-circle-ish, planar-approximated — fine at road scale)
// distance in meters from a point to the nearest segment of a polyline.
function pointToPolylineDistanceMeters(lat, lng, latlngs) {
    if (!latlngs || latlngs.length < 2) return Infinity;
    const cosLat = Math.cos((lat * Math.PI) / 180);
    const toXY = (la, ln) => [(ln) * 111320 * cosLat, (la) * 110540];
    const [px, py] = toXY(lat, lng);
    let best = Infinity;
    for (let i = 0; i < latlngs.length - 1; i++) {
        const [ax, ay] = toXY(latlngs[i][0], latlngs[i][1]);
        const [bx, by] = toXY(latlngs[i + 1][0], latlngs[i + 1][1]);
        const dx = bx - ax, dy = by - ay;
        const lenSq = dx * dx + dy * dy;
        let t = lenSq > 0 ? ((px - ax) * dx + (py - ay) * dy) / lenSq : 0;
        t = Math.max(0, Math.min(1, t));
        const cx = ax + t * dx, cy = ay + t * dy;
        const d = Math.hypot(px - cx, py - cy);
        if (d < best) best = d;
    }
    return best;
}

// Reroute-decision threshold, exactly as specified (roadmap Section 10):
// only worth swapping if it saves real time, isn't a wildly different path,
// and we haven't just rerouted.
function shouldReroute(current, candidate, lastRerouteTime) {
    const timeSavedSec = current.durationSec - candidate.durationSec;
    const distDeltaPct = current.distanceM > 0 ? Math.abs(candidate.distanceM - current.distanceM) / current.distanceM : 1;
    const cooldownOk = Date.now() - lastRerouteTime > 60_000;
    return timeSavedSec > 90 && distDeltaPct < 0.5 && cooldownOk;
}

// Kept for existing call sites; routes through the Phase 3 voice policy so
// navigation speech obeys mute / priority / hands-free echo guard like the rest.
function speak(text, opts = {}) {
    return voiceAnnounce(text, { priority: 65, category: "nav", drivingOnly: false, ...opts });
}

// Short on-screen distance ("350 m", "1.2 km").
function formatDistanceShort(meters) {
    if (!Number.isFinite(meters)) return "";
    if (meters < 1000) return `${Math.max(10, Math.round(meters / 10) * 10)} m`;
    return `${(meters / 1000).toFixed(meters < 10000 ? 1 : 0)} km`;
}
const lowerFirst = (s) => (s ? s.charAt(0).toLowerCase() + s.slice(1) : s);

function startSearchNavigation(destLat, destLng, destName, routeData) {
    navigationLayer.clearLayers();
    if (navWatchId) navigator.geolocation.clearWatch(navWatchId);

    safeHide("map-tools");
    safeHide("search-container");
    safeHide("top-header");
    safeHide("bottom-info");
    safeHide("chat-toggle-btn");
    safeHide("memoryButton");

    safeShow("premium-nav-ui", "block");
    safeShow("nav-bottom-sheet", "flex");
    safeShow("turn-banner", "flex");

    let fullPath = routeData.geometry.coordinates.map(c => [c[1], c[0]]);
    let activeRoute = { distanceM: routeData.distance, durationSec: routeData.duration };
    let steps = (routeData.legs && routeData.legs[0] && routeData.legs[0].steps) || [];
    // stepIdx = the step the rider is currently ON. The banner shows and
    // speaks steps[stepIdx + 1] — the NEXT maneuver. (Before Phase 3 the
    // banner showed steps[stepIdx], i.e. the maneuver that had just happened.)
    let stepIdx = 0;
    let offRouteStreak = 0;
    let lastRerouteTime = 0;
    let rerouteInFlight = false;
    let routeVersion = 0;                 // bumps on reroute so prompt keys never collide
    const promptedPre = new Set();        // "In 200 metres, turn left" already spoken
    const promptedNow = new Set();        // "Turn left" (late prompt) already spoken
    let lastPos = myCoords ? [myCoords.lat, myCoords.lng] : null;

    navState.ready = true;
    navState.active = false;
    navState.destName = destName;
    navState.remainingM = routeData.distance;
    navState.etaSec = routeData.duration;
    navState.routePath = fullPath;          // Phase 4: tunnel mode snaps its estimate to this

    const dottedPath = L.polyline(fullPath, { color: '#4f46e5', weight: 8, opacity: 0.7, className: 'anim-dash' }).addTo(navigationLayer);
    const solidPath = L.polyline([], { color: '#34e0b4', weight: 8, opacity: 1, className: 'solid-trail' }).addTo(navigationLayer);

    const userIcon = L.divIcon({
        className: 'nav-avatar-marker',
        html: `<img src="${escapeHTML(currentUser.avatar)}" style="width:100%;height:100%;object-fit:cover; border-radius:50%; border:2px solid #34e0b4;">`,
        iconSize: [40, 40], iconAnchor: [20, 20]
    });

    const startPos = myCoords ? [myCoords.lat, myCoords.lng] : fullPath[0];
    const userMarker = L.marker(startPos, { icon: userIcon, zIndexOffset: 1000 }).addTo(navigationLayer);
    L.marker([destLat, destLng], { icon: L.divIcon({ className: 'geofence-marker', html: '📍' }) }).addTo(navigationLayer);

    const updateNavStats = (distMeters, durSec) => {
        navState.remainingM = distMeters;
        navState.etaSec = durSec;
        if ($("stat-dist")) $("stat-dist").innerHTML = (distMeters / 1000).toFixed(1) + "<small> km</small>";
        if ($("stat-eta")) $("stat-eta").innerHTML = Math.max(0, Math.round(durSec / 60)) + "<small> min</small>";
        const arrivalTime = new Date(Date.now() + Math.max(0, durSec) * 1000);
        if ($("nav-arrival-time")) $("nav-arrival-time").textContent = arrivalTime.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit', hour12: true });
    };
    updateNavStats(routeData.distance, routeData.duration);

    const maneuverLatLng = (s) => {
        const loc = s && s.maneuver && s.maneuver.location;
        return Array.isArray(loc) && validCoord(loc[1], loc[0]) ? [loc[1], loc[0]] : null;
    };
    const nextManeuver = () => steps[stepIdx + 1] || null;

    // Distance to the next maneuver: live from GPS when the step carries a
    // location; otherwise the current step's own length as an estimate.
    const distanceToNext = (fromPos) => {
        const next = nextManeuver();
        if (!next) return null;
        const ll = maneuverLatLng(next);
        if (ll && fromPos) return map.distance(fromPos, ll);
        const cur = steps[stepIdx];
        return cur && Number.isFinite(cur.distance) ? cur.distance : null;
    };

    const updateStepDisplay = (fromPos) => {
        const next = nextManeuver();
        const turnDist = $("turn-dist"), turnName = $("turn-name"), stepText = $("nav-step-text"), stepDist = $("nav-step-dist"), svg = $("turn-svg");
        if (!next) {
            if (turnDist) turnDist.textContent = Number.isFinite(navState.remainingM) ? `${formatDistanceShort(navState.remainingM)} to go` : "Follow the route";
            if (turnName) turnName.textContent = `Heading to ${destName}`;
            if (stepText) stepText.textContent = "";
            if (stepDist) stepDist.textContent = "";
            if (svg) svg.style.transform = "rotate(0deg)";
            navState.nextManeuver = "";
            return;
        }
        const phrase = maneuverPhrase(next);
        const d = distanceToNext(fromPos);
        if (turnDist) turnDist.textContent = Number.isFinite(d) ? `In ${formatDistanceShort(d)}` : "Next";
        if (turnName) turnName.textContent = phrase;
        if (svg) svg.style.transform = `rotate(${maneuverRotation(next)}deg)`;
        const after = steps[stepIdx + 2];
        if (stepText) stepText.textContent = after ? `Then ${lowerFirst(maneuverPhrase(after))}` : `Then arrive at ${destName}`;
        if (stepDist) stepDist.textContent = Number.isFinite(next.distance) && next.distance > 0 && after ? `· after ${formatDistanceShort(next.distance)}` : "";
        navState.nextManeuver = phrase;
    };
    updateStepDisplay(lastPos);

    map.fitBounds(dottedPath.getBounds(), { paddingBottomRight: [0, 350], paddingTopLeft: [50, 150] });

    const startBtn = $("btn-start-nav");
    const resetBtn = $("btn-reset-nav");
    const exitBtn = $("btn-exit-nav");

    if (startBtn) {
        startBtn.style.display = "block";
        startBtn.textContent = "Start Navigation";
        startBtn.style.background = "linear-gradient(135deg, #34d399, #22c55e)";
        startBtn.style.color = "#062112";
    }
    if (resetBtn) resetBtn.style.display = "block";
    if (exitBtn) { exitBtn.style.display = "none"; exitBtn.textContent = "Stop"; exitBtn.style.background = ""; exitBtn.style.color = ""; }
    if ($("stat-status")) { $("stat-status").textContent = "Ready"; $("stat-status").style.color = ""; }
    if ($("speed-n")) $("speed-n").textContent = "0";

    if (startBtn) {
        startBtn.onclick = () => {
            startBtn.style.display = "none";
            if (resetBtn) resetBtn.style.display = "none";
            if (exitBtn) exitBtn.style.display = "block";

            if ($("stat-status")) { $("stat-status").textContent = "En route"; $("stat-status").style.color = "#f5a524"; }

            if (myCoords) map.flyTo([myCoords.lat, myCoords.lng], 18, { animate: true, duration: 1.5 });

            navState.ready = false;
            navState.active = true;
            SmartDrive.startTrip();              // also emits mu:drive-state
            if (typeof TripDB !== "undefined") TripDB.saveNavState({ destLat, destLng, destName, active: true });

            // Opening line: destination, then the first real maneuver if we know it.
            const first = nextManeuver();
            const d0 = distanceToNext(lastPos);
            let opening = `Navigation started. Heading to ${destName}.`;
            if (first && Number.isFinite(d0)) {
                opening += ` In ${spokenDistance(d0)}, ${lowerFirst(maneuverPhrase(first))}.`;
                if (d0 <= 250) promptedPre.add(`${routeVersion}:${stepIdx + 1}`);
            }
            speak(opening, { priority: 70, key: `nav-start-${destLat}-${destLng}`, cooldownMs: 5000 });

            if (navigator.geolocation) {
                let traveledCoords = [];
                // Phase 4: ONE handler for real fixes and for dead-reckoned
                // estimates (mu:dr-position). Estimates move the marker, the
                // trail and the turn prompts, but never trigger an off-route
                // reroute or "arrived" off a guess.
                const onNavPosition = async (currentLat, currentLng, speedMps, estimated) => {
                    const currentPos = [currentLat, currentLng];
                    lastPos = currentPos;

                    const speedKmh = Math.round(speedMps * 3.6);
                    if ($("speed-n")) $("speed-n").textContent = speedKmh;

                    userMarker.setLatLng(currentPos);
                    const umEl = typeof userMarker.getElement === "function" ? userMarker.getElement() : null;
                    if (umEl) umEl.classList.toggle("dr-est", Boolean(estimated));
                    const ss = $("stat-status");
                    if (ss && ss.textContent !== "Arrived") { ss.textContent = estimated ? "No GPS" : "En route"; ss.style.color = estimated ? "var(--c-sensor)" : "#f5a524"; }
                    map.panTo(currentPos);

                    traveledCoords.push(L.latLng(currentLat, currentLng));
                    solidPath.setLatLngs(traveledCoords);

                    const remainingMeters = map.distance(currentPos, [destLat, destLng]);
                    updateNavStats(remainingMeters, activeRoute.durationSec * (remainingMeters / Math.max(1, activeRoute.distanceM)));

                    // --- Turn-by-turn prompts (Phase 3, voice-first Safe Drive) ---
                    // One early prompt inside 250 m, one late prompt only if the
                    // early one was missed (short step / sparse fixes), then
                    // advance when within 35 m of the maneuver point.
                    const next = nextManeuver();
                    const nextLL = maneuverLatLng(next);
                    if (next && nextLL) {
                        const d = map.distance(currentPos, nextLL);
                        const k = `${routeVersion}:${stepIdx + 1}`;
                        if (d <= 250 && d > 60 && !promptedPre.has(k)) {
                            promptedPre.add(k);
                            speak(`In ${spokenDistance(d)}, ${lowerFirst(maneuverPhrase(next))}.`, { priority: 70, key: `man-pre-${k}`, cooldownMs: 30000, maxAgeMs: 5000 });
                        } else if (d <= 60 && !promptedPre.has(k) && !promptedNow.has(k)) {
                            promptedNow.add(k);
                            speak(`${maneuverPhrase(next)}.`, { priority: 72, key: `man-now-${k}`, cooldownMs: 30000, maxAgeMs: 4000 });
                        }
                        if (d < 35) stepIdx++;
                    }
                    updateStepDisplay(currentPos);
                    if (estimated) return;             // no reroute / arrival decisions on an estimate

                    // --- Off-route detection + reroute (roadmap Section 7 + 10) ---
                    const offDist = pointToPolylineDistanceMeters(currentLat, currentLng, fullPath);
                    offRouteStreak = offDist > 40 ? offRouteStreak + 1 : 0;
                    // One reroute request at a time: the next fix used to arrive while
                    // the first request was still in flight and fire a duplicate.
                    if (offRouteStreak >= 2 && Date.now() - lastRerouteTime > 60_000 && !rerouteInFlight) {
                        rerouteInFlight = true;
                        try {
                            // Same avoid-highways/tolls preference as the original route —
                            // a reroute must not quietly put the rider back on a toll road.
                            const data = await RoutePrefs.fetchRoute(`https://router.project-osrm.org/route/v1/driving/${currentLng},${currentLat};${destLng},${destLat}?overview=full&geometries=geojson&steps=true&alternatives=false`);
                            const cand = data.routes && data.routes[0];
                            if (cand) {
                                const currentEstimate = { distanceM: remainingMeters, durationSec: activeRoute.durationSec * (remainingMeters / Math.max(1, activeRoute.distanceM)) };
                                const candidate = { distanceM: cand.distance, durationSec: cand.duration };
                                // Always resync the polyline once we're genuinely off it — silent
                                // navigation off a route the rider can see is confusing either way.
                                // shouldReroute() only decides whether to also call this out as a
                                // "faster path found" cue vs. a quiet resync. Either way the rider
                                // HEARS it (roadmap Section 26: no silent rerouting).
                                fullPath = cand.geometry.coordinates.map(c => [c[1], c[0]]);
                                dottedPath.setLatLngs(fullPath);
                                navState.routePath = fullPath;
                                activeRoute = { distanceM: cand.distance, durationSec: cand.duration };
                                steps = (cand.legs && cand.legs[0] && cand.legs[0].steps) || [];
                                stepIdx = 0;
                                routeVersion++;
                                updateStepDisplay(currentPos);
                                lastRerouteTime = Date.now();
                                offRouteStreak = 0;

                                if (shouldReroute(currentEstimate, candidate, 0)) {
                                    showToast("🔄 Faster route found — recalculating.", 4000);
                                    speak("Recalculating a faster route.", { priority: 66, key: "reroute", cooldownMs: 20000 });
                                } else {
                                    showToast("🔄 Back on track — route updated.", 3000);
                                    speak("Route updated.", { priority: 66, key: "reroute", cooldownMs: 20000 });
                                }
                                islandShow({ id: "reroute", kind: "info", title: "Rerouting", sub: "Path updated to your position", ttl: 4000 });
                            }
                        } catch (e) { /* OSRM demo instance hiccup — just try again next off-route streak */ }
                        finally { rerouteInFlight = false; }
                    }

                    if (remainingMeters < 30) {
                        navigator.geolocation.clearWatch(navWatchId);
                        if (exitBtn) { exitBtn.textContent = "Arrived"; exitBtn.style.background = "#3b82f6"; exitBtn.style.color = "white"; }
                        if ($("stat-status")) { $("stat-status").textContent = "Arrived"; $("stat-status").style.color = "var(--mint)"; }
                        if ($("turn-name")) $("turn-name").textContent = "Destination reached!";
                        if ($("turn-dist")) $("turn-dist").textContent = destName;
                        speak(`You have arrived at ${destName}.`, { priority: 70, key: "arrived", cooldownMs: 60000 });
                        setTimeout(() => stopDrive(), 3000);
                    }
                };
                navWatchId = navigator.geolocation.watchPosition((pos) => {
                    if (DeadReckoning.shouldIgnoreNavFix(pos)) return;   // coarse fix mid-outage: the estimate has it
                    onNavPosition(pos.coords.latitude, pos.coords.longitude, pos.coords.speed || 0, false);
                }, (err) => {
                    // TIMEOUT (3) is routine when stationary or under canopy — the
                    // watch keeps running, so it isn't worth an error. Surface a
                    // permission loss; log anything else quietly.
                    if (err && err.code === 3) return;
                    if (err && err.code === 1) { showToast("⚠️ Location permission was turned off — navigation can't follow you.", 6000); return; }
                    console.warn("GPS error during nav:", err && err.message);
                }, { enableHighAccuracy: true, maximumAge: 0, timeout: 5000 });
                if (navDrListener) document.removeEventListener("mu:dr-position", navDrListener);
                navDrListener = (e) => {
                    const est = e.detail;
                    if (navState.active && est && !est.lost && validCoord(est.lat, est.lng)) onNavPosition(est.lat, est.lng, (est.speedKmh || 0) / 3.6, true);
                };
                document.addEventListener("mu:dr-position", navDrListener);
            }
            emitDriveState();
        };
    }

    if (resetBtn) resetBtn.onclick = () => stopDrive(true);
    if (exitBtn) exitBtn.onclick = () => stopDrive();
}

function stopDrive(cancelled = false) {
    if (navWatchId) navigator.geolocation.clearWatch(navWatchId);
    navWatchId = null;
    if (navDrListener) { document.removeEventListener("mu:dr-position", navDrListener); navDrListener = null; }
    navigationLayer.clearLayers();
    safeHide("premium-nav-ui");
    safeHide("nav-bottom-sheet");
    safeHide("turn-banner");
    safeHide("speed-dial");

    safeShow("map-tools", "flex");
    safeShow("search-container", "flex");
    safeShow("top-header", "flex");
    safeShow("bottom-info", "flex");
    safeShow("chat-toggle-btn", "flex");
    safeShow("memoryButton", "flex");

    if (myCoords) map.flyTo([myCoords.lat, myCoords.lng], 16);

    navState.ready = false;
    navState.active = false;
    navState.destName = "";
    navState.remainingM = null;
    navState.etaSec = null;
    navState.nextManeuver = "";
    navState.routePath = null;
    // Clear the saved nav state so a refresh doesn't resurrect a finished drive.
    if (typeof TripDB !== "undefined") TripDB.saveNavState({ active: false });

    if (!cancelled) SmartDrive.endTrip();     // emits mu:drive-state itself
    else { SmartDrive.releaseWakeLock(); emitDriveState(); }
}

// ==========================================
// VOICE CALLING (1:1 WebRTC via Socket.IO signaling)
// ==========================================
let peerConnection = null;
let localStream = null;
let incomingIceCandidates = [];
let callDialog = null;
let activeCallBtn = null;

const rtcConfig = {
    iceServers: [
        { urls: "stun:stun.l.google.com:19302" },
        { urls: "stun:stun.cloudflare.com:3478" },
        { urls: "turn:openrelay.metered.ca:80", username: "openrelayproject", credential: "openrelayproject" },
        { urls: "turn:openrelay.metered.ca:443", username: "openrelayproject", credential: "openrelayproject" },
        { urls: "turn:openrelay.metered.ca:443?transport=tcp", username: "openrelayproject", credential: "openrelayproject" }
    ]
};

function attachAudioTrack(event) {
    let audio = document.getElementById("remote-audio");
    if (!audio) {
        audio = document.createElement("audio");
        audio.id = "remote-audio";
        audio.autoplay = true;
        audio.playsInline = true;
        audio.hidden = true;
        document.body.appendChild(audio);
    }
    if (event.streams && event.streams[0]) audio.srcObject = event.streams[0];
    else audio.srcObject = new MediaStream([event.track]);

    audio.play().catch(e => {
        console.log("Audio play error, forcing play:", e);
        document.body.addEventListener('click', () => { audio.play(); }, { once: true });
    });
}

function initCallButton(u) {
    const callBtn = $("profile-call-btn");
    if (!callBtn) return;
    const newBtn = callBtn.cloneNode(true);
    callBtn.parentNode.replaceChild(newBtn, callBtn);

    newBtn.onclick = async () => {
        if (!navigator.onLine || u.online === false) {
            const phone = prompt(`No Internet or Friend is offline.\nEnter mobile number to dial via SIM:`);
            if (phone) window.location.href = `tel:${phone.trim()}`;
            return;
        }
        if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
            showToast("❌ Microphone is not available in this browser.");
            return;
        }
        try {
            // Phase 3: hand the mic over from hands-free voice commands first.
            if (window.VoiceAssistant) window.VoiceAssistant.stopListening();
            localStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
            peerConnection = new RTCPeerConnection(rtcConfig);
            localStream.getTracks().forEach(track => peerConnection.addTrack(track, localStream));
            peerConnection.ontrack = attachAudioTrack;
            peerConnection.onicecandidate = (event) => {
                if (event.candidate) socket.emit("call-user", { to: u.id, signal: { type: "ice", candidate: event.candidate }, name: currentUser.name });
            };
            const offer = await peerConnection.createOffer();
            await peerConnection.setLocalDescription(offer);
            socket.emit("call-user", { to: u.id, signal: { type: "offer", sdp: offer }, name: currentUser.name });
            showToast(`📞 Calling ${u.name}...`, 5000);
            showActiveCallUI(() => socket.emit("end-call", { to: u.id }));
        } catch (err) {
            console.error("CALL MIC ERROR:", err);
            showToast(`❌ Mic Error: ${err.name || "Unknown"}`);
            endLocalCall();
        }
    };
}

socket.on("incoming-call", async (data) => {
    if (data.signal.type === "offer") {
        if (peerConnection) { socket.emit("end-call", { to: data.from }); return; }
        incomingIceCandidates = [];
        if (callDialog) callDialog.remove();

        callDialog = document.createElement('div');
        callDialog.style.cssText = "position:fixed;top:70px;left:50%;transform:translateX(-50%);background:rgba(15,23,42,0.98);padding:24px;border:1px solid #18d6a3;border-radius:20px;z-index:9999;box-shadow:0 15px 40px rgba(0,0,0,0.7);color:white;text-align:center;backdrop-filter:blur(10px);min-width:280px;";
        callDialog.innerHTML = `
            <div style="font-size:32px;margin-bottom:10px;">📞</div>
            <strong style="font-size:18px;display:block;">${escapeHTML(data.name)}</strong>
            <div style="font-size:13px;color:#94a3b8;margin-top:6px;margin-bottom:20px;">Incoming Voice Call...</div>
            <div style="display:flex;gap:12px;justify-content:center;">
                <button id="accept-call-btn" style="flex:1;background:#10b981;border:none;padding:12px;border-radius:12px;color:#064e3b;font-weight:800;cursor:pointer;font-size:15px;box-shadow:0 4px 10px rgba(16,185,129,0.3);">Accept</button>
                <button id="reject-call-btn" style="flex:1;background:#ef4444;border:none;padding:12px;border-radius:12px;color:white;font-weight:700;cursor:pointer;font-size:15px;box-shadow:0 4px 10px rgba(239,68,68,0.3);">Decline</button>
            </div>
        `;
        document.body.appendChild(callDialog);

        const acceptBtn = document.getElementById("accept-call-btn");
        if (acceptBtn) {
            acceptBtn.onclick = async () => {
                if (callDialog) callDialog.remove();
                callDialog = null;
                try {
                    if (window.VoiceAssistant) window.VoiceAssistant.stopListening();
                    localStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
                    peerConnection = new RTCPeerConnection(rtcConfig);
                    localStream.getTracks().forEach(track => peerConnection.addTrack(track, localStream));
                    peerConnection.ontrack = attachAudioTrack;
                    peerConnection.onicecandidate = (event) => {
                        if (event.candidate) socket.emit("answer-call", { to: data.from, signal: { type: "ice", candidate: event.candidate } });
                    };
                    await peerConnection.setRemoteDescription(new RTCSessionDescription(data.signal.sdp));
                    const answer = await peerConnection.createAnswer();
                    await peerConnection.setLocalDescription(answer);
                    socket.emit("answer-call", { to: data.from, signal: { type: "answer", sdp: answer } });
                    showToast(`🎙️ Call Connected with ${data.name}`);
                    showActiveCallUI(() => socket.emit("end-call", { to: data.from }));
                    incomingIceCandidates.forEach(async (c) => { try { await peerConnection.addIceCandidate(new RTCIceCandidate(c)); } catch (e) { /* stale candidate, ignore */ } });
                    incomingIceCandidates = [];
                } catch (e) {
                    showToast("❌ Mic error.");
                    socket.emit("end-call", { to: data.from });
                    endLocalCall();
                }
            };
        }
        const rejectBtn = document.getElementById("reject-call-btn");
        if (rejectBtn) rejectBtn.onclick = () => { if (callDialog) callDialog.remove(); callDialog = null; socket.emit("end-call", { to: data.from }); };
    } else if (data.signal.type === "ice") {
        if (peerConnection && peerConnection.remoteDescription) { try { await peerConnection.addIceCandidate(new RTCIceCandidate(data.signal.candidate)); } catch (e) { /* stale candidate, ignore */ } }
        else incomingIceCandidates.push(data.signal.candidate);
    }
});

socket.on("call-accepted", async (signal) => {
    if (signal.type === "answer" && peerConnection) {
        await peerConnection.setRemoteDescription(new RTCSessionDescription(signal.sdp));
        showToast("🎙️ Call Connected!");
    } else if (signal.type === "ice" && peerConnection && peerConnection.remoteDescription) {
        try { await peerConnection.addIceCandidate(new RTCIceCandidate(signal.candidate)); } catch (e) { /* stale candidate, ignore */ }
    }
});

socket.on("call-ended", () => { endLocalCall(); showToast("📴 Call Ended."); });

function showActiveCallUI(endFn) {
    if (activeCallBtn) return;
    activeCallBtn = document.createElement("button");
    activeCallBtn.innerHTML = "📴 End Call";
    activeCallBtn.style.cssText = "position:fixed;top:80px;left:50%;transform:translateX(-50%);z-index:9999;background:#ef4444;color:white;border:none;padding:12px 24px;border-radius:30px;font-weight:bold;box-shadow:0 10px 25px rgba(239,68,68,0.5);cursor:pointer;font-size:14px;";
    document.body.appendChild(activeCallBtn);
    activeCallBtn.onclick = () => { endFn(); endLocalCall(); };
}

function endLocalCall() {
    if (activeCallBtn) { activeCallBtn.remove(); activeCallBtn = null; }
    if (callDialog) { callDialog.remove(); callDialog = null; }
    if (peerConnection) { peerConnection.close(); peerConnection = null; }
    if (localStream) { localStream.getTracks().forEach(t => t.stop()); localStream = null; }
    incomingIceCandidates = [];
    // Phase 3: the mic is free again — hands-free listening may resume.
    if (window.VoiceAssistant) window.VoiceAssistant.updateHandsFree();
}

// ==========================================
// PWA INSTALL BUTTON  (registration itself lives in shell.js now)
// ==========================================
let deferredPrompt;
window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    deferredPrompt = e;
    const installBtn = $("install-app-btn");
    if (installBtn) installBtn.style.display = 'flex';
});

window.addEventListener('DOMContentLoaded', () => {
    const installBtn = $("install-app-btn");
    if (installBtn) {
        installBtn.onclick = async () => {
            if (deferredPrompt) {
                deferredPrompt.prompt();
                const { outcome } = await deferredPrompt.userChoice;
                if (outcome === 'accepted') installBtn.style.display = 'none';
                deferredPrompt = null;
            }
        };
    }
    if (window.matchMedia('(display-mode: standalone)').matches || window.navigator.standalone === true) {
        if (installBtn) installBtn.style.display = 'none';
    }
});

window.addEventListener('appinstalled', () => { const installBtn = $("install-app-btn"); if (installBtn) installBtn.style.display = 'none'; });

// ==========================================
// TRIP GEAR CHECKLIST
// ==========================================
const TripChecklist = {
    items: JSON.parse(localStorage.getItem("koraput_gear")) || {
        "Action Camera & Mounts": false, "Powerbanks & Extra Batteries": false,
        "Vehicle & ID Documents": false, "Trekking Shoes": false, "First Aid & Meds": false
    },
    toggle(key) { this.items[key] = !this.items[key]; localStorage.setItem("koraput_gear", JSON.stringify(this.items)); this.render(); },
    render() {
        const container = $("trip-checklist-container");
        if (!container) return;
        container.innerHTML = `<h4 style="margin:5px 0; color:#18d6a3; font-size:13px;">🎒 Trip Gear Checklist</h4>`;
        Object.keys(this.items).forEach(item => {
            const row = document.createElement("label");
            row.style.cssText = "display:flex; align-items:center; gap:8px; font-size:12px; color:white; cursor:pointer; margin-bottom:4px;";
            const cb = document.createElement("input"); cb.type = "checkbox"; cb.checked = Boolean(this.items[item]); cb.style.accentColor = "#18d6a3";
            cb.addEventListener("change", () => this.toggle(item));
            const span = document.createElement("span"); span.textContent = item;
            if (this.items[item]) span.style.cssText = "text-decoration:line-through; color:#94a3b8;";
            row.appendChild(cb); row.appendChild(span); container.appendChild(row);
        });
    }
};
window.TripChecklist = TripChecklist;

// ==========================================
// EMERGENCY SOS
// ==========================================
// Shared by the SOS button (after its confirm sheet) and the voice command
// "send SOS" (after a spoken "confirm SOS") — one code path, one payload.
// Phase 4: also goes out over the paired LoRa radio (features.js ConvoyRelay).
// Returns "server" | "radio" | "queued" (truthy) or false (no position yet).
//   server — the socket is up: everyone online is alerted now;
//   radio  — no data, but the SOS left over the radio (a rider with data
//            uploads it; nearby radios alert their riders directly);
//   queued — no data and no radio: held here and sent right after the next
//            profileAccepted (see there for why NOT Socket.IO's own buffer).
let pendingSos = null;
function sendSOS() {
    if (!myCoords) { showToast("❌ Waiting for GPS..."); return false; }
    const online = Boolean(socket.connected);
    if (online) socket.emit("sos-alert", { name: currentUser.name, lat: myCoords.lat, lng: myCoords.lng, alt: myCoords.alt ?? null });
    else pendingSos = { queuedAt: Date.now() };
    const radio = Boolean(window.ConvoyRelay && typeof window.ConvoyRelay.sendSos === "function" && window.ConvoyRelay.sendSos());
    if (online) {
        showToast(radio ? "🚨 SOS BROADCASTED TO ALL FRIENDS — and over the radio." : "🚨 SOS BROADCASTED TO ALL FRIENDS!", 8000);
        islandShow({ id: "sos", kind: "sos", title: "SOS sent", sub: radio ? "Friends alerted · radio too" : "Your friends were alerted", ttl: 6000 });
        return "server";
    }
    if (radio) {
        showToast("🚨 No data — SOS sent over the radio. It also goes out online as soon as you have signal.", 9000);
        islandShow({ id: "sos", kind: "sos", title: "SOS sent by radio", sub: "Waiting for a rider to confirm", ttl: 9000 });
        return "radio";
    }
    showToast("🚨 No connection — your SOS will send the moment you're back online.", 9000);
    islandShow({ id: "sos", kind: "sos", title: "SOS queued", sub: "Sends as soon as you're back online", ttl: 9000 });
    return "queued";
}

// 8-point compass word from A to B ("north-east"), for spoken directions.
function compassWord(lat1, lng1, lat2, lng2) {
    const toRad = (d) => (d * Math.PI) / 180;
    const y = Math.sin(toRad(lng2 - lng1)) * Math.cos(toRad(lat2));
    const x = Math.cos(toRad(lat1)) * Math.sin(toRad(lat2)) - Math.sin(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.cos(toRad(lng2 - lng1));
    const deg = ((Math.atan2(y, x) * 180) / Math.PI + 360) % 360;
    return ["north", "north-east", "east", "south-east", "south", "south-west", "west", "north-west"][Math.round(deg / 45) % 8];
}

function setupSOS() {
    let sosBtn = $("sos-btn");
    if (!sosBtn) {
        sosBtn = document.createElement("button");
        sosBtn.id = "sos-btn";
        sosBtn.innerHTML = "🚨 SOS";
        sosBtn.style.cssText = "position:fixed;bottom:calc(90px + env(safe-area-inset-bottom,0px));right:20px;z-index:9998;background:#ef4444;color:white;border:none;border-radius:50%;width:55px;height:55px;font-weight:900;font-size:12px;box-shadow:0 0 15px rgba(239,68,68,0.7);cursor:pointer;animation:dangerPulse 1s infinite alternate;";
        document.body.appendChild(sosBtn);
    }

    sosBtn.onclick = async () => {
        if (!myCoords) return showToast("❌ Waiting for GPS...");
        const { ok } = await confirmDialog({
            title: "Send emergency SOS?", body: "This alerts every connected friend with your exact coordinates.",
            okLabel: "Send SOS", cancelLabel: "Cancel", danger: true
        });
        if (!ok) return;
        sendSOS();
    };

    socket.on("sos-alert", (data) => showIncomingSos(data));
}

// Phase 4: one entry point for an incoming SOS — from the server, or heard
// directly over our own radio (features.js). The same emergency can arrive
// both ways (and a radio retry again), so it alerts ONCE per rider per minute;
// later copies only move that rider's SOS pin.
const recentSos = new Map();        // ownerKey | id -> {ts, marker}
function showIncomingSos(data) {
    if (!data || !validCoord(data.lat, data.lng)) return;
    const key = data.ownerKey || data.id || data.name || "unknown";
    const now = Date.now();
    const seen = recentSos.get(key);
    const who = String(data.name || "A rider");
    const viaRadio = data.via === "radio";
    const ageSec = Number.isFinite(data.at) ? Math.round((now - data.at) / 1000) : 0;
    const note = viaRadio ? ` (via radio${data.relayedBy ? `, relayed by ${data.relayedBy}` : ""}${ageSec > 45 ? `, ${agoText(data.at)}` : ""})` : "";

    let marker = seen && seen.marker;
    if (marker) marker.setLatLng([data.lat, data.lng]);
    else {
        marker = L.marker([data.lat, data.lng], { icon: L.divIcon({ className: 'sos-marker', html: '<div style="font-size:30px;animation:dangerPulse 1s infinite alternate;">🚨</div>' }) })
            .bindPopup(`<b style="color:red;">EMERGENCY SOS: ${escapeHTML(who)}</b>${escapeHTML(note)}`).addTo(map);
        marker.openPopup();
    }
    recentSos.set(key, { ts: seen && now - seen.ts < 60000 ? seen.ts : now, marker });
    if (seen && now - seen.ts < 60000) return;

    const div = document.createElement("div");
    div.style.cssText = "position:fixed;top:0;left:0;width:100%;height:100%;background:rgba(239,68,68,0.3);border:10px solid #ef4444;z-index:99999;pointer-events:none;animation:dangerPulse 1s infinite alternate;";
    document.body.appendChild(div);

    showToast(`🚨 URGENT SOS FROM ${who.toUpperCase()}!${note} Check Map!`, 15000);
    // StatusIsland uses textContent — raw string, not escapeHTML().
    islandShow({ id: "sos-in", kind: "sos", title: "SOS", sub: `${who} needs help${viaRadio ? " · via radio" : ""}`, ttl: 15000 });
    // Always spoken: an emergency bypasses mute and the "spoken alerts"
    // toggle (stated next to that toggle in settings).
    let where = "";
    if (myCoords && validCoord(data.lat, data.lng)) {
        where = ` ${spokenDistance(map.distance([myCoords.lat, myCoords.lng], [data.lat, data.lng]))} ${compassWord(myCoords.lat, myCoords.lng, data.lat, data.lng)} of you.`;
    }
    const radioNote = viaRadio ? " Received over the radio." : "";
    voiceAnnounce(`Emergency. ${who} sent an S O S.${where}${radioNote}`, { priority: 100, force: true, key: `sos-in-${key}`, cooldownMs: 10000, category: "sos" });

    map.flyTo([data.lat, data.lng], 16, { animate: true, duration: 2 });
    setTimeout(() => div.remove(), 10000);
}

// ==========================================
// BOOT
// ==========================================
function initApp() {
    const tasks = [
        { name: "Join Setup", fn: setupJoin },
        { name: "Controls", fn: setupBasicControlsSafe },
        { name: "Advanced Tools", fn: setupAdvancedToolsSafe },
        { name: "Chat UI", fn: setupChatSafe },
        { name: "Memories", fn: setupMemoriesSafe },
        { name: "SmartDrive", fn: () => SmartDrive.init() },
        { name: "Privacy Controls", fn: () => PrivacyControls.init() },
        { name: "Route Options", fn: () => RoutePrefs.bindUI() },
        { name: "Meetup Planner", fn: () => MeetupPlanner.init() },
        { name: "Carpool Planner", fn: () => CarpoolPlanner.init() },
        { name: "Trip Analytics", fn: () => TripAnalytics.init() },
        { name: "Dead Reckoning", fn: () => DeadReckoning.init() },
        { name: "GPS System", fn: startGPS },
        { name: "Google Search", fn: setupGoogleSearch },
        { name: "Emergency SOS", fn: setupSOS }
    ];

    tasks.forEach(task => {
        try { task.fn(); } catch (e) { console.error(`[INIT ERROR] Failed to load ${task.name}:`, e); }
    });

    setTimeout(() => {
        try {
            const panel = $("trip-panel");
            if (panel && !$("trip-checklist-container")) {
                const listDiv = document.createElement("div");
                listDiv.id = "trip-checklist-container";
                listDiv.style.cssText = "background:rgba(255,255,255,0.05); padding:10px; border-radius:10px; margin-top:10px;";
                // Fixed: this used insertBefore(listDiv, #trip-action-btn), but that
                // button sits inside a row <div>, not directly in #trip-panel —
                // insertBefore() threw NotFoundError and the checklist never showed.
                panel.appendChild(listDiv);
                TripChecklist.render();
            }
        } catch (e) { console.error(e); }
    }, 1000);
}

if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", initApp); else initApp();

// Auto-restore navigation across a refresh. Fixed: TripDB has no
// restoreNavState() — read the same backing store via restoreAll() instead
// (see tripDbRestoreNav() near SmartDrive, defined earlier in this file).
setTimeout(() => {
    const savedNav = tripDbRestoreNav();
    if (savedNav && savedNav.active && savedNav.destLat && typeof startSearchNavigation === "function") {
        console.log("🔄 Restoring previous navigation state...");
        // Fixed: the original called startSearchNavigation(..., null) here,
        // which crashed immediately on routeData.geometry.coordinates — a real
        // route has to be fetched first.
        if (myCoords) {
            RoutePrefs.fetchRoute(`https://router.project-osrm.org/route/v1/driving/${myCoords.lng},${myCoords.lat};${savedNav.destLng},${savedNav.destLat}?overview=full&geometries=geojson&steps=true`)
                .then(data => {
                    const route = data.routes && data.routes[0];
                    if (!route) return;
                    startSearchNavigation(savedNav.destLat, savedNav.destLng, savedNav.destName, route);
                    setTimeout(() => { const startBtn = document.getElementById("btn-start-nav"); if (startBtn && startBtn.style.display !== "none") startBtn.click(); }, 1200);
                }).catch(() => { /* couldn't restore — rider just re-searches, no crash */ });
        }
    }
}, 2000);
