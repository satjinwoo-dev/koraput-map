// @ts-check
"use strict";
/* ============================================================================
   MapUnite map detail (server) — named places on the map, and Google's tiles
   ==============================================================================
   1. OSM PLACES (free)   GET /api/map/places?tiles=a:b,c:d   (≤ 12 tiles)
      The satellite view's label layers name roads and areas, but not the gyms,
      temples, schools, shops and petrol pumps Google shows. This serves them
      from OpenStreetMap (Overpass), in 0.01° tiles (~1.1 km), each fetched once
      and shared by every rider for 24 h, like the speed-limit tiles. Per place
      only what the map draws: id, position, name (plus an English name when
      OSM has a different one), a kind and a rank (which to keep when labels
      collide). OSM data is ODbL: storable, with attribution.
      A tile answers { places } or { failed: true } (retry later) or
      { busy: true } (too many Overpass queries in flight; retry in a moment).

   2. GOOGLE TILES (paid, opt-in)   GET /api/map/gtile/:type/:z/:x/:y
                                    GET /api/map/gattr?type&zoom&n&s&e&w
      Google's own map, through the Map Tiles API, only when the server has a
      key for it: GOOGLE_MAP_TILES_KEY, or GOOGLE_MAPS_SERVER_KEY with
      MAP_TILES_GOOGLE=1 (the key must have the Map Tiles API enabled, and
      billing). The key never reaches the phone: the server creates the
      session, fetches each tile and passes it through with Google's own
      cache headers. It stores no tiles (Google's terms limit caching).
      type: "satellite" (imagery with roads and names, like Google's satellite
      view) or "roadmap". gattr returns the copyright line Google requires for
      what's on screen.
      Not checked against Google's live API from here: the request shapes
      follow Google's Map Tiles API documentation (createSession, 2dtiles,
      viewport) and need a check with a real key before launch.
   ============================================================================ */

const TILE_DEG = 0.01;
const TILE_KEY_RE = /^-?\d{1,5}:-?\d{1,5}$/;
const MAX_TILES_PER_REQUEST = 12;
const MAX_PLACES_PER_TILE = 300;

/** kind → rank (lower = more important, kept when labels collide) */
const RANK = Object.freeze({ area: 1, health: 2, fuel: 2, police: 2, worship: 3, education: 3, transit: 3, attraction: 3,
    food: 4, lodging: 4, bank: 4, government: 4, gym: 5, park: 5, shop: 6, service: 6, other: 7 });

/**
 * What a place is, from its OSM tags. null: not something the map labels.
 * @param {Record<string, string>} t
 * @returns {keyof typeof RANK | null}
 */
function kindOf(t) {
    const a = t.amenity || "", s = t.shop || "", tour = t.tourism || "", l = t.leisure || "", p = t.place || "";
    if (/^(suburb|neighbourhood|quarter|village|hamlet|town|city|locality|isolated_dwelling)$/.test(p)) return "area";
    if (/^(hospital|clinic|doctors|pharmacy|dentist)$/.test(a) || t.healthcare) return "health";
    if (/^(fuel|charging_station)$/.test(a)) return "fuel";
    if (a === "police" || a === "fire_station") return "police";
    if (a === "place_of_worship") return "worship";
    if (/^(school|college|university|kindergarten|library)$/.test(a)) return "education";
    if (/^(bus_station|ferry_terminal)$/.test(a) || t.railway === "station" || t.public_transport === "station") return "transit";
    if (/^(attraction|viewpoint|museum|zoo|theme_park|artwork|gallery)$/.test(tour) || t.historic) return "attraction";
    if (/^(restaurant|cafe|fast_food|food_court|bar|pub|ice_cream|biergarten)$/.test(a)) return "food";
    if (/^(hotel|guest_house|hostel|motel|apartment|chalet|camp_site)$/.test(tour)) return "lodging";
    if (/^(bank|atm|bureau_de_change)$/.test(a)) return "bank";
    if (/^(townhall|courthouse|post_office|community_centre|social_facility)$/.test(a) || t.office === "government") return "government";
    if (l === "fitness_centre" || l === "sports_centre") return "gym";
    if (/^(park|garden|playground|pitch|stadium|nature_reserve|recreation_ground|track)$/.test(l)) return "park";
    if (s) return "shop";
    if (/^(car_repair|motorcycle_repair|car_wash|vehicle_inspection)$/.test(a || s) || t.craft) return "service";
    if (a || tour || l || t.office) return "other";
    return null;
}

const clamp = (/** @type {unknown} */ s, /** @type {number} */ n) => String(s || "").replace(/\s+/g, " ").trim().slice(0, n);

/**
 * One Overpass element → what the phone draws, or null.
 * @param {any} el
 */
function compactPlace(el) {
    const t = el && el.tags;
    if (!t || !t.name) return null;
    const lat = el.type === "node" ? el.lat : el.center && el.center.lat;
    const lng = el.type === "node" ? el.lon : el.center && el.center.lon;
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
    const kind = kindOf(t);
    if (!kind) return null;
    const name = clamp(t.name, 60);
    const en = clamp(t["name:en"], 60);
    /** @type {{ id: string, lat: number, lng: number, name: string, kind: string, rank: number, en?: string }} */
    const p = { id: `${el.type[0]}${el.id}`, lat: +lat.toFixed(6), lng: +lng.toFixed(6), name, kind, rank: RANK[kind] };
    if (en && en.toLowerCase() !== name.toLowerCase()) p.en = en;
    return p;
}

/** @param {string} key */
function tileBounds(key) {
    const [a, b] = key.split(":").map(Number);
    const s = a * TILE_DEG, w = b * TILE_DEG;
    return { s: +s.toFixed(5), w: +w.toFixed(5), n: +(s + TILE_DEG).toFixed(5), e: +(w + TILE_DEG).toFixed(5) };
}

/** @param {string} key */
function placesQuery(key) {
    const b = tileBounds(key), bb = `${b.s},${b.w},${b.n},${b.e}`;
    const keys = "^(amenity|shop|tourism|leisure|historic|office|healthcare|place|craft)$";
    return `[out:json][timeout:20];(node(${bb})[name][~"${keys}"~"."];way(${bb})[name][~"^(amenity|shop|tourism|leisure|historic|office|healthcare)$"~"."];node(${bb})[name][railway=station];);out center tags;`;
}

/**
 * @param {{ env?: Record<string, string|undefined>, fetch?: typeof fetch, now?: () => number, log?: (m: string) => void,
 *   overpassUrl?: string, ttlMs?: number, failTtlMs?: number, maxTiles?: number, maxInflight?: number }} [o]
 */
function createMapDetail(o = {}) {
    const env = o.env || process.env;
    const f = o.fetch || fetch;
    const now = o.now || Date.now;
    const log = o.log || ((m) => console.warn(m));
    const overpassUrl = o.overpassUrl || env.OVERPASS_URL || "https://overpass-api.de/api/interpreter";
    const TTL = o.ttlMs ?? 24 * 3600e3, FAIL_TTL = o.failTtlMs ?? 60e3, MAX = o.maxTiles ?? 3000, MAX_INFLIGHT = o.maxInflight ?? 2;

    // ------------------------------------------------------------ 1. OSM places
    /** @type {Map<string, any>} */ const cache = new Map();
    /** @type {Map<string, Promise<any>>} */ const inflight = new Map();

    /** @param {string} key */
    async function placesTile(key) {
        const hit = cache.get(key);
        if (hit && now() - hit.ts < (hit.failed ? FAIL_TTL : TTL)) return hit;
        const running = inflight.get(key);
        if (running) return running;
        if (inflight.size >= MAX_INFLIGHT) return { busy: true };
        const job = (async () => {
            try {
                const res = await f(overpassUrl, {
                    method: "POST",
                    headers: { "Content-Type": "application/x-www-form-urlencoded", "User-Agent": "MapUnite/1.0 (squad riding app; map place names)" },
                    body: "data=" + encodeURIComponent(placesQuery(key)),
                    signal: AbortSignal.timeout(25000)
                });
                if (!res.ok) throw new Error(`Overpass HTTP ${res.status}`);
                const json = await res.json();
                const seen = new Set();
                const places = (json.elements || []).map(compactPlace).filter((p) => p && !seen.has(p.id) && seen.add(p.id))
                    .sort((a, b) => a.rank - b.rank).slice(0, MAX_PLACES_PER_TILE);
                const entry = { ts: now(), places };
                if (cache.size >= MAX) cache.delete(/** @type {string} */ (cache.keys().next().value));
                cache.set(key, entry);
                return entry;
            } catch (e) {
                log(`map places tile ${key} failed: ${/** @type {Error} */ (e).message}`);
                const entry = { ts: now(), failed: true };
                cache.set(key, entry);
                return entry;
            } finally {
                inflight.delete(key);
            }
        })();
        inflight.set(key, job);
        return job;
    }

    /** @param {any} req @param {any} res */
    async function placesHandler(req, res) {
        const raw = typeof req.query.tiles === "string" ? req.query.tiles : "";
        const keys = [...new Set(raw.split(",").map((s) => s.trim()).filter(Boolean))];
        if (!keys.length || keys.length > MAX_TILES_PER_REQUEST || !keys.every((k) => TILE_KEY_RE.test(k))) {
            return res.status(400).json({ ok: false, reason: "bad-tiles" });
        }
        /** @type {Record<string, any>} */ const tiles = {};
        await Promise.all(keys.map(async (k) => {
            const t = await placesTile(k);
            tiles[k] = t.places ? { places: t.places } : t.busy ? { busy: true } : { failed: true };
        }));
        res.setHeader("Cache-Control", Object.values(tiles).every((t) => t.places) ? "public, max-age=3600" : "no-store");
        res.json({ ok: true, tileDeg: TILE_DEG, tiles });
    }

    // ------------------------------------------------------------ 2. Google tiles
    const googleKey = env.GOOGLE_MAP_TILES_KEY || (env.MAP_TILES_GOOGLE === "1" ? env.GOOGLE_MAPS_SERVER_KEY || "" : "");
    const G = "https://tile.googleapis.com";
    const TYPES = Object.freeze({
        satellite: { mapType: "satellite", language: "en-US", region: "IN", layerTypes: ["layerRoadmap"] },
        roadmap: { mapType: "roadmap", language: "en-US", region: "IN" }
    });
    /** @type {Record<string, { token: string, expiresAt: number } | undefined>} */ const sessions = {};
    /** @type {Record<string, Promise<string> | undefined>} */ const pendingSession = {};

    /** @param {keyof typeof TYPES} type @param {boolean} [fresh] */
    async function session(type, fresh = false) {
        const s = sessions[type];
        if (!fresh && s && s.expiresAt - now() > 3600e3) return s.token;
        if (pendingSession[type]) return /** @type {Promise<string>} */ (pendingSession[type]);
        const p = (async () => {
            try {
                const r = await f(`${G}/v1/createSession?key=${encodeURIComponent(googleKey)}`, {
                    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(TYPES[type]),
                    signal: AbortSignal.timeout(8000)
                });
                if (!r.ok) throw new Error(`createSession HTTP ${r.status}`);
                const j = await r.json();
                if (!j || typeof j.session !== "string") throw new Error("createSession: no session");
                const exp = Number(j.expiry) * 1000;
                sessions[type] = { token: j.session, expiresAt: Number.isFinite(exp) && exp > now() ? exp : now() + 24 * 3600e3 };
                return j.session;
            } finally {
                pendingSession[type] = undefined;
            }
        })();
        pendingSession[type] = p;
        return p;
    }

    /** @param {any} v */
    const isType = (v) => typeof v === "string" && Object.prototype.hasOwnProperty.call(TYPES, v);

    /** @param {any} req @param {any} res */
    async function googleTileHandler(req, res) {
        if (!googleKey) return res.status(503).json({ ok: false, reason: "google-tiles-not-configured" });
        const { type } = req.params;
        const z = Number(req.params.z), x = Number(req.params.x), y = Number(req.params.y);
        if (!isType(type) || !Number.isInteger(z) || z < 0 || z > 22 || !Number.isInteger(x) || !Number.isInteger(y) || x < 0 || y < 0 || x >= 2 ** z || y >= 2 ** z) {
            return res.status(400).json({ ok: false, reason: "bad-tile" });
        }
        try {
            let r = null;
            for (const fresh of [false, true]) {
                const token = await session(type, fresh);
                r = await f(`${G}/v1/2dtiles/${z}/${x}/${y}?session=${encodeURIComponent(token)}&key=${encodeURIComponent(googleKey)}`, { signal: AbortSignal.timeout(8000) });
                if (r.status !== 401 && r.status !== 403) break;          // an expired session: make a new one once
            }
            if (!r || !r.ok) return res.status(r && r.status === 404 ? 404 : 502).end();
            res.setHeader("Content-Type", r.headers.get("content-type") || "image/png");
            const cc = r.headers.get("cache-control");
            if (cc) res.setHeader("Cache-Control", cc);
            res.setHeader("Cross-Origin-Resource-Policy", "cross-origin");
            res.end(Buffer.from(await r.arrayBuffer()));
        } catch (e) {
            log(`google tile failed: ${/** @type {Error} */ (e).message}`);
            res.status(502).end();
        }
    }

    /** @param {any} req @param {any} res */
    async function googleAttributionHandler(req, res) {
        if (!googleKey) return res.status(503).json({ ok: false, reason: "google-tiles-not-configured" });
        const q = req.query || {};
        const zoom = Number(q.zoom), n = Number(q.n), s = Number(q.s), e = Number(q.e), w = Number(q.w);
        const okLat = (/** @type {number} */ v) => Number.isFinite(v) && v >= -90 && v <= 90, okLng = (/** @type {number} */ v) => Number.isFinite(v) && v >= -180 && v <= 180;
        if (!isType(q.type) || !Number.isInteger(zoom) || zoom < 0 || zoom > 22 || !okLat(n) || !okLat(s) || !okLng(e) || !okLng(w)) {
            return res.status(400).json({ ok: false, reason: "bad-viewport" });
        }
        try {
            const token = await session(q.type);
            const r = await f(`${G}/tile/v1/viewport?session=${encodeURIComponent(token)}&key=${encodeURIComponent(googleKey)}&zoom=${zoom}&north=${n}&south=${s}&east=${e}&west=${w}`, { signal: AbortSignal.timeout(6000) });
            if (!r.ok) return res.status(502).json({ ok: false, reason: "upstream-error" });
            const j = await r.json();
            res.json({ ok: true, copyright: clamp(j && j.copyright, 300) });
        } catch (err) {
            log(`google viewport failed: ${/** @type {Error} */ (err).message}`);
            res.status(502).json({ ok: false, reason: "upstream-unreachable" });
        }
    }

    return { placesHandler, placesTile, googleTileHandler, googleAttributionHandler, googleEnabled: Boolean(googleKey) };
}

module.exports = { createMapDetail, kindOf, compactPlace, placesQuery, tileBounds, RANK, TILE_DEG };
