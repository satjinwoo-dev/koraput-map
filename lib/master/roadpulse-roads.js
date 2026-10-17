// @ts-check
"use strict";
/* ============================================================================
   MapUnite RoadPulse — the road index: snap a hazard to its road (blueprint review point 4)
   ==============================================================================
   Hazards are merged by ROAD, not by a radius: two potholes 10 m apart on the same
   road are two hazards; ten GPS-scattered reports of one pothole are one; the other
   carriageway of a divided road is another road.

   Input: GeoJSON LineStrings of the pilot district's roads, cut from an OpenStreetMap
   extract (ODbL: "© OpenStreetMap contributors"), one feature per OSM way, with
   properties { osm_way_id, osm_version?, oneway?, highway?, name?, ref? }. None ship
   with the app; see data/roads/README.md for how to make one.

   snap(lat, lng, heading) → the best road within maxSnapM (25 m) whose direction fits
   the heading (±45°; a oneway road only along it), as
     { wayId, version, alongM (from the way's start), lateralM (signed, + = right of the
       way's direction), dir (+1 along the way, −1 against it, 0 heading unknown),
       carriageway: "divided" (oneway: a dual carriageway is two ways) | "undivided",
       snapLat, snapLng, distM, name, ref }
   The hazard's PHYSICAL point stays its identity; this is a cache, re-derivable after
   any OSM update (resnap): a hazard never disappears because a way id changed.

   Metre maths: local equirectangular metres around each segment (exact enough at
   a few hundred metres; never degrees compared with metres). On PostGIS the same
   is ST_DWithin on geography, or a UTM projection (EPSG:32644 / 32645 for Odisha).
   ============================================================================ */

const M_PER_DEG = 111320;
const CELL_DEG = 0.005;                    // ≈ 550 m grid for the segment index
const fin = (/** @type {any} */ v) => typeof v === "number" && Number.isFinite(v);
const headingDiff = (/** @type {number} */ a, /** @type {number} */ b) => { const d = Math.abs(((a - b) % 360 + 360) % 360); return d > 180 ? 360 - d : d; };

/**
 * @param {{ features?: any[] } | any[]} geojson a FeatureCollection (or its features)
 * @param {{ maxSnapM?: number, headingTolDeg?: number, version?: string }} [o]
 */
function createRoadIndex(geojson, o = {}) {
    const maxSnapM = o.maxSnapM ?? 25, tol = o.headingTolDeg ?? 45;
    const feats = Array.isArray(geojson) ? geojson : (geojson && Array.isArray(geojson.features) ? geojson.features : []);
    /** @type {Map<string, { id: string, version: string|null, oneway: boolean, name: string|null, ref: string|null, pts: number[][], cum: number[] }>} */
    const ways = new Map();
    /** @type {Map<string, { way: string, i: number }[]>} */ const grid = new Map();
    let skipped = 0;
    for (const f of feats) {
        const g = f && f.geometry, p = (f && f.properties) || {};
        const lines = g && g.type === "LineString" ? [g.coordinates] : g && g.type === "MultiLineString" ? g.coordinates : null;
        const id = p.osm_way_id !== undefined ? String(p.osm_way_id) : null;
        if (!lines || !id) { skipped++; continue; }
        lines.forEach((/** @type {any[]} */ line, /** @type {number} */ k) => {
            const pts = (line || []).filter((c) => Array.isArray(c) && fin(c[0]) && fin(c[1])).map((c) => [c[1], c[0]]);   // [lat, lng]
            if (pts.length < 2) { skipped++; return; }
            const wid = lines.length > 1 ? `${id}#${k}` : id;
            const ow = String(p.oneway || "").toLowerCase();
            if (ow === "-1") pts.reverse();                                     // store every oneway in its direction of travel
            const cum = [0];
            for (let i = 1; i < pts.length; i++) cum.push(cum[i - 1] + metres(pts[i - 1], pts[i]));
            ways.set(wid, { id: wid, version: p.osm_version !== undefined ? String(p.osm_version) : null, oneway: ow === "yes" || ow === "true" || ow === "1" || ow === "-1", name: p.name || null, ref: p.ref || null, pts, cum });
            for (let i = 1; i < pts.length; i++) {
                // every grid cell the segment's bounding box touches
                const [a, b] = [pts[i - 1], pts[i]];
                for (let y = Math.floor(Math.min(a[0], b[0]) / CELL_DEG); y <= Math.floor(Math.max(a[0], b[0]) / CELL_DEG); y++)
                    for (let x = Math.floor(Math.min(a[1], b[1]) / CELL_DEG); x <= Math.floor(Math.max(a[1], b[1]) / CELL_DEG); x++) {
                        const key = `${y}:${x}`;
                        (grid.get(key) || grid.set(key, []).get(key)).push({ way: wid, i });
                    }
            }
        });
    }

    /**
     * @param {number} lat @param {number} lng @param {number|null} [heading]
     * @returns {null | { wayId: string, version: string|null, alongM: number, lateralM: number, dir: number, carriageway: "divided"|"undivided", snapLat: number, snapLng: number, distM: number, name: string|null, ref: string|null, wayBearing: number }}
     */
    function snap(lat, lng, heading = null) {
        /** @type {any} */ let best = null;
        const seen = new Set();
        const cy = Math.floor(lat / CELL_DEG), cx = Math.floor(lng / CELL_DEG);
        for (let y = cy - 1; y <= cy + 1; y++) for (let x = cx - 1; x <= cx + 1; x++) {
            for (const s of grid.get(`${y}:${x}`) || []) {
                const key = `${s.way}|${s.i}`;
                if (seen.has(key)) continue;
                seen.add(key);
                const w = /** @type {any} */ (ways.get(s.way));
                const a = w.pts[s.i - 1], b = w.pts[s.i];
                const kx = M_PER_DEG * Math.cos(lat * Math.PI / 180);
                const bx = (b[1] - a[1]) * kx, by = (b[0] - a[0]) * M_PER_DEG, px = (lng - a[1]) * kx, py = (lat - a[0]) * M_PER_DEG;
                const len2 = bx * bx + by * by;
                if (len2 === 0) continue;
                const u = Math.max(0, Math.min(1, (px * bx + py * by) / len2));
                const dx = px - u * bx, dy = py - u * by, d = Math.hypot(dx, dy);
                if (d > maxSnapM) continue;
                const bearing = (Math.atan2(bx, by) * 180 / Math.PI + 360) % 360;
                let dir = 0;
                if (fin(heading)) {
                    const along = headingDiff(/** @type {number} */ (heading), bearing), against = headingDiff(/** @type {number} */ (heading), (bearing + 180) % 360);
                    if (along <= tol) dir = 1;
                    else if (!w.oneway && against <= tol) dir = -1;
                    else continue;                                             // the wrong direction for this road
                }
                // a small preference for the road the heading fits best, then the nearest
                const score = d + (fin(heading) ? headingDiff(/** @type {number} */ (heading), dir >= 0 ? bearing : (bearing + 180) % 360) * 0.05 : 0);
                if (best && best.score <= score) continue;
                const cross = bx * py - by * px;                               // > 0: left of the way's direction
                best = {
                    score, wayId: w.id, version: w.version, alongM: Math.round((w.cum[s.i - 1] + u * Math.sqrt(len2)) * 10) / 10,
                    lateralM: Math.round((cross > 0 ? -d : d) * 10) / 10, dir, carriageway: w.oneway ? "divided" : "undivided",
                    snapLat: a[0] + u * (b[0] - a[0]), snapLng: a[1] + u * (b[1] - a[1]), distM: Math.round(d * 10) / 10, name: w.name, ref: w.ref, wayBearing: Math.round(bearing)
                };
            }
        }
        if (!best) return null;
        const { score, ...out } = best;
        return out;
    }

    return { snap, size: () => ways.size, skipped: () => skipped, version: o.version || null, has: (/** @type {string} */ id) => ways.has(id) };
}

/** metres between [lat, lng] points @param {number[]} a @param {number[]} b */
function metres(a, b) {
    const n = (b[0] - a[0]) * M_PER_DEG, e = (b[1] - a[1]) * M_PER_DEG * Math.cos(a[0] * Math.PI / 180);
    return Math.hypot(n, e);
}

/**
 * Is a report the same hazard as h, by road? Both must be snapped. Same way, same direction of travel (unless the
 * hazard is marked both ways), along-road distance within the combined GPS tolerance, and a close lateral offset.
 * Two well-placed reports clearly apart along the road are two hazards even within 15 m.
 * @param {{ road: any, sigmaM: number|null, reports?: number }} h hazard: its road ref, marker sigma, report count
 * @param {{ road: any, sigmaM: number|null }} r report
 * @returns {{ same: boolean, alongM: number, tolM: number, why: string }}
 */
function sameByRoad(h, r) {
    const a = h.road, b = r.road;
    if (!a || !b) return { same: false, alongM: Infinity, tolM: 0, why: "not snapped" };
    if (a.wayId !== b.wayId) return { same: false, alongM: Infinity, tolM: 0, why: "another road" };
    const sh = fin(h.sigmaM) ? /** @type {number} */ (h.sigmaM) : 8, sr = fin(r.sigmaM) ? /** @type {number} */ (r.sigmaM) : 8;
    const sc = Math.sqrt(sh * sh + sr * sr);
    const tolM = Math.min(25, Math.max(6, 2 * sc));
    const along = Math.abs(a.alongM - b.alongM);
    if (a.dir && b.dir && a.dir !== b.dir && !/** @type {any} */ (h).bothWays) return { same: false, alongM: along, tolM, why: "other direction" };
    if (along > tolM) return { same: false, alongM: along, tolM, why: "too far along the road" };
    if (Math.abs(a.lateralM - b.lateralM) > Math.max(5, 1.5 * sc)) return { same: false, alongM: along, tolM, why: "across the road" };
    // two close potholes: a well-located hazard and a sharp report clearly apart along the road
    if ((h.reports || 0) >= 3 && sh <= 3 && sr <= 4 && along > 3 * sc) return { same: false, alongM: along, tolM, why: "a separate nearby hazard" };
    return { same: true, alongM: along, tolM, why: "same road, direction and spot" };
}

/**
 * 1-D clusters of reports along one road: where a hazard's reports form two groups with a gap wider than 3σ, and each
 * group has 2+ different riders, they are two hazards. Returns the split point, or null.
 * @param {{ alongM: number, sigmaM: number|null, contributor: string }[]} reps
 */
function splitPoint(reps) {
    const xs = reps.filter((r) => fin(r.alongM)).sort((a, b) => a.alongM - b.alongM);
    if (xs.length < 4) return null;
    const sig = [...xs.map((r) => (fin(r.sigmaM) ? /** @type {number} */ (r.sigmaM) : 8))].sort((a, b) => a - b)[Math.floor(xs.length / 2)];
    let best = null;
    for (let i = 1; i < xs.length; i++) {
        const gap = xs[i].alongM - xs[i - 1].alongM;
        if (gap <= 3 * sig || (best && best.gap >= gap)) continue;
        const left = new Set(xs.slice(0, i).map((r) => r.contributor)), right = new Set(xs.slice(i).map((r) => r.contributor));
        if (left.size >= 2 && right.size >= 2) best = { gap, at: (xs[i].alongM + xs[i - 1].alongM) / 2 };
    }
    return best ? best.at : null;
}

/**
 * The roads of a folder of GeoJSON files (default data/roads). Missing folder: null (no road index: hazards merge by
 * distance and direction, as before).
 * @param {string} dir
 */
function loadRoadDir(dir) {
    const fs = require("fs"), path = require("path");
    let files = [];
    try { files = fs.readdirSync(dir).filter((f) => /\.geojson$|\.json$/i.test(f)); } catch (e) { return null; }
    const feats = [];
    for (const f of files) {
        try { const j = JSON.parse(fs.readFileSync(path.join(dir, f), "utf8")); feats.push(...(Array.isArray(j.features) ? j.features : [])); } catch (e) { /* a bad file is skipped */ }
    }
    if (!feats.length) return null;
    return createRoadIndex(feats, { version: files.sort().join(",") });
}

module.exports = { createRoadIndex, sameByRoad, splitPoint, loadRoadDir, metres };
