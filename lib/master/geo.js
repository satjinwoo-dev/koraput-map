// @ts-check
"use strict";
/* ============================================================================
   MapUnite Master AI (server) — geometry helpers (SI: metres, radians inside)
   ==============================================================================
   Kept separate from the client's public/js/master/geo.js on purpose: the
   server must validate every coordinate a phone sends before it reaches an
   upstream query (an Overpass "around" with 5 000 points is a denial of
   service on someone else's server).
   ============================================================================ */

const R = 6371008.8;
const RAD = Math.PI / 180;

/** @param {any} lat @param {any} lng */
const isCoord = (lat, lng) => Number.isFinite(lat) && Number.isFinite(lng) && Math.abs(lat) <= 90 && Math.abs(lng) <= 180 && !(lat === 0 && lng === 0);

/** Great-circle distance in metres. @param {number} lat1 @param {number} lng1 @param {number} lat2 @param {number} lng2 */
function haversine(lat1, lng1, lat2, lng2) {
    const dLat = (lat2 - lat1) * RAD, dLng = (lng2 - lng1) * RAD;
    const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * RAD) * Math.cos(lat2 * RAD) * Math.sin(dLng / 2) ** 2;
    return 2 * R * Math.asin(Math.min(1, Math.sqrt(a)));
}

/**
 * Distance from a point to a polyline (metres) and the along-line position of
 * the closest point (metres from the first vertex). Local equirectangular
 * projection: exact enough below ~50 km, which is all a corridor ever is.
 * @param {number} lat @param {number} lng @param {Array<[number, number]>} line
 * @returns {{ d: number, s: number }}
 */
function distanceToLine(lat, lng, line) {
    if (!line.length) return { d: Infinity, s: 0 };
    const kx = Math.cos(lat * RAD) * R * RAD, ky = R * RAD;
    let best = Infinity, bestS = 0, s = 0;
    for (let i = 0; i < line.length; i++) {
        const [aLat, aLng] = line[i];
        if (i === line.length - 1) {
            const d = Math.hypot((lng - aLng) * kx, (lat - aLat) * ky);
            if (d < best) { best = d; bestS = s; }
            break;
        }
        const [bLat, bLng] = line[i + 1];
        const ax = (aLng - lng) * kx, ay = (aLat - lat) * ky, bx = (bLng - lng) * kx, by = (bLat - lat) * ky;
        const dx = bx - ax, dy = by - ay, len2 = dx * dx + dy * dy;
        const t = len2 > 0 ? Math.max(0, Math.min(1, -(ax * dx + ay * dy) / len2)) : 0;
        const d = Math.hypot(ax + t * dx, ay + t * dy);
        const segLen = Math.sqrt(len2);
        if (d < best) { best = d; bestS = s + t * segLen; }
        s += segLen;
    }
    return { d: best, s: bestS };
}

/**
 * Validate and clean a phone-sent polyline: [[lat, lng], …].
 * @param {any} points @param {{ max?: number, maxSpanM?: number }} [o]
 * @returns {Array<[number, number]>|null} null when unusable
 */
function cleanLine(points, o = {}) {
    const max = o.max ?? 40, maxSpanM = o.maxSpanM ?? 6000;
    if (!Array.isArray(points) || points.length < 1 || points.length > max) return null;
    /** @type {Array<[number, number]>} */ const out = [];
    for (const p of points) {
        if (!Array.isArray(p)) return null;
        const lat = Number(p[0]), lng = Number(p[1]);
        if (!isCoord(lat, lng)) return null;
        out.push([Math.round(lat * 1e5) / 1e5, Math.round(lng * 1e5) / 1e5]);
    }
    let span = 0;
    for (let i = 1; i < out.length; i++) span += haversine(out[i - 1][0], out[i - 1][1], out[i][0], out[i][1]);
    return span <= maxSpanM ? out : null;
}

/** A short stable key for a polyline at ~110 m resolution. @param {Array<[number, number]>} line */
function lineKey(line) {
    return line.map(([a, b]) => `${a.toFixed(3)},${b.toFixed(3)}`).filter((k, i, arr) => i === 0 || k !== arr[i - 1]).join(";");
}

module.exports = { R, RAD, isCoord, haversine, distanceToLine, cleanLine, lineKey };
