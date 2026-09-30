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
    const NativeLocation = {
        running: false, starting: false, headersKey: "", lastFixAt: 0, stats: { fixes: 0, fed: 0 },

        inTrip() { return Boolean(currentTrip && Array.isArray(currentTrip.members) && currentTrip.members.some((m) => m.id === socket.id)); },
        wanted() {
            return Boolean(BG && DeviceIdentity.id && DeviceIdentity.token && PrivacyControls.canShare() &&
                ((SmartDrive.trip && SmartDrive.trip.active) || this.inTrip()));
        },
        headers() { return { "X-MU-Device": DeviceIdentity.id, "Authorization": `Bearer ${DeviceIdentity.token}` }; },

        async sync() {
            const want = this.wanted();
            if (want && !this.running && !this.starting) return this.start();
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
            try {
                // Android 13+: the foreground-service notification needs this.
                if (Native) await Native.requestNotifications().catch(() => null);
                this.headersKey = JSON.stringify(this.headers());
                await BG.start({
                    backgroundTitle: "MapUnite is sharing your ride",
                    backgroundMessage: "Your squad sees you while this ride or trip is on. Stop the ride to stop sharing.",
                    requestPermissions: true,
                    stale: false,
                    distanceFilter: 0,              // keep parked heartbeats (squad's "no signal" flag trips at 3 min)
                    minIntervalMs: 10000,           // one native POST every 10 s at most
                    url: `${MU_SERVER_ORIGIN}/api/native/location`,
                    headers: this.headers()
                }, (loc, err) => this.onFix(loc, err));
                this.running = true;
                islandShow({ id: "native-bg", kind: "safe", icon: "📡", title: "Sharing continues in the background", sub: "See the notification · stops when the ride ends", ttl: 4000, haptic: false });
            } catch (e) {
                console.warn("[native] background location didn't start:", e && e.message);
                if (/permission|denied/i.test(String(e && e.message))) showToast("Allow location access for MapUnite to keep sharing while the screen is off.", 6000);
            } finally {
                this.starting = false;
            }
        },

        async stop() {
            this.running = false;
            try { await BG.stop(); } catch (e) { /* already stopped */ }
        },

        onFix(loc, err) {
            if (err) {
                if (err.code === "NOT_AUTHORIZED") showToast("Location permission is off for MapUnite — background sharing stopped.", 6000);
                return;
            }
            if (!loc || !Number.isFinite(loc.latitude) || !Number.isFinite(loc.longitude)) return;
            this.stats.fixes++;
            this.lastFixAt = Date.now();
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
            await this.stop();
            this.token = token;
            if (Native) {
                try { await Native.startBeacon({ serviceUuid: this.SERVICE, data: token, txPower: "medium", mode: "balanced" }); this.advertising = true; }
                catch (e) { console.warn("[native] beacon not advertising:", e && e.message); }
            }
            if (BLE) {
                try {
                    this.bleReady = this.bleReady || BLE.initialize({ androidNeverForLocation: false });
                    await this.bleReady;
                    const mode = BLEX.ScanMode ? BLEX.ScanMode.SCAN_MODE_BALANCED : 1;
                    await BLE.requestLEScan({ services: [this.SERVICE], allowDuplicates: true, scanMode: mode }, (r) => this.onScan(r));
                    this.scanning = true;
                } catch (e) { this.bleReady = null; console.warn("[native] beacon scan failed:", e && e.message); }
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

    window.NativeLocation = NativeLocation;
    window.NativeProximity = NativeProximity;

    const syncAll = () => { NativeLocation.sync(); NativeProximity.sync(); };
    document.addEventListener("mu:drive-state", syncAll);
    socket.on("privacyChanged", () => setTimeout(syncAll, 0));
    socket.on("tripData", () => setTimeout(() => { NativeLocation.sync(); NativeProximity.onTripChange(); }, 300));
    socket.on("profileAccepted", () => setTimeout(syncAll, 800));
    document.addEventListener("DOMContentLoaded", () => {
        if (window.ConvoyRelay && typeof ConvoyRelay.onChange === "function") ConvoyRelay.onChange(() => NativeProximity.sync());
    });
    setInterval(syncAll, 15000);
})();
