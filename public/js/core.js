"use strict";

/* ============================================================================
   MapUnite client — js/core.js
   ==============================================================================
   Foundation every other file builds on: /config.js settings, the Socket.IO
   connection, the Leaflet map and its four base layers (with map credits),
   shared state (current user, friends, layers, trip, memories), device
   identity, the GPS filter + confidence score, DOM/geo/dialog/island/toast
   helpers, marker icons, weather + place-name lookups, and TripDB (local
   backup). Also keeps the original app.js and features.js header notes.

   Classic scripts sharing one global scope (no bundler, no build step),
   loaded by index.html in this order: core → voice → gps → navigation → smartdrive → groupnav → privacy → analytics → deadreckoning → presence → controls → chat → memories → calls → sos → pwa → skunkworks → radio → convoy → boot.
   ============================================================================ */


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
     - GpsFilter + gpsConfidence(): Kalman speed filter + z-score spike test, physical limits and a
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

// ---- Former features.js header (its modules now live in voice.js, calls.js,
// ---- radio.js, skunkworks.js, convoy.js and TripDB in core.js) ------------

/* ============================================================================
   MapUnite experimental features — features.js  (v2, roadmap-aligned)
   ==============================================================================
   Loaded after app.js — reuses its globals (socket, rtcConfig, currentUser,
   friendData, myOwnerKey, showToast, escapeHTML, distanceKm, validCoord, $,
   islandShow). Three modules, matching the roadmap's own verdicts:

     1. VoiceSquad — the old "Group Call" button got the mic, toggled itself,
        and emitted `join-voice-squad`, which server.js never listened for.
        No audio ever reached anyone. Step 1 added the matching server
        handlers (`join-voice-squad` / `voice-signal` / `leave-voice-squad`),
        so this is now a REAL multi-peer WebRTC mesh: one RTCPeerConnection
        per other squad member, signaled through the server.

     2. P2PRadar — the old panel's "success" path printed hardcoded strings
        ("Rider_2 ~15m", "Squad Leader Signal: Good") regardless of what
        Bluetooth actually found — a UI mockup, not a radar. The real Web
        Bluetooth central scan is kept (that part was genuine) and clearly
        labeled for what it is: a browser tab can only ever be a BLE
        *central*, never advertise as a peripheral, so it can find other
        *discoverable* BLE devices, not specifically "other MapUnite phones."
        Alongside it, a second, honestly-labeled panel shows real squad
        members within range using the GPS data the app already has —
        computed with real trigonometry (distance + bearing), not simulated.

     3. Skunkworks (Seismograph pothole detector, AI Dashcam, travel mode) —
        these were already real (DeviceMotion, getUserMedia), just wired
        loosely. Tightened up and connected to the Status Island. One real
        bug fixed along the way: the pothole marker read
        `lastFixCoords.latitude/.longitude`, but app.js's `lastFixCoords`
        object uses `.lat/.lng` — the marker was silently placing at
        undefined coordinates every time.

     PHASE 3 (roadmap Section 4):
     5. VoiceAssistant — voice-first Safe Drive. SpeechSynthesis behind a
        priority queue (pre-emption, expiry, de-dupe, mute) for every spoken
        cue app.js sends through voiceAnnounce(); SpeechRecognition for
        hands-free commands — push-to-talk by default, optional continuous
        listening during drives with an echo guard so it never obeys its own
        voice. Commands: how far · where is <name> · where am I · squad status
        · navigate to <place> · start / stop navigation · recenter · speed ·
        mute / unmute · send SOS (two-step: "confirm SOS").
     6. ConvoyIntelligence — the comparison loop over `friendMoved` +
        per-member OSRM road ETAs: falling behind (in road minutes, not
        straight-line), stopped 3+ min, off their planned road, lost signal,
        arrived. Island + voice + trip-panel badge + marker ring.

     PHASE 4 (roadmap Section 5 — experimental):
     7. MeshtasticLink — Web Bluetooth to a Meshtastic LoRa radio (the
        phone-to-phone path a browser can't do by itself): GATT ToRadio /
        FromRadio / FromNum, the want_config handshake, PRIVATE_APP packets,
        auto-reconnect, and plain-language warnings about the radio's own
        setup (region unset, transmit off, public channel).
     8. ConvoyRelay — position pings and SOS over the radio when mobile data
        drops: AES-GCM with a per-trip key (the default Meshtastic channel is
        public), a per-rider HMAC the server checks, last-writer-wins per
        rider, store-and-forward upload by any rider who still has data, and
        radio acks so an SOS sender hears "Rahul put your SOS online".
     2. (rewritten) The radar panel now shows riders heard over the radio —
        real distance/bearing from their own frames — beside riders known via
        the network, on a north-up canvas plus a text list.
     5. (extended) Voice: "radio status"; SOS confirmation says honestly
        whether it went online, over the radio, or is queued.

     PHASE 5 (roadmap — rare & experimental), core logic:
     9. RelativeMotion — per-rider velocity from a weighted least-squares fit
        of their recent track, then bearing, closing speed, closest point of
        approach and time-to-meet between you and each rider: "approaching /
        meeting / passed / moving away / holding distance", with confidence.
    10. ConvoyRegroup — a small graph over riders' travel times to the shared
        destination (road ETAs + direct along-road gaps), solved by weighted
        least squares, turned into safe suggestions: who eases off to what
        speed, who pauses for how long, where the convoy closes up. Never
        suggests speeding. Emits `mu:regroup`; no new socket events.
    11. Phase5UI — puts both on screen and in voice: motion line in the rider
        popup, motion label + arrow on the radar, regroup block in the trip
        panel / meetup sheet, a "Regroup here" pin, your own suggestion
        spoken once per change, a heads-up when a convoy rider is about to
        meet you, and the voice commands "regroup" / "who's approaching".
   ============================================================================ */

// Batch 2: /config.js (served by the server, loaded before the app scripts)
// says which Socket.IO transports work — WebSocket only when several server
// processes run without sticky sessions — and which OSRM server to route
// with (self-hosted, or the public demo server by default).
const MU_CONFIG = (typeof window !== "undefined" && window.MU_CONFIG) || {};
const OSRM_BASE = typeof MU_CONFIG.osrmBase === "string" && /^https?:\/\//.test(MU_CONFIG.osrmBase) ? MU_CONFIG.osrmBase.replace(/\/+$/, "") : "https://router.project-osrm.org";
// autoConnect: false — the app is split into several script files, and
// boot.js (loaded last) calls socket.connect() once every file has run, so
// no server event can reach a handler whose module isn't loaded yet.
// Android app (Capacitor): the pages are bundled and served from
// https://localhost, so the server's own address comes from the native build
// (scripts/build-native.mjs sets window.MU_SERVER_ORIGIN). Empty on the web.
const MU_SERVER_ORIGIN = typeof window.MU_SERVER_ORIGIN === "string" && /^https?:\/\/[^/\s]+$/.test(window.MU_SERVER_ORIGIN) ? window.MU_SERVER_ORIGIN : "";
const socketOptions = { transports: Array.isArray(MU_CONFIG.socketTransports) && MU_CONFIG.socketTransports.length ? MU_CONFIG.socketTransports : ["websocket", "polling"], autoConnect: false };
const socket = MU_SERVER_ORIGIN ? io(MU_SERVER_ORIGIN, socketOptions) : io(socketOptions);
// Server-relative links (/media/…) resolved against the server in the app.
function serverUrl(u) { return MU_SERVER_ORIGIN && typeof u === "string" && u.startsWith("/media/") ? MU_SERVER_ORIGIN + u : u; }
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
    // Imagery is Esri's; the roads, routes, place names and speed limits
    // drawn over it come from OpenStreetMap (OSRM, Nominatim, Overpass), so
    // the OSM credit belongs on this layer too (ODbL attribution).
    { maxZoom: 19, attribution: 'Imagery &copy; Esri, Maxar, Earthstar Geographics | Map data &copy; <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a> contributors' }
);
const OSM_CREDIT = '&copy; <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a> contributors';
const streetLayer = L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", { maxZoom: 19, attribution: OSM_CREDIT });
const darkLayer = L.tileLayer("https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png", { maxZoom: 20, attribution: `${OSM_CREDIT} &copy; <a href="https://carto.com/attributions" target="_blank" rel="noopener">CARTO</a>` });
const terrainLayer = L.tileLayer("https://{s}.tile.opentopomap.org/{z}/{x}/{y}.png", { maxZoom: 17, subdomains: "abc", attribution: `Map data: ${OSM_CREDIT}, SRTM | Map style: &copy; <a href="https://opentopomap.org" target="_blank" rel="noopener">OpenTopoMap</a> (CC-BY-SA)` });
satelliteLayer.addTo(map);

let currentUser = { name: localStorage.getItem("koraput_name") || "", avatar: localStorage.getItem("koraput_avatar") || DEFAULT_AVATAR };
let myCoords = null, myWeather = "", ownMarker = null, accuracyCircle = null, cityName = "";
let myWeatherCode = null, myWeatherCodeAt = 0;     // Open-Meteo WMO code: the roadmap Step 8 advice gate holds advice on a wet road
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
// Batch 1 (roadmap Section 6): the 8-sample moving average is replaced by a
// 1-D KALMAN filter on speed, and every fix gets a Z-SCORE against the
// filter's prediction:
//   predict   v stays, variance grows by (SIGMA_A · dt)²  (riders change
//             speed by ~1 m/s² in normal riding)
//   measure   R from the fix itself: device (Doppler) speed is good to
//             ~1.5 km/h; speed derived from two positions is only as good as
//             the positions: σ ≈ √2·(accuracy/2)/dt
//   update    v += K·(z − v), K = P/(P+R) — trusts good fixes quickly, noisy
//             derived speeds slowly, with no fixed window to lag behind
//   z-score   |z − v| / √(P+R) > Z_MAX flags a statistical spike. ONE flagged
//             fix is rejected (soft, like low confidence). A SECOND flagged
//             fix in the same direction that agrees with the first is a real
//             change (hard braking, a quick overtake): both are accepted and
//             the filter re-centres — so a genuine change can never be locked
//             out, while a one-off blip never reaches an alert.
// When the device gives NO speed (desktop, some Androids), speed from two
// positions is a magnitude — jitter only ever adds to it (≈10 km/h of fake
// speed standing still with 3 m jitter). Those fixes go through a 2-D
// constant-velocity Kalman on POSITION instead (x/y each [pos, vel]); its
// velocity averages jitter out, and |v| feeds the speed filter.
// The physical limits (8 m/s², 300 km/h teleport) stay as the hard backstop.
const GpsFilter = {
    lastSmoothed: 0,       // read by features.js ("how fast am I going", where am I) — now the Kalman estimate
    SIGMA_A_KMH_S: 4,      // process noise: ~1.1 m/s² of unexplained speed change per second
    Z_MAX: 4,
    kf: { v: 0, P: 1e4, n: 0, t: null },
    zPending: null,        // the last statistically-flagged fix { sign, speed, t }
    GATE: 0.4,             // same threshold checkSafetyLimits() acts on
    STALE_GAP_SEC: 10,     // a longer gap between good fixes restarts the average
    REANCHOR_AFTER: 3,
    anchor: null,          // last ACCEPTED fix { lat, lng, t, speedKmh }
    pending: [],           // consecutive hard-rejected fixes that agree with each other
    stats: { accepted: 0, rejected: 0, hardRejected: 0, reanchored: 0, zFlagged: 0, zConfirmed: 0 },

    // Measurement variance (km/h)² for one fix.
    measVar(speedKmh, accuracyM, dtSec, derived) {
        if (!derived) { const sd = 1.5 + 0.02 * Math.max(0, speedKmh); return sd * sd; }
        const sd = Math.max(2, Math.SQRT2 * (Math.max(1, accuracyM) / 2) / Math.max(0.5, dtSec) * 3.6);
        return sd * sd;
    },
    predictedVar(tMs) {
        const dt = this.kf.t === null ? 1 : Math.max(0, (tMs - this.kf.t) / 1000);
        return this.kf.P + (this.SIGMA_A_KMH_S * dt) ** 2;
    },
    kfReset() { this.kf = { v: 0, P: 1e4, n: 0, t: null }; this.zPending = null; this.pos = null; },

    // ---- 2-D constant-velocity position filter (for fixes without device speed)
    pos: null,             // { lat0, lng0, t, x: {p, v, P:[a,b,c]}, y: {...} }  P = [[a,b],[b,c]]
    POS_SIGMA_A: 1.2,      // m/s² of unexplained acceleration
    posUpdate(lat, lng, accuracyM, tMs) {
        const sdPos = Math.max(1.5, accuracyM / 2), R = sdPos * sdPos;
        if (!this.pos) {
            this.pos = { lat0: lat, lng0: lng, t: tMs, x: { p: 0, v: 0, P: [R, 0, 25] }, y: { p: 0, v: 0, P: [R, 0, 25] } };
            return 0;
        }
        const cos0 = Math.cos(this.pos.lat0 * Math.PI / 180);
        const mx = (lng - this.pos.lng0) * 111320 * cos0, my = (lat - this.pos.lat0) * 110540;
        const dt = Math.max(0.05, (tMs - this.pos.t) / 1000), q = this.POS_SIGMA_A ** 2;
        const step = (k, z) => {
            // predict: p += v·dt ; P = F P Fᵀ + Q
            k.p += k.v * dt;
            let [a, b, c] = k.P;
            a = a + 2 * dt * b + dt * dt * c + q * dt ** 4 / 4;
            b = b + dt * c + q * dt ** 3 / 2;
            c = c + q * dt * dt;
            // update with position z
            const S = a + R, Kp = a / S, Kv = b / S, y = z - k.p;
            k.p += Kp * y; k.v += Kv * y;
            k.P = [(1 - Kp) * a, (1 - Kp) * b, c - Kv * b];
        };
        step(this.pos.x, mx); step(this.pos.y, my);
        this.pos.t = tMs;
        return Math.hypot(this.pos.x.v, this.pos.y.v) * 3.6;     // km/h
    },
    kfUpdate(z, R, tMs) {
        const Pp = this.predictedVar(tMs);
        const K = Pp / (Pp + R);
        this.kf.v = Math.max(0, this.kf.v + K * (z - this.kf.v));
        this.kf.P = (1 - K) * Pp;
        this.kf.n++;
        this.kf.t = tMs;
        return this.kf.v;
    },
    // Kept for callers of the old API: one measurement at a nominal 2 km/h noise.
    smooth(rawSpeedKmh, tMs = Date.now()) { return this.kfUpdate(rawSpeedKmh, 4, tMs); },

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

        let conf = a
            ? gpsConfidence({ accuracyM: acc, prevSpeedKmh: a.speedKmh, newSpeedKmh: speed, dtSec, jumpDistanceKm: jumpM / 1000 })
            : accScore;                                           // first fix: nothing to compare against yet
        const teleport = Boolean(a) && jumpM / 1000 >= (300 / 3600) * dtSec;

        // Statistical spike test against the Kalman prediction (see header).
        const derived = !(Number.isFinite(fix.gpsSpeedKmh) && fix.gpsSpeedKmh >= 0);
        const R = this.measVar(speed, acc, dtSec, derived);
        let zConfirm = false;
        out.zScore = 0;
        if (a && !teleport && this.kf.n >= 3 && (this.kf.t === null || (fix.t - this.kf.t) / 1000 <= this.STALE_GAP_SEC)) {
            const z = (speed - this.kf.v) / Math.sqrt(this.predictedVar(fix.t) + R);
            out.zScore = z;
            if (Math.abs(z) > this.Z_MAX) {
                const zp = this.zPending;
                const agrees = zp && Math.sign(z) === zp.sign && fix.t - zp.t > 0 && fix.t - zp.t < 5000 &&
                    Math.abs(speed - zp.speed) / 3.6 / Math.max(0.5, (fix.t - zp.t) / 1000) < 8;
                if (agrees) { zConfirm = true; this.zPending = null; this.stats.zConfirmed++; }
                else { this.zPending = { sign: Math.sign(z), speed, t: fix.t }; conf *= 0.2; this.stats.zFlagged++; }
            } else this.zPending = null;
        }
        out.confidence = conf;

        if (conf >= this.GATE) {
            this.pending = [];
            if (dtSec > this.STALE_GAP_SEC || zConfirm) this.kfReset();     // long gap / confirmed real change: re-centre
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
                this.kfReset();
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
            const vPos = this.posUpdate(fix.lat, fix.lng, acc, fix.t);
            if (derived) {
                // Speed = the position filter's |v|; keep the speed filter in step
                // with it so a later Doppler fix starts from the right place.
                const varV = ((this.pos.x.P[2] + this.pos.y.P[2]) / 2) * 12.96;
                this.kf = { v: vPos, P: Math.max(1, varV), n: this.kf.n + 1, t: fix.t };
                this.lastSmoothed = vPos;
            } else {
                this.lastSmoothed = this.kfUpdate(out.speedKmh, this.measVar(out.speedKmh, acc, dtSec, derived), fix.t);
            }
            out.smoothedKmh = this.lastSmoothed;
            this.stats.accepted++;
        } else if (out.hardReject) this.stats.hardRejected++;
        else this.stats.rejected++;
        return out;
    },

    // Trip start: restart the filter, keep the anchor (a fresh trip must not
    // lose teleport protection on its first fix).
    reset() { this.kfReset(); this.lastSmoothed = 0; this.pending = []; }
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
        if (Number.isFinite(code)) { myWeatherCode = code; myWeatherCodeAt = Date.now(); }
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

function showToast(message, duration = 4000) {
    if (window.MapUnite && typeof window.MapUnite.toast === "function") { window.MapUnite.toast(message, duration); return; }
    const container = $("toast-container"); if (!container) return;
    const toast = document.createElement("div"); toast.className = "toast"; toast.textContent = message;
    container.appendChild(toast);
    setTimeout(() => { toast.style.opacity = '0'; setTimeout(() => toast.remove(), 300); }, duration);
}

// ============================================================================
// 4. TRIPDB — 7-day local backup + export (unchanged; app.js now reads it
//    correctly via restoreAll() instead of the nonexistent restoreTrip() /
//    restoreNavState() methods the shipped build called)
// ============================================================================
const TripDB = {
    autoSaveInterval: null,
    expiryTime: 7 * 24 * 60 * 60 * 1000,

    checkExpiry() {
        const lastSaved = localStorage.getItem('mapUnite_last_saved');
        if (lastSaved && (Date.now() - parseInt(lastSaved)) > this.expiryTime) {
            this.clearBackup();
            console.log("🗑️ [DB] 7 days passed — old local backup cleared for privacy.");
        }
    },
    startAutoSave(tripObject) {
        this.checkExpiry();
        if (this.autoSaveInterval) clearInterval(this.autoSaveInterval);
        this.autoSaveInterval = setInterval(() => {
            if (tripObject && tripObject.active) {
                localStorage.setItem('mapUnite_trip_backup', JSON.stringify(tripObject));
                localStorage.setItem('mapUnite_last_saved', Date.now().toString());
            }
        }, 5000);
    },
    saveNavState(destinationData) {
        if (destinationData) {
            localStorage.setItem('mapUnite_nav_backup', JSON.stringify(destinationData));
            localStorage.setItem('mapUnite_last_saved', Date.now().toString());
        }
    },
    saveSession(username, groupData) {
        if (username) localStorage.setItem('mapUnite_username', username);
        if (groupData) localStorage.setItem('mapUnite_group_backup', JSON.stringify(groupData));
        localStorage.setItem('mapUnite_last_saved', Date.now().toString());
    },
    restoreAll() {
        this.checkExpiry();
        return {
            username: localStorage.getItem('mapUnite_username'),
            nav: JSON.parse(localStorage.getItem('mapUnite_nav_backup') || "null"),
            trip: JSON.parse(localStorage.getItem('mapUnite_trip_backup') || "null"),
            group: JSON.parse(localStorage.getItem('mapUnite_group_backup') || "null")
        };
    },
    clearBackup() {
        localStorage.removeItem('mapUnite_trip_backup');
        localStorage.removeItem('mapUnite_nav_backup');
        localStorage.removeItem('mapUnite_group_backup');
        localStorage.removeItem('mapUnite_last_saved');
        if (this.autoSaveInterval) clearInterval(this.autoSaveInterval);
    },
    downloadDetailedInfo() {
        const allBackup = {
            ExportDate: new Date().toLocaleString(),
            Username: localStorage.getItem('mapUnite_username') || "Not Set",
            TripDetails: JSON.parse(localStorage.getItem('mapUnite_trip_backup') || "{}"),
            Navigation: JSON.parse(localStorage.getItem('mapUnite_nav_backup') || "{}"),
            GroupData: JSON.parse(localStorage.getItem('mapUnite_group_backup') || "{}")
        };
        const dataStr = "data:text/json;charset=utf-8," + encodeURIComponent(JSON.stringify(allBackup, null, 2));
        const a = document.createElement('a');
        a.setAttribute("href", dataStr);
        a.setAttribute("download", `MapUnite_Data_${new Date().toLocaleDateString().replace(/\//g, '-')}.json`);
        document.body.appendChild(a);
        a.click();
        a.remove();
    }
};
TripDB.checkExpiry();
