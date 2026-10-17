// @ts-check
"use strict";
/* ============================================================================
   MapUnite elevation — the self-hosted 30 m terrain model (server)
   ==============================================================================
   Heights for the pilot corridors from Copernicus GLO-30 (ESA) or NASADEM
   (NASA), cut and stored by scripts/elevation-ingest.mjs as one grid per
   corridor in ELEVATION_DIR (default data/elevation/grids):
       <id>.json   { id, name, source, lat0, lng0, dLat, dLng, width, height, … }
       <id>.f32    width × height Float32 little-endian, row 0 = north,
                   NaN = no data (sea / void)
   grid(row, col) is the CENTRE of a pixel: lat = lat0 − row·dLat, lng = lng0 + col·dLng.

   POST /api/elevation   { lat: number[], lng: number[] }   (≤ 1000 points)
     → { ok, elevation: (number|null)[], source, resolutionM, attribution }
       metres above the EGM2008 geoid, to 0.1 m; null outside every corridor
       or on a void. The phone treats null as "unknown" (a flat profile,
       labelled "hills not included"); nothing is ever made up.
   GET /api/elevation/coverage → the corridors (bbox, source, attribution).

   Interpolation: bilinear between the four surrounding pixel centres. Where
   one of them is a void, the nearest valid of the four is used; all four
   void → null.
   ============================================================================ */

const fs = require("node:fs");
const path = require("node:path");

const MAX_POINTS = 1000;
const r7 = (/** @type {number} */ x) => Math.round(x * 1e7) / 1e7;

/**
 * @typedef {{ id: string, name: string, source: string, sourceName: string, attribution: string, resolutionM: number,
 *   lat0: number, lng0: number, dLat: number, dLng: number, width: number, height: number, data: Float32Array,
 *   bbox: { s: number, w: number, n: number, e: number } }} Grid
 */

/**
 * @param {{ id: string, name?: string, source?: string, sourceName?: string, attribution?: string, resolutionM?: number,
 *   lat0: number, lng0: number, dLat: number, dLng: number, width: number, height: number }} meta
 * @param {Float32Array} data
 * @returns {Grid}
 */
function makeGrid(meta, data) {
    for (const k of ["lat0", "lng0", "dLat", "dLng", "width", "height"]) {
        if (!Number.isFinite(/** @type {any} */ (meta)[k])) throw new Error(`${meta.id}: ${k} missing`);
    }
    if (!(meta.dLat > 0 && meta.dLng > 0)) throw new Error(`${meta.id}: bad pixel size`);
    if (data.length !== meta.width * meta.height) throw new Error(`${meta.id}: ${data.length} heights for ${meta.width}×${meta.height}`);
    return {
        id: meta.id, name: meta.name || meta.id, source: meta.source || "unknown", sourceName: meta.sourceName || meta.source || "unknown",
        attribution: meta.attribution || "", resolutionM: meta.resolutionM || 30,
        lat0: meta.lat0, lng0: meta.lng0, dLat: meta.dLat, dLng: meta.dLng, width: meta.width, height: meta.height, data,
        bbox: { n: r7(meta.lat0), s: r7(meta.lat0 - (meta.height - 1) * meta.dLat), w: r7(meta.lng0), e: r7(meta.lng0 + (meta.width - 1) * meta.dLng) }
    };
}

/**
 * Height at a point from one grid, or null.
 * @param {Grid} g @param {number} lat @param {number} lng
 */
function sample(g, lat, lng) {
    const fr = (g.lat0 - lat) / g.dLat, fc = (lng - g.lng0) / g.dLng;
    if (!(fr >= 0 && fc >= 0 && fr <= g.height - 1 && fc <= g.width - 1)) return null;
    const r0 = Math.min(g.height - 2, Math.floor(fr)), c0 = Math.min(g.width - 2, Math.floor(fc));
    if (r0 < 0 || c0 < 0) {                              // a one-pixel-wide grid: nearest
        const v = g.data[Math.round(fr) * g.width + Math.round(fc)];
        return Number.isFinite(v) ? v : null;
    }
    const tr = fr - r0, tc = fc - c0;
    const i = r0 * g.width + c0;
    const q = [g.data[i], g.data[i + 1], g.data[i + g.width], g.data[i + g.width + 1]];
    const w = [(1 - tr) * (1 - tc), (1 - tr) * tc, tr * (1 - tc), tr * tc];
    if (q.every(Number.isFinite)) return q[0] * w[0] + q[1] * w[1] + q[2] * w[2] + q[3] * w[3];
    let best = -1;
    for (let k = 0; k < 4; k++) if (Number.isFinite(q[k]) && (best < 0 || w[k] > w[best])) best = k;
    return best < 0 ? null : q[best];
}

/**
 * @param {{ dir?: string, grids?: Grid[], log?: (m: string) => void }} [o]
 */
function createDemStore(o = {}) {
    const log = o.log || ((m) => console.log(m));
    /** @type {Grid[]} */ const grids = [...(o.grids || [])];
    if (o.dir && fs.existsSync(o.dir)) {
        for (const f of fs.readdirSync(o.dir).filter((x) => x.endsWith(".json")).sort()) {
            const base = f.slice(0, -5);
            const bin = path.join(o.dir, `${base}.f32`);
            if (!fs.existsSync(bin)) continue;                   // corridors.json and other notes have no grid
            try {
                const meta = JSON.parse(fs.readFileSync(path.join(o.dir, f), "utf8"));
                const buf = fs.readFileSync(bin);
                const data = new Float32Array(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
                grids.push(makeGrid({ id: base, ...meta }, data));
                log(`   Elevation: ${base} (${meta.sourceName || meta.source}, ${meta.width}×${meta.height})`);
            } catch (e) {
                log(`   Elevation: ${base} skipped: ${/** @type {Error} */ (e).message}`);
            }
        }
    }

    /** Height in metres (0.1 m), or null. @param {number} lat @param {number} lng */
    function heightAt(lat, lng) {
        if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
        for (const g of grids) {
            const v = sample(g, lat, lng);
            if (v !== null) return Math.round(v * 10) / 10;
        }
        return null;
    }

    function coverage() {
        return grids.map((g) => ({ id: g.id, name: g.name, bbox: g.bbox, source: g.source, sourceName: g.sourceName, resolutionM: g.resolutionM, attribution: g.attribution }));
    }

    /** @param {any} req @param {any} res */
    function handler(req, res) {
        const b = req.body || {};
        const lat = b.lat, lng = b.lng;
        if (!Array.isArray(lat) || !Array.isArray(lng) || lat.length !== lng.length || lat.length === 0) return res.status(400).json({ ok: false, reason: "bad-points" });
        if (lat.length > MAX_POINTS) return res.status(413).json({ ok: false, reason: "too-many-points", max: MAX_POINTS });
        const elevation = lat.map((la, i) => (typeof la === "number" && typeof lng[i] === "number" && Math.abs(la) <= 90 && Math.abs(lng[i]) <= 180 ? heightAt(la, lng[i]) : null));
        const used = grids.filter((g) => lat.some((la, i) => typeof la === "number" && sample(g, la, lng[i]) !== null));
        res.setHeader("Cache-Control", "no-store");
        res.json({
            ok: true, elevation,
            source: used.length ? [...new Set(used.map((g) => g.source))].join(",") : null,
            resolutionM: used.length ? Math.max(...used.map((g) => g.resolutionM)) : null,
            attribution: [...new Set(used.map((g) => g.attribution).filter(Boolean))]
        });
    }

    /** @param {any} _req @param {any} res */
    function coverageHandler(_req, res) {
        res.setHeader("Cache-Control", "public, max-age=3600");
        res.json({ ok: true, corridors: coverage() });
    }

    return { heightAt, coverage, handler, coverageHandler, get size() { return grids.length; } };
}

module.exports = { createDemStore, makeGrid, sample, MAX_POINTS };
