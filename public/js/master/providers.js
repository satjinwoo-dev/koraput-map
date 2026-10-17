// @ts-check
/* ============================================================================
   MapUnite Master AI — capability providers for the cognitive engines
   ==============================================================================
   Agents never touch Capacitor plugins or the app's globals (capabilities.js
   explains why). This file builds four providers; master-app.js provides each
   one only where it can work, so an agent that needs it simply waits.

   "radio"        radio-level signal: the MapUniteRadio native plugin
                  (native/android/radar/RadioPlugin.kt). Android app only: no
                  browser exposes signal strength.
                    snapshot() → Promise<RadioSample|null>, onSample(fn) (≈ 1 per 2 s while
                    someone listens; the plugin is started on the first listener and
                    stopped after the last)
                  RadioSample = { t, transport: "cellular"|"wifi"|"ethernet"|"none",
                    gen: "2g"|"3g"|"4g"|"5g"|"unknown", level: 0–4, dbm, rsrp, rsrq, sinr,
                    wifiRssi, downKbps, upKbps, metered }   (dBm, dB, kbit/s; null = unknown)

   "media"        what's playing in ANY app (Spotify, YouTube Music, JioSaavn …):
                  the MapUniteMedia native plugin, a NotificationListenerService
                  reading Android's media sessions. Android requires the rider to
                  switch on "notification access" for the app ONCE in system
                  settings (no app can grant it to itself): access() tells,
                  requestAccess() opens that settings page.
                    current() → Track|null, onTrack(fn), control("next"|"previous"|"pause"|"play")
                  Track = { title, artist, album, app, playing, durationMs }

   "app-context"  what the rider is doing IN THIS APP, from the app's own events and
                  globals: the bike in the garage, the group trip and its size, the
                  destination, place searches, shared memories, what the mic heard
                  (after the app's own voice commands had their turn). Local only.
                    snapshot() → { bike, group: { inTrip, size }, destination, place }
                    onEvent(fn) → fn({ type, detail, t })

   "terrain"      heights for points (js/trip/elevation.js: MapUnite's own 30 m terrain
                  model, Copernicus GLO-30, pilot corridors only; cached on the phone). heights([[lat, lng], …]) → number[] (NaN = unknown)
   ============================================================================ */
(function (root, factory) {
    if (typeof module === "object" && module.exports) module.exports = factory();
    else { const W = /** @type {any} */ (root); (W.MUMaster || (W.MUMaster = {})).providers = factory(); }
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
    "use strict";

    /** @param {any} W @param {string} name */
    function plugin(W, name) {
        try {
            const core = W.capacitorExports;
            const Cap = core && core.Capacitor;
            if (!Cap || !Cap.isNativePlatform || !Cap.isNativePlatform() || !Cap.isPluginAvailable || !Cap.isPluginAvailable(name)) return null;
            return core.registerPlugin(name);
        } catch (e) { return null; }
    }

    /** @template T */
    function emitter() {
        /** @type {Set<(v: T) => void>} */ const fns = new Set();
        return {
            /** @param {(v: T) => void} fn */ on(fn) { fns.add(fn); return () => fns.delete(fn); },
            /** @param {T} v */ emit(v) { for (const fn of fns) { try { fn(v); } catch (e) { /* independent */ } } },
            get size() { return fns.size; }
        };
    }

    const num = (/** @type {any} */ v) => (typeof v === "number" && Number.isFinite(v) ? v : null);

    /** @param {any} s */
    function cleanRadio(s) {
        if (!s || typeof s !== "object") return null;
        const transport = ["cellular", "wifi", "ethernet", "none"].includes(s.transport) ? s.transport : "none";
        return {
            t: num(s.t) || Date.now(), transport,
            gen: ["2g", "3g", "4g", "5g"].includes(s.gen) ? s.gen : "unknown",
            level: num(s.level) !== null ? Math.max(0, Math.min(4, Math.round(s.level))) : null,
            dbm: num(s.dbm), rsrp: num(s.rsrp), rsrq: num(s.rsrq), sinr: num(s.sinr),
            wifiRssi: num(s.wifiRssi), downKbps: num(s.downKbps), upKbps: num(s.upKbps),
            metered: typeof s.metered === "boolean" ? s.metered : null
        };
    }

    /** @param {any} p the MapUniteRadio plugin @param {{ intervalMs?: number }} [o] */
    function createRadioProvider(p, o = {}) {
        const samples = emitter();
        /** @type {any} */ let handle = null;
        let starting = /** @type {Promise<any>|null} */ (null);
        async function ensure() {
            if (handle || starting) return;
            starting = (async () => {
                try {
                    handle = await p.addListener("radio", (/** @type {any} */ s) => { const c = cleanRadio(s); if (c) samples.emit(c); });
                    await p.start({ intervalMs: o.intervalMs || 2000 });
                } catch (e) { handle = null; }
                finally { starting = null; }
            })();
        }
        async function release() {
            if (samples.size) return;
            try { if (handle) await handle.remove(); await p.stop(); } catch (e) { /* ignore */ }
            handle = null;
        }
        return {
            available: () => true,
            native: true,
            async snapshot() { try { return cleanRadio(await p.snapshot()); } catch (e) { return null; } },
            /** @param {(s: any) => void} fn */
            onSample(fn) { const off = samples.on(fn); ensure(); return () => { off(); release(); }; }
        };
    }

    /** @param {any} s */
    function cleanTrack(s) {
        if (!s || typeof s !== "object" || typeof s.title !== "string" || !s.title.trim()) return null;
        const str = (/** @type {any} */ v, n = 120) => (typeof v === "string" ? v.trim().slice(0, n) : "");
        return { title: str(s.title), artist: str(s.artist), album: str(s.album), app: str(s.package || s.app, 80), playing: s.playing !== false, durationMs: num(s.durationMs) };
    }

    /** @param {any} p the MapUniteMedia plugin */
    function createMediaProvider(p) {
        const tracks = emitter();
        /** @type {any} */ let last = null;
        let access = false, listening = false;
        async function refresh() {
            try { const st = await p.status(); access = Boolean(st && st.access); } catch (e) { access = false; }
            if (access && !listening) {
                listening = true;
                try {
                    await p.addListener("track", (/** @type {any} */ s) => { const t = cleanTrack(s); last = t; tracks.emit(t); });
                    const now = cleanTrack(await p.nowPlaying());
                    if (now) { last = now; tracks.emit(now); }
                } catch (e) { listening = false; }
            }
            return access;
        }
        refresh();
        return {
            available: () => true,
            access: () => access,
            refresh,
            async requestAccess() { try { await p.openAccessSettings(); } catch (e) { /* no settings screen */ } },
            current: () => (last ? { ...last } : null),
            /** @param {(t: any) => void} fn */ onTrack: tracks.on,
            /** @param {"next"|"previous"|"pause"|"play"} action */
            async control(action) {
                if (!["next", "previous", "pause", "play"].includes(action)) return false;
                try { await p.control({ action }); return true; } catch (e) { return false; }
            }
        };
    }

    /** @param {any} W @param {any} doc */
    function createAppContextProvider(W, doc) {
        const events = emitter();
        const read = (/** @type {() => any} */ fn) => { try { return fn(); } catch (e) { return undefined; } };
        function bike() {
            const g = read(() => JSON.parse(W.localStorage.getItem("mu.garage.v1") || "null"));
            return g && typeof g.title === "string" ? { title: g.title.slice(0, 80), classKey: String(g.classKey || ""), bikeId: String(g.bikeId || "") } : null;
        }
        function group() {
            // core.js keeps the other riders in friendData and the trip in currentTrip (classic-script lexicals)
            // @ts-ignore
            const fd = read(() => (typeof friendData !== "undefined" ? friendData : W.friendData));
            // @ts-ignore
            const trip = read(() => (typeof currentTrip !== "undefined" ? currentTrip : W.currentTrip));
            const others = fd && typeof fd === "object" ? Object.keys(fd).length : 0;
            return { inTrip: Boolean(trip), size: trip ? others + 1 : 1, tripName: trip && typeof trip.name === "string" ? trip.name.slice(0, 60) : "" };
        }
        function destination() {
            // @ts-ignore
            const ns = read(() => (typeof navState !== "undefined" ? navState : W.navState));
            if (!ns || !(ns.active || ns.ready)) return null;
            const path = Array.isArray(ns.routePath) && ns.routePath.length ? ns.routePath : null;
            const end = path ? path[path.length - 1] : null;
            return { name: String(ns.destName || "").slice(0, 80), lat: end ? Number(end[0]) : null, lng: end ? Number(end[1]) : null, remainingM: Number.isFinite(ns.remainingM) ? ns.remainingM : null, etaS: Number.isFinite(ns.etaSec) ? ns.etaSec : null };
        }
        // @ts-ignore
        const place = () => read(() => (typeof cityName !== "undefined" ? cityName : W.cityName)) || "";
        const forward = (/** @type {string} */ type, /** @type {(d: any) => any} */ map = (d) => d) => {
            try { doc.addEventListener(`mu:${type}`, (/** @type {any} */ e) => events.emit({ type, detail: map((e && e.detail) || {}), t: Date.now() })); } catch (e) { /* no DOM */ }
        };
        forward("place-search", (d) => ({ name: String(d.name || "").slice(0, 80), lat: num(d.lat), lng: num(d.lng) }));
        forward("destination", (d) => ({ name: String(d.name || "").slice(0, 80), lat: num(d.lat), lng: num(d.lng) }));
        forward("garage-change", () => ({ bike: bike() }));
        forward("convoy-evaluated", () => ({ group: group() }));
        forward("trip-end", (d) => ({ distanceKm: num(d.totalDistKm), fuelL: num(d.fuelUsedL) }));
        forward("ride-summary", (d) => ({ summary: d && typeof d === "object" ? { distanceM: num(d.distanceM), durationS: num(d.durationS) } : null }));
        forward("memories-changed", () => ({}));
        forward("voice-heard", (d) => ({ text: String(d.text || "").slice(0, 200), mode: String(d.mode || "") }));
        forward("advice-quiet", (d) => ({ on: Boolean(d.on ?? d.quiet) }));
        return {
            available: () => true,
            snapshot: () => ({ bike: bike(), group: group(), destination: destination(), place: String(place()).slice(0, 80) }),
            /** @param {(e: { type: string, detail: any, t: number }) => void} fn */ onEvent: events.on
        };
    }

    /** @param {any} elevation MUTrip.elevation.createElevation() */
    function createTerrainProvider(elevation) {
        return {
            available: () => true,
            /** @param {Array<[number, number]>} pts @returns {Promise<number[]>} */
            async heights(pts) {
                try {
                    const r = await elevation.lookup(pts.map((p) => p[0]), pts.map((p) => p[1]));
                    return Array.from(r && r.z ? r.z : [], (z) => (Number.isFinite(z) ? Number(z) : NaN));
                } catch (e) { return pts.map(() => NaN); }
            }
        };
    }

    return { plugin, cleanRadio, cleanTrack, createRadioProvider, createMediaProvider, createAppContextProvider, createTerrainProvider };
});
