#!/usr/bin/env node
/*
 * Master AI: turn an OFFICIAL accident-blackspot list (CSV) into the server's
 * dataset format (lib/master/blackspots.js).
 *
 *   node scripts/master/import-blackspots.mjs <file.csv> --id morth-2024 \
 *        --name "MoRTH identified blackspots" --url "<where you downloaded it>" \
 *        --licence "<its licence>" [--radius 500] [--out data/master/blackspots/morth-2024.json]
 *
 * Columns are found by header name (case-insensitive), or set them explicitly:
 *   --lat <col> --lng <col> --label <col> --road <col> --accidents <col> --fatalities <col> --period <col> --key <col>
 *   auto: lat|latitude, lng|lon|long|longitude, name|location|place|blackspot,
 *         road|nh|highway|road_name, accidents|total_accidents, fatalities|deaths|killed|persons_killed
 *
 * Rows without valid coordinates are skipped and counted (many published lists
 * have chainage only: geocode them first, never guess). The source's id, name,
 * url and licence are written into the file, and every warning the app gives
 * carries that source id.
 */
import fs from "node:fs";
import path from "node:path";

/** RFC 4180 CSV → rows of strings (quoted fields, "" escapes, CRLF). @param {string} text */
export function parseCsv(text) {
    const rows = []; let row = [], field = "", q = false;
    for (let i = 0; i < text.length; i++) {
        const c = text[i];
        if (q) {
            if (c === '"') { if (text[i + 1] === '"') { field += '"'; i++; } else q = false; }
            else field += c;
        } else if (c === '"') q = true;
        else if (c === ",") { row.push(field); field = ""; }
        else if (c === "\n" || c === "\r") {
            if (c === "\r" && text[i + 1] === "\n") i++;
            row.push(field); field = "";
            if (row.some((x) => x.trim() !== "")) rows.push(row);
            row = [];
        } else field += c;
    }
    row.push(field);
    if (row.some((x) => x.trim() !== "")) rows.push(row);
    return rows;
}

const AUTO = {
    lat: ["lat", "latitude"],
    lng: ["lng", "lon", "long", "longitude"],
    label: ["name", "location", "place", "blackspot", "black_spot", "black spot", "location_name"],
    road: ["road", "nh", "nh no", "nh_no", "highway", "road_name", "road no", "road_no"],
    accidents: ["accidents", "total_accidents", "no_of_accidents", "total accidents"],
    fatalities: ["fatalities", "deaths", "killed", "persons_killed", "no_of_fatalities", "total fatalities"],
    period: ["period", "year", "years"],
    key: ["id", "sl_no", "s_no", "sno", "serial"]
};

/**
 * @param {string[][]} rows @param {Record<string, string>} cols @param {{ id: string, radius?: number }} o
 * @returns {{ spots: any[], skipped: number }}
 */
export function toSpots(rows, cols, o) {
    if (!rows.length) return { spots: [], skipped: 0 };
    const head = rows[0].map((h) => h.trim().toLowerCase());
    const idx = (/** @type {string} */ k) => {
        if (cols[k]) return head.indexOf(cols[k].toLowerCase());
        for (const name of /** @type {any} */ (AUTO)[k]) { const i = head.indexOf(name); if (i >= 0) return i; }
        return -1;
    };
    const I = Object.fromEntries(Object.keys(AUTO).map((k) => [k, idx(k)]));
    if (I.lat < 0 || I.lng < 0) throw new Error(`no latitude/longitude columns in: ${head.join(", ")} (use --lat / --lng)`);
    const spots = []; let skipped = 0;
    rows.slice(1).forEach((r, n) => {
        const lat = Number(String(r[I.lat] ?? "").trim()), lng = Number(String(r[I.lng] ?? "").trim());
        if (!Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180 || (lat === 0 && lng === 0)) { skipped++; return; }
        const v = (/** @type {number} */ i) => (i >= 0 ? String(r[i] ?? "").trim() : "");
        const num = (/** @type {number} */ i) => { const x = Number(v(i).replace(/,/g, "")); return v(i) !== "" && Number.isFinite(x) ? x : undefined; };
        spots.push({ id: v(I.key) || String(n + 1), lat, lng, name: v(I.label), road: v(I.road), accidents: num(I.accidents), fatalities: num(I.fatalities), period: v(I.period), radiusM: o.radius || 300 });
    });
    return { spots, skipped };
}

function main() {
    const args = process.argv.slice(2);
    const file = args[0] && !args[0].startsWith("--") ? args[0] : undefined;
    const opt = (/** @type {string} */ k) => { const i = args.indexOf(`--${k}`); return i >= 0 ? args[i + 1] : undefined; };
    const id = opt("id");
    if (!file || !id) { console.error("usage: import-blackspots.mjs <file.csv> --id <source-id> --name <name> --url <url> --licence <licence>"); process.exit(1); }
    if (!opt("licence")) console.warn("import-blackspots: no --licence given. Check you may redistribute this list before deploying it.");
    const cols = Object.fromEntries(Object.keys(AUTO).map((k) => [k, opt(k)]).filter(([, v]) => v));
    const { spots, skipped } = toSpots(parseCsv(fs.readFileSync(file, "utf8")), /** @type {any} */ (cols), { id, radius: Number(opt("radius")) || 300 });
    const out = opt("out") || path.join("data/master/blackspots", `${id}.json`);
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(out, JSON.stringify({ v: 1, source: { id, name: opt("name") || id, url: opt("url") || "", licence: opt("licence") || "", retrieved: new Date().toISOString().slice(0, 10) }, spots }, null, 1));
    console.log(`import-blackspots: ${spots.length} spots → ${out}${skipped ? ` (${skipped} rows had no usable coordinates and were skipped)` : ""}`);
}

if (import.meta.url === `file://${process.argv[1]}`) main();
