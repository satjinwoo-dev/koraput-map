// @ts-check
"use strict";
/* ============================================================================
   MapUnite Ride Plan (server) — everything about a route, before the ride
   ==============================================================================
   POST /api/master/ride-plan
     { routes: [{ id, line: [[lat, lng], …], distanceM, durationS }] (1–3),
       departAt: ms, focus?: id, tzOffsetMin?: number (India: 330) }
     → { ok, routes: [Report], fastestId, bestId, best: { why: [...] }, picks, sources, generatedAt }

   One report per route, every figure from a named source, and nothing paid;
   where there's no data the report says so instead of guessing:
     weather      MET Norway's forecast (metno.js: fetched by OUR server, never
                  by the phone; free, commercial use allowed, with attribution)
                  for the RIDE DAY, at about the time the rider reaches each
                  point (every ~30 km). It reaches about 9 days ahead; further
                  out the report says when to check again. More than 3 days
                  ahead it's marked less certain. Hazards use the same
                  thresholds as the live corridor weather (weather.js classify()).
     places       OpenStreetMap (one Overpass query along the whole route):
                  hospitals (4 km either side), fuel, mechanics and tyre
                  shops, hotels, dhabas, tea stalls and restaurants (1.5 km),
                  police (3 km), toilets (1 km). Counts, km marks, and the
                  longest stretch WITHOUT fuel / a hospital / a mechanic.
     known        hospitals from a government directory imported on this
     hospitals    server (hospitals.js): shown apart, as KNOWN locations that
                  may be out of date, never as verified.
     picks        for the focus route: a rest stop about every 2 h of riding,
                  breakfast / lunch / dinner where the ride crosses meal time,
                  hospitals and mechanics every ~60 km, hotels at the
                  destination (and at ~7 h on a long ride). Ranked by MapUnite
                  riders' own ratings (place-ratings.js: only from riders who
                  said they stopped there, shown from 3 ratings), else nearest
                  first. No paid reviews.
     road         OpenStreetMap along the line: speed breakers, level
                  crossings, mapped hazards, and how many km are unpaved or
                  tagged bad. OSM is incomplete in places: "none mapped" is
                  not "none there".
     terrain      the self-hosted 30 m model (Copernicus GLO-30), where its
                  corridors cover the route: climb, descent, steepest 200 m.
     accidents    the OFFICIAL blackspot lists loaded on this server
                  (blackspots.js), and nothing else: no list loaded → "no
                  official accident data loaded for this road".
   FASTEST is the router's shortest time. BEST weighs measured things only
   (time, weather warnings, blackspots, unpaved km, level crossings, breakers,
   fuel and hospital gaps, climb) and lists exactly what made the difference.
   Pure and tested: simplify(), cumulative(), pointAt(), gaps(), restStops(),
   mealStops(), categorize(), overlapM(), climb(), scoreRoutes().
   ============================================================================ */

const { createCache } = require("./cache");
const { createUpstream } = require("./upstream");
const { isCoord, haversine, distanceToLine, lineKey } = require("./geo");

const H = 3600 * 1000, DAY = 24 * H;
const LIMITS = Object.freeze({
    maxRoutes: 3, maxPoints: 4000, maxLengthM: 1500000,
    poiLinePts: 200, featureLinePts: 1500,
    buffers: { hospital: 4000, fuel: 1500, mechanic: 1500, hotel: 1500, food: 1500, police: 3000, toilets: 1000 },
    weatherEveryM: 30000, weatherMax: 14, forecastDays: 9, certainDays: 3,
    restEveryS: 2 * 3600, pickEveryM: 60000, maxPicksPoints: 5
});
const MEALS = Object.freeze([
    { meal: "breakfast", from: 7.5, to: 9.5 }, { meal: "lunch", from: 12.5, to: 14.5 }, { meal: "dinner", from: 19.5, to: 21.5 }
]);

// ------------------------------------------------------------------ pure geometry
/** Metres along each vertex of a line. @param {Array<[number, number]>} line */
function cumulative(line) {
    const c = [0];
    for (let i = 1; i < line.length; i++) c.push(c[i - 1] + haversine(line[i - 1][0], line[i - 1][1], line[i][0], line[i][1]));
    return c;
}
/** The point s metres along a line. @param {Array<[number, number]>} line @param {number[]} cum @param {number} s @returns {[number, number]} */
function pointAt(line, cum, s) {
    if (s <= 0) return line[0];
    const last = line.length - 1;
    if (s >= cum[last]) return line[last];
    let lo = 0, hi = last;
    while (hi - lo > 1) { const m = (lo + hi) >> 1; if (cum[m] <= s) lo = m; else hi = m; }
    const t = (s - cum[lo]) / Math.max(1e-9, cum[hi] - cum[lo]);
    return [line[lo][0] + (line[hi][0] - line[lo][0]) * t, line[lo][1] + (line[hi][1] - line[lo][1]) * t];
}
/** Perpendicular distance (m) from p to segment a–b, locally flat. */
function segDist(p, a, b) {
    const kx = Math.cos(p[0] * Math.PI / 180) * 111320, ky = 110540;
    const ax = (a[1] - p[1]) * kx, ay = (a[0] - p[0]) * ky, bx = (b[1] - p[1]) * kx, by = (b[0] - p[0]) * ky;
    const dx = bx - ax, dy = by - ay, L2 = dx * dx + dy * dy;
    const t = L2 > 0 ? Math.max(0, Math.min(1, -(ax * dx + ay * dy) / L2)) : 0;
    return Math.hypot(ax + t * dx, ay + t * dy);
}
/** Douglas–Peucker with a tolerance in metres (iterative). Pure. @param {Array<[number, number]>} line @param {number} tolM */
function simplify(line, tolM) {
    if (line.length < 3) return line.slice();
    const keep = new Uint8Array(line.length); keep[0] = 1; keep[line.length - 1] = 1;
    const stack = [[0, line.length - 1]];
    while (stack.length) {
        const [i, j] = /** @type {number[]} */ (stack.pop());
        let best = -1, bd = 0;
        for (let k = i + 1; k < j; k++) { const d = segDist(line[k], line[i], line[j]); if (d > bd) { bd = d; best = k; } }
        if (best >= 0 && bd > tolM) { keep[best] = 1; stack.push([i, best], [best, j]); }
    }
    return line.filter((_p, i) => keep[i]);
}
/** Simplify until at most maxPts remain; returns the line and the tolerance used. @param {Array<[number, number]>} line @param {number} maxPts @param {number} [tol0] */
function simplifyTo(line, maxPts, tol0 = 10) {
    let tol = tol0, out = simplify(line, tol);
    while (out.length > maxPts) { tol *= 1.6; out = simplify(line, tol); }
    return { line: out, tolM: tol };
}

/**
 * The longest stretch without a place: positions (m along the route) of the places of one kind, from the start to
 * the end. Pure. @param {number[]} sList @param {number} total @returns {{ maxM: number, fromM: number, toM: number }}
 */
function gaps(sList, total) {
    const s = [0, ...sList.filter((x) => x >= 0 && x <= total).sort((a, b) => a - b), total];
    let best = { maxM: 0, fromM: 0, toM: 0 };
    for (let i = 1; i < s.length; i++) if (s[i] - s[i - 1] > best.maxM) best = { maxM: s[i] - s[i - 1], fromM: s[i - 1], toM: s[i] };
    return best;
}

/**
 * Rest stops: about every 2 h of riding (a common guide for riders and drivers against fatigue), placed by the
 * route's own average pace, none in the last 30 minutes. Pure.
 * @param {number} distanceM @param {number} durationS @param {number} departAt
 * @returns {Array<{ sM: number, at: number, afterS: number }>}
 */
function restStops(distanceM, durationS, departAt) {
    const out = [];
    if (!(durationS > 0) || !(distanceM > 0)) return out;
    for (let t = LIMITS.restEveryS; t < durationS - 1800; t += LIMITS.restEveryS) out.push({ sM: Math.round(distanceM * t / durationS), at: departAt + t * 1000, afterS: t });
    return out;
}

/**
 * Meal stops: where the ride is when a meal window starts (or, leaving inside a window, 30 min after setting off),
 * in the rider's local time. Pure.
 * @param {number} distanceM @param {number} durationS @param {number} departAt @param {number} tzOffsetMin
 * @returns {Array<{ meal: string, sM: number, at: number }>}
 */
function mealStops(distanceM, durationS, departAt, tzOffsetMin) {
    const out = [];
    if (!(durationS > 0)) return out;
    const end = departAt + durationS * 1000;
    const local0 = new Date(departAt + tzOffsetMin * 60000);
    const dayStart = Date.UTC(local0.getUTCFullYear(), local0.getUTCMonth(), local0.getUTCDate()) - tzOffsetMin * 60000;
    for (let d = 0; d < 3; d++) {
        for (const m of MEALS) {
            const from = dayStart + d * DAY + m.from * H, to = dayStart + d * DAY + m.to * H;
            if (to <= departAt || from >= end) continue;
            let at = Math.max(from, departAt + 30 * 60000);
            if (at >= Math.min(to, end - 20 * 60000)) continue;     // the meal window passes before a stop makes sense
            out.push({ meal: m.meal, sM: Math.round(distanceM * (at - departAt) / (durationS * 1000)), at });
        }
    }
    return out;
}

/** Which kind of place an OSM element is. Pure. @param {Record<string, string>} t @returns {{ cat: string, kind: string }|null} */
function categorize(t) {
    const name = String(t.name || "");
    if (t.amenity === "hospital" || (t.amenity === "clinic" && t.emergency === "yes")) return { cat: "hospital", kind: t.amenity };
    if (t.amenity === "fuel") return { cat: "fuel", kind: "fuel" };
    if (["motorcycle_repair", "motorcycle", "car_repair", "tyres"].includes(t.shop) || t.craft === "motorcycle_repair") return { cat: "mechanic", kind: t.shop === "tyres" ? "tyres" : "repair" };
    if (["hotel", "motel", "guest_house"].includes(t.tourism)) return { cat: "hotel", kind: t.tourism };
    if (["restaurant", "fast_food", "cafe"].includes(t.amenity)) {
        const kind = /dhaba/i.test(name) ? "dhaba" : /\b(chai|tea|chaha|cha)\b/i.test(name) || t.amenity === "cafe" ? "tea" : "restaurant";
        return { cat: "food", kind };
    }
    if (t.amenity === "police") return { cat: "police", kind: "police" };
    if (t.amenity === "toilets") return { cat: "toilets", kind: "toilets" };
    return null;
}

/** Metres of an OSM way that run along the route (consecutive nodes both within tolM of it). Pure. */
function overlapM(geom, routeLine, tolM) {
    let s = 0;
    for (let i = 1; i < geom.length; i++) {
        const a = geom[i - 1], b = geom[i];
        if (distanceToLine(a[0], a[1], routeLine).d <= tolM && distanceToLine(b[0], b[1], routeLine).d <= tolM) s += haversine(a[0], a[1], b[0], b[1]);
    }
    return s;
}

/**
 * Climb and descent from heights every `stepM` metres (a 3-point mean, then only changes of 3 m or more, so the
 * model's noise isn't counted as climbing), and the steepest 200 m. Pure. @param {Array<number|null>} h @param {number} stepM
 */
function climb(h, stepM) {
    const known = h.filter((x) => Number.isFinite(x)).length;
    if (!h.length || known / h.length < 0.5) return { available: false, coverage: h.length ? known / h.length : 0 };
    const v = h.map((x, i) => {
        const w = [h[i - 1], x, h[i + 1]].filter((y) => Number.isFinite(y));
        return w.length ? /** @type {number[]} */ (w).reduce((a, y) => a + y, 0) / w.length : null;
    });
    let up = 0, down = 0, maxGrade = 0, lo = Infinity, hi = -Infinity, ref = null;
    const n = Math.max(1, Math.round(200 / stepM));
    for (let i = 0; i < v.length; i++) {
        const b = v[i];
        if (b === null) continue;
        // counted only once the height has moved 3 m from the last counted point (the model's noise is ~1–2 m)
        if (ref === null) ref = b;
        else if (b - ref >= 3) { up += b - ref; ref = b; }
        else if (ref - b >= 3) { down += ref - b; ref = b; }
        lo = Math.min(lo, b); hi = Math.max(hi, b);
        const c = v[i - n];
        if (i >= n && c !== null && c !== undefined) maxGrade = Math.max(maxGrade, Math.abs(b - c) / (n * stepM) * 100);
    }
    return { available: true, coverage: known / h.length, climbM: Math.round(up), descentM: Math.round(down), maxGradePct: Math.round(maxGrade * 10) / 10, lowM: Math.round(lo), highM: Math.round(hi) };
}

/** What counts against a route, all measured. Exported for the tests and for tuning in one place. */
const WEIGHTS = Object.freeze({ perMinSlower: 0.5, weatherWarning: 15, blackspot: 6, unpavedKm: 4, levelCrossing: 2, breaker: 0.3, fuelGapKmOver60: 0.3, hospitalGapKmOver40: 0.3, climbPer100m: 1 });

/**
 * Fastest and best of the routes, with the reasons. Pure.
 * @param {Array<{ id: string, durationS: number, factors: { weatherWarnings: number, blackspots: number, unpavedKm: number, levelCrossings: number, breakers: number, fuelGapKm: number, hospitalGapKm: number, climbM: number } }>} rs
 */
function scoreRoutes(rs) {
    if (!rs.length) return { fastestId: null, bestId: null, penalties: {}, why: [] };
    const fastest = rs.reduce((a, b) => (b.durationS < a.durationS ? b : a));
    const W = WEIGHTS;
    /** @type {Record<string, number>} */ const pen = {};
    for (const r of rs) {
        const f = r.factors;
        pen[r.id] = Math.round((Math.max(0, r.durationS - fastest.durationS) / 60 * W.perMinSlower + f.weatherWarnings * W.weatherWarning + f.blackspots * W.blackspot
            + f.unpavedKm * W.unpavedKm + f.levelCrossings * W.levelCrossing + f.breakers * W.breaker
            + Math.max(0, f.fuelGapKm - 60) * W.fuelGapKmOver60 + Math.max(0, f.hospitalGapKm - 40) * W.hospitalGapKmOver40 + f.climbM / 100 * W.climbPer100m) * 10) / 10;
    }
    const best = rs.reduce((a, b) => (pen[b.id] < pen[a.id] ? b : a));
    const why = [];
    if (best.id !== fastest.id) {
        const a = best.factors, b = fastest.factors, d = (/** @type {number} */ x) => Math.round(x * 10) / 10;
        if (a.weatherWarnings < b.weatherWarnings) why.push(`${b.weatherWarnings - a.weatherWarnings} fewer weather warnings`);
        if (a.blackspots < b.blackspots) why.push(`${b.blackspots - a.blackspots} fewer official blackspots`);
        if (a.unpavedKm + 0.5 < b.unpavedKm) why.push(`${d(b.unpavedKm - a.unpavedKm)} km less unpaved or bad road`);
        if (a.levelCrossings < b.levelCrossings) why.push(`${b.levelCrossings - a.levelCrossings} fewer level crossings`);
        if (a.breakers + 5 <= b.breakers) why.push(`${b.breakers - a.breakers} fewer speed breakers mapped`);
        if (a.fuelGapKm + 10 < b.fuelGapKm && b.fuelGapKm > 60) why.push(`longest stretch without fuel ${Math.round(a.fuelGapKm)} km instead of ${Math.round(b.fuelGapKm)} km`);
        if (a.hospitalGapKm + 10 < b.hospitalGapKm && b.hospitalGapKm > 40) why.push(`longest stretch without a hospital ${Math.round(a.hospitalGapKm)} km instead of ${Math.round(b.hospitalGapKm)} km`);
        if (a.climbM + 200 < b.climbM) why.push(`${b.climbM - a.climbM} m less climbing`);
        why.push(`${Math.round((best.durationS - fastest.durationS) / 60)} min slower`);
    } else why.push("also the fastest");
    return { fastestId: fastest.id, bestId: best.id, penalties: pen, why };
}

// ------------------------------------------------------------------ the service
/**
 * @param {{ fetchImpl?: typeof fetch, now?: () => number, overpassUrl?: string,
 *   metno?: { forecastAt: (p: Array<{ lat: number, lng: number, at: number }>) => Promise<any[]> } | null,
 *   ratings?: { lookupIds: (ids: string[]) => Record<string, any> } | null,
 *   hospitals?: { nearLine: (line: any, m: number) => any[], info: () => { count: number, sources: any[] } } | null,
 *   blackspots?: { nearLine: (line: any, m: number) => any[], info: () => { count: number, sources?: any } },
 *   dem?: { heightAt: (lat: number, lng: number) => number|null } | null }} [o]
 */
function createRidePlan(o = {}) {
    const now = o.now || (() => Date.now());
    const overpassUrl = o.overpassUrl || "https://overpass-api.de/api/interpreter";
    const osm = createUpstream({ name: "overpass-rideplan", fetchImpl: o.fetchImpl, now, failuresToOpen: 3 });
    /** @type {ReturnType<typeof createCache<any>>} */ const cache = createCache({ max: 300, ttlMs: DAY, staleMs: 6 * DAY, now });

    const ovp = (/** @type {string} */ q, /** @type {number} */ timeoutMs) => osm.json(overpassUrl, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", "user-agent": "MapUnite/1.0 (ride plan)" }, body: `data=${encodeURIComponent(q)}` }, { timeoutMs, retries: 0 });
    const lineArg = (/** @type {Array<[number, number]>} */ l) => l.map(([a, b]) => `${a.toFixed(5)},${b.toFixed(5)}`).join(",");

    /** Places along the whole route, one Overpass query. */
    async function places(line, total) {
        const coarse = simplifyTo(line, LIMITS.poiLinePts, 50);
        const L = lineArg(coarse.line), B = LIMITS.buffers, pad = Math.round(coarse.tolM);
        const A = (/** @type {number} */ m) => `(around:${m + pad},${L})`;
        const q = `[out:json][timeout:90];(nwr${A(B.hospital)}[amenity=hospital];nwr${A(B.hospital)}[amenity=clinic][emergency=yes];`
            + `nwr${A(B.fuel)}[amenity=fuel];nwr${A(B.mechanic)}[shop~"^(motorcycle_repair|motorcycle|car_repair|tyres)$"];nwr${A(B.mechanic)}[craft=motorcycle_repair];`
            + `nwr${A(B.hotel)}[tourism~"^(hotel|motel|guest_house)$"];nwr${A(B.food)}[amenity~"^(restaurant|fast_food|cafe)$"];`
            + `nwr${A(B.police)}[amenity=police];nwr${A(B.toilets)}[amenity=toilets];);out tags center 5000;`;
        const j = await ovp(q, 95000);
        /** @type {Record<string, any[]>} */ const lists = { hospital: [], fuel: [], mechanic: [], hotel: [], food: [], police: [], toilets: [] };
        for (const el of Array.isArray(j && j.elements) ? j.elements : []) {
            const t = el.tags || {}, c = categorize(t);
            const lat = el.lat ?? (el.center && el.center.lat), lng = el.lon ?? (el.center && el.center.lon);
            if (!c || !isCoord(lat, lng)) continue;
            const at = distanceToLine(lat, lng, line);
            if (at.d > /** @type {any} */ (B)[c.cat] || at.s < 0 || at.s > total) continue;
            const phone = t.phone || t["contact:phone"] || t["contact:mobile"] || null;
            lists[c.cat].push({ cat: c.cat, kind: c.kind, name: t.name ? String(t.name).slice(0, 80) : null, brand: t.brand || t.operator || null, lat, lng, sM: Math.round(at.s), offM: Math.round(at.d), phone: phone ? String(phone).split(";")[0].trim() : null, openingHours: t.opening_hours || null, emergency: t.emergency === "yes", osmId: `${el.type[0]}${el.id}` });
        }
        for (const k of Object.keys(lists)) lists[k].sort((a, b) => a.sM - b.sM);
        const count = (/** @type {string} */ k, /** @type {(p: any) => boolean} */ f = () => true) => lists[k].filter(f).length;
        return {
            counts: { hospital: count("hospital"), fuel: count("fuel"), mechanic: count("mechanic"), tyres: count("mechanic", (p) => p.kind === "tyres"), hotel: count("hotel"), food: count("food"), dhaba: count("food", (p) => p.kind === "dhaba"), tea: count("food", (p) => p.kind === "tea"), police: count("police"), toilets: count("toilets") },
            gaps: { fuel: gaps(lists.fuel.map((p) => p.sM), total), hospital: gaps(lists.hospital.map((p) => p.sM), total), mechanic: gaps(lists.mechanic.map((p) => p.sM), total) },
            lists
        };
    }

    /** Breakers, crossings, hazards and unpaved / bad km along the line. */
    async function road(line) {
        const fine = simplifyTo(line, LIMITS.featureLinePts, 8);
        const L = lineArg(fine.line), r = Math.round(15 + fine.tolM);
        const q = `[out:json][timeout:90];(node(around:${r + 10},${L})[traffic_calming];node(around:${r + 10},${L})[railway=level_crossing];node(around:${r + 15},${L})[hazard];`
            + `way(around:${r},${L})[highway][surface~"^(unpaved|dirt|gravel|ground|sand|mud|earth|compacted|fine_gravel)$"];`
            + `way(around:${r},${L})[highway][smoothness~"^(bad|very_bad|horrible|very_horrible|impassable)$"];);out tags geom 4000;`;
        const j = await ovp(q, 95000);
        let breakers = 0, crossings = 0, unpavedM = 0;
        const hazards = [];
        for (const el of Array.isArray(j && j.elements) ? j.elements : []) {
            const t = el.tags || {};
            if (el.type === "node") {
                const at = distanceToLine(el.lat, el.lon, line);
                if (at.d > r + 15) continue;
                if (t.traffic_calming && t.traffic_calming !== "no") breakers++;
                else if (t.railway === "level_crossing") crossings++;
                else if (t.hazard) hazards.push({ type: String(t.hazard).slice(0, 40), sM: Math.round(at.s), lat: el.lat, lng: el.lon });
            } else if (el.type === "way" && Array.isArray(el.geometry)) {
                unpavedM += overlapM(el.geometry.map((/** @type {any} */ g) => [g.lat, g.lon]), fine.line, r + 5);
            }
        }
        return { available: true, breakers, levelCrossings: crossings, hazards: hazards.slice(0, 40), unpavedKm: Math.round(unpavedM / 100) / 10 };
    }

    /** Weather along the route at about the time the rider passes each point (MET Norway, through metno.js). */
    async function weatherFor(line, cum, total, departAt, durationS) {
        const t = now();
        if (!o.metno) return { available: false, reason: "weather-unavailable" };
        if (departAt > t + LIMITS.forecastDays * DAY) return { available: false, reason: "too-far-ahead", checkFrom: departAt - LIMITS.forecastDays * DAY };
        const n = Math.min(LIMITS.weatherMax, Math.max(2, Math.ceil(total / LIMITS.weatherEveryM) + 1));
        const pts = Array.from({ length: n }, (_v, i) => { const s = total * i / (n - 1); const p = pointAt(line, cum, s); return { sM: Math.round(s), lat: p[0], lng: p[1], at: departAt + durationS * 1000 * (s / total) }; });
        const got = await o.metno.forecastAt(pts);
        const samples = pts.map((p, i) => {
            const f = got[i];
            if (!f || !f.available) return { sM: p.sM, at: p.at, available: false, reason: f ? f.reason : "unavailable" };
            return { sM: p.sM, at: p.at, hourAt: f.at, hourly: f.hourly, available: true, tempC: f.tempC, rhPct: f.rhPct, windMs: f.windMs, gustMs: f.gustMs, precipMmH: f.precipMmH, rainProb1hPct: f.rainProbPct, symbol: f.symbol, code: f.code, hazards: f.hazards };
        });
        const daysAhead = (departAt - t) / DAY;
        return { available: samples.some((s) => s.available), certain: daysAhead <= LIMITS.certainDays, daysAhead: Math.max(0, Math.round(daysAhead * 10) / 10), samples, source: "MET Norway" };
    }

    /** Heights every 100 m (≤ 3000 samples) from the 30 m model. */
    function terrain(line, cum, total) {
        if (!o.dem || typeof o.dem.heightAt !== "function") return { available: false, reason: "no-terrain-model" };
        const step = Math.max(100, total / 3000);
        const h = [];
        for (let s = 0; s <= total; s += step) { const p = pointAt(line, cum, s); h.push(o.dem.heightAt(p[0], p[1])); }
        const c = climb(h, step);
        return c.available ? { ...c, source: "Copernicus GLO-30 (30 m)" } : { available: false, reason: "outside-terrain-corridors", coverage: c.coverage };
    }

    function accidents(line) {
        const info = o.blackspots ? o.blackspots.info() : { count: 0 };
        if (!o.blackspots || !info.count) return { loaded: false };
        const spots = o.blackspots.nearLine(line, 150);
        return { loaded: true, sources: info.sources || null, spots: spots.slice(0, 60), count: spots.length };
    }

    /** Riders' ratings for OSM places (place-ratings.js), shown only from MIN_RATINGS. @param {any[]} list */
    function rated(list) {
        const ids = list.map((p) => p.osmId).filter(Boolean);
        const R = o.ratings && ids.length ? o.ratings.lookupIds(ids) : {};
        return list.map((p) => ({ ...p, riders: R[p.osmId] && R[p.osmId].shown ? { up: R[p.osmId].up, down: R[p.osmId].down, tags: R[p.osmId].tags, score: R[p.osmId].score } : null }));
    }
    /** Places rated by riders first (best share of 👍, Wilson), then the nearest; never a guess. */
    const rank = (/** @type {any[]} */ list, /** @type {number} */ s) => list.sort((a, b) => {
        if (a.riders && b.riders) return b.riders.score - a.riders.score;
        if (a.riders || b.riders) return a.riders ? -1 : 1;
        return Math.abs(a.sM - s) + a.offM - (Math.abs(b.sM - s) + b.offM);
    });
    const brief = (/** @type {any} */ p) => ({ name: p.name, cat: p.cat, kind: p.kind || null, brand: p.brand || null, lat: p.lat, lng: p.lng, sM: p.sM, offM: p.offM, phone: p.phone || null, osmId: p.osmId || null, riders: p.riders || null, known: Boolean(p.known), source: p.known ? p.source : "osm" });

    async function picks(r, pl, departAt, tz) {
        const total = r.total;
        const near = (/** @type {string} */ cat, /** @type {number} */ s, /** @type {number} */ win, /** @type {(p: any) => boolean} */ f = () => true) => pl.lists[cat].filter((p) => Math.abs(p.sM - s) <= win && f(p));
        const stopAt = (/** @type {number} */ s, /** @type {string} */ cat, /** @type {number} */ win = 8000) => {
            const list = rank(rated(near(cat, s, win, (x) => Boolean(x.name))), s).slice(0, 4);
            return { ratings: list.some((x) => x.riders), options: list.map(brief) };
        };
        const meals = mealStops(total, r.durationS, departAt, tz);
        const rests = restStops(total, r.durationS, departAt).filter((x) => !meals.some((m) => Math.abs(m.sM - x.sM) < 15000));
        const out = { restStops: [], meals: [], hospitals: [], mechanics: [], hotels: [] };
        for (const m of meals.slice(0, 4)) out.meals.push({ ...m, ...stopAt(m.sM, "food") });
        for (const x of rests.slice(0, 6)) out.restStops.push({ ...x, ...stopAt(x.sM, "food"), fuelNearby: near("fuel", x.sM, 5000).slice(0, 2).map(brief), toiletsNearby: near("toilets", x.sM, 5000).length });
        const every = Math.max(LIMITS.pickEveryM, total / LIMITS.maxPicksPoints);
        for (let s = Math.min(total / 2, every / 2); s < total; s += every) {
            const hs = [...near("hospital", s, every / 2), ...(pl.known || []).filter((k) => Math.abs(k.sM - s) <= every / 2)];
            out.hospitals.push({ sM: Math.round(s), options: rank(rated(hs), s).slice(0, 3).map(brief) });
            const ms = stopAt(s, "mechanic", every / 2);
            out.mechanics.push({ sM: Math.round(s), ...ms });
        }
        const hotelPoints = [total, ...(r.durationS > 8 * 3600 ? [Math.round(total * 7 * 3600 / r.durationS)] : [])];
        for (const s of hotelPoints) out.hotels.push({ sM: Math.round(s), atEnd: s === total, ...stopAt(s, "hotel", 10000) });
        return out;
    }

    /** @param {any} body @returns {Promise<{ status: number, json: any }>} */
    async function handle(body) {
        const raw = Array.isArray(body && body.routes) ? body.routes.slice(0, LIMITS.maxRoutes) : [];
        const routes = [];
        for (const [i, r] of raw.entries()) {
            const pts = Array.isArray(r && r.line) ? r.line : [];
            if (pts.length < 2 || pts.length > LIMITS.maxPoints) return { status: 400, json: { ok: false, reason: "bad-line" } };
            /** @type {Array<[number, number]>} */ const line = [];
            for (const p of pts) { const a = Number(p && p[0]), b = Number(p && p[1]); if (!isCoord(a, b)) return { status: 400, json: { ok: false, reason: "bad-line" } }; line.push([a, b]); }
            const cum = cumulative(line), total = cum[cum.length - 1];
            if (total < 200 || total > LIMITS.maxLengthM) return { status: 400, json: { ok: false, reason: "bad-length" } };
            const durationS = Number(r.durationS) > 0 ? Number(r.durationS) : total / 13.9;
            routes.push({ id: String(r.id ?? i).slice(0, 20), line, cum, total, durationS, distanceM: Number(r.distanceM) > 0 ? Number(r.distanceM) : total });
        }
        if (!routes.length) return { status: 400, json: { ok: false, reason: "no-routes" } };
        const t = now();
        const departAt = Number.isFinite(Number(body.departAt)) && Number(body.departAt) > t - H ? Number(body.departAt) : t;
        const tz = Number.isFinite(Number(body.tzOffsetMin)) && Math.abs(Number(body.tzOffsetMin)) <= 840 ? Number(body.tzOffsetMin) : 330;

        const reports = await Promise.all(routes.map(async (r) => {
            const k = lineKey(simplifyTo(r.line, 300, 30).line);
            const [pl, rd, wx] = await Promise.allSettled([
                cache.wrap(`p:${k}`, () => places(r.line, r.total)),
                cache.wrap(`r:${k}`, () => road(r.line)),
                weatherFor(r.line, r.cum, r.total, departAt, r.durationS)
            ]);
            const P = pl.status === "fulfilled" ? pl.value : null;
            const R = rd.status === "fulfilled" ? rd.value : { available: false, reason: "osm-unavailable" };
            const Wx = wx.status === "fulfilled" ? wx.value : { available: false, reason: "weather-unavailable" };
            const T = terrain(r.line, r.cum, r.total), A = accidents(r.line);
            // government directory hospitals: KNOWN locations (may be out of date), kept apart from OSM's
            const known = o.hospitals && o.hospitals.info().count ? o.hospitals.nearLine(r.line, LIMITS.buffers.hospital).map((h) => ({ ...h, cat: "hospital", kind: "hospital", known: true })) : [];
            if (P) { P.known = known; P.gaps = { ...P.gaps }; P.gaps.hospital = gaps([...P.lists.hospital.map((p) => p.sM), ...known.map((k) => k.sM)], r.total); }
            const warnings = Wx.available ? Wx.samples.filter((s) => s.available && s.hazards.some((h) => h.level === "warning")).length : 0;
            const factors = {
                weatherWarnings: warnings, blackspots: A.loaded ? A.count : 0, unpavedKm: R.available ? R.unpavedKm : 0,
                levelCrossings: R.available ? R.levelCrossings : 0, breakers: R.available ? R.breakers : 0,
                fuelGapKm: P ? Math.round(P.gaps.fuel.maxM / 1000) : 0, hospitalGapKm: P ? Math.round(P.gaps.hospital.maxM / 1000) : 0, climbM: T.available ? Number(/** @type {any} */ (T).climbM) || 0 : 0
            };
            const placesOut = P ? { available: true, counts: { ...P.counts, knownHospitals: known.length }, gaps: P.gaps, lists: Object.fromEntries(Object.entries(P.lists).map(([c, l]) => [c, rated(l.slice(0, c === "food" ? 120 : 60))])), knownHospitals: known.slice(0, 60) } : { available: false, reason: "osm-unavailable" };
            return { id: r.id, distanceM: Math.round(r.distanceM), durationS: Math.round(r.durationS), arriveAt: departAt + Math.round(r.durationS * 1000), weather: Wx, road: R, terrain: T, accidents: A, places: placesOut, factors, _P: P };
        }));
        const sc = scoreRoutes(reports.map((x) => ({ id: x.id, durationS: x.durationS, factors: x.factors })));
        const focusId = reports.some((x) => x.id === String(body.focus)) ? String(body.focus) : sc.bestId;
        const fr = reports.find((x) => x.id === focusId), fRoute = routes.find((x) => x.id === focusId);
        const pk = fr && fr._P && fRoute ? await picks(fRoute, fr._P, departAt, tz) : null;
        for (const x of reports) { /** @type {any} */ (x).penalty = sc.penalties[x.id]; delete /** @type {any} */ (x)._P; }
        return {
            status: 200, json: {
                ok: true, generatedAt: t, departAt, fastestId: sc.fastestId, bestId: sc.bestId, best: { why: sc.why }, routes: reports,
                picks: pk ? { routeId: focusId, ...pk } : null,
                sources: { places: "OpenStreetMap contributors (ODbL)", ratings: o.ratings ? "MapUnite riders who said they stopped there" : null, knownHospitals: o.hospitals && o.hospitals.info().count ? o.hospitals.info().sources.map((/** @type {any} */ s) => s.name).join(", ") : null, weather: o.metno ? "Weather forecast from MET Norway" : null, terrain: reports.some((x) => x.terrain.available) ? "Copernicus GLO-30" : null, accidents: o.blackspots && o.blackspots.info().count ? "official blackspot lists loaded on this server" : null }
            }
        };
    }

    return { handle, stats: () => ({ osm: osm.state(), cache: cache.stats() }) };
}

module.exports = { createRidePlan, simplify, simplifyTo, cumulative, pointAt, gaps, restStops, mealStops, categorize, overlapM, climb, scoreRoutes, WEIGHTS, LIMITS };
