"use strict";

/* ============================================================================
   MapUnite Service Worker — sw.js
   ==============================================================================
   Design goals (this replaces the old register/teardown race):
     * ONE registration path (shell.js). This file never unregisters anything.
     * Idempotent install: re-running install/activate any number of times
       produces the same cache state.
     * Consistent app version: HTML / JS / CSS are NETWORK-FIRST (fresh when
       online, cached when offline). They are never served stale while online,
       so a new index.html can never run against old app scripts.
     * A new worker WAITS until the page asks it to take over (SKIP_WAITING
       message) so an update never swaps code under a driver mid-trip.
     * Map tiles use a separate, size-capped cache that survives releases.
     * Realtime + API traffic (/socket.io/, /api/) is never intercepted.
     * Step 7 — true offline for "My bike" and trip energy: garage.html is a
       second cached page; the garage, physics and trip scripts are precached
       (the map lazy-loads the garage UI, so it must be in the cache already);
       the Google Fonts stylesheet and its Latin font files are precached; the
       bike catalogue is seeded into the garage's own cache (mu-bikedb-v1).
       /bikedb/ requests pass straight through: the garage store does its own
       network-first + verified caching there, and a second, stale-while-
       revalidate copy here would defeat its "fresh when online" rule.

   RELEASE CHECKLIST: bump VERSION whenever any precached file changes.
   ============================================================================ */

const VERSION = "mu-2026-10-10.6";           // Road perception P1: settings link to the Android road data recorder (recorder.html)
const SHELL_CACHE = `mapunite-shell-${VERSION}`;
const TILE_CACHE = "mapunite-tiles-v1";        // intentionally NOT versioned
const TILE_CACHE_MAX_ENTRIES = 500;
// Memory photos + chat images (/media/…): file names are unique and never
// change, so cache-first, size-capped, and kept across releases. Audio/video
// (byte-range requests) always go to the network.
const MEDIA_CACHE = "mapunite-media-v1";
const MEDIA_CACHE_MAX_ENTRIES = 300;
const NETWORK_TIMEOUT_MS = 4000;

const SHELL_INDEX = "/index.html";
// Other pages that work offline (cached copy served when the network fails).
const OFFLINE_PAGES = { "/garage.html": "/garage.html", "/garage": "/garage.html" };
const REQUIRED_PRECACHE = [SHELL_INDEX];       // install FAILS (and retries) without these
// The app scripts (js/*.js, in index.html's load order) and /config.js,
// which the server generates (routing server, transports).
const APP_SCRIPTS = [
    "/js/core.js",
    "/js/voice.js",
    "/js/gps.js",
    "/js/navigation.js",
    "/js/smartdrive.js",
    "/js/groupnav.js",
    "/js/privacy.js",
    "/js/analytics.js",
    "/js/deadreckoning.js",
    "/js/presence.js",
    "/js/controls.js",
    "/js/chat.js",
    "/js/memories.js",
    "/js/calls.js",
    "/js/sos.js",
    "/js/pwa.js",
    "/js/skunkworks.js",
    "/js/radio.js",
    "/js/convoy.js",
    "/js/boot.js"
];
// Step 7: bike catalogue search, physics core, garage UI ("My bike") and trip
// energy. Keep in step with garage.html, index.html and js/trip/trip-app.js.
const BIKE_SCRIPTS = [
    "/js/bikedb/catalog-search.js",
    "/js/physics/atmosphere.js",
    "/js/physics/tyre.js",
    "/js/physics/powertrain.js",
    "/js/physics/roadload.js",
    "/js/physics/model.js",
    "/js/physics/cruise.js",
    "/js/physics/index.js",
    "/js/garage/units.js",
    "/js/garage/store.js",
    "/js/garage/silhouettes.js",
    "/js/garage/picker.js",
    "/js/garage/settings.js",
    "/js/garage/visualizer.js",
    "/js/garage/garage.js",
    "/js/garage/garage-page.js",
    "/js/garage/garage.css",
    "/js/trip/profile.js",
    "/js/trip/elevation.js",
    "/js/trip/energy.js",
    "/js/trip/trip-card.js",
    "/js/trip/trip-app.js",
    "/js/trip/trip.css",
    // Step 8: fuel learner dashboard + convoy pitstop planner (both lazy-loaded by their *-app.js)
    "/js/insights/fuel-insights.js",
    "/js/insights/fuel-dashboard.js",
    "/js/insights/fuel-dashboard.css",
    "/js/insights/insights-app.js",
    "/js/pitstop/plan.js",
    "/js/pitstop/stations.js",
    "/js/pitstop/convoy-panel.js",
    "/js/pitstop/convoy-panel.css",
    "/js/pitstop/pitstop-app.js",
    // Step 9: SmartDrive HUD (eager) · Step 11: share card (lazy-loaded by share-app.js)
    "/js/hud/live.js",
    "/js/hud/hud.js",
    "/js/hud/hud-app.js",
    "/js/hud/hud.css",
    "/js/share/card-model.js",
    "/js/share/card-render.js",
    "/js/share/share-ui.js",
    "/js/share/share-app.js",
    "/js/share/share.css",
    // roadmap step 8: advice layer & safety gate
    "/js/advice/gate.js",
    "/js/advice/ask.js",
    "/js/advice/conditions.js",
    "/js/advice/overlay.js",
    "/js/advice/advice-app.js",
    "/js/advice/advice.css",
    // roadmap step 9: gradient from elevation (the profile sheet works offline)
    "/js/gradient/gradient.js",
    "/js/gradient/structures.js",
    "/js/gradient/gradient-app.js",
    "/js/gradient/profile-chart.js",
    "/js/gradient/gradient.css",
    // roadmap step 10: ride summaries, consent, delete my history
    "/js/rides/ride-store.js",
    "/js/rides/ride-model.js",
    "/js/rides/fleet.js",
    "/js/rides/rides-app.js",
    "/js/rides/rides-ui.js",
    "/js/rides/consent-ui.js",
    "/js/rides/rides.css",
    // Master AI core + sub-agents
    "/js/master/contracts.js",
    "/js/master/bus.js",
    "/js/master/capabilities.js",
    "/js/master/kernel.js",
    "/js/master/persona.js",
    "/js/master/phrases-desi.js",
    "/js/master/output.js",
    "/js/master/brain.js",
    "/js/master/agents/ride-agent.js",
    "/js/master/agents/network-agent.js",
    "/js/master/vision/fatigue.js",
    "/js/master/vision/landmarker.js",
    "/js/master/vision/face-scan.js",
    "/js/master/vision/vision.css",
    "/js/master/agents/vision-agent.js",
    "/js/master/perception/contract.js",
    "/js/master/perception/governor.js",
    "/js/master/perception/confirm.js",
    "/js/master/perception/provider.js",
    "/js/master/agents/road-agent.js",
    "/js/master/master-app.js"
];
const OPTIONAL_PRECACHE = [
    ...APP_SCRIPTS, ...BIKE_SCRIPTS, "/garage.html", "/config.js", "/shell.js", "/manifest.json",
    "/icon-192.png", "/icon-512.png", "/icon-maskable-512.png", "/satyam.png"
];
// Third-party assets the shell needs to render offline (pinned versions).
const CDN_PRECACHE = [
    "https://unpkg.com/leaflet@1.9.4/dist/leaflet.css",
    "https://unpkg.com/leaflet@1.9.4/dist/leaflet.js"
];
// The one Google Fonts stylesheet both pages use (same URL in index.html and
// garage.html, so one cached copy serves both). Its font files are precached
// for the Latin subsets; other scripts' subsets are cached the first time used.
const FONT_CSS = "https://fonts.googleapis.com/css2?family=Sora:wght@500;600;700;800&family=Inter:wght@400;500;600;700&display=swap";
const FONT_SUBSETS_RE = /\/\*\s*(latin|latin-ext)\s*\*\/\s*@font-face\s*{[^}]*?url\((https:\/\/fonts\.gstatic\.com\/[^)\s]+)\)/g;
// The garage's own cache (js/garage/store.js CACHE_NAME). Not "mapunite-*", so
// activate never deletes it; seeded here only when empty.
const BIKEDB_CACHE = "mu-bikedb-v1";
const BIKEDB_CATALOG = "/bikedb/catalog.json";

const NEVER_INTERCEPT_PATHS = ["/socket.io/", "/api/", "/healthz", "/csp-report", "/bikedb/"];
const TILE_HOST_RE = /(^|\.)(tile\.openstreetmap\.org|basemaps\.cartocdn\.com|arcgisonline\.com|tile\.opentopomap\.org)$/;
const CDN_HOST_RE = /^(unpkg\.com|cdn\.jsdelivr\.net|fonts\.googleapis\.com|fonts\.gstatic\.com)$/;

// -------------------------------------------------------------------------
// helpers
// -------------------------------------------------------------------------
// Cache keys ignore the query string so js/core.js?v=... and js/core.js share one entry.
function shellKey(url) {
    const u = new URL(url, self.location.origin);
    if (u.origin !== self.location.origin) return u.href;
    const p = u.pathname === "/" ? SHELL_INDEX : u.pathname;
    return new Request(u.origin + p);
}

function withTimeout(promise, ms) {
    return new Promise((resolve, reject) => {
        const t = setTimeout(() => reject(new Error("timeout")), ms);
        promise.then((v) => { clearTimeout(t); resolve(v); }, (e) => { clearTimeout(t); reject(e); });
    });
}

async function trimCache(cacheName, maxEntries) {
    const cache = await caches.open(cacheName);
    const keys = await cache.keys();             // insertion order => oldest first
    for (let i = 0; i < keys.length - maxEntries; i++) await cache.delete(keys[i]);
}

// Re-request cross-origin assets in CORS mode. The result is a NON-opaque
// response (opaque responses are padded to several MB each in browser quota
// accounting). A CORS response can still satisfy a plain <img>/<script> load.
async function fetchCorsThenPlain(request) {
    try {
        const res = await fetch(request.url, { mode: "cors", credentials: "omit" });
        if (res && res.ok) return res;
    } catch { /* host has no CORS headers: fall through */ }
    return fetch(request);                        // passes through, never cached
}

// -------------------------------------------------------------------------
// install — idempotent, tolerant of optional-file failures
// -------------------------------------------------------------------------
self.addEventListener("install", (event) => {
    event.waitUntil((async () => {
        const cache = await caches.open(SHELL_CACHE);

        for (const url of REQUIRED_PRECACHE) {
            const res = await fetch(new Request(url, { cache: "reload" }));
            if (!res.ok) throw new Error(`Precache of required ${url} failed (${res.status})`);
            await cache.put(shellKey(url), res);
        }
        await Promise.all(OPTIONAL_PRECACHE.map(async (url) => {
            try {
                const res = await fetch(new Request(url, { cache: "reload" }));
                if (res.ok) await cache.put(shellKey(url), res);
            } catch { /* optional: skip */ }
        }));
        await Promise.all(CDN_PRECACHE.map(async (url) => {
            try {
                const res = await fetch(url, { mode: "cors", credentials: "omit" });
                if (res.ok) await cache.put(url, res);
            } catch { /* optional: skip */ }
        }));
        await Promise.all([precacheFonts(cache), seedBikeCatalog()]);
        // NOTE: no skipWaiting() here. First-ever install activates on its own
        // (nothing to wait for); updates wait for the SKIP_WAITING message.
    })());
});

// Step 7: the fonts stylesheet + its Latin font files (best effort, CORS so
// the responses aren't opaque).
async function precacheFonts(cache) {
    try {
        const res = await fetch(FONT_CSS, { mode: "cors", credentials: "omit" });
        if (!res.ok) return;
        const css = await res.clone().text();
        await cache.put(FONT_CSS, res);
        const urls = new Set();
        for (const m of css.matchAll(FONT_SUBSETS_RE)) urls.add(m[2]);
        await Promise.all([...urls].map(async (u) => {
            try {
                if (await cache.match(u)) return;
                const f = await fetch(u, { mode: "cors", credentials: "omit" });
                if (f.ok) await cache.put(u, f);
            } catch { /* optional */ }
        }));
    } catch { /* offline install or fonts blocked: system fonts are the fallback */ }
}

// Step 7: give the garage its bike list before it is ever opened, so "My bike"
// and trip energy work on a first offline visit. Never overwrites a copy the
// store already saved (it may be newer); the store refreshes it when online.
async function seedBikeCatalog() {
    try {
        const c = await caches.open(BIKEDB_CACHE);
        const key = new Request(self.location.origin + BIKEDB_CATALOG);
        if (await c.match(key)) return;
        const res = await fetch(new Request(BIKEDB_CATALOG, { cache: "no-cache" }));
        if (res.ok && (res.headers.get("content-type") || "").includes("json")) await c.put(key, res);
    } catch { /* not built on this server, or offline */ }
}

// -------------------------------------------------------------------------
// activate — drop old shell caches, claim clients
// -------------------------------------------------------------------------
self.addEventListener("activate", (event) => {
    event.waitUntil((async () => {
        const names = await caches.keys();
        await Promise.all(names
            .filter((n) => n.startsWith("mapunite-") && n !== SHELL_CACHE && n !== TILE_CACHE && n !== MEDIA_CACHE)
            .map((n) => caches.delete(n)));
        if (self.registration.navigationPreload) {
            try { await self.registration.navigationPreload.enable(); } catch { /* unsupported */ }
        }
        await self.clients.claim();
    })());
});

// -------------------------------------------------------------------------
// fetch routing
// -------------------------------------------------------------------------
self.addEventListener("fetch", (event) => {
    const req = event.request;
    if (req.method !== "GET") return;
    let url;
    try { url = new URL(req.url); } catch { return; }
    if (url.protocol !== "http:" && url.protocol !== "https:") return;

    if (url.origin === self.location.origin) {
        if (NEVER_INTERCEPT_PATHS.some((p) => url.pathname.startsWith(p))) return;
        if (url.pathname === "/sw.js") return;
        if (url.pathname.startsWith("/media/")) {
            if (req.headers.has("range") || req.destination === "video" || req.destination === "audio") return;
            event.respondWith(mediaHandler(event, req));
            return;
        }

        if (req.mode === "navigate") {
            // The SPA shell and the offline pages (garage.html); anything else navigates normally.
            if (url.pathname === "/" || url.pathname === SHELL_INDEX) event.respondWith(handleNavigation(event));
            else if (Object.prototype.hasOwnProperty.call(OFFLINE_PAGES, url.pathname)) event.respondWith(handleNavigation(event, OFFLINE_PAGES[url.pathname]));
            return;
        }
        const dest = req.destination;
        if (dest === "script" || dest === "style" || dest === "manifest" || dest === "worker") {
            event.respondWith(networkFirst(event, req, shellKey(req.url)));
        } else {
            event.respondWith(staleWhileRevalidate(event, req, shellKey(req.url), SHELL_CACHE, false));
        }
        return;
    }

    if (TILE_HOST_RE.test(url.hostname)) {
        event.respondWith(tileHandler(event, req));
        return;
    }
    if (CDN_HOST_RE.test(url.hostname)) {
        event.respondWith(staleWhileRevalidate(event, req, req.url, SHELL_CACHE, true));
        return;
    }
    // Everything else (Google Maps JS, OSRM, weather, geocoders): straight to network.
});

async function mediaHandler(event, req) {
    const cache = await caches.open(MEDIA_CACHE);
    const hit = await cache.match(req.url);
    if (hit) return hit;
    const res = await fetch(req);
    if (res && res.ok && res.status === 200) {
        event.waitUntil(cache.put(req.url, res.clone()).then(() => trimCache(MEDIA_CACHE, MEDIA_CACHE_MAX_ENTRIES)).catch(() => { }));
    }
    return res;
}

async function handleNavigation(event, page = SHELL_INDEX) {
    const cache = await caches.open(SHELL_CACHE);
    try {
        const preload = event.preloadResponse ? await event.preloadResponse : null;
        const res = preload || await withTimeout(fetch(event.request), NETWORK_TIMEOUT_MS);
        if (res && res.ok && !res.redirected) event.waitUntil(cache.put(shellKey(page), res.clone()));
        if (res) return res;
    } catch { /* offline or slow: fall back to the cached page */ }
    const cached = await cache.match(shellKey(page));
    return cached || new Response("MapUnite is offline and has not been cached yet. Reconnect once to install it.", {
        status: 503, headers: { "Content-Type": "text/plain; charset=utf-8" }
    });
}

async function networkFirst(event, req, key) {
    const cache = await caches.open(SHELL_CACHE);
    try {
        const res = await withTimeout(fetch(req), NETWORK_TIMEOUT_MS);
        if (res && res.ok) event.waitUntil(cache.put(key, res.clone()));
        return res;
    } catch { /* fall through to cache */ }
    const cached = await cache.match(key);
    return cached || new Response("", { status: 504, statusText: "Offline and not cached" });
}

async function staleWhileRevalidate(event, req, key, cacheName, cors) {
    const cache = await caches.open(cacheName);
    const cached = await cache.match(key);
    const refresh = (async () => {
        const res = cors ? await fetchCorsThenPlain(req) : await fetch(req);
        if (res && res.ok && res.type !== "opaque") await cache.put(key, res.clone());
        return res;
    })();
    if (cached) { event.waitUntil(refresh.catch(() => {})); return cached; }
    try { return await refresh; } catch {
        return new Response("", { status: 504, statusText: "Offline and not cached" });
    }
}

async function tileHandler(event, req) {
    const cache = await caches.open(TILE_CACHE);
    const cached = await cache.match(req.url);
    if (cached) return cached;
    try {
        const res = await fetchCorsThenPlain(req);
        if (res && res.ok && res.type !== "opaque") {
            event.waitUntil((async () => {
                await cache.put(req.url, res.clone());
                await trimCache(TILE_CACHE, TILE_CACHE_MAX_ENTRIES);
            })());
        }
        return res;
    } catch {
        return new Response("", { status: 504, statusText: "Tile unavailable offline" });
    }
}

// -------------------------------------------------------------------------
// messages from the page
// -------------------------------------------------------------------------
self.addEventListener("message", (event) => {
    const data = event.data || {};
    const reply = (payload) => {
        if (event.ports && event.ports[0]) event.ports[0].postMessage(payload);
        else if (event.source) event.source.postMessage(payload);
    };
    if (data.type === "SKIP_WAITING") {
        self.skipWaiting();
    } else if (data.type === "GET_VERSION") {
        reply({ type: "VERSION", version: VERSION });
    } else if (data.type === "PURGE_TILE_CACHE") {
        // Privacy: cached tiles reveal where the user has been looking.
        event.waitUntil(caches.delete(TILE_CACHE).then(() => reply({ type: "TILE_CACHE_PURGED", ok: true })));
    }
});
