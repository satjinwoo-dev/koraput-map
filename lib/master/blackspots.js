// @ts-check
"use strict";
/* ============================================================================
   MapUnite Master AI (server) — accident blackspots
   ==============================================================================
   POST /api/master/blackspots  { line: [[lat, lng], …], radiusM? }
     → { ok, datasetVersion, spots: [{ id, lat, lng, sAlongM, offM, name, road,
                                         radiusM, accidents, fatalities, period, source }] }

   WHERE THE DATA COMES FROM. This module ships NO accident data: it can't be
   invented, and a wrong blackspot is worse than none. data/master/blackspots/
   holds JSON files produced by scripts/master/import-blackspots.mjs from an
   OFFICIAL list (MoRTH's identified blackspots, a state PWD / police list, an
   iRAD export) that has coordinates. Each file names its source and licence;
   every spot carries its source id so a warning can always be traced.

   File format (data/master/blackspots/<source>.json):
     { "v": 1, "source": { "id": "morth-2024", "name": "…", "url": "…", "licence": "…", "retrieved": "2026-01-15" },
       "spots": [ { "id": "MH-123", "lat": 19.1, "lng": 72.9, "name": "…", "road": "NH48",
                    "radiusM": 500, "accidents": 14, "fatalities": 6, "period": "2019-2021" } ] }

   INDEX: a uniform grid of 0.02° cells (≈ 2.2 km). A corridor query touches a
   handful of cells, so it is O(spots near the road), not O(all spots); 100 000
   spots load in well under a second and fit in a few MB.

   SEVERITY used by the phone (agents/blackspot-agent.js): fatalities first,
   then accidents; a spot with neither is "listed" and still warned about,
   because being on an official list is itself the signal.
   ============================================================================ */

const fs = require("fs");
const path = require("path");
const { cleanLine, distanceToLine, isCoord } = require("./geo");

const CELL = 0.02;
const cellKey = (/** @type {number} */ lat, /** @type {number} */ lng) => `${Math.floor(lat / CELL)}:${Math.floor(lng / CELL)}`;

/**
 * Check one spot from a file. Returns the cleaned spot or null.
 * @param {any} s @param {string} sourceId
 */
function cleanSpot(s, sourceId) {
    if (!s || typeof s !== "object") return null;
    const lat = Number(s.lat), lng = Number(s.lng);
    if (!isCoord(lat, lng)) return null;
    const int = (/** @type {any} */ v) => (Number.isFinite(Number(v)) && Number(v) >= 0 ? Math.round(Number(v)) : null);
    const str = (/** @type {any} */ v, n = 80) => (typeof v === "string" ? v.trim().slice(0, n) : "");
    const radius = Number(s.radiusM);
    return {
        id: `${sourceId}:${str(s.id, 40) || `${lat.toFixed(5)},${lng.toFixed(5)}`}`,
        lat, lng,
        name: str(s.name), road: str(s.road, 30),
        radiusM: Number.isFinite(radius) && radius >= 50 && radius <= 3000 ? Math.round(radius) : 300,
        accidents: int(s.accidents), fatalities: int(s.fatalities),
        period: str(s.period, 20), source: sourceId
    };
}

function createBlackspots() {
    /** @type {Map<string, any[]>} */ let grid = new Map();
    /** @type {any[]} */ let sources = [];
    let count = 0, version = "empty";

    /**
     * Replace the index with these datasets (all-or-nothing per file).
     * @param {Array<{ v: number, source: any, spots: any[] }>} datasets
     */
    function load(datasets) {
        /** @type {Map<string, any[]>} */ const g = new Map();
        /** @type {any[]} */ const src = [];
        let n = 0;
        for (const ds of datasets) {
            if (!ds || ds.v !== 1 || !ds.source || typeof ds.source.id !== "string" || !Array.isArray(ds.spots)) continue;
            const sid = ds.source.id.replace(/[^a-z0-9_-]/gi, "").slice(0, 30);
            if (!sid) continue;
            let kept = 0;
            for (const raw of ds.spots) {
                const s = cleanSpot(raw, sid);
                if (!s) continue;
                const k = cellKey(s.lat, s.lng);
                const arr = g.get(k);
                if (arr) arr.push(s); else g.set(k, [s]);
                kept++;
            }
            n += kept;
            src.push({ id: sid, name: String(ds.source.name || sid).slice(0, 120), url: String(ds.source.url || "").slice(0, 300), licence: String(ds.source.licence || "").slice(0, 120), retrieved: String(ds.source.retrieved || "").slice(0, 20), spots: kept });
        }
        grid = g; sources = src; count = n;
        version = n ? `${src.map((s) => `${s.id}@${s.retrieved || "?"}`).join("+")}:${n}` : "empty";
        return { count, sources };
    }

    /** Load every *.json in a folder. Missing folder = empty dataset (not an error). @param {string} dir */
    function loadDir(dir) {
        /** @type {any[]} */ const all = [];
        let files = [];
        try { files = fs.readdirSync(dir).filter((f) => f.endsWith(".json")); } catch { return load([]); }
        for (const f of files) {
            try { all.push(JSON.parse(fs.readFileSync(path.join(dir, f), "utf8"))); }
            catch (e) { console.warn(`[master] blackspots: skipped ${f}: ${/** @type {Error} */ (e).message}`); }
        }
        return load(all);
    }

    /**
     * Spots whose zone (spot radius + margin) touches the line.
     * @param {Array<[number, number]>} line @param {number} marginM
     */
    function nearLine(line, marginM) {
        if (!count) return [];
        /** @type {Set<string>} */ const keys = new Set();
        const pad = Math.ceil((marginM + 3000) / 2200);                  // cells within reach of the largest radius
        for (const [lat, lng] of line) {
            const ci = Math.floor(lat / CELL), cj = Math.floor(lng / CELL);
            for (let di = -pad; di <= pad; di++) for (let dj = -pad; dj <= pad; dj++) keys.add(`${ci + di}:${cj + dj}`);
        }
        const out = [];
        for (const k of keys) for (const s of grid.get(k) || []) {
            const r = distanceToLine(s.lat, s.lng, line);
            if (r.d <= s.radiusM + marginM) out.push({ ...s, sAlongM: Math.round(r.s), offM: Math.round(r.d) });
        }
        return out.sort((a, b) => a.sAlongM - b.sAlongM);
    }

    /** Spots within radiusM of a point. @param {number} lat @param {number} lng @param {number} radiusM */
    function nearPoint(lat, lng, radiusM) { return nearLine([[lat, lng]], radiusM); }

    /** @param {any} body @returns {Promise<{ status: number, json: any }>} */
    async function handle(body) {
        const line = cleanLine(body && body.line, { max: 40, maxSpanM: 6000 });
        if (!line) return { status: 400, json: { ok: false, reason: "bad-line" } };
        const margin = Math.max(0, Math.min(500, Number(body.radiusM) || 100));
        return { status: 200, json: { ok: true, datasetVersion: version, spots: nearLine(line, margin) } };
    }

    return { load, loadDir, nearLine, nearPoint, handle, info: () => ({ count, version, sources }) };
}

module.exports = { createBlackspots, cleanSpot, CELL };
