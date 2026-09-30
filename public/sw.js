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
       so a new index.html can never run against an old app.js.
     * A new worker WAITS until the page asks it to take over (SKIP_WAITING
       message) so an update never swaps code under a driver mid-trip.
     * Map tiles use a separate, size-capped cache that survives releases.
     * Realtime + API traffic (/socket.io/, /api/) is never intercepted.

   RELEASE CHECKLIST: bump VERSION whenever any precached file changes.
   ============================================================================ */

const VERSION = "mu-2026-09-30.1";           // Phase 4 release (app.js / features.js / index.html changed)
const SHELL_CACHE = `mapunite-shell-${VERSION}`;
const TILE_CACHE = "mapunite-tiles-v1";        // intentionally NOT versioned
const TILE_CACHE_MAX_ENTRIES = 500;
const NETWORK_TIMEOUT_MS = 4000;

const SHELL_INDEX = "/index.html";
const REQUIRED_PRECACHE = [SHELL_INDEX];       // install FAILS (and retries) without these
const OPTIONAL_PRECACHE = [
    "/app.js", "/features.js", "/shell.js", "/manifest.json",
    "/icon-192.png", "/icon-512.png", "/icon-maskable-512.png", "/satyam.png"
];
// Third-party assets the shell needs to render offline (pinned versions).
const CDN_PRECACHE = [
    "https://unpkg.com/leaflet@1.9.4/dist/leaflet.css",
    "https://unpkg.com/leaflet@1.9.4/dist/leaflet.js"
];

const NEVER_INTERCEPT_PATHS = ["/socket.io/", "/api/", "/healthz", "/csp-report"];
const TILE_HOST_RE = /(^|\.)(tile\.openstreetmap\.org|basemaps\.cartocdn\.com|arcgisonline\.com|tile\.opentopomap\.org)$/;
const CDN_HOST_RE = /^(unpkg\.com|cdn\.jsdelivr\.net|fonts\.googleapis\.com|fonts\.gstatic\.com)$/;

// -------------------------------------------------------------------------
// helpers
// -------------------------------------------------------------------------
// Cache keys ignore the query string so app.js?v=... and app.js share one entry.
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
        // NOTE: no skipWaiting() here. First-ever install activates on its own
        // (nothing to wait for); updates wait for the SKIP_WAITING message.
    })());
});

// -------------------------------------------------------------------------
// activate — drop old shell caches, claim clients
// -------------------------------------------------------------------------
self.addEventListener("activate", (event) => {
    event.waitUntil((async () => {
        const names = await caches.keys();
        await Promise.all(names
            .filter((n) => n.startsWith("mapunite-") && n !== SHELL_CACHE && n !== TILE_CACHE)
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

        if (req.mode === "navigate") {
            // Only the SPA shell is handled; anything else navigates normally.
            if (url.pathname === "/" || url.pathname === SHELL_INDEX) event.respondWith(handleNavigation(event));
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

async function handleNavigation(event) {
    const cache = await caches.open(SHELL_CACHE);
    try {
        const preload = event.preloadResponse ? await event.preloadResponse : null;
        const res = preload || await withTimeout(fetch(event.request), NETWORK_TIMEOUT_MS);
        if (res && res.ok && !res.redirected) event.waitUntil(cache.put(shellKey(SHELL_INDEX), res.clone()));
        if (res) return res;
    } catch { /* offline or slow: fall back to the cached shell */ }
    const cached = await cache.match(shellKey(SHELL_INDEX));
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
