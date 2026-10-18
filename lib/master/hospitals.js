// @ts-check
"use strict";
/* ============================================================================
   MapUnite (server) — known hospital locations from a government directory
   ==============================================================================
   data/master/hospitals/<source>.json, made by scripts/master/import-hospitals.mjs
   from a published government directory (e.g. the National Hospital Directory
   with geo-codes on data.gov.in, Government Open Data License – India: free,
   commercial use allowed, with attribution).

   HONESTY. These are KNOWN LOCATIONS, not verified ones: a directory can be
   years old, a hospital can have moved or closed, and geo-codes are often
   approximate. The Ride Plan shows them as "known location (government
   directory, may be out of date: call ahead)" and never as a guarantee of
   care, and keeps them apart from what OpenStreetMap maps.

   File format: { "v": 1, "source": { "id", "name", "url", "licence", "retrieved" },
                  "hospitals": [ { "id", "name", "lat", "lng", "category", "district", "state", "phone" } ] }
   Grid index of 0.05° cells, like blackspots.js.
   ============================================================================ */

const fs = require("fs");
const path = require("path");
const { isCoord, distanceToLine } = require("./geo");

const CELL = 0.05;
const cellKey = (/** @type {number} */ lat, /** @type {number} */ lng) => `${Math.floor(lat / CELL)}:${Math.floor(lng / CELL)}`;

function createHospitals() {
    /** @type {Map<string, any[]>} */ let grid = new Map();
    let count = 0;
    /** @type {any[]} */ let sources = [];

    /** @param {any[]} files parsed JSON files */
    function load(files) {
        grid = new Map(); count = 0; sources = [];
        for (const f of files) {
            if (!f || f.v !== 1 || !f.source || !f.source.id || !Array.isArray(f.hospitals)) continue;
            sources.push({ id: String(f.source.id), name: String(f.source.name || ""), url: f.source.url || null, licence: f.source.licence || null, retrieved: f.source.retrieved || null });
            for (const h of f.hospitals) {
                const lat = Number(h && h.lat), lng = Number(h && h.lng);
                if (!isCoord(lat, lng) || !h.name) continue;
                const rec = { id: `${f.source.id}:${String(h.id || count)}`, name: String(h.name).slice(0, 120), lat, lng, category: h.category ? String(h.category).slice(0, 40) : null, district: h.district ? String(h.district).slice(0, 60) : null, state: h.state ? String(h.state).slice(0, 60) : null, phone: h.phone ? String(h.phone).slice(0, 40) : null, source: String(f.source.id) };
                const k = cellKey(lat, lng);
                if (!grid.has(k)) grid.set(k, []);
                /** @type {any[]} */ (grid.get(k)).push(rec);
                count++;
            }
        }
        return { count, sources };
    }
    /** @param {string} dir */
    function loadDir(dir) {
        let files = [];
        try { files = fs.readdirSync(dir).filter((f) => f.endsWith(".json")); } catch { return load([]); }
        return load(files.map((f) => { try { return JSON.parse(fs.readFileSync(path.join(dir, f), "utf8")); } catch { return null; } }));
    }
    /**
     * Known hospitals within marginM of a line, with their position along it.
     * @param {Array<[number, number]>} line @param {number} marginM
     */
    function nearLine(line, marginM) {
        if (!count || line.length < 1) return [];
        const pad = marginM / 111000 + CELL;
        /** @type {Set<string>} */ const keys = new Set();
        for (let i = 0; i < line.length; i++) {
            const [a, b] = line[i], [c, d] = line[Math.min(line.length - 1, i + 1)];
            const steps = Math.max(1, Math.ceil(Math.max(Math.abs(c - a), Math.abs(d - b)) / CELL));
            for (let s = 0; s <= steps; s++) {
                const la = a + (c - a) * s / steps, ln = b + (d - b) * s / steps;
                for (let dy = -pad; dy <= pad + 1e-9; dy += CELL) for (let dx = -pad; dx <= pad + 1e-9; dx += CELL) keys.add(cellKey(la + dy, ln + dx));
            }
        }
        const out = [];
        for (const k of keys) for (const h of grid.get(k) || []) {
            const at = distanceToLine(h.lat, h.lng, line);
            if (at.d <= marginM) out.push({ ...h, sM: Math.round(at.s), offM: Math.round(at.d) });
        }
        return out.sort((a, b) => a.sM - b.sM);
    }
    return { load, loadDir, nearLine, info: () => ({ count, sources }) };
}

module.exports = { createHospitals, CELL };
