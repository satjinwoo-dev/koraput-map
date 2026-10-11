"use strict";

/* ============================================================================
   MapUnite client — js/native/bridge.js  (Android app only)
   ==============================================================================
   Loaded ONLY in the Capacitor build, after js/boot.js. Two native features
   the web app can't have:

   1. NativeLocation — background location. While a ride is recording or you
      are in a group trip (and sharing isn't off), @capgo/background-geolocation
      runs a foreground service with a notification. Each fix is POSTed by
      NATIVE code to the server's /api/native/location (device id + device
      token headers), so your squad keeps seeing you even when Android
      throttles or freezes the WebView, or the app is swiped away. While the
      page is hidden the same fixes also feed the app's own GPS pipeline, so
      the ride recording and speed alerts continue. Stops the moment the ride
      and the trip are over — never 24/7 tracking.

   2. NativeProximity — Bluetooth "peripheral" mode. Inside a group trip the
      phone advertises a Bluetooth LE beacon carrying this trip's tag + your
      per-trip rider id (the same pseudonymous ids the radio relay uses, from
      getRelayCredentials — nothing linkable across trips), and scans for the
      same beacon from trip-mates. Riders within ~50 m show in the radar panel
      ("📡 Rahul — very close · Bluetooth") with no GPS or network needed —
      in a basement car park, a tunnel, or with no signal. Advertising uses
      the MapUniteNative plugin (native/android/MapUniteNativePlugin.java);
      scanning uses @capacitor-community/bluetooth-le.
   ============================================================================ */

(function () {
    const core = window.capacitorExports;
    const Cap = core && core.Capacitor;
    if (!Cap || typeof Cap.isNativePlatform !== "function" || !Cap.isNativePlatform()) return;
    if (!MU_SERVER_ORIGIN) { console.warn("[native] MU_SERVER_ORIGIN missing — rebuild with scripts/build-native.mjs"); return; }

    const BG = window.capacitorBackgroundGeolocation && window.capacitorBackgroundGeolocation.BackgroundGeolocation;
    const BLEX = window.capacitorCommunityBluetoothLe;
    const BLE = BLEX && BLEX.BleClient;
    const Native = typeof core.registerPlugin === "function" ? core.registerPlugin("MapUniteNative") : null;

    // ------------------------------------------------------------------
    // 1. Background location
    // ------------------------------------------------------------------
    // How the plugin reports problems: start() is a callback method, so its
    // promise resolves straight away and every failure arrives in the
    // callback as (undefined, { code, message }) — never as a rejection.
    //   NOT_AUTHORIZED  location permission denied (or only "approximate"
    //                   granted — GPS needs precise), or Location turned off
    //   ALREADY_STARTED the native service is still attached from before a
    //                   page reload
    //   FOREGROUND_SERVICE_START_NOT_ALLOWED  Android 12+ refuses to start a
    //                   location service while the app is in the background
    const NativeLocation = {
        running: false, starting: false, headersKey: "", lastFixAt: 0, stats: { fixes: 0, fed: 0, errors: 0 },
        blocked: null,          // { code, until } — don't re-prompt in a loop after a "no"
        announced: false, reconciled: false, restartedOnce: false,

        inTrip() { return Boolean(currentTrip && Array.isArray(currentTrip.members) && currentTrip.members.some((m) => m.id === socket.id)); },
        wanted() {
            return Boolean(BG && DeviceIdentity.id && DeviceIdentity.token && PrivacyControls.canShare() &&
                ((SmartDrive.trip && SmartDrive.trip.active) || this.inTrip()));
        },
        headers() { return { "X-MU-Device": DeviceIdentity.id, "Authorization": `Bearer ${DeviceIdentity.token}` }; },
        isBlocked() { return Boolean(this.blocked && Date.now() < this.blocked.until); },

        async sync() {
            const want = this.wanted();
            if (want && !this.running && !this.starting) {
                if (this.isBlocked()) return;
                // Android 12+ only lets the app start a location service while
                // it's on screen; wait until it is.
                if (document.visibilityState === "hidden") return;
                return this.start();
            }
            if (!want && this.running) return this.stop();
            if (want && this.running) {
                const key = JSON.stringify(this.headers());
                if (key !== this.headersKey && typeof BG.updateHeaders === "function") {       // identity was reset
                    this.headersKey = key;
                    BG.updateHeaders({ headers: this.headers() }).catch(() => { this.stop().then(() => this.sync()); });
                }
            }
        },

        async start() {
            this.starting = true;
            this.announced = false;
            try {
                // Android 13+: without this the service still runs, but its
                // notification is hidden (and the rider can't stop it from there).
                if (Native) await Native.requestNotifications().catch(() => null);
                this.headersKey = JSON.stringify(this.headers());
                this.running = true;          // errors arrive in onFix and clear it
                await BG.start({
                    backgroundTitle: "MapUnite is sharing your ride",
                    backgroundMessage: "Your squad sees you while this ride or trip is on. Stop the ride to stop sharing.",
                    requestPermissions: true,
                    stale: false,
                    distanceFilter: 0,              // keep parked heartbeats (squad's "no signal" flag trips at 3 min)
                    minIntervalMs: 10000,           // one native POST every 10 s at most (also the GPS interval)
                    networkFallback: true,          // cell/Wi-Fi fix when GPS goes quiet (plugin ≥ 8.5; ignored before)
                    url: `${MU_SERVER_ORIGIN}/api/native/location`,
                    headers: this.headers()
                }, (loc, err) => this.onFix(loc, err));
            } catch (e) {
                this.running = false;
                console.warn("[native] background location didn't start:", e && e.message);
            } finally {
                this.starting = false;
            }
        },

        async stop() {
            this.running = false;
            this.announced = false;
            try { await BG.stop(); } catch (e) { /* already stopped */ }
            // After an app restart the plugin no longer holds the service, so
            // BG.stop() alone can't reach a service that kept running (native
            // delivery outlives the app on purpose). Stop it directly too.
            if (Native && typeof Native.stopBackgroundTracking === "function") {
                try { await Native.stopBackgroundTracking(); } catch (e) { /* older native build */ }
            }
        },

        // Once the app has settled after launch: a service still running from
        // a ride that's no longer active (app was killed mid-ride, then
        // reopened) is stopped, so sharing never continues past the ride.
        async reconcile() {
            if (this.reconciled) return;
            this.reconciled = true;
            if (this.running || this.starting || this.wanted()) return;
            if (!Native || typeof Native.backgroundTrackingStatus !== "function") return;
            try {
                const st = await Native.backgroundTrackingStatus();
                if (st && st.configured) {
                    await this.stop();
                    islandShow({ id: "native-bg-orphan", kind: "info", icon: "📡", title: "Background sharing stopped", sub: "It was left on from your last ride", ttl: 5000, haptic: false });
                }
            } catch (e) { /* ignore */ }
        },

        onError(err) {
            this.stats.errors++;
            this.running = false;
            const code = String((err && err.code) || "");
            const msg = String((err && err.message) || "");
            console.warn("[native] background location:", code || "error", msg);
            if (code === "ALREADY_STARTED" && !this.restartedOnce) {
                // Still attached from before a page reload: restart it so fixes reach this page again.
                this.restartedOnce = true;
                BG.stop().catch(() => null).then(() => this.sync());
                return;
            }
            if (code === "FOREGROUND_SERVICE_START_NOT_ALLOWED") return;      // retried when the app is on screen again
            if (code === "NOT_AUTHORIZED" && /disabled/i.test(msg)) {
                this.blocked = { code: "LOCATION_OFF", until: Date.now() + 60_000 };
                showToast("Turn on Location for MapUnite to share your ride.", 6000);
                return;
            }
            if (code === "NOT_AUTHORIZED") {
                // Don't ask again in a loop; the rider can fix it in Settings.
                this.blocked = { code, until: Date.now() + 30 * 60_000 };
                islandShow({
                    id: "native-bg-perm", kind: "sensor", icon: "📍", priority: 47, ttl: 10000, haptic: false,
                    title: "Background sharing is off", sub: "Allow precise location for MapUnite",
                    action: { label: "Settings", onClick: () => { this.blocked = null; try { BG.openSettings(); } catch (e) { /* ignore */ } } }
                });
                return;
            }
            this.blocked = { code: code || "ERROR", until: Date.now() + 2 * 60_000 };
        },

        onFix(loc, err) {
            if (err) return this.onError(err);
            if (!loc || !Number.isFinite(loc.latitude) || !Number.isFinite(loc.longitude)) return;
            this.stats.fixes++;
            this.lastFixAt = Date.now();
            this.blocked = null;
            if (!this.announced) {
                // Only now is it certain the service is running.
                this.announced = true;
                islandShow({ id: "native-bg", kind: "safe", icon: "📡", title: "Sharing continues in the background", sub: "See the notification · stops when the ride ends", ttl: 4000, haptic: false });
            }
            // In the foreground the WebView's own GPS drives everything; hidden,
            // these fixes keep the ride recording and alerts going.
            if (document.visibilityState === "hidden" && typeof window.__muProcessLocation === "function") {
                this.stats.fed++;
                window.__muProcessLocation({
                    coords: {
                        latitude: loc.latitude, longitude: loc.longitude, accuracy: Number.isFinite(loc.accuracy) ? loc.accuracy : 50,
                        altitude: loc.altitude ?? null, altitudeAccuracy: loc.altitudeAccuracy ?? null,
                        heading: loc.bearing ?? null, speed: loc.speed ?? null
                    },
                    timestamp: Number.isFinite(loc.time) ? loc.time : Date.now()
                });
            }
        }
    };

    // ------------------------------------------------------------------
    // 2. Bluetooth proximity between trip-mates
    // ------------------------------------------------------------------
    const NativeProximity = {
        SERVICE: "6d61702d-756e-6974-652d-626561636f6e",   // "map-unite-beacon" in ASCII
        token: null, advertising: false, scanning: false, seen: new Map(), announced: new Map(),
        bleReady: null, ownCreds: null, askedAt: 0, askTimer: null, rosterAskAt: 0,
        permBlockedUntil: 0, advertiseUnsupported: false, btOffShown: false, syncing: false,

        valid(c) { return Boolean(c && /^[0-9a-f]{8}$/i.test(c.tag || "") && /^[0-9a-f]{8}$/i.test(c.rid || "")); },
        // The radio relay's ids when a Meshtastic radio is paired; otherwise
        // the same per-trip ids fetched just for Bluetooth proximity.
        creds() {
            const c = window.ConvoyRelay && ConvoyRelay.creds;
            if (this.valid(c)) return c;
            return this.valid(this.ownCreds) ? this.ownCreds : null;
        },
        inTrip() { return Boolean(window.ConvoyRelay && ConvoyRelay.inTrip()); },
        wanted() { return Boolean(this.creds() && this.inTrip() && PrivacyControls.state.sharingMode !== "off"); },

        // Per-trip ids for riders without a radio (same server call, radio:false).
        askCreds() {
            if (!socket.connected || !this.inTrip() || !(Native || BLE)) return;
            const wait = 2600 - (Date.now() - this.askedAt);
            if (wait > 0) { clearTimeout(this.askTimer); this.askTimer = setTimeout(() => this.askCreds(), wait); return; }
            this.askedAt = Date.now();
            socket.emit("getRelayCredentials", { radio: false }, (res) => {
                if (res && res.ok) { this.ownCreds = { tripId: res.tripId, tag: res.tag, rid: res.rid, roster: res.roster || [] }; this.sync(); }
                else if (res && res.reason === "not-in-trip") { this.ownCreds = null; this.sync(); }
                else if (res && res.reason === "too-frequent") { clearTimeout(this.askTimer); this.askTimer = setTimeout(() => this.askCreds(), 2600); }
            });
        },
        onTripChange() {
            if (!this.inTrip()) { this.ownCreds = null; return this.sync(); }
            // New trip or roster change: refresh our own ids unless the radio relay has them.
            if (!this.valid(window.ConvoyRelay && ConvoyRelay.creds)) this.askCreds();
            this.sync();
        },

        async sync() {
            if (!this.wanted()) {
                if (this.inTrip() && !this.creds() && PrivacyControls.state.sharingMode !== "off") this.askCreds();
                return this.stop();
            }
            const c = this.creds();
            const token = (c.tag + c.rid).toLowerCase();
            if (token === this.token && (this.advertising || this.scanning)) return;
            // A "no" to Nearby devices: don't put the dialog up again every 15 s.
            if (this.permBlockedUntil > Date.now()) return;
            if (this.syncing) return;
            this.syncing = true;
            try {
                await this.stop();
                this.token = token;
                let denied = false, btOff = false;
                if (Native && !this.advertiseUnsupported) {
                    try { await Native.startBeacon({ serviceUuid: this.SERVICE, data: token, txPower: "medium", mode: "balanced" }); this.advertising = true; }
                    catch (e) {
                        const code = String((e && e.code) || ""), msg = String((e && e.message) || "");
                        if (code === "PERMISSION_DENIED" || /permission/i.test(msg)) denied = true;
                        else if (code === "BLUETOOTH_OFF") btOff = true;
                        else if (code === "UNSUPPORTED") this.advertiseUnsupported = true;     // this phone can still see others
                        console.warn("[native] beacon not advertising:", code || msg);
                    }
                }
                if (BLE && !denied) {
                    try {
                        this.bleReady = this.bleReady || BLE.initialize({ androidNeverForLocation: false });   // beacons are filtered out with neverForLocation
                        await this.bleReady;
                        const mode = BLEX.ScanMode ? BLEX.ScanMode.SCAN_MODE_BALANCED : 1;
                        await BLE.requestLEScan({ services: [this.SERVICE], allowDuplicates: true, scanMode: mode }, (r) => this.onScan(r));
                        this.scanning = true;
                    } catch (e) {
                        this.bleReady = null;
                        const msg = String((e && e.message) || "");
                        if (/permission/i.test(msg)) denied = true;
                        else if (/disabled|not enabled|off/i.test(msg)) btOff = true;
                        console.warn("[native] beacon scan failed:", msg);
                    }
                }
                if (denied) {
                    this.token = null;
                    this.permBlockedUntil = Date.now() + 30 * 60_000;
                    islandShow({
                        id: "ble-perm", kind: "info", icon: "📡", ttl: 8000, haptic: false,
                        title: "Nearby trip-mates over Bluetooth is off", sub: "Allow “Nearby devices” for MapUnite to use it",
                        action: BG && typeof BG.openSettings === "function" ? { label: "Settings", onClick: () => { this.permBlockedUntil = 0; BG.openSettings().catch(() => null); } } : undefined
                    });
                } else if (btOff && !this.btOffShown) {
                    this.btOffShown = true;          // once per app session; retried quietly on each sync
                    islandShow({ id: "ble-off", kind: "info", icon: "📡", ttl: 5000, haptic: false, title: "Bluetooth is off", sub: "Turn it on to see trip-mates right next to you" });
                }
            } finally {
                this.syncing = false;
            }
        },

        async stop() {
            this.token = null;
            if (this.advertising && Native) { try { await Native.stopBeacon(); } catch (e) { /* ignore */ } }
            if (this.scanning && BLE) { try { await BLE.stopLEScan(); } catch (e) { /* ignore */ } }
            this.advertising = false; this.scanning = false;
            this.seen.clear();
        },

        hexOf(dv) {
            if (!dv) return "";
            const v = dv instanceof DataView ? dv : new DataView(dv.buffer || dv);
            let s = "";
            for (let i = 0; i < v.byteLength; i++) s += v.getUint8(i).toString(16).padStart(2, "0");
            return s;
        },

        // Rough distance from signal strength: log-distance path loss, n = 2.2.
        // Bodies, pockets and bikes add ±10 dB, so it's shown as a band.
        metres(rssi, txPower) {
            const at1m = Number.isFinite(txPower) && txPower !== 127 && txPower > -40 && txPower < 20 ? txPower - 41 : -59;
            return Math.pow(10, (at1m - rssi) / 22);
        },
        label(m) { return m < 4 ? "right next to you" : m < 15 ? "very close" : m < 40 ? "nearby" : "in Bluetooth range"; },

        onScan(r) {
            const c = this.creds();
            if (!c || !r || !Number.isFinite(r.rssi)) return;
            const sd = r.serviceData || {};
            const key = Object.keys(sd).find((k) => k.toLowerCase() === this.SERVICE);
            const hex = key ? this.hexOf(sd[key]) : "";
            if (hex.length < 16 || hex.slice(0, 8) !== c.tag.toLowerCase()) return;        // not our trip
            const rid = hex.slice(8, 16);
            if (rid === c.rid.toLowerCase()) return;
            const member = (c.roster || []).find((m) => String(m.rid).toLowerCase() === rid);
            if (!member) {
                // Someone who joined after our ids were issued: refresh the roster (at most every 30 s).
                if (c === this.ownCreds && Date.now() - this.rosterAskAt > 30_000) { this.rosterAskAt = Date.now(); this.askCreds(); }
                return;
            }
            const prev = this.seen.get(rid);
            const rssi = prev ? prev.rssi * 0.7 + r.rssi * 0.3 : r.rssi;                 // smooth the jitter
            const metres = this.metres(rssi, r.txPower);
            const entry = { rid, name: member.name, ownerKey: member.ownerKey, rssi, metres, label: this.label(metres), at: Date.now() };
            this.seen.set(rid, entry);
            // First contact in a while: say so once.
            const lastSaid = this.announced.get(rid) || 0;
            if (!prev && Date.now() - lastSaid > 10 * 60 * 1000) {
                this.announced.set(rid, Date.now());
                islandShow({ id: `ble-${rid}`, kind: "info", icon: "📡", title: `${member.name} is ${entry.label}`, sub: "Detected over Bluetooth", ttl: 4000, haptic: false });
            }
        },

        list() {
            const now = Date.now();
            return Array.from(this.seen.values()).filter((e) => now - e.at < 60_000).sort((a, b) => a.metres - b.metres);
        }
    };

    // ------------------------------------------------------------------
    // 3. Can the app reach the server? Say so plainly when it can't.
    // ------------------------------------------------------------------
    // In the app the pages come from the phone, so a wrong MU_SERVER_ORIGIN,
    // a sleeping server or an old server.js otherwise just looks like an
    // empty map. Shown after a couple of failed attempts, cleared on connect.
    const ServerLink = {
        host: (() => { try { return new URL(MU_SERVER_ORIGIN).host; } catch (e) { return MU_SERVER_ORIGIN; } })(),
        startedAt: Date.now(), fails: 0, everConnected: false, shown: false, lastReason: "",
        reason(err) {
            const m = String((err && err.message) || err || "");
            if (/timeout/i.test(m)) return "the server isn't answering (it may still be starting up)";
            if (/xhr poll error|websocket error|transport/i.test(m)) return "no connection to it — check the server is running and the address is right";
            return m ? `refused: ${m}`.slice(0, 80) : "unknown error";
        },
        onError(err) {
            this.fails++;
            this.lastReason = this.reason(err);
            if (navigator.onLine === false) return;           // the shell already shows "You're offline"
            if (this.fails >= 2 || Date.now() - this.startedAt > 8000) this.show();
        },
        show() {
            this.shown = true;
            islandShow({
                id: "native-conn", kind: "sensor", icon: "🛰️", priority: 46, ttl: 0, sticky: true, haptic: false,
                title: this.everConnected ? "Reconnecting to MapUnite…" : "Can't reach the MapUnite server",
                sub: `${this.host} · ${this.lastReason}`,
                action: { label: "Retry", onClick: () => { try { socket.disconnect(); socket.connect(); } catch (e) { /* ignore */ } } }
            });
        },
        onConnect() {
            this.everConnected = true;
            this.fails = 0;
            if (this.shown) { this.shown = false; islandHide("native-conn"); }
        }
    };
    socket.on("connect", () => ServerLink.onConnect());
    socket.on("connect_error", (err) => ServerLink.onError(err));

    window.NativeLocation = NativeLocation;
    window.NativeProximity = NativeProximity;
    window.NativeServerLink = ServerLink;

    const syncAll = () => { NativeLocation.sync(); NativeProximity.sync(); };
    // Back on screen: a start that Android refused in the background can go now.
    document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible") setTimeout(syncAll, 300); });
    // Leftover service from a ride the app no longer knows about: stop it once things settle.
    socket.on("profileAccepted", () => setTimeout(() => NativeLocation.reconcile(), 10_000));
    setTimeout(() => NativeLocation.reconcile(), 30_000);
    document.addEventListener("mu:drive-state", syncAll);
    socket.on("privacyChanged", () => setTimeout(syncAll, 0));
    socket.on("tripData", () => setTimeout(() => { NativeLocation.sync(); NativeProximity.onTripChange(); }, 300));
    socket.on("profileAccepted", () => setTimeout(syncAll, 800));
    document.addEventListener("DOMContentLoaded", () => {
        if (window.ConvoyRelay && typeof ConvoyRelay.onChange === "function") ConvoyRelay.onChange(() => NativeProximity.sync());
    });
    setInterval(syncAll, 15000);
})();
