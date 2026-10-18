#!/usr/bin/env node
/*
 * Ride Plan: turn a GOVERNMENT hospital directory (CSV) into the server's known-hospital
 * dataset (lib/master/hospitals.js).
 *
 *   node scripts/master/import-hospitals.mjs <file.csv> --id nhd-2024 \
 *        --name "National Hospital Directory with Geo Code" --url "<where you downloaded it>" \
 *        --licence "Government Open Data License - India" [--state Odisha] [--out data/master/hospitals/nhd-2024.json]
 *
 * Columns are found by header name (case-insensitive), or set explicitly:
 *   --lat <col> --lng <col> --label <col> --category <col> --district <col> --state-col <col> --phone <col> --key <col>
 *   auto: latitude|lat, longitude|lng|lon, hospital_name|name, hospital_category|category|hospital_care_type,
 *         district, state, telephone|mobile_number|emergency_num|phone
 *   Some directories put both in one column "Location_Coordinates" ("20.29, 85.82"): found as well.
 *
 * Only rows with coordinates inside India's bounding box are kept (others counted as skipped: never
 * guessed); duplicates (same name within 100 m) are merged. These are KNOWN locations, not verified ones:
 * the app says so wherever it shows them.
 */
import fs from "node:fs";
import path from "node:path";
import { parseCsv } from "./import-blackspots.mjs";

const AUTO = {
    lat: ["latitude", "lat"],
    lng: ["longitude", "lng", "lon", "long"],
    both: ["location_coordinates", "location coordinates", "coordinates", "geo_code", "geocode"],
    label: ["hospital_name", "hospital name", "name", "facility_name", "facility name"],
    category: ["hospital_category", "hospital category", "category", "hospital_care_type", "hospital care type", "type"],
    district: ["district", "district_name"],
    state: ["state", "state_name"],
    phone: ["telephone", "phone", "mobile_number", "emergency_num", "contact_number"],
    key: ["sr_no", "sr no", "id", "sl_no", "s_no"]
};
const INDIA = { latMin: 6, latMax: 37.6, lngMin: 68, lngMax: 97.5 };

/** Metres between two points (flat, short distances). */
const near = (a, b) => Math.hypot((a.lat - b.lat) * 110540, (a.lng - b.lng) * 111320 * Math.cos(a.lat * Math.PI / 180));

/**
 * @param {string[][]} rows @param {Record<string, string>} cols @param {{ state?: string }} [o]
 * @returns {{ hospitals: any[], skipped: number, merged: number }}
 */
export function toHospitals(rows, cols, o = {}) {
    if (!rows.length) return { hospitals: [], skipped: 0, merged: 0 };
    const head = rows[0].map((h) => h.trim().toLowerCase());
    const idx = (k) => {
        if (cols[k]) return head.indexOf(cols[k].toLowerCase());
        for (const name of AUTO[k]) { const i = head.indexOf(name); if (i >= 0) return i; }
        return -1;
    };
    const I = Object.fromEntries(Object.keys(AUTO).map((k) => [k, idx(k)]));
    if ((I.lat < 0 || I.lng < 0) && I.both < 0) throw new Error(`no coordinate columns in: ${head.join(", ")} (use --lat / --lng)`);
    if (I.label < 0) throw new Error(`no hospital name column in: ${head.join(", ")} (use --label)`);
    const out = []; let skipped = 0, merged = 0;
    rows.slice(1).forEach((r, n) => {
        const v = (i) => (i >= 0 ? String(r[i] ?? "").trim() : "");
        let lat = Number(v(I.lat)), lng = Number(v(I.lng));
        if ((!Number.isFinite(lat) || !Number.isFinite(lng) || !v(I.lat)) && I.both >= 0) { const m = v(I.both).match(/(-?\d+(?:\.\d+)?)\s*[,; ]\s*(-?\d+(?:\.\d+)?)/); if (m) { lat = Number(m[1]); lng = Number(m[2]); } }
        const name = v(I.label);
        if (!name || !Number.isFinite(lat) || !Number.isFinite(lng) || lat < INDIA.latMin || lat > INDIA.latMax || lng < INDIA.lngMin || lng > INDIA.lngMax) { skipped++; return; }
        if (o.state && v(I.state).toLowerCase() !== o.state.toLowerCase()) return;
        const rec = { id: v(I.key) || String(n + 1), name, lat: Math.round(lat * 1e5) / 1e5, lng: Math.round(lng * 1e5) / 1e5, category: v(I.category) || null, district: v(I.district) || null, state: v(I.state) || null, phone: v(I.phone) || null };
        const twin = out.find((h) => h.name.toLowerCase() === name.toLowerCase() && near(h, rec) < 100);
        if (twin) { merged++; if (!twin.phone && rec.phone) twin.phone = rec.phone; return; }
        out.push(rec);
    });
    return { hospitals: out, skipped, merged };
}

function main() {
    const args = process.argv.slice(2);
    const file = args[0] && !args[0].startsWith("--") ? args[0] : undefined;
    const opt = (k) => { const i = args.indexOf(`--${k}`); return i >= 0 ? args[i + 1] : undefined; };
    const id = opt("id");
    if (!file || !id) { console.error("usage: import-hospitals.mjs <file.csv> --id <source-id> --name <name> --url <url> --licence <licence> [--state <state>]"); process.exit(1); }
    if (!opt("licence")) console.warn("import-hospitals: no --licence given. Check the directory's licence allows use in an app before deploying it.");
    const cols = Object.fromEntries([["lat", "lat"], ["lng", "lng"], ["label", "label"], ["category", "category"], ["district", "district"], ["state", "state-col"], ["phone", "phone"], ["key", "key"]].map(([k, f]) => [k, opt(f)]).filter(([, v]) => v));
    const { hospitals, skipped, merged } = toHospitals(parseCsv(fs.readFileSync(file, "utf8")), cols, { state: opt("state") });
    const out = opt("out") || path.join("data/master/hospitals", `${id}.json`);
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(out, JSON.stringify({ v: 1, source: { id, name: opt("name") || id, url: opt("url") || "", licence: opt("licence") || "", retrieved: new Date().toISOString().slice(0, 10) }, hospitals }, null, 1));
    console.log(`import-hospitals: ${hospitals.length} hospitals → ${out}${skipped ? ` (${skipped} rows without usable coordinates skipped)` : ""}${merged ? ` (${merged} duplicates merged)` : ""}`);
}

if (import.meta.url === `file://${process.argv[1]}`) main();
