// @ts-check
"use strict";
/* ============================================================================
   MapUnite Master AI (server) — vetted places around the rider
   ==============================================================================
   POST /api/master/poi  { lat, lng, radiusM ≤ 3000, categories: [...] }
     → { ok, places: [Place], sources: { google, osm } }

   CATEGORIES   hospital · mechanic · service · hotel · food (dhabas, restaurants)

   SOURCES
     Google Places API (New), GOOGLE_MAPS_SERVER_KEY: ratings, review counts,
       up to 5 reviews, phone, opening state. Field mask kept to what vetting
       needs (it decides the SKU, i.e. the bill: reviews are the expensive part).
     OpenStreetMap (Overpass), free: name, position, phone, opening hours. No
       reviews, so OSM-only places are never "vetted", but an OSM hospital is
       still the right answer in an emergency when nothing else is near.

   VETTING (vet(), pure): what reviews CAN tell, honestly labelled.
     1. Bayesian rating: (C·m + n·r) / (C + n), prior m = 3.9 stars worth C
        reviews (C = 30 hospitals, 20 others). 4.9★ from 6 reviews ranks below
        4.4★ from 900.
     2. Volume: a minimum review count per category (hospital 25, others 15)
        before a place can be "vetted".
     3. Red flags in recent reviews (≤ 365 days), English and Hinglish:
        "fraud", "overcharged", "rude", "no doctor", "food poisoning", "dhokha",
        "loot", … Each costs score. "permanently closed" / "band ho gaya" in a
        recent review rejects the place outright, as does businessStatus ≠
        OPERATIONAL.
     4. Fake-review tells: ≥ 4 five-star reviews posted within 14 days of each
        other on a place with < 60 reviews (a burst), or two reviews sharing
        ≥ 60 % of their word pairs (copy-paste). Each is a penalty, not a ban:
        both happen innocently too.
     5. Fit: a "mechanic" must look like a two-wheeler/auto repair place by
        type or name; hotels and food are checked against their Google types.
     Tiers: "vetted" (passed everything, enough reviews), "ok", "unvetted".
     Nothing here VERIFIES a review; it filters. The app says "well reviewed",
     never "verified".

   CACHING AND GOOGLE'S TERMS. Google Maps Platform terms limit caching of
   Places content: place IDs may be stored, coordinates for up to 30 days,
   most other fields not at all. So:
     - the server keeps Google answers in memory for PLACES_CACHE_SECONDS
       (default 900 s, to absorb a convoy asking the same tile at once);
     - every Google place carries storable: ["placeId", "lat", "lng"] and the
       phone persists ONLY those fields (OSM places are ODbL and persist whole).
     Review your own Google agreement before raising the TTL.
   ============================================================================ */

const { createCache } = require("./cache");
const { createUpstream } = require("./upstream");
const { isCoord, haversine } = require("./geo");

const CATEGORIES = Object.freeze(["hospital", "mechanic", "service", "hotel", "food"]);
const PRIOR = Object.freeze({ m: 3.9, C: { hospital: 30, mechanic: 20, service: 20, hotel: 20, food: 20 } });
const MIN_REVIEWS = Object.freeze({ hospital: 25, mechanic: 15, service: 15, hotel: 15, food: 15 });
const DAY = 86400000;

/** Google request per category: nearby by type, or text search where types don't exist in India's data. */
const GOOGLE = Object.freeze({
    hospital: { nearby: ["hospital"] },
    mechanic: { text: "motorcycle repair mechanic" },
    service: { text: "two wheeler service center" },
    hotel: { nearby: ["lodging"] },
    food: { text: "dhaba restaurant" }
});
const FIELD_MASK = [
    "places.id", "places.displayName", "places.location", "places.rating", "places.userRatingCount",
    "places.nationalPhoneNumber", "places.internationalPhoneNumber", "places.businessStatus",
    "places.currentOpeningHours.openNow", "places.reviews", "places.types", "places.formattedAddress"
].join(",");

const RED_FLAGS = [
    /\bfraud\b/, /\bscam\b/, /\bcheat(ed|ing|er)?\b/, /\bover ?charg/, /\bloot(ed|ing)?\b/, /\bdhokha\b/, /\bdhokebaaz/, /\bchor\b/,
    /\brude\b/, /\bbad behaviou?r\b/, /\bbadtameez/, /\bworst\b/, /\bpathetic\b/, /\bhorrible\b/, /\bbekaar\b|\bbekar\b/,
    /\bdirty\b/, /\bunhygienic\b/, /\bganda\b|\bgandi\b/, /\bfood poisoning\b/, /\bcockroach/, /\bstale\b/,
    /\bno doctors?\b/, /\bdoctor (was )?not (available|present)\b/, /\bnegligen/, /\brefused (to )?(admit|treat)/,
    /\bfake (parts|spare|review)/, /\bduplicate parts\b/, /\bnot safe\b/, /\bunsafe\b/, /\bharass/
];
const CLOSED = [/\bpermanently closed\b/, /\bshut ?down\b/, /\bno longer (exists|open|operating)\b/, /\bband ho gay[ai]\b/, /\bclosed down\b/];
const MECHANIC_NAME = /\b(motor|moto|bike|two[- ]?wheeler|2[- ]?wheeler|scooter|garage|mechanic|auto|service|works|hero|honda|bajaj|tvs|yamaha|royal enfield|suzuki|ktm)\b/i;

/** Word pairs of a text, for near-duplicate detection. @param {string} t */
function shingles(t) {
    const w = t.toLowerCase().replace(/[^a-z0-9ऀ-ॿ ]+/g, " ").split(/\s+/).filter(Boolean);
    /** @type {Set<string>} */ const s = new Set();
    for (let i = 0; i + 1 < w.length; i++) s.add(`${w[i]} ${w[i + 1]}`);
    return s;
}
/** @param {Set<string>} a @param {Set<string>} b */
function jaccard(a, b) {
    if (a.size < 4 || b.size < 4) return 0;
    let inter = 0;
    for (const x of a) if (b.has(x)) inter++;
    return inter / (a.size + b.size - inter);
}

/**
 * Score one place. Pure.
 * @param {{ cat: string, rating?: number|null, reviewsCount?: number|null, businessStatus?: string|null, phone?: string|null,
 *   openNow?: boolean|null, types?: string[], name?: string, reviews?: Array<{ rating?: number, text?: string, publishTime?: string }> }} p
 * @param {number} now
 * @returns {{ ok: boolean, score: number, tier: "vetted"|"ok"|"unvetted", bayes: number|null, flags: string[], reason?: string }}
 */
function vet(p, now) {
    const flags = [];
    if (p.businessStatus && p.businessStatus !== "OPERATIONAL") return { ok: false, score: 0, tier: "unvetted", bayes: null, flags: [`status:${p.businessStatus}`], reason: "not operating" };
    const cat = /** @type {keyof typeof MIN_REVIEWS} */ (p.cat);
    if (cat === "mechanic" || cat === "service") {
        const t = p.types || [];
        if (!t.includes("car_repair") && !t.includes("motorcycle_repair") && !MECHANIC_NAME.test(p.name || "")) return { ok: false, score: 0, tier: "unvetted", bayes: null, flags: ["not-a-mechanic"], reason: "doesn't look like a repair shop" };
    }
    if (cat === "hotel" && p.types && p.types.length && !p.types.some((t) => /lodging|hotel|motel|guest_house|resort/.test(t))) return { ok: false, score: 0, tier: "unvetted", bayes: null, flags: ["not-lodging"], reason: "not a place to stay" };

    const n = Number.isFinite(p.reviewsCount) ? /** @type {number} */ (p.reviewsCount) : 0;
    const r = Number.isFinite(p.rating) ? /** @type {number} */ (p.rating) : null;
    const C = PRIOR.C[cat] || 20, minN = MIN_REVIEWS[cat] || 15;
    if (r === null || n === 0) {
        // nothing to judge by (OSM, or a new listing): usable, never "vetted"
        const score = 0.35 + (p.phone ? 0.05 : 0);
        return { ok: true, score, tier: "unvetted", bayes: null, flags: ["no-reviews"] };
    }
    const bayes = (C * PRIOR.m + n * r) / (C + n);
    const base = (bayes - 1) / 4;
    const volume = 1 - Math.exp(-n / minN);
    let penalty = 0, bonus = 0;

    const reviews = (p.reviews || []).filter((x) => x && typeof x.text === "string");
    const recent = reviews.filter((x) => { const t = Date.parse(x.publishTime || ""); return Number.isFinite(t) && now - t <= 365 * DAY; });
    for (const rv of recent) {
        const t = /** @type {string} */ (rv.text).toLowerCase();
        if (CLOSED.some((re) => re.test(t))) return { ok: false, score: 0, tier: "unvetted", bayes, flags: ["closed-in-review"], reason: "a recent review says it closed" };
        const hits = RED_FLAGS.filter((re) => re.test(t)).length;
        if (hits && (rv.rating ?? 5) <= 3) { penalty += Math.min(0.12, 0.06 * hits); flags.push("red-flag"); }
    }
    penalty = Math.min(0.3, penalty);
    const recentLow = recent.filter((x) => Number.isFinite(x.rating));
    if (recentLow.length >= 2) {
        const avg = recentLow.reduce((a, x) => a + /** @type {number} */ (x.rating), 0) / recentLow.length;
        if (avg < 3) { penalty += 0.1; flags.push("recent-decline"); }
    }
    // burst of 5-star reviews close together on a small place
    const fives = reviews.filter((x) => x.rating === 5).map((x) => Date.parse(x.publishTime || "")).filter(Number.isFinite).sort((a, b) => a - b);
    if (n < 60 && fives.length >= 4) {
        for (let i = 0; i + 3 < fives.length; i++) if (fives[i + 3] - fives[i] <= 14 * DAY) { penalty += 0.15; flags.push("review-burst"); break; }
    }
    // copy-paste reviews
    const sh = reviews.map((x) => shingles(/** @type {string} */ (x.text)));
    dup: for (let i = 0; i < sh.length; i++) for (let j = i + 1; j < sh.length; j++) if (jaccard(sh[i], sh[j]) >= 0.6) { penalty += 0.15; flags.push("duplicate-reviews"); break dup; }

    if (p.phone) bonus += 0.05; else flags.push("no-phone");
    if (p.openNow === true) bonus += 0.03;
    if (cat === "hospital" && reviews.some((x) => /\b(emergency|casualty|24 ?(hours|hrs|x ?7)|ambulance|icu|trauma)\b/i.test(/** @type {string} */ (x.text)))) bonus += 0.03;

    const score = Math.max(0, Math.min(1, base * (0.6 + 0.4 * volume) + bonus - penalty));
    const severe = flags.includes("review-burst") || flags.includes("duplicate-reviews") || flags.includes("recent-decline");
    const tier = n >= minN && bayes >= 3.8 && score >= 0.6 && !severe && !flags.includes("red-flag") ? "vetted" : n >= 5 && bayes >= 3.5 ? "ok" : "unvetted";
    return { ok: true, score: Math.round(score * 1000) / 1000, tier, bayes: Math.round(bayes * 100) / 100, flags: [...new Set(flags)] };
}

/** Name similarity for merging Google and OSM records of the same place. @param {string} a @param {string} b */
function sameName(a, b) {
    const t = (/** @type {string} */ s) => new Set(s.toLowerCase().replace(/[^a-z0-9 ]+/g, " ").split(/\s+/).filter((w) => w.length > 2 && !/^(the|and|hospital|hotel|restaurant|dhaba|motors?|service|center|centre)$/.test(w)));
    const A = t(a), B = t(b);
    if (!A.size || !B.size) return a.trim().toLowerCase() === b.trim().toLowerCase();
    let inter = 0;
    for (const x of A) if (B.has(x)) inter++;
    return inter / Math.min(A.size, B.size) >= 0.5;
}

/** Overpass query for one category around a point. @param {string} cat @param {number} lat @param {number} lng @param {number} r */
function osmQuery(cat, lat, lng, r) {
    const A = `(around:${r},${lat},${lng})`;
    const parts = {
        hospital: [`nwr${A}[amenity=hospital]`, `nwr${A}[amenity=clinic][emergency=yes]`],
        mechanic: [`nwr${A}[shop=motorcycle_repair]`, `nwr${A}[shop=motorcycle][service:repair!=no]`, `nwr${A}[craft=motorcycle_repair]`],
        service: [`nwr${A}[shop=motorcycle]`, `nwr${A}[shop=car_repair]`],
        hotel: [`nwr${A}[tourism~"^(hotel|motel|guest_house)$"]`],
        food: [`nwr${A}[amenity~"^(restaurant|fast_food)$"]`, `nwr${A}[amenity=cafe][name~"(?i)(chai|tea|dhaba)"]`]
    };
    return `[out:json][timeout:15];(${(/** @type {any} */ (parts)[cat] || []).join(";")};);out tags center 40;`;
}

/**
 * @param {{ googleKey?: string, overpassUrl?: string, fetchImpl?: typeof fetch, now?: () => number, googleTtlMs?: number }} [o]
 */
function createPoi(o = {}) {
    const now = o.now || (() => Date.now());
    const googleKey = o.googleKey || "";
    const overpassUrl = o.overpassUrl || "https://overpass-api.de/api/interpreter";
    const g = createUpstream({ name: "google-places", fetchImpl: o.fetchImpl, now });
    const osm = createUpstream({ name: "overpass-poi", fetchImpl: o.fetchImpl, now, failuresToOpen: 3 });
    /** @type {ReturnType<typeof createCache<any[]>>} */ const gCache = createCache({ max: 4000, ttlMs: o.googleTtlMs ?? 900000, staleMs: 0, now });
    /** @type {ReturnType<typeof createCache<any>>} */ const oCache = createCache({ max: 8000, ttlMs: 7 * DAY, staleMs: 30 * DAY, now });

    /** @param {string} cat @param {number} lat @param {number} lng @param {number} r */
    async function fromGoogle(cat, lat, lng, r) {
        const spec = /** @type {any} */ (GOOGLE)[cat];
        const circle = { center: { latitude: lat, longitude: lng }, radius: r };
        const isNearby = Boolean(spec.nearby);
        const url = isNearby ? "https://places.googleapis.com/v1/places:searchNearby" : "https://places.googleapis.com/v1/places:searchText";
        const body = isNearby
            ? { includedTypes: spec.nearby, maxResultCount: 20, locationRestriction: { circle }, rankPreference: "POPULARITY" }
            : { textQuery: spec.text, pageSize: 20, locationBias: { circle } };
        const j = await g.json(url, { method: "POST", headers: { "content-type": "application/json", "X-Goog-Api-Key": googleKey, "X-Goog-FieldMask": FIELD_MASK }, body: JSON.stringify(body) }, { timeoutMs: 7000 });
        const t = now();
        return (Array.isArray(j && j.places) ? j.places : []).map((/** @type {any} */ p) => {
            const plat = p.location && p.location.latitude, plng = p.location && p.location.longitude;
            if (!isCoord(plat, plng) || haversine(lat, lng, plat, plng) > r * 1.5) return null;  // text search "bias" can return far places
            const rec = {
                cat, source: "google", placeId: String(p.id || ""), name: (p.displayName && p.displayName.text) || "",
                lat: plat, lng: plng, phone: p.internationalPhoneNumber || p.nationalPhoneNumber || null,
                address: p.formattedAddress || "", rating: Number.isFinite(p.rating) ? p.rating : null,
                reviewsCount: Number.isFinite(p.userRatingCount) ? p.userRatingCount : 0,
                openNow: p.currentOpeningHours && typeof p.currentOpeningHours.openNow === "boolean" ? p.currentOpeningHours.openNow : null,
                businessStatus: p.businessStatus || null, types: Array.isArray(p.types) ? p.types : []
            };
            const reviews = (Array.isArray(p.reviews) ? p.reviews : []).map((/** @type {any} */ rv) => ({ rating: rv.rating, publishTime: rv.publishTime, text: (rv.originalText && rv.originalText.text) || (rv.text && rv.text.text) || "" }));
            const v = vet({ ...rec, reviews }, t);
            if (!v.ok) return null;
            return { ...rec, score: v.score, tier: v.tier, bayes: v.bayes, flags: v.flags, storable: ["placeId", "lat", "lng"] };
        }).filter(Boolean);
    }

    /** @param {string} cat @param {number} lat @param {number} lng @param {number} r */
    async function fromOsm(cat, lat, lng, r) {
        const j = await osm.json(overpassUrl, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", "user-agent": "MapUnite/1.0 (master poi)" }, body: `data=${encodeURIComponent(osmQuery(cat, lat, lng, r))}` }, { timeoutMs: 16000 });
        const t = now();
        return (Array.isArray(j && j.elements) ? j.elements : []).map((/** @type {any} */ el) => {
            const tg = el.tags || {};
            const plat = el.lat ?? (el.center && el.center.lat), plng = el.lon ?? (el.center && el.center.lon);
            if (!isCoord(plat, plng) || !tg.name) return null;
            const phone = tg.phone || tg["contact:phone"] || tg["contact:mobile"] || null;
            const rec = { cat, source: "osm", osmId: `${el.type[0]}${el.id}`, name: String(tg.name).slice(0, 80), lat: plat, lng: plng, phone: phone ? String(phone).split(";")[0].trim() : null, address: [tg["addr:street"], tg["addr:city"]].filter(Boolean).join(", "), rating: null, reviewsCount: 0, openNow: null, openingHours: tg.opening_hours || null, emergency: tg.emergency === "yes" };
            // the Overpass tags already guarantee the category: give vet() the matching type so its fit check passes
            const v = vet({ ...rec, types: cat === "mechanic" || cat === "service" ? ["motorcycle_repair"] : [] }, t);
            return v.ok ? { ...rec, score: v.score + (rec.emergency ? 0.05 : 0), tier: v.tier, bayes: null, flags: v.flags, storable: true } : null;
        }).filter(Boolean);
    }

    /** Google first; OSM fills gaps and lends phone numbers; same place twice → one. @param {any[]} gl @param {any[]} ol */
    function merge(gl, ol) {
        const out = [...gl];
        for (const op of ol) {
            const twin = out.find((x) => x.source === "google" && haversine(x.lat, x.lng, op.lat, op.lng) < 80 && sameName(x.name, op.name));
            if (twin) { if (!twin.phone && op.phone) { twin.phone = op.phone; twin.phoneSource = "osm"; } twin.osmId = op.osmId; continue; }
            out.push(op);
        }
        return out.sort((a, b) => b.score - a.score);
    }

    /** @param {any} body @returns {Promise<{ status: number, json: any }>} */
    async function handle(body) {
        const lat = Number(body && body.lat), lng = Number(body && body.lng);
        if (!isCoord(lat, lng)) return { status: 400, json: { ok: false, reason: "bad-position" } };
        const r = Math.round(Math.max(300, Math.min(3000, Number(body.radiusM) || 1600)));
        const cats = (Array.isArray(body.categories) ? body.categories : CATEGORIES).filter((/** @type {string} */ c) => CATEGORIES.includes(c)).slice(0, CATEGORIES.length);
        if (!cats.length) return { status: 400, json: { ok: false, reason: "bad-categories" } };
        // tile-snapped key: phones ask for tile centres, so a convoy shares one answer
        const tile = `${lat.toFixed(3)},${lng.toFixed(3)},${r}`;
        const perCat = await Promise.all(cats.map(async (/** @type {string} */ cat) => {
            const [gr, orr] = await Promise.allSettled([
                googleKey ? gCache.wrap(`g:${cat}:${tile}`, () => fromGoogle(cat, lat, lng, r)) : Promise.resolve([]),
                oCache.wrap(`o:${cat}:${tile}`, () => fromOsm(cat, lat, lng, r))
            ]);
            return { cat, google: gr.status === "fulfilled" ? gr.value : null, osm: orr.status === "fulfilled" ? orr.value : null };
        }));
        if (perCat.every((x) => x.google === null && x.osm === null)) return { status: 502, json: { ok: false, reason: "upstream-unreachable" } };
        const places = perCat.flatMap((x) => merge(x.google || [], x.osm || []).slice(0, 12));
        return { status: 200, json: { ok: true, tile: { lat, lng, radiusM: r }, places, sources: { google: Boolean(googleKey) && perCat.some((x) => x.google !== null), osm: perCat.some((x) => x.osm !== null) } } };
    }

    /** Nearest hospital / police for destination safety (OSM only: cheap, cacheable). @param {number} lat @param {number} lng */
    async function safetyAnchors(lat, lng) {
        const key = `anchor:${lat.toFixed(2)},${lng.toFixed(2)}`;
        return oCache.wrap(key, async () => {
            const q = `[out:json][timeout:15];(nwr(around:15000,${lat},${lng})[amenity=hospital];nwr(around:8000,${lat},${lng})[amenity=police];nwr(around:2000,${lat},${lng})[amenity~"^(restaurant|cafe|fuel|pharmacy|bank|atm)$"];);out tags center 300;`;
            const j = await osm.json(overpassUrl, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", "user-agent": "MapUnite/1.0 (master safety)" }, body: `data=${encodeURIComponent(q)}` }, { timeoutMs: 16000 });
            /** @type {any[]} */ const els = Array.isArray(j && j.elements) ? j.elements : [];
            const near = (/** @type {RegExp} */ re) => els.filter((e) => re.test((e.tags || {}).amenity || "")).map((e) => {
                const a = e.lat ?? (e.center && e.center.lat), b = e.lon ?? (e.center && e.center.lon);
                return isCoord(a, b) ? { name: (e.tags && e.tags.name) || "", lat: a, lng: b, distanceM: Math.round(haversine(lat, lng, a, b)) } : null;
            }).filter(Boolean).sort((x, y) => /** @type {any} */ (x).distanceM - /** @type {any} */ (y).distanceM);
            const services = near(/^(restaurant|cafe|fuel|pharmacy|bank|atm)$/).filter((x) => /** @type {any} */ (x).distanceM <= 2000).length;
            return { hospital: near(/^hospital$/)[0] || null, police: near(/^police$/)[0] || null, servicesWithin2km: services };
        });
    }

    return { handle, safetyAnchors, vet, configured: () => ({ google: Boolean(googleKey), osm: true }), stats: () => ({ google: g.state(), osm: osm.state(), gCache: gCache.stats(), oCache: oCache.stats() }) };
}

module.exports = { createPoi, vet, sameName, osmQuery, CATEGORIES, MIN_REVIEWS };
