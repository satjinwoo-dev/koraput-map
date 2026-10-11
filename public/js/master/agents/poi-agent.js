// @ts-check
/* ============================================================================
   MapUnite Master AI — POI agent ("poi"): the best hospital, mechanic, service
   centre, hotel and dhaba around the rider, ready BEFORE they're needed
   ==============================================================================
   EVERY SECOND (on the phone, no network): ranks the places it already holds
   for where the rider is now and shares the best per category as state.poi.
   An emergency answer is a lookup in memory: no loading time.

   IN THE BACKGROUND (network, only when needed): the area is cut into 0.02°
   tiles (≈ 2.2 km). The tile the rider is in and the tiles the corridor runs
   through are fetched from /api/master/poi (Google Places + OSM, vetted on the
   server: lib/master/poi.js), one tile at a time, the rider's own tile first,
   with a per-tile back-off on failure. A tile is fresh for 12 h.

   ON THE PHONE (store "poi"): up to 80 tiles, least recently used dropped.
   Google's terms allow storing place IDs and coordinates but not names,
   phones or ratings, so Google places are persisted as id + position only
   (and re-fetched when online); OpenStreetMap places (ODbL) are persisted
   whole, which is what keeps an OFFLINE emergency answer possible.

   RANKING  utility = vetting score − λ(category) × km  (+0.05 vetted, −0.10 unvetted,
            +0.05 ahead of a moving rider). λ: hospital 0.08, mechanic 0.12,
            service 0.06, hotel 0.04, food 0.06 per km. Distance = straight line × 1.25
            (a typical road detour factor), ETA at max(speed, 8.3 m/s).

   ASK IT (bus requests, instant):
     task.poi-best   { category, count? }    → [{ name, phone, lat, lng, distanceM, etaS, tier, navUrl }]
     task.emergency  { kind: "medical"|"breakdown" } → { primary, alternatives[] }
   SAYS (through the brain):
     rest.stop   advice, when the ride agent says a break is due, or at meal time
                 after ≥ 45 min of riding: the best food stop 500 m – 5 km AHEAD.
   ============================================================================ */
(function (root, factory) {
    // geo.js and phrases-radar.js load before this file (index.html); in Node they're required
    if (typeof module === "object" && module.exports) module.exports = factory(require("../geo.js"), require("../phrases-radar.js"));
    else {
        const M = /** @type {any} */ (root).MUMaster || (/** @type {any} */ (root).MUMaster = {});
        const def = factory(M.geo, M.phrasesRadar);
        if (typeof M.define === "function") M.define(def); else (M._pending || (M._pending = [])).push(def);
    }
})(typeof globalThis !== "undefined" ? globalThis : this, function (/** @type {any} */ GEO, /** @type {any} */ PHRASES) {
    "use strict";

    const geo = () => GEO;
    const CATS = ["hospital", "mechanic", "service", "hotel", "food"];
    const LAMBDA = { hospital: 0.08, mechanic: 0.12, service: 0.06, hotel: 0.04, food: 0.06 };
    const DETOUR = 1.25;

    /**
     * Rank places for a position. Pure (exported for tests).
     * @param {any[]} places @param {string} cat
     * @param {{ lat: number, lng: number, speedMs?: number, headingDeg?: number|null }} ego @param {any} G
     * @param {{ maxKm?: number, emergency?: boolean }} [o]
     */
    function rank(places, cat, ego, G, o = {}) {
        const maxKm = o.maxKm ?? 10;
        const moving = (ego.speedMs || 0) >= 3 && Number.isFinite(ego.headingDeg);
        const out = [];
        for (const p of places) {
            if (p.cat !== cat || !p.name) continue;
            const km = (G.metres(ego.lat, ego.lng, p.lat, p.lng) * DETOUR) / 1000;
            if (km > maxKm) continue;
            let ahead = false;
            if (moving) {
                let d = Math.abs(G.bearing(ego.lat, ego.lng, p.lat, p.lng) - /** @type {number} */ (ego.headingDeg));
                if (d > 180) d = 360 - d;
                ahead = d <= 60;
            }
            const tierAdj = p.tier === "vetted" ? 0.05 : p.tier === "unvetted" && !o.emergency ? -0.1 : 0;
            const u = (p.score || 0) - /** @type {any} */ (LAMBDA)[cat] * km + tierAdj + (ahead ? 0.05 : 0);
            out.push({ ...p, distanceM: Math.round(km * 1000), etaS: Math.round((km * 1000) / Math.max(ego.speedMs || 0, 8.3)), ahead, utility: Math.round(u * 1000) / 1000 });
        }
        return out.sort((a, b) => b.utility - a.utility);
    }

    const navUrl = (/** @type {number} */ lat, /** @type {number} */ lng) => `https://www.google.com/maps/dir/?api=1&destination=${lat.toFixed(6)},${lng.toFixed(6)}`;
    /** What a caller gets: never the internal fields. @param {any} p */
    const publicPlace = (p) => ({ name: p.name, category: p.cat, phone: p.phone || null, lat: p.lat, lng: p.lng, address: p.address || "", distanceM: p.distanceM, etaS: p.etaS, tier: p.tier, rating: p.rating ?? null, reviews: p.reviewsCount || 0, openNow: p.openNow ?? null, source: p.source, navUrl: navUrl(p.lat, p.lng) });

    return {
        id: "poi",
        version: "1.0.0",
        apiVersion: 1,
        description: "Vetted hospitals, mechanics, service centres, hotels and dhabas nearby, cached for emergencies.",
        requires: ["master-api", "location"],
        defaults: { tickMs: 1000, tileTtlMs: 43200000, googleTtlMs: 3600000, maxTiles: 80, failBackoffMs: 120000, radiusM: 1700, mealMinRideMs: 2700000, mealRepeatMs: 10800000, restMinM: 500, restMaxM: 5000, timeoutMs: 15000 },
        rank,

        /** @param {any} ctx */
        start(ctx) {
            const G = geo();
            const cfg = ctx.config;
            const api = ctx.caps.get("master-api");
            const loc = ctx.caps.get("location");
            /** @type {Record<string, { fetchedAt: number, usedAt: number, places: any[], memoryUntil?: number }>} */
            const tiles = ctx.store.get("tiles", {}) || {};
            /** @type {Map<string, number>} */ const failedAt = new Map();
            let fetching = false, lastMealAt = -Infinity;
            /** @type {string} */ let lastSig = "";

            function persist() {
                const keys = Object.keys(tiles);
                if (keys.length > cfg.maxTiles) keys.sort((a, b) => tiles[a].usedAt - tiles[b].usedAt).slice(0, keys.length - cfg.maxTiles).forEach((k) => delete tiles[k]);
                /** @type {Record<string, any>} */ const out = {};
                for (const [k, t] of Object.entries(tiles)) {
                    out[k] = {
                        fetchedAt: t.fetchedAt, usedAt: t.usedAt,
                        places: t.places.map((p) => (p.storable === true ? p : { cat: p.cat, source: p.source, placeId: p.placeId, lat: p.lat, lng: p.lng, storable: p.storable }))
                    };
                }
                ctx.store.set("tiles", out);
            }
            const allPlaces = () => Object.values(tiles).flatMap((t) => t.places);

            function needed() {
                const c = ctx.bus.last("state.corridor");
                const f = loc.current();
                const pos = c && c.ego ? c.ego : f;
                if (!pos || !Number.isFinite(pos.lat)) return [];
                const keys = [G.tileOf(pos.lat, pos.lng)];
                for (const s of (c && c.samples) || []) { const k = G.tileOf(s[0], s[1]); if (!keys.includes(k)) keys.push(k); }
                return keys;
            }
            const stale = (/** @type {string} */ k) => {
                const t = tiles[k];
                if (!t) return true;
                if (ctx.now() - t.fetchedAt > cfg.tileTtlMs) return true;
                // Google fields don't survive a restart: refresh once this session if they were stripped
                return !(t.memoryUntil && t.memoryUntil > ctx.now()) && t.places.some((p) => p.source === "google" && !p.name);
            };

            async function fetchNext() {
                if (fetching) return;
                const k = needed().find((key) => stale(key) && ctx.now() - (failedAt.get(key) || -Infinity) > cfg.failBackoffMs);
                if (!k) return;
                fetching = true;
                try {
                    const [lat, lng] = G.tileCentre(k);
                    const r = await api.post("/poi", { lat, lng, radiusM: cfg.radiusM, categories: CATS }, { timeoutMs: cfg.timeoutMs, signal: ctx.signal });
                    if (!r.ok) { failedAt.set(k, ctx.now()); if (r.reason !== "offline") ctx.markDegraded(`places unavailable (${r.reason})`); return; }
                    ctx.markDegraded("");
                    tiles[k] = { fetchedAt: ctx.now(), usedAt: ctx.now(), memoryUntil: ctx.now() + cfg.googleTtlMs, places: (r.data.places || []).filter((/** @type {any} */ p) => p && Number.isFinite(p.lat) && Number.isFinite(p.lng) && CATS.includes(p.cat)) };
                    persist();
                } finally { fetching = false; }
            }

            function egoNow() {
                const c = ctx.bus.last("state.corridor");
                if (c && c.ego) return c.ego;
                const f = loc.current();
                return f && Number.isFinite(f.lat) ? { lat: f.lat, lng: f.lng, speedMs: f.speedMs || 0, headingDeg: null } : null;
            }

            function tick() {
                const ego = egoNow();
                if (!ego) return;
                for (const k of needed()) if (tiles[k]) tiles[k].usedAt = ctx.now();
                const places = allPlaces();
                /** @type {Record<string, any>} */ const best = {};
                let sig = "";
                for (const cat of CATS) {
                    const top = rank(places, cat, ego, G)[0];
                    best[cat] = top ? publicPlace(top) : null;
                    sig += top ? `${top.name}@${Math.round(top.distanceM / 100)}|` : "-|";
                }
                if (sig !== lastSig) { lastSig = sig; ctx.setState("poi", { at: ctx.now(), best, cachedTiles: Object.keys(tiles).length }); }
                ctx.heartbeat();
                fetchNext();
            }

            /** Best food stop AHEAD, for a break. */
            function suggestStop(/** @type {string} */ why) {
                const ego = egoNow();
                if (!ego) return false;
                const list = rank(allPlaces(), "food", ego, G, { maxKm: cfg.restMaxM / 1000 })
                    .filter((p) => p.distanceM >= cfg.restMinM && (p.ahead || !(ego.speedMs >= 3)) && p.tier !== "unvetted");
                const p = list[0];
                if (!p) return false;
                ctx.report("rest.stop", { severity: "advice", key: "rest.stop", category: "food", data: { place: p.name, distanceM: Math.max(500, Math.round(p.distanceM / 100) * 100), why, tier: p.tier, placeLat: p.lat, placeLng: p.lng }, cooldownMs: 1800000 });
                return true;
            }

            ctx.bus.handle("task.poi-best", (/** @type {any} */ q) => {
                const ego = egoNow();
                const cat = q && CATS.includes(q.category) ? q.category : null;
                if (!ego || !cat) return [];
                return rank(allPlaces(), cat, ego, G, { maxKm: 25 }).slice(0, Math.max(1, Math.min(5, (q && q.count) || 3))).map(publicPlace);
            });
            ctx.bus.handle("task.emergency", (/** @type {any} */ q) => {
                const ego = egoNow();
                if (!ego) return { primary: null, alternatives: [], reason: "no-position" };
                const cats = q && q.kind === "breakdown" ? ["mechanic", "service"] : ["hospital"];
                const list = cats.flatMap((c) => rank(allPlaces(), c, ego, G, { maxKm: 30, emergency: true }));
                if (!list.length) return { primary: null, alternatives: [], reason: "none-cached" };
                // medical: the nearest, unless a better-reviewed one is at most 1.5× as far
                const byDist = [...list].sort((a, b) => a.distanceM - b.distanceM);
                const nearest = byDist[0];
                const better = list.find((p) => p.tier === "vetted" && p.distanceM <= nearest.distanceM * 1.5);
                const primary = q && q.kind === "breakdown" ? list[0] : (better || nearest);
                return { primary: publicPlace(primary), alternatives: list.filter((p) => p !== primary).slice(0, 3).map(publicPlace), emergencyNumber: "112" };
            });

            // babysitter: a break is due → suggest the best dhaba ahead
            ctx.bus.subscribe("report.ride.ride.break-due", () => { suggestStop("break"); });
            // meal time on a long ride
            ctx.timers.setInterval(() => {
                const ride = ctx.bus.last("state.ride");
                if (!ride || !ride.active || (ride.ridingSec || 0) * 1000 < cfg.mealMinRideMs || ctx.now() - lastMealAt < cfg.mealRepeatMs) return;
                const d = new Date(Date.now()), hm = d.getHours() * 60 + d.getMinutes();
                if (!((hm >= 750 && hm <= 840) || (hm >= 1170 && hm <= 1260))) return;     // 12:30–14:00, 19:30–21:00 local
                if (suggestStop("meal")) lastMealAt = ctx.now();
            }, 60000);

            ctx.timers.setInterval(tick, cfg.tickMs);
            tick();
        }
    };
});
