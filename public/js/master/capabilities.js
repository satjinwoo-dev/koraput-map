// @ts-check
/* ============================================================================
   MapUnite Master AI — capabilities (sensors and services, behind one door)
   ==============================================================================
   Agents never touch Capacitor plugins, navigator.* or the app's globals
   directly. They ask for a capability by name ("network", "location",
   "camera", "bluetooth", …) and get a small provider object back. So:

     - the same agent runs in the browser, in the Android app and in tests
       (a test just provides a fake);
     - a native plugin can be swapped (or upgraded) in one place;
     - an agent whose capability is missing simply waits: the kernel starts it
       the moment the capability is provided (e.g. after a lazy load or a
       permission grant), and stops it if the capability is revoked.

   A provider is any object; these members have a meaning:
     available()   → boolean   false = present but unusable right now
     permission()  → Promise<"granted"|"denied"|"prompt">   (optional)
     request()     → Promise<"granted"|"denied">            (optional)

   installDefaults() provides what this build already has:
     network   online state, connection type, an RTT probe to our own server
     location  the app's filtered GPS (the "mu:fix" pipeline + myCoords), no
               second GPS watch, so no extra battery
     route     the route on screen ("mu:route" / "mu:route-clear")
     drive     riding / navigating ("mu:drive-state")
     store     a small key/value store on the phone, namespaced per agent
   Camera, Bluetooth, motion etc. are provided by their own modules later
   (caps.provide("camera", …)); nothing here needs to change for that.
   ============================================================================ */
(function (root, factory) {
    if (typeof module === "object" && module.exports) module.exports = factory();
    else { const W = /** @type {any} */ (root); (W.MUMaster || (W.MUMaster = {})).caps = factory(); }
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
    "use strict";

    function createCapabilities() {
        /** @type {Map<string, any>} */ const providers = new Map();
        /** @type {Set<(name: string, provider: any) => void>} */ const listeners = new Set();
        const notify = (/** @type {string} */ name, /** @type {any} */ p) => { for (const fn of listeners) { try { fn(name, p); } catch (e) { /* listeners are independent */ } } };
        return {
            /** @param {string} name @param {any} provider */
            provide(name, provider) {
                if (!provider || typeof provider !== "object") throw new Error(`caps: provider for "${name}" must be an object`);
                providers.set(name, provider);
                notify(name, provider);
                return () => { if (providers.get(name) === provider) { providers.delete(name); notify(name, null); } };
            },
            /** @param {string} name */
            revoke(name) { if (providers.delete(name)) notify(name, null); },
            /** Present and usable right now. @param {string} name */
            has(name) {
                const p = providers.get(name);
                if (!p) return false;
                try { return typeof p.available === "function" ? p.available() !== false : true; } catch (e) { return false; }
            },
            /** @param {string} name */
            get(name) { return providers.get(name) || null; },
            /** Re-check availability (e.g. after a permission change). @param {string} name */
            touch(name) { notify(name, providers.get(name) || null); },
            /** @param {(name: string, provider: any) => void} fn */
            onChange(fn) { listeners.add(fn); return () => listeners.delete(fn); },
            list() { return [...providers.keys()].map((name) => ({ name, available: this.has(name) })); }
        };
    }

    // ------------------------------------------------------------------ small helpers
    /** @template T */
    function emitter() {
        /** @type {Set<(v: T) => void>} */ const fns = new Set();
        return {
            /** @param {(v: T) => void} fn */ on(fn) { fns.add(fn); return () => fns.delete(fn); },
            /** @param {T} v */ emit(v) { for (const fn of fns) { try { fn(v); } catch (e) { /* independent */ } } }
        };
    }
    const on = (/** @type {any} */ target, /** @type {string} */ type, /** @type {any} */ fn) => { try { target && target.addEventListener && target.addEventListener(type, fn); } catch (e) { /* not available */ } };

    // ------------------------------------------------------------------ network
    /**
     * @param {any} W window-like
     * @param {{ probeUrl?: () => string, fetchImpl?: Function, now?: () => number }} [o]
     */
    function createNetworkProvider(W, o = {}) {
        const Net = W.capacitorNetwork && W.capacitorNetwork.Network;            // optional @capacitor/network
        const conn = W.navigator && W.navigator.connection;
        const now = o.now || (() => (W.performance && W.performance.now ? W.performance.now() : Date.now()));
        const fetchImpl = o.fetchImpl || (W.fetch ? W.fetch.bind(W) : null);
        const probeUrl = o.probeUrl || (() => `${W.MU_SERVER_ORIGIN || (W.location && W.location.origin) || ""}/api/config`);
        const changes = emitter();
        const st = { connected: !(W.navigator && W.navigator.onLine === false), type: "unknown", downlinkMbps: null, rttMs: null, source: Net ? "capacitor" : "browser" };
        const readConn = () => {
            if (!conn) return;
            if (conn.effectiveType) st.type = conn.effectiveType;
            st.downlinkMbps = Number.isFinite(conn.downlink) ? conn.downlink : null;
            st.rttMs = Number.isFinite(conn.rtt) ? conn.rtt : null;
        };
        const update = (/** @type {any} */ patch) => { Object.assign(st, patch); readConn(); changes.emit({ ...st }); };
        readConn();
        on(W, "online", () => update({ connected: true }));
        on(W, "offline", () => update({ connected: false }));
        on(conn, "change", () => update({}));
        if (Net) {
            try {
                Net.getStatus().then((/** @type {any} */ s) => update({ connected: Boolean(s.connected), type: s.connectionType || st.type }), () => {});
                Net.addListener("networkStatusChange", (/** @type {any} */ s) => update({ connected: Boolean(s.connected), type: s.connectionType || st.type }));
            } catch (e) { /* plugin present but broken: browser signals still work */ }
        }
        return {
            available: () => true,
            status: () => ({ ...st }),
            onChange: changes.on,
            /**
             * One round trip to our own server. Never throws.
             * @param {{ timeoutMs?: number }} [p]
             * @returns {Promise<{ ok: boolean, rttMs: number|null, status?: number }>}
             */
            async probe(p = {}) {
                if (!fetchImpl) return { ok: st.connected, rttMs: null };
                const timeoutMs = p.timeoutMs || 4000;
                const ctl = typeof AbortController === "function" ? new AbortController() : null;
                const timer = setTimeout(() => ctl && ctl.abort(), timeoutMs);
                const t0 = now();
                try {
                    const url = probeUrl();
                    const res = await fetchImpl(`${url}${url.includes("?") ? "&" : "?"}probe=${Date.now()}`, { cache: "no-store", signal: ctl ? ctl.signal : undefined });
                    return { ok: Boolean(res && res.ok), rttMs: Math.round(now() - t0), status: res && res.status };
                } catch (e) {
                    return { ok: false, rttMs: null };
                } finally { clearTimeout(timer); }
            }
        };
    }

    // ------------------------------------------------------------------ location (reuses the app's GPS pipeline)
    /** @param {any} W @param {any} doc */
    function createLocationProvider(W, doc) {
        const fixes = emitter();
        /** @type {any} */ let last = null;
        const coords = () => {
            // core.js keeps the latest accepted position in a top-level `myCoords`.
            try {
                // @ts-ignore: a global from core.js
                return typeof myCoords !== "undefined" && myCoords ? myCoords : (W.myCoords || null);
            } catch (e) { return null; }
        };
        on(doc, "mu:fix", (/** @type {any} */ e) => {
            const f = (e && e.detail) || {};
            const c = coords();
            const kmh = Number.isFinite(f.smoothedKmh) ? f.smoothedKmh : Number.isFinite(f.speedKmh) ? f.speedKmh : 0;
            last = {
                lat: c && Number.isFinite(c.lat) ? c.lat : null,
                lng: c && Number.isFinite(c.lng) ? c.lng : null,
                speedMs: kmh / 3.6,
                accuracyM: Number.isFinite(f.accuracyM) ? f.accuracyM : null,
                confidence: Number.isFinite(f.confidence) ? f.confidence : 0,
                accepted: Boolean(f.accepted),
                t: Number.isFinite(f.t) ? f.t : Date.now()
            };
            fixes.emit({ ...last });
        });
        return {
            available: () => true,
            current: () => (last ? { ...last } : null),
            onFix: fixes.on
        };
    }

    // ------------------------------------------------------------------ route on screen
    /** @param {any} doc */
    function createRouteProvider(doc) {
        const changes = emitter();
        /** @type {{ path: number[][], distanceM: number|null }|null} */ let route = null;
        on(doc, "mu:route", (/** @type {any} */ e) => {
            const d = (e && e.detail) || {};
            route = Array.isArray(d.path) && d.path.length > 1 ? { path: d.path, distanceM: Number.isFinite(d.distanceM) ? d.distanceM : null } : null;
            changes.emit(route);
        });
        on(doc, "mu:route-clear", () => { route = null; changes.emit(null); });
        return { available: () => true, current: () => route, onChange: changes.on };
    }

    // ------------------------------------------------------------------ riding / navigating
    /** @param {any} W @param {any} doc */
    function createDriveProvider(W, doc) {
        const changes = emitter();
        let st = { driving: false, navigating: false };
        try {
            // @ts-ignore: a global from voice.js
            if (typeof isDriving === "function") st.driving = Boolean(isDriving());
        } catch (e) { /* not loaded yet */ }
        on(doc, "mu:drive-state", (/** @type {any} */ e) => {
            const d = (e && e.detail) || {};
            st = { driving: Boolean(d.driving), navigating: Boolean(d.navigating) };
            changes.emit({ ...st });
        });
        return { available: () => true, current: () => ({ ...st }), onChange: changes.on };
    }

    // ------------------------------------------------------------------ key/value store on the phone
    /** @param {any} W @param {string} [prefix] */
    function createStoreProvider(W, prefix = "mu.master.") {
        /** @type {Map<string, string>} */ const memory = new Map();
        const ls = (() => { try { const s = W.localStorage; s.setItem("mu.master.__t", "1"); s.removeItem("mu.master.__t"); return s; } catch (e) { return null; } })();
        const raw = {
            get: (/** @type {string} */ k) => (ls ? ls.getItem(k) : memory.get(k) ?? null),
            set: (/** @type {string} */ k, /** @type {string} */ v) => { try { ls ? ls.setItem(k, v) : memory.set(k, v); return true; } catch (e) { memory.set(k, v); return false; } },
            del: (/** @type {string} */ k) => { try { ls ? ls.removeItem(k) : memory.delete(k); } catch (e) { memory.delete(k); } },
            keys: () => { const out = []; if (ls) { for (let i = 0; i < ls.length; i++) { const k = ls.key(i); if (k) out.push(k); } } else out.push(...memory.keys()); return out; }
        };
        return {
            available: () => true,
            persistent: Boolean(ls),
            /** @param {string} ns */
            namespace(ns) {
                const p = `${prefix}${ns}.`;
                return {
                    /** @param {string} key @param {any} [fallback] */
                    get(key, fallback = null) { const v = raw.get(p + key); if (v == null) return fallback; try { return JSON.parse(v); } catch (e) { return fallback; } },
                    /** @param {string} key @param {any} value */
                    set(key, value) { return raw.set(p + key, JSON.stringify(value)); },
                    /** @param {string} key */ remove(key) { raw.del(p + key); },
                    keys() { return raw.keys().filter((k) => k.startsWith(p)).map((k) => k.slice(p.length)); },
                    clear() { for (const k of raw.keys()) if (k.startsWith(p)) raw.del(k); }
                };
            }
        };
    }

    /**
     * Provide everything this build already has.
     * @param {ReturnType<typeof createCapabilities>} caps
     * @param {{ window: any, document?: any, network?: any }} env
     */
    function installDefaults(caps, env) {
        const W = env.window, doc = env.document || W.document;
        caps.provide("store", createStoreProvider(W));
        caps.provide("network", createNetworkProvider(W, env.network));
        caps.provide("location", createLocationProvider(W, doc));
        caps.provide("route", createRouteProvider(doc));
        caps.provide("drive", createDriveProvider(W, doc));
        return caps;
    }

    return {
        createCapabilities, installDefaults,
        createNetworkProvider, createLocationProvider, createRouteProvider, createDriveProvider, createStoreProvider
    };
});
