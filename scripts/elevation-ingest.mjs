#!/usr/bin/env node
// Builds the self-hosted 30 m terrain model for the pilot corridors (lib/elevation/dem-store.js reads it).
//
//   node scripts/elevation-ingest.mjs                      Copernicus GLO-30 (ESA), downloaded from the public
//                                                          AWS Open Data bucket (no account needed)
//   node scripts/elevation-ingest.mjs --from <dir>         use tiles already on disk instead of downloading:
//                                                          Copernicus_DSM_COG_10_N18_00_E082_00_DEM.tif, or
//                                                          NASADEM / SRTM N18E082.hgt (NASA: needs an Earthdata
//                                                          login to download, so it's never fetched here)
//   options: --source copernicus|nasadem   --corridors data/elevation/corridors.json   --out data/elevation/grids
//            --only <corridor id>
//
// For each corridor: the 1° tiles under its bbox are read, mosaicked, cut to the bbox and written as
// <id>.f32 (Float32 LE, row 0 = north, NaN = void) + <id>.json (grid, source, licence attribution, the files used
// and their SHA-256). Restart the server afterwards.
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const { readGeoTiff, readHgt } = require("../lib/elevation/geotiff.js");
const ROOT = fileURLToPath(new URL("../", import.meta.url));

export const SOURCES = Object.freeze({
    copernicus: {
        sourceName: "Copernicus DEM GLO-30",
        resolutionM: 30,
        // the licence asks for this credit when the data (or work derived from it) is shown; data/sources.json
        attribution: "Copernicus DEM GLO-30 © DLR e.V. 2010-2014 and © Airbus Defence and Space GmbH 2014-2018, provided under COPERNICUS by the European Union and ESA",
        file: (lat, lng) => `Copernicus_DSM_COG_10_${lat < 0 ? "S" : "N"}${String(Math.abs(lat)).padStart(2, "0")}_00_${lng < 0 ? "W" : "E"}${String(Math.abs(lng)).padStart(3, "0")}_00_DEM.tif`,
        url: (lat, lng) => { const f = SOURCES.copernicus.file(lat, lng); return `https://copernicus-dem-30m.s3.amazonaws.com/${f.replace(/\.tif$/, "")}/${f}`; }
    },
    nasadem: {
        sourceName: "NASADEM (NASA JPL)",
        resolutionM: 30,
        attribution: "NASADEM courtesy of NASA JPL and the NASA EOSDIS Land Processes DAAC",
        file: (lat, lng) => `${lat < 0 ? "S" : "N"}${String(Math.abs(lat)).padStart(2, "0")}${lng < 0 ? "W" : "E"}${String(Math.abs(lng)).padStart(3, "0")}.hgt`,
        url: null
    }
});

/** The 1° tiles (south-west corners) under a bbox. */
export function tilesFor(b) {
    const out = [];
    for (let lat = Math.floor(b.s); lat < Math.ceil(b.n) || lat === Math.floor(b.s); lat++) {
        for (let lng = Math.floor(b.w); lng < Math.ceil(b.e) || lng === Math.floor(b.w); lng++) out.push({ lat, lng });
    }
    return out;
}

/**
 * Cut a bbox out of tiles (each { width, height, data, lat0, lng0, dLat, dLng }, the same pixel size) into one grid.
 * Pixels nobody covers stay NaN; a tile's nodata value becomes NaN.
 */
export function mosaic(bbox, tiles) {
    if (!tiles.length) throw new Error("no tiles");
    const dLat = tiles[0].dLat, dLng = tiles[0].dLng;
    for (const t of tiles) if (Math.abs(t.dLat - dLat) > 1e-12 || Math.abs(t.dLng - dLng) > 1e-12) throw new Error("tiles of different resolution");
    // the grid is aligned to the tiles' pixel centres: snap the bbox outward onto them
    const ref = tiles[0];
    const r0 = Math.floor((ref.lat0 - bbox.n) / dLat + 1e-9), r1 = Math.ceil((ref.lat0 - bbox.s) / dLat - 1e-9);
    const c0 = Math.floor((bbox.w - ref.lng0) / dLng + 1e-9), c1 = Math.ceil((bbox.e - ref.lng0) / dLng - 1e-9);
    const lat0 = ref.lat0 - r0 * dLat, lng0 = ref.lng0 + c0 * dLng;
    const width = c1 - c0 + 1, height = r1 - r0 + 1;
    const data = new Float32Array(width * height).fill(NaN);
    for (const t of tiles) {
        // grid (r, c) is tile (r + dr, c + dc): the same pixel centres, offset by whole pixels
        const dr = Math.round((t.lat0 - lat0) / dLat), dc = Math.round((lng0 - t.lng0) / dLng);
        for (let r = 0; r < height; r++) {
            const tr = r + dr;
            if (tr < 0 || tr >= t.height) continue;
            for (let c = 0; c < width; c++) {
                const tc = c + dc;
                if (tc < 0 || tc >= t.width) continue;
                const v = t.data[tr * t.width + tc];
                if (!Number.isFinite(v) || (t.nodata !== null && v === t.nodata)) continue;
                if (Number.isNaN(data[r * width + c])) data[r * width + c] = v;   // edge pixels two tiles share: the first wins
            }
        }
    }
    return { lat0, lng0, dLat, dLng, width, height, data };
}

function args(argv) {
    const o = { source: "copernicus", corridors: path.join(ROOT, "data/elevation/corridors.json"), out: path.join(ROOT, "data/elevation/grids"), from: null, only: null };
    for (let i = 0; i < argv.length; i++) {
        const k = argv[i].replace(/^--/, "");
        if (k in o) o[k] = argv[++i];
        else throw new Error(`unknown option ${argv[i]}`);
    }
    if (!SOURCES[o.source]) throw new Error(`--source must be ${Object.keys(SOURCES).join(" or ")}`);
    return o;
}

async function getTile(src, t, from, cacheDir) {
    const name = src.file(t.lat, t.lng);
    for (const dir of [from, cacheDir].filter(Boolean)) {
        const p = path.join(dir, name);
        if (fs.existsSync(p)) return { name, buf: fs.readFileSync(p) };
    }
    if (!src.url) throw new Error(`${name} not found in --from ${from}: NASADEM tiles need an Earthdata login, download them yourself`);
    const url = src.url(t.lat, t.lng);
    process.stdout.write(`   downloading ${name} … `);
    const res = await fetch(url);
    if (res.status === 404 || res.status === 403) { console.log("none (sea)"); return null; }   // the bucket has no all-sea tiles
    if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
    const buf = Buffer.from(await res.arrayBuffer());
    console.log(`${(buf.length / 1e6).toFixed(1)} MB`);
    fs.mkdirSync(cacheDir, { recursive: true });
    fs.writeFileSync(path.join(cacheDir, name), buf);
    return { name, buf };
}

export async function main(argv = process.argv.slice(2)) {
    const o = args(argv);
    const src = SOURCES[o.source];
    const conf = JSON.parse(fs.readFileSync(o.corridors, "utf8"));
    fs.mkdirSync(o.out, { recursive: true });
    const cacheDir = path.join(o.out, "_downloads");
    for (const cor of conf.corridors) {
        if (o.only && cor.id !== o.only) continue;
        if (!/^[a-z0-9-]{1,40}$/.test(cor.id)) throw new Error(`bad corridor id "${cor.id}"`);
        console.log(`${cor.id}: ${cor.name}`);
        const files = [], tiles = [];
        for (const t of tilesFor(cor.bbox)) {
            const got = await getTile(src, t, o.from, cacheDir);
            if (!got) continue;
            const g = o.source === "nasadem" ? readHgt(got.buf, got.name) : readGeoTiff(got.buf);
            tiles.push(g);
            files.push({ file: got.name, sha256: crypto.createHash("sha256").update(got.buf).digest("hex") });
        }
        const m = mosaic(cor.bbox, tiles);
        let voids = 0, lo = Infinity, hi = -Infinity;
        for (const v of m.data) { if (Number.isNaN(v)) voids++; else { if (v < lo) lo = v; if (v > hi) hi = v; } }
        const meta = {
            name: cor.name, source: o.source, sourceName: src.sourceName, resolutionM: src.resolutionM, attribution: src.attribution,
            verticalDatum: "EGM2008 geoid (Copernicus) / EGM96 (NASADEM)", lat0: m.lat0, lng0: m.lng0, dLat: m.dLat, dLng: m.dLng,
            width: m.width, height: m.height, minM: Math.round(lo * 10) / 10, maxM: Math.round(hi * 10) / 10, voidPixels: voids,
            files, builtAt: new Date().toISOString()
        };
        fs.writeFileSync(path.join(o.out, `${cor.id}.f32`), Buffer.from(m.data.buffer, m.data.byteOffset, m.data.byteLength));
        fs.writeFileSync(path.join(o.out, `${cor.id}.json`), JSON.stringify(meta, null, 2) + "\n");
        console.log(`   → ${m.width}×${m.height}, ${meta.minM}–${meta.maxM} m, ${voids} void pixels, ${(m.data.byteLength / 1e6).toFixed(1)} MB`);
    }
    console.log(`Done. Restart the server to load ${o.out}.`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
    main().catch((e) => { console.error(e.message); process.exit(1); });
}
