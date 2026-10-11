// @ts-check
"use strict";
/* ============================================================================
   MapUnite Master AI (server) — road topology along the corridor (OpenStreetMap)
   ==============================================================================
   POST /api/master/road  { line: [[lat, lng], …] }   (≤ 40 points, ≤ 6 km)
     → { ok, features: [{ type, lat, lng, sAlongM, offM, name, tags }] }

   One Overpass query per corridor (cached 24 h at ~110 m resolution, shared by
   everyone on that road) for what matters on a two-wheeler:

     bridge          highway ways tagged bridge=* (not "no")
     tunnel          highway ways tagged tunnel=* (not "no")
     bad-surface     smoothness bad … impassable, or an unpaved surface
     breaker         traffic_calming=bump/hump/table/rumble_strip …  (India: speed breakers)
     level-crossing  railway=level_crossing
     hazard          OSM hazard=* (dangerous_junction, curves, landslide, animal_crossing, …)
     pass            mountain_pass=yes
     steep           highway ways with an incline=* tag of 8 % or more

   Ghats (hairpins, long grades) are NOT asked from OSM: the phone computes
   them from the route geometry and the elevation model it already has
   (agents/terrain-agent.js), which also works offline.

   Only elements within 35 m of the line are kept. A bridge or tunnel must also
   RUN ALONG the line for ≥ 20 m: a flyover or a railway bridge crossing above
   the road touches it at one point only and is dropped.
   ============================================================================ */

const { createCache } = require("./cache");
const { createUpstream } = require("./upstream");
const { cleanLine, lineKey, distanceToLine, haversine } = require("./geo");

const SMOOTH_BAD = /^(bad|very_bad|horrible|very_horrible|impassable)$/;
const SURFACE_BAD = /^(unpaved|gravel|dirt|ground|mud|sand|earth|compacted|fine_gravel|rock|pebblestone)$/;
const CALMING = /^(bump|hump|table|cushion|rumble_strip|dip|double_dip|yes)$/;

/** @param {Array<[number, number]>} line */
function query(line) {
    const L = line.map(([a, b]) => `${a},${b}`).join(",");
    return `[out:json][timeout:20];(
way(around:30,${L})[highway][bridge][bridge!=no];
way(around:30,${L})[highway][tunnel][tunnel!=no];
way(around:20,${L})[highway][smoothness~"^(bad|very_bad|horrible|very_horrible|impassable)$"];
way(around:20,${L})[highway~"^(primary|secondary|tertiary|trunk|unclassified|residential)$"][surface~"^(unpaved|gravel|dirt|ground|mud|sand|earth)$"];
node(around:25,${L})[traffic_calming];
node(around:25,${L})[railway=level_crossing];
node(around:40,${L})[hazard];
way(around:40,${L})[hazard];
node(around:80,${L})[mountain_pass=yes];
way(around:20,${L})[highway][incline];
);out tags geom qt;`;
}

/** incline tag → grade (fraction) or null: "10%", "-8%", "up", "down", "5°". @param {string} v */
function inclineOf(v) {
    const m = /^(-?\d+(?:\.\d+)?)\s*(%|°)?$/.exec(String(v || "").trim());
    if (!m) return null;
    const n = Number(m[1]);
    return m[2] === "°" ? Math.tan((n * Math.PI) / 180) : n / 100;
}

/**
 * Overpass elements → features near the line, de-duplicated and ordered along it.
 * @param {any} json @param {Array<[number, number]>} line
 */
function toFeatures(json, line) {
    const els = Array.isArray(json && json.elements) ? json.elements : [];
    /** @type {any[]} */ const out = [];
    for (const el of els) {
        const tags = el.tags || {};
        /** @type {string|null} */ let type = null;
        if (el.type === "node") {
            if (tags.railway === "level_crossing") type = "level-crossing";
            else if (tags.traffic_calming && CALMING.test(tags.traffic_calming)) type = "breaker";
            else if (tags.mountain_pass === "yes") type = "pass";
            else if (tags.hazard) type = "hazard";
        } else if (el.type === "way") {
            if (tags.bridge && tags.bridge !== "no") type = "bridge";
            else if (tags.tunnel && tags.tunnel !== "no") type = "tunnel";
            else if (tags.hazard) type = "hazard";
            else if ((tags.smoothness && SMOOTH_BAD.test(tags.smoothness)) || (tags.surface && SURFACE_BAD.test(tags.surface))) type = "bad-surface";
            else if (tags.incline) { const g = inclineOf(tags.incline); if (g !== null && Math.abs(g) >= 0.08) type = "steep"; }
        }
        if (!type) continue;
        // the element's closest point to the line (nodes: itself; ways: the nearest vertex)
        const pts = el.type === "node" ? [[el.lat, el.lon]] : Array.isArray(el.geometry) ? el.geometry.map((/** @type {any} */ g) => [g.lat, g.lon]) : [];
        let best = { d: Infinity, s: 0 }, at = /** @type {number[]|null} */ (null), first = Infinity, last = -Infinity;
        for (const p of pts) {
            if (!Number.isFinite(p[0]) || !Number.isFinite(p[1])) continue;
            const r = distanceToLine(p[0], p[1], line);
            if (r.d < best.d) { best = r; at = p; }
            if (r.d < 35) { first = Math.min(first, r.s); last = Math.max(last, r.s); }
        }
        if (!at || best.d > 35) continue;
        const lengthM = el.type === "way" && Number.isFinite(first) ? Math.round(last - first) : 0;
        if ((type === "bridge" || type === "tunnel") && lengthM < 20) continue;   // crosses the road, isn't on it
        out.push({
            type, lat: at[0], lng: at[1],
            sAlongM: Math.round(Number.isFinite(first) ? first : best.s), offM: Math.round(best.d), lengthM,
            name: typeof tags.name === "string" ? tags.name.slice(0, 80) : "",
            tags: pick(tags, ["hazard", "traffic_calming", "smoothness", "surface", "incline", "bridge", "tunnel", "railway", "crossing:barrier", "maxspeed"]),
            id: `${el.type[0]}${el.id}`
        });
    }
    out.sort((a, b) => a.sAlongM - b.sAlongM);
    // the same breaker or crossing mapped twice within 15 m: keep one
    return out.filter((f, i) => !out.slice(0, i).some((g) => g.type === f.type && haversine(g.lat, g.lng, f.lat, f.lng) < 15));
}

/** @param {Record<string, any>} o @param {string[]} keys */
function pick(o, keys) { /** @type {Record<string, string>} */ const r = {}; for (const k of keys) if (typeof o[k] === "string") r[k] = o[k].slice(0, 40); return r; }

/**
 * @param {{ overpassUrl?: string, fetchImpl?: typeof fetch, now?: () => number, userAgent?: string }} [o]
 */
function createRoad(o = {}) {
    const url = o.overpassUrl || "https://overpass-api.de/api/interpreter";
    const now = o.now || (() => Date.now());
    const up = createUpstream({ name: "overpass-road", fetchImpl: o.fetchImpl, now, failuresToOpen: 3 });
    /** @type {ReturnType<typeof createCache<any>>} */ const cache = createCache({ max: 3000, ttlMs: 86400000, staleMs: 7 * 86400000, now });

    /** @param {Array<[number, number]>} line */
    function features(line) {
        return cache.wrap(`road:${lineKey(line)}`, async () => {
            const json = await up.json(url, {
                method: "POST",
                headers: { "content-type": "application/x-www-form-urlencoded", "user-agent": o.userAgent || "MapUnite/1.0 (master road radar)" },
                body: `data=${encodeURIComponent(query(line))}`
            }, { timeoutMs: 22000, retries: 1 });
            return toFeatures(json, line);
        });
    }

    /** @param {any} body @returns {Promise<{ status: number, json: any }>} */
    async function handle(body) {
        const line = cleanLine(body && body.line, { max: 40, maxSpanM: 6000 });
        if (!line || line.length < 2) return { status: 400, json: { ok: false, reason: "bad-line" } };
        return { status: 200, json: { ok: true, source: "osm", features: await features(line) } };
    }

    return { handle, features, stats: () => ({ cache: cache.stats(), upstream: up.state() }) };
}

module.exports = { createRoad, toFeatures, query, inclineOf };
