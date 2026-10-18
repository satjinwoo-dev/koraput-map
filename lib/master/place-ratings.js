// @ts-check
"use strict";
/* ============================================================================
   MapUnite (server) — riders rate the places they stopped at
   ==============================================================================
   No paid reviews. A rider tells us about a place only after they said so:
   the phone notices a long stop on a ride (10 minutes or more in one spot), and
   LATER, when the ride is over, asks "Did you stop at <place>?". A stop alone
   proves nothing (traffic, a closed gate, a friend's house), so nothing is ever
   rated automatically: only a rider's explicit "Yes, I stopped here" and their
   👍 / 👎 reach this module. What the plan shows is labelled for what it is:
   "riders who said they stopped here".

     POST /api/master/ratings/candidates { lat, lng }            places within 150 m of a stop (OpenStreetMap)
     POST /api/master/ratings/submit    { v: 1, rater, place: { id, cat }, up, tags: [...] }
     POST /api/master/ratings/lookup    { ids: [osm ids] }  → { ratings: { id: { up, down, tags } } }
     POST /api/master/ratings/forget    { v: 1, rater }    every rating that rater gave, deleted

   The RATER is a random token the phone made once; stored only as
   HMAC(SERVER_SECRET, token), so one rider is one vote per place. No name, no
   ride, no position is stored (candidates gets the stop's position, rounded to
   ~11 m, to look places up, and keeps nothing). One rating per rater and place;
   it can change after 30 days. At most 30 ratings per rater a day.
   Places are OpenStreetMap ids ("n123", "w456"). Tags are a fixed list, no free
   text, so nothing personal or abusive can be posted.
   The plan shows a place's riders' verdict only from MIN_RATINGS (3) ratings,
   ranked by the Wilson lower bound (a few 👍 can't outrank many).
   Pure and tested: wilson(), cleanTags(), summarize().
   ============================================================================ */

const crypto = require("crypto");
const { createCache } = require("./cache");
const { createUpstream } = require("./upstream");
const { isCoord, haversine } = require("./geo");

const TAGS = Object.freeze({
    good: ["clean", "good-food", "fair-price", "friendly", "honest-work", "quick", "safe-parking", "clean-toilets"],
    bad: ["dirty", "overcharged", "rude", "poor-work", "slow", "unsafe"]
});
const ALL_TAGS = new Set([...TAGS.good, ...TAGS.bad]);
const CATS = Object.freeze(["food", "fuel", "mechanic", "hotel", "hospital"]);
const MIN_RATINGS = 3;
const DAY = 86400000;
const OSM_ID = /^[nwr][1-9]\d{0,11}$/;

/** Wilson lower bound (95 %) of the share of 👍. Pure. @param {number} up @param {number} down */
function wilson(up, down) {
    const n = up + down;
    if (!n) return 0;
    const z = 1.96, p = up / n;
    return (p + z * z / (2 * n) - z * Math.sqrt((p * (1 - p) + z * z / (4 * n)) / n)) / (1 + z * z / n);
}
/** Only known tags that fit the verdict, at most 4. Pure. @param {any} tags @param {boolean} up */
function cleanTags(tags, up) {
    if (!Array.isArray(tags)) return [];
    const allowed = new Set(up ? TAGS.good : TAGS.bad);
    return [...new Set(tags.filter((t) => typeof t === "string" && allowed.has(t)))].slice(0, 4);
}
/** Rows → { up, down, tags: { tag: n }, shown, score }. Pure. @param {Array<{ up: number, tags: string }>} rows */
function summarize(rows) {
    let up = 0, down = 0;
    /** @type {Record<string, number>} */ const tags = {};
    for (const r of rows) {
        if (r.up) up++; else down++;
        for (const t of String(r.tags || "").split(",").filter(Boolean)) if (ALL_TAGS.has(t)) tags[t] = (tags[t] || 0) + 1;
    }
    return { up, down, tags, shown: up + down >= MIN_RATINGS, score: wilson(up, down) };
}

/**
 * @param {{ db: () => any, secret: () => string, now?: () => number, fetchImpl?: typeof fetch, overpassUrl?: string }} o
 */
function createPlaceRatings(o) {
    const now = o.now || (() => Date.now());
    const overpassUrl = o.overpassUrl || "https://overpass-api.de/api/interpreter";
    const osm = createUpstream({ name: "overpass-ratings", fetchImpl: o.fetchImpl, now, failuresToOpen: 3 });
    /** @type {ReturnType<typeof createCache<any>>} */ const cand = createCache({ max: 2000, ttlMs: 7 * DAY, now });
    let schemaFor = null, q = /** @type {any} */ (null);
    const raterOf = (/** @type {string} */ token) => `p${crypto.createHmac("sha256", o.secret()).update(`mu-place-rater-v1|${token}`).digest("hex").slice(0, 15)}`;

    function st() {
        const db = o.db();
        if (!db) return null;
        if (schemaFor === db) return q;
        db.exec(`
CREATE TABLE IF NOT EXISTS place_rating (
  place TEXT NOT NULL, rater TEXT NOT NULL, cat TEXT NOT NULL, up INTEGER NOT NULL, tags TEXT NOT NULL DEFAULT '', at INTEGER NOT NULL,
  PRIMARY KEY (place, rater)
);
CREATE INDEX IF NOT EXISTS place_rating_rater ON place_rating (rater, at);`);
        q = {
            get: db.prepare(`SELECT at FROM place_rating WHERE place = ? AND rater = ?`),
            upsert: db.prepare(`INSERT INTO place_rating (place, rater, cat, up, tags, at) VALUES (?,?,?,?,?,?) ON CONFLICT(place, rater) DO UPDATE SET up = excluded.up, tags = excluded.tags, cat = excluded.cat, at = excluded.at`),
            today: db.prepare(`SELECT COUNT(*) AS n FROM place_rating WHERE rater = ? AND at > ?`),
            forPlace: db.prepare(`SELECT up, tags FROM place_rating WHERE place = ?`),
            forget: db.prepare(`DELETE FROM place_rating WHERE rater = ?`)
        };
        schemaFor = db;
        return q;
    }
    const token = (/** @type {any} */ t) => (typeof t === "string" && /^[A-Za-z0-9_-]{16,64}$/.test(t) ? t : null);

    /** @param {any} body */
    async function submit(body) {
        const s = st();
        if (!s) return { status: 503, json: { ok: false, reason: "no-database" } };
        const rater = token(body && body.rater), place = body && body.place;
        if (!rater || !place || !OSM_ID.test(String(place.id)) || !CATS.includes(place.cat) || typeof body.up !== "boolean") return { status: 400, json: { ok: false, reason: "bad-rating" } };
        const r = raterOf(rater), t = now();
        const prev = s.get.get(String(place.id), r);
        if (prev && t - prev.at < 30 * DAY) return { status: 409, json: { ok: false, reason: "rated-recently" } };
        if (s.today.get(r, t - DAY).n >= 30) return { status: 429, json: { ok: false, reason: "daily-limit" } };
        s.upsert.run(String(place.id), r, place.cat, body.up ? 1 : 0, cleanTags(body.tags, body.up).join(","), t);
        return { status: 200, json: { ok: true, place: String(place.id), ...summarize(s.forPlace.all(String(place.id))) } };
    }

    /** Ratings for places (used by the Ride Plan directly, and by the phone). @param {string[]} ids */
    function lookupIds(ids) {
        const s = st();
        /** @type {Record<string, any>} */ const out = {};
        if (!s) return out;
        for (const id of ids.slice(0, 400)) if (OSM_ID.test(id)) { const rows = s.forPlace.all(id); if (rows.length) out[id] = summarize(rows); }
        return out;
    }
    /** @param {any} body */
    async function lookup(body) {
        const ids = Array.isArray(body && body.ids) ? body.ids.map(String) : [];
        if (!ids.length || ids.length > 400) return { status: 400, json: { ok: false, reason: "bad-ids" } };
        return { status: 200, json: { ok: true, minRatings: MIN_RATINGS, ratings: lookupIds(ids) } };
    }

    /** Places within 150 m of a stop, for the "Did you stop at …?" question. @param {any} body */
    async function candidates(body) {
        const lat = Math.round(Number(body && body.lat) * 1e4) / 1e4, lng = Math.round(Number(body && body.lng) * 1e4) / 1e4;
        if (!isCoord(lat, lng)) return { status: 400, json: { ok: false, reason: "bad-position" } };
        const list = await cand.wrap(`${lat},${lng}`, async () => {
            const A = `(around:150,${lat},${lng})`;
            const qy = `[out:json][timeout:20];(nwr${A}[amenity~"^(restaurant|fast_food|cafe|fuel|hospital|clinic)$"];nwr${A}[shop~"^(motorcycle_repair|motorcycle|car_repair|tyres)$"];nwr${A}[tourism~"^(hotel|motel|guest_house)$"];);out tags center 30;`;
            const j = await osm.json(overpassUrl, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", "user-agent": "MapUnite/1.0 (place ratings)" }, body: `data=${encodeURIComponent(qy)}` }, { timeoutMs: 20000 });
            return (Array.isArray(j && j.elements) ? j.elements : []).map((/** @type {any} */ el) => {
                const t = el.tags || {}, a = el.lat ?? (el.center && el.center.lat), b = el.lon ?? (el.center && el.center.lon);
                if (!t.name || !isCoord(a, b)) return null;
                const cat = /^(restaurant|fast_food|cafe)$/.test(t.amenity) ? "food" : t.amenity === "fuel" ? "fuel" : /^(hospital|clinic)$/.test(t.amenity) ? "hospital" : t.tourism ? "hotel" : "mechanic";
                return { id: `${el.type[0]}${el.id}`, name: String(t.name).slice(0, 80), cat, distanceM: Math.round(haversine(lat, lng, a, b)) };
            }).filter(Boolean).sort((x, y) => x.distanceM - y.distanceM).slice(0, 5);
        });
        return { status: 200, json: { ok: true, places: list, tags: TAGS } };
    }

    /** @param {any} body */
    async function forget(body) {
        const s = st();
        const rater = token(body && body.rater);
        if (!s) return { status: 503, json: { ok: false, reason: "no-database" } };
        if (!rater) return { status: 400, json: { ok: false, reason: "bad-rater" } };
        const r = s.forget.run(raterOf(rater));
        return { status: 200, json: { ok: true, deleted: Number(r.changes) || 0 } };
    }

    return { submit, lookup, lookupIds, candidates, forget, configured: () => Boolean(o.db()), stats: () => ({ osm: osm.state(), candidates: cand.stats() }) };
}

module.exports = { createPlaceRatings, wilson, cleanTags, summarize, TAGS, MIN_RATINGS };
