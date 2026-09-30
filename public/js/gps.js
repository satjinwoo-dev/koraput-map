"use strict";

/* ============================================================================
   MapUnite client — js/gps.js
   ==============================================================================
   Location tracking: OpenStreetMap road speed limits, automatic walk/ride
   detection, GPS power saving when parked, and startGPS() — the pipeline
   every fix goes through.

   Classic scripts sharing one global scope (no bundler, no build step),
   loaded by index.html in this order: core → voice → gps → navigation → smartdrive → groupnav → privacy → analytics → deadreckoning → presence → controls → chat → memories → calls → sos → pwa → skunkworks → radio → convoy → boot.
   ============================================================================ */

// ---- Road speed limits from OpenStreetMap (roadmap Section 8) -------------
// The server hands out ~1.1 km tiles of drivable roads (cached 24 h, shared
// by every rider); the phone matches EACH accepted GPS fix to a road itself —
// no request per fix, and it keeps working between tiles.
//   Matching: nearest road segment within max(20, min(40, accuracy)) m. When
//   moving, the segment must also point the way you're going (±40° for a
//   two-way road; with the flow for a one-way), so a parallel service road or
//   a flyover's slip road doesn't steal the match. A NEW road must win two
//   fixes in a row (junction flicker), three misses or 30 s without a match
//   drop back to "unknown".
//   Limit: direction-specific (maxspeed:forward/backward) and motorcycle
//   (maxspeed:motorcycle when riding a bike) values win over plain maxspeed.
//   Unknown limit -> SmartDrive keeps its flat 60/80/100 thresholds. The app
//   never invents a legal limit from the road class.
const SpeedLimits = {
    KEY: "mu_speed_limits",
    enabled: true,
    TILE_DEG: 0.01, EDGE_PREFETCH_M: 250, MAX_TILES: 60, RETRY_FAILED_MS: 60000, REQUEST_GAP_MS: 450,
    MATCH_BASE_M: 20, MATCH_MAX_M: 40, CONFIRM_FIXES: 2, LOSE_AFTER: 3, STALE_MS: 30000,
    tiles: new Map(),          // key -> { ways, at } | { failedAt }
    queue: [], pumping: false,
    current: null,             // { wayId, limit, raw, name, hw, forward, at }
    pending: null, pendingCount: 0, missCount: 0,
    last: null, heading: null,

    init() {
        try { this.enabled = localStorage.getItem(this.KEY) !== "0"; } catch (e) { /* default on */ }
        const t = $("speed-limits-toggle");
        if (t) {
            t.checked = this.enabled;
            t.addEventListener("change", () => {
                this.enabled = t.checked;
                try { localStorage.setItem(this.KEY, this.enabled ? "1" : "0"); } catch (e) { /* ignore */ }
                if (!this.enabled) this.setCurrent(null);
            });
        }
        if (typeof socket !== "undefined") socket.on("connect", () => this.pump());   // resume queued tiles after a drop
    },

    keyFor(lat, lng) { return `${Math.floor(lat / this.TILE_DEG)}:${Math.floor(lng / this.TILE_DEG)}`; },
    neighbourKeys(lat, lng) {
        const a = Math.floor(lat / this.TILE_DEG), b = Math.floor(lng / this.TILE_DEG), keys = [];
        for (let i = -1; i <= 1; i++) for (let j = -1; j <= 1; j++) keys.push(`${a + i}:${b + j}`);
        return keys;
    },

    // Own tile always; a neighbour when we're within EDGE_PREFETCH_M of that edge.
    ensureTiles(lat, lng) {
        const a = Math.floor(lat / this.TILE_DEG), b = Math.floor(lng / this.TILE_DEG);
        const fy = lat / this.TILE_DEG - a, fx = lng / this.TILE_DEG - b;
        const my = (this.EDGE_PREFETCH_M / 110540) / this.TILE_DEG, mx = (this.EDGE_PREFETCH_M / (111320 * Math.max(0.2, Math.cos(lat * Math.PI / 180)))) / this.TILE_DEG;
        const di = [0], dj = [0];
        if (fy < my) di.push(-1); if (fy > 1 - my) di.push(1);
        if (fx < mx) dj.push(-1); if (fx > 1 - mx) dj.push(1);
        di.forEach((i) => dj.forEach((j) => this.request(`${a + i}:${b + j}`)));
    },
    request(key) {
        const t = this.tiles.get(key);
        if (t && (t.ways || Date.now() - t.failedAt < this.RETRY_FAILED_MS)) return;
        if (this.queue.includes(key)) return;
        this.queue.push(key);
        this.pump();
    },
    pump() {
        if (this.pumping || !this.queue.length) return;
        if (typeof socket === "undefined" || !socket.connected) return;
        this.pumping = true;
        const key = this.queue.shift();
        socket.emit("getRoadTile", { key }, (res) => {
            if (res && res.ok && Array.isArray(res.ways)) {
                this.tiles.set(key, { ways: res.ways, at: Date.now() });
                while (this.tiles.size > this.MAX_TILES) this.tiles.delete(this.tiles.keys().next().value);
            } else if (res && (res.reason === "busy" || res.reason === "too-frequent" || res.reason === "no-profile")) {
                setTimeout(() => this.request(key), 2000);
            } else {
                this.tiles.set(key, { failedAt: Date.now() });
            }
            setTimeout(() => { this.pumping = false; this.pump(); }, this.REQUEST_GAP_MS);
        });
    },

    // Heading: the device's own when moving, else from our last position.
    updateHeading(lat, lng, headingDeg, speedKmh) {
        if (Number.isFinite(headingDeg) && speedKmh > 5) this.heading = headingDeg;
        else if (this.last) {
            const dy = (lat - this.last.lat) * 110540, dx = (lng - this.last.lng) * 111320 * Math.cos(lat * Math.PI / 180);
            if (Math.hypot(dx, dy) >= 8) this.heading = (Math.atan2(dx, dy) * 180 / Math.PI + 360) % 360;
            else return;
        }
        this.last = { lat, lng };
    },

    match(lat, lng, accuracyM, speedKmh) {
        const cosLat = Math.cos(lat * Math.PI / 180);
        const X = (g) => (g - lng) * 111320 * cosLat, Y = (a) => (a - lat) * 110540;
        const radius = Math.max(this.MATCH_BASE_M, Math.min(this.MATCH_MAX_M, Number.isFinite(accuracyM) ? accuracyM : this.MATCH_MAX_M));
        const useHeading = Number.isFinite(this.heading) && speedKmh >= 10;
        let best = null;
        this.neighbourKeys(lat, lng).forEach((k) => {
            const tile = this.tiles.get(k);
            if (!tile || !tile.ways) return;
            tile.ways.forEach((w) => (w.runs || []).forEach((r) => {
                for (let i = 0; i + 3 < r.length; i += 2) {
                    const ax = X(r[i + 1]), ay = Y(r[i]), bx = X(r[i + 3]), by = Y(r[i + 2]);
                    const vx = bx - ax, vy = by - ay, len2 = vx * vx + vy * vy;
                    if (len2 < 0.01) continue;
                    const tt = Math.max(0, Math.min(1, -(ax * vx + ay * vy) / len2));
                    const d = Math.hypot(ax + tt * vx, ay + tt * vy);
                    if (d > radius) continue;
                    const segBearing = (Math.atan2(vx, vy) * 180 / Math.PI + 360) % 360;
                    let forward = true, angPenalty = 0;
                    if (useHeading) {
                        const diff = Math.abs(((this.heading - segBearing) + 540) % 360 - 180);   // 0..180
                        forward = diff <= 90;
                        if (w.ow === 1 && diff > 60) continue;                 // against a one-way: not this road
                        if (w.ow === -1 && diff < 120) continue;
                        const along = Math.min(diff, 180 - diff);
                        if (w.ow === 0 && along > 40) continue;                // crossing road, not the one we're on
                        angPenalty = along * 0.25;
                    }
                    const sticky = this.current && this.current.wayId === w.id ? 5 : 0;
                    const score = d + angPenalty - sticky;
                    if (!best || score < best.score) best = { way: w, dist: d, forward: w.ow === -1 ? !forward : forward, score };
                }
            }));
        });
        return best;
    },

    limitFor(m) {
        const w = m.way;
        const bike = (window.currentTravelMode || "bike") === "bike";
        const dir = m.forward ? w.fwd : w.bwd;
        const limit = (bike && Number.isFinite(w.mc) ? w.mc : null) ?? (Number.isFinite(dir) ? dir : null) ?? (Number.isFinite(w.lim) ? w.lim : null);
        return { limit, raw: w.raw || null };
    },

    // Called by processLocation() for every ACCEPTED fix, before SmartDrive.tick().
    onFix({ lat, lng, speedKmh, accuracyM, headingDeg }) {
        if (!this.enabled || !validCoord(lat, lng)) return;
        this.updateHeading(lat, lng, headingDeg, speedKmh || 0);
        this.ensureTiles(lat, lng);
        const m = this.match(lat, lng, accuracyM, speedKmh || 0);
        if (!m) {
            this.missCount++;
            if (this.missCount >= this.LOSE_AFTER) this.setCurrent(null);
            return;
        }
        this.missCount = 0;
        if (this.current && this.current.wayId === m.way.id) {
            this.pending = null; this.pendingCount = 0;
            this.setCurrent(m);                                  // refresh time; direction may have flipped
            return;
        }
        if (this.pending && this.pending.way.id === m.way.id) this.pendingCount++;
        else { this.pending = m; this.pendingCount = 1; }
        if (!this.current || this.pendingCount >= this.CONFIRM_FIXES) { this.setCurrent(m); this.pending = null; this.pendingCount = 0; }
    },

    setCurrent(m) {
        const prevLimit = this.current ? this.current.limit : null;
        if (!m) this.current = null;
        else {
            const { limit, raw } = this.limitFor(m);
            this.current = { wayId: m.way.id, limit, raw, name: m.way.name || "", hw: m.way.hw, forward: m.forward, at: Date.now() };
        }
        const limit = this.current ? this.current.limit : null;
        if (limit !== prevLimit) {
            // A new limit starts its own alert ladder: a 40-zone alert must not be
            // swallowed by the cooldown of a 60-zone one a few seconds earlier.
            if (typeof SmartDrive !== "undefined") { SmartDrive.lastAlertTier = 0; SmartDrive.lastAlertTime = 0; }
            document.dispatchEvent(new CustomEvent("mu:speed-limit", { detail: { limit, name: this.current ? this.current.name : "" } }));
        }
        this.renderSign();
    },

    known() {
        return Boolean(this.enabled && this.current && Number.isFinite(this.current.limit) && Date.now() - this.current.at < this.STALE_MS);
    },
    // Road-based alert levels: over the limit (+ a small GPS grace), well over
    // (+15), far over (+30). null -> unknown. SmartDrive only ever uses these
    // to make an alert EARLIER than its own 60/80/100 ladder, never later: OSM
    // limits are usually the car limit (motorcycles often have lower legal
    // limits in India), and a high posted limit must not switch off the app's
    // own safety alerts.
    thresholds() {
        if (!this.known()) return null;
        const L = this.current.limit;
        return { limit: L, t1: L + Math.max(3, Math.round(L * 0.05)), t2: L + 15, t3: L + 30 };
    },

    renderSign() {
        const sign = $("speed-limit-sign"), n = $("speed-limit-n");
        if (!sign || !n) return;
        const show = this.known();
        sign.hidden = !show;
        if (show) {
            n.textContent = String(this.current.limit);
            sign.setAttribute("aria-label", `Speed limit ${this.current.limit} kilometres per hour${this.current.name ? ` on ${this.current.name}` : ""}, from OpenStreetMap`);
            sign.title = `Limit ${this.current.limit} km/h${this.current.raw && /mph/i.test(this.current.raw) ? ` (${this.current.raw})` : ""} · OpenStreetMap`;
        }
    },

    describe() {
        if (!this.enabled) return "Road speed limits are turned off in settings.";
        if (this.known()) return `The limit here is ${this.current.limit} kilometres per hour${this.current.name ? ` on ${this.current.name}` : ""}, according to OpenStreetMap. Road signs always win.`;
        if (this.current) return "This road has no speed limit in OpenStreetMap, so I'm using the standard 60, 80 and 100 alerts.";
        return "I don't know the speed limit here yet.";
    }
};

// ============================================================================
// AUTOMATIC WALK / RIDE DETECTION (roadmap Section 8: GpsFilter.detectMode)
// ============================================================================
// Speed can tell walking from riding, but not a car from a motorbike — so
// this only moves between WALK and your last VEHICLE mode (bike or car):
//   walk -> vehicle   AUTOMATIC once detectMode() says "drive" on a sustained
//                     30 s average (every sample >= 15 km/h). Walking turns
//                     speed alerts and pothole detection off, so riding in
//                     walk mode is a safety gap worth closing without a tap.
//   vehicle -> walk   only SUGGESTED (a status-island action): 2 minutes at
//                     walking pace could also be a traffic crawl.
//   walk + "cycle"    band (7–25 km/h for a minute) -> suggestion as well.
// A manual pick is respected: no automatic change for 10 minutes after one.
const ModeDetector = {
    KEY: "mu_auto_mode",
    enabled: true,
    WINDOW_MS: 120000,
    samples: [],               // { t, v, lat, lng }
    lastVehicle: "bike",
    manualAt: 0, MANUAL_HOLD_MS: 600000,
    lastSuggestAt: 0, SUGGEST_EVERY_MS: 600000,
    auto: false,
    stats: { autoSwitches: 0, suggestions: 0 },

    init() {
        try { this.enabled = localStorage.getItem(this.KEY) !== "0"; } catch (e) { /* default on */ }
        const t = $("auto-mode-toggle");
        if (t) {
            t.checked = this.enabled;
            t.addEventListener("change", () => { this.enabled = t.checked; try { localStorage.setItem(this.KEY, this.enabled ? "1" : "0"); } catch (e) { /* ignore */ } });
        }
        // Wrap the mode setter (features.js) so manual picks are remembered.
        const orig = window.setTravelMode;
        if (typeof orig === "function" && !orig.__muWrapped) {
            const self = this;
            const wrapped = function (mode) {
                if (!self.auto) self.manualAt = Date.now();
                if (mode === "car" || mode === "bike") self.lastVehicle = mode;
                return orig.apply(this, arguments);
            };
            wrapped.__muWrapped = true;
            window.setTravelMode = wrapped;
        }
        const cur = window.currentTravelMode;
        if (cur === "car" || cur === "bike") this.lastVehicle = cur;
    },

    mode() { return window.currentTravelMode || "bike"; },
    setMode(mode) {
        this.auto = true;
        try { if (typeof window.setTravelMode === "function") window.setTravelMode(mode); else window.currentTravelMode = mode; }
        finally { this.auto = false; }
    },

    // Every ACCEPTED fix (processLocation).
    onFix({ lat, lng, speedKmh, t = Date.now() }) {
        this.samples.push({ t, v: speedKmh, lat, lng });
        while (this.samples.length && t - this.samples[0].t > this.WINDOW_MS) this.samples.shift();
        if (!this.enabled || t - this.manualAt < this.MANUAL_HOLD_MS) return;
        const within = (ms) => this.samples.filter((x) => t - x.t <= ms);
        const span = (arr) => (arr.length ? arr[arr.length - 1].t - arr[0].t : 0);
        const avg = (arr) => arr.reduce((a, x) => a + x.v, 0) / Math.max(1, arr.length);
        const mode = this.mode();

        if (mode === "walk") {
            const w30 = within(30000);
            if (w30.length >= 5 && span(w30) >= 25000 && GpsFilter.detectMode(avg(w30)) === "drive" && w30.every((x) => x.v >= 15)) {
                this.setMode(this.lastVehicle);
                this.stats.autoSwitches++;
                islandShow({ id: "mode", kind: "info", icon: this.lastVehicle === "car" ? "🚗" : "🏍️", title: "Riding detected", sub: "Speed alerts and road-hazard alerts are back on", ttl: 5000 });
                voiceAnnounce("Riding detected. Speed alerts are back on.", { priority: 60, key: "mode-auto", cooldownMs: 120000, category: "speed" });
                return;
            }
            const w60 = within(60000);
            if (w60.length >= 8 && span(w60) >= 50000 && GpsFilter.detectMode(avg(w60)) === "cycle" && w60.every((x) => x.v >= 5)) {
                this.suggest(this.lastVehicle, `Moving at about ${Math.round(avg(w60))} km/h — riding?`);
            }
            return;
        }
        // vehicle mode: walking pace for 2 minutes, never faster than 9 km/h, and actually covering ground
        const w = within(this.WINDOW_MS);
        if (w.length >= 10 && span(w) >= 110000) {
            const a = avg(w), maxV = Math.max(...w.map((x) => x.v));
            const moved = GpsFilter.metres(w[0].lat, w[0].lng, w[w.length - 1].lat, w[w.length - 1].lng);
            if (GpsFilter.detectMode(a) === "walk" && a >= 2.5 && maxV < 9 && moved >= 120) this.suggest("walk", `Walking pace for 2 minutes (${Math.round(moved)} m) — switch to walking?`);
        }
    },

    suggest(mode, text) {
        const now = Date.now();
        if (now - this.lastSuggestAt < this.SUGGEST_EVERY_MS) return;
        this.lastSuggestAt = now;
        this.stats.suggestions++;
        const label = mode === "walk" ? "Walking" : mode === "car" ? "Car" : "Bike";
        islandShow({ id: "mode", kind: "info", icon: mode === "walk" ? "🚶" : "🏍️", title: text, sub: `Tap to switch to ${label} mode`, ttl: 12000,
            action: { label: `Switch to ${label}`, onClick: () => { window.setTravelMode ? window.setTravelMode(mode) : (window.currentTravelMode = mode); } } });
    }
};

// ============================================================================
// GPS POWER — back off when parked (roadmap Section 24)
// ============================================================================
// The main GPS watch was always { enableHighAccuracy: true, maximumAge: 2 s }:
// tuned for "always moving", paid for while parked at a chai stop too. After
// PARK_AFTER_MS with every good fix inside a small circle (and no navigation,
// tunnel estimate or pending SOS), the watch is swapped for a low-power one
// (network location, 60 s maximumAge). Browsers can't change a watch's
// options, so it's clearWatch + a new watchPosition.
// While parked:
//   - fixes consistent with standing still are absorbed (no marker jitter
//     from coarse network fixes, no pointless broadcasts);
//   - the squad still hears from us: the last good position is re-sent every
//     HEARTBEAT_MS, well under the convoy's 3-minute "no signal" rule;
//   - one high-accuracy fix every CHECK_EVERY_MS confirms we haven't moved.
// Wakes to full power on: a fix that shows movement, sustained phone motion
// (accelerometer, where the browser gives it without a prompt), a drive or
// navigation starting, the app coming back to the foreground, or the setting
// being turned off.
const GpsPower = {
    KEY: "mu_gps_saver",
    enabled: true,
    mode: "high",
    HIGH_OPTS: { enableHighAccuracy: true, timeout: 15000, maximumAge: 2000 },
    LOW_OPTS: { enableHighAccuracy: false, timeout: 60000, maximumAge: 60000 },
    PARK_AFTER_MS: 180000, PARK_RADIUS_M: 30, MOVE_MIN_M: 60,
    HEARTBEAT_MS: 60000, CHECK_EVERY_MS: 600000,
    MOTION_RMS: 1.2, MOTION_SUSTAIN_MS: 2500,
    watchId: null, onFix: null, onErr: null,
    still: null,                 // { lat, lng, acc, since } — where we've been standing
    parkedAt: 0, heartbeatTimer: null, checkTimer: null,
    motion: { samples: [], above: 0 }, motionHandler: null,
    stats: { parks: 0, wakes: {}, absorbed: 0, heartbeats: 0, checks: 0 },

    init() {
        try { this.enabled = localStorage.getItem(this.KEY) !== "0"; } catch (e) { /* default on */ }
        const t = $("gps-saver-toggle");
        if (t) {
            t.checked = this.enabled;
            t.addEventListener("change", () => {
                this.enabled = t.checked;
                try { localStorage.setItem(this.KEY, this.enabled ? "1" : "0"); } catch (e) { /* ignore */ }
                if (!this.enabled) this.wake("setting-off");
            });
        }
        document.addEventListener("mu:drive-state", (e) => { if (e.detail && (e.detail.driving || e.detail.navigating)) this.wake("drive"); });
        document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible") this.wake("foreground"); });
    },

    // startGPS() hands over its callbacks; this owns the main watch from then on.
    start(onFix, onErr) {
        this.onFix = onFix; this.onErr = onErr;
        this.watch(this.HIGH_OPTS);
    },
    watch(opts) {
        if (!navigator.geolocation) return;
        if (this.watchId !== null) navigator.geolocation.clearWatch(this.watchId);
        this.watchId = navigator.geolocation.watchPosition(this.onFix, this.onErr, opts);
    },

    allowed() {
        if (!this.enabled) return false;
        if (typeof navState !== "undefined" && navState.active) return false;
        if (typeof DeadReckoning !== "undefined" && DeadReckoning.core && DeadReckoning.core.active()) return false;
        if (typeof pendingSos !== "undefined" && pendingSos) return false;
        return true;
    },

    // Every ACCEPTED fix in full-power mode: are we still standing in one place?
    // Position decides, not derived speed: standing still, a few metres of
    // jitter per fix reads as 2–6 km/h once turned into a speed. Only the
    // device's OWN speed report (Doppler) counts as "moving" on its own.
    note({ lat, lng, accuracyM, deviceSpeedKmh }) {
        if (this.mode !== "high") return;
        const now = Date.now();
        const r = Math.max(this.PARK_RADIUS_M, Math.min(60, 1.5 * (accuracyM || 0)));
        if (!this.still || GpsFilter.metres(this.still.lat, this.still.lng, lat, lng) > r || deviceSpeedKmh > 5) {
            this.still = { lat, lng, acc: accuracyM, since: now };
            return;
        }
        if (now - this.still.since >= this.PARK_AFTER_MS && this.allowed()) this.park();
    },

    park() {
        if (this.mode === "low") return;
        this.mode = "low";
        this.parkedAt = Date.now();
        this.stats.parks++;
        this.watch(this.LOW_OPTS);
        this.heartbeatTimer = setInterval(() => this.heartbeat(), this.HEARTBEAT_MS);
        this.checkTimer = setInterval(() => this.check(), this.CHECK_EVERY_MS);
        this.listenMotion(true);
        if (window.StatusIsland) window.StatusIsland.setIdle({ text: "Parked · saving battery", tone: "ok" });
        islandShow({ id: "gps-power", kind: "safe", icon: "🅿️", title: "Parked — GPS saving battery", sub: "Full GPS comes back as soon as you move", ttl: 3500, haptic: false });
        document.dispatchEvent(new CustomEvent("mu:gps-power", { detail: { mode: "low" } }));
    },

    wake(reason) {
        if (this.mode === "high") { if (this.still) this.still.since = Date.now(); return; }
        this.mode = "high";
        this.stats.wakes[reason] = (this.stats.wakes[reason] || 0) + 1;
        clearInterval(this.heartbeatTimer); clearInterval(this.checkTimer);
        this.heartbeatTimer = this.checkTimer = null;
        this.listenMotion(false);
        this.still = null;                            // must stand still a full PARK_AFTER_MS again
        this.watch(this.HIGH_OPTS);
        if (window.StatusIsland) window.StatusIsland.setIdle({ text: navigator.onLine === false ? "Offline" : "Live", tone: navigator.onLine === false ? "warn" : "ok" });
        document.dispatchEvent(new CustomEvent("mu:gps-power", { detail: { mode: "high", reason } }));
    },

    // Parked: does this (probably coarse) fix say we've moved? If not, swallow it.
    absorb(p) {
        if (this.mode !== "low" || !this.still || !p || !p.coords) return false;
        const lat = Number(p.coords.latitude), lng = Number(p.coords.longitude), acc = Number(p.coords.accuracy);
        if (!validCoord(lat, lng)) return true;
        const d = GpsFilter.metres(this.still.lat, this.still.lng, lat, lng);
        const speedKmh = p.coords.speed != null && p.coords.speed > 0 ? p.coords.speed * 3.6 : 0;
        // Moved = beyond the fix's own uncertainty (and a floor for Wi-Fi jitter), or a real speed.
        if (d > Math.max(this.MOVE_MIN_M, 1.5 * (Number.isFinite(acc) ? acc : 100)) || speedKmh > 8) {
            this.wake("moved");
            return false;                             // let this fix through: it's news
        }
        this.stats.absorbed++;
        return true;
    },

    // Keep the squad's convoy view fed (their "no signal" flag trips at 3 min).
    heartbeat() {
        if (this.mode !== "low" || typeof socket === "undefined" || !socket.connected || !myCoords || myCoords.est) return;
        this.stats.heartbeats++;
        emitLocation({ lat: myCoords.lat, lng: myCoords.lng, alt: myCoords.alt ?? null, speedKmh: 0, accuracy: this.still ? this.still.acc : null, weather: myWeather });
    },

    // One precise fix now and then: parked-but-drifted (towed, pushed, walked
    // off without the phone moving much) shouldn't go unnoticed for long.
    check() {
        if (this.mode !== "low" || !navigator.geolocation) return;
        this.stats.checks++;
        navigator.geolocation.getCurrentPosition((p) => {
            if (this.mode !== "low") return;
            const lat = Number(p.coords.latitude), lng = Number(p.coords.longitude), acc = Number(p.coords.accuracy);
            if (!validCoord(lat, lng) || !this.still) return;
            if (GpsFilter.metres(this.still.lat, this.still.lng, lat, lng) > Math.max(this.MOVE_MIN_M, 1.5 * acc)) {
                this.wake("check-moved");
                if (this.onFix) this.onFix(p);
            }
        }, () => { /* no precise fix right now — the low-power watch still runs */ }, { enableHighAccuracy: true, maximumAge: 0, timeout: 20000 });
    },

    // Sustained acceleration (RMS of |a| minus gravity over ~2.5 s) = moving.
    listenMotion(on) {
        if (on) {
            if (this.motionHandler || typeof window.DeviceMotionEvent === "undefined") return;
            this.motion = { samples: [], above: 0 };
            this.motionHandler = (e) => {
                const a = e.acceleration && Number.isFinite(e.acceleration.x) ? e.acceleration : null;
                const g = e.accelerationIncludingGravity;
                let mag;
                if (a) mag = Math.hypot(a.x || 0, a.y || 0, a.z || 0);
                else if (g && Number.isFinite(g.x)) mag = Math.abs(Math.hypot(g.x || 0, g.y || 0, g.z || 0) - 9.81);
                else return;
                const now = Date.now(), m = this.motion;
                m.samples.push({ t: now, v: mag });
                while (m.samples.length && now - m.samples[0].t > 1000) m.samples.shift();
                const rms = Math.sqrt(m.samples.reduce((acc2, x) => acc2 + x.v * x.v, 0) / m.samples.length);
                if (rms > this.MOTION_RMS) { if (!m.above) m.above = now; else if (now - m.above >= this.MOTION_SUSTAIN_MS) this.wake("motion"); }
                else m.above = 0;
            };
            window.addEventListener("devicemotion", this.motionHandler);
        } else if (this.motionHandler) {
            window.removeEventListener("devicemotion", this.motionHandler);
            this.motionHandler = null;
        }
    }
};

function startGPS() {
    if (!navigator.geolocation) {
        showToast("❌ Browser does not support GPS");
        return;
    }

    const processLocation = async (p) => {
        // Phase 4: during a GPS outage a coarse network fix is absorbed by the
        // dead-reckoning estimate instead of yanking the marker ~1 km away.
        if (DeadReckoning.onGpsFix(p) === "suppress") return;
        // Parked (low-power GPS): a coarse fix that doesn't show movement changes nothing.
        if (GpsPower.absorb(p)) return;
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

        // Which road am I on, and its posted limit (OpenStreetMap)? Accepted
        // fixes only — a weak fix could snap to the wrong road.
        if (fix.accepted) ModeDetector.onFix({ lat, lng, speedKmh: fix.smoothedKmh, t: Date.now() });
        if (fix.accepted) GpsPower.note({ lat, lng, accuracyM: acc, deviceSpeedKmh: p.coords.speed != null && p.coords.speed > 0 ? p.coords.speed * 3.6 : 0 });
        if (fix.accepted) SpeedLimits.onFix({ lat, lng, speedKmh: fix.smoothedKmh, accuracyM: acc, headingDeg: p.coords.heading == null ? NaN : Number(p.coords.heading) });
        // The verdict carries the real accuracy/dt/distance from the last GOOD fix.
        SmartDrive.tick(fix);

        emitLocation({ lat, lng, alt, speedKmh, accuracy: acc, weather: myWeather });
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
    // The main watch belongs to GpsPower: full power while moving, low power once parked.
    GpsPower.start(processLocation, handleGpsError);
}
