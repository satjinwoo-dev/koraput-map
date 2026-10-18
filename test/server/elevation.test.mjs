// The self-hosted 30 m terrain model: the GeoTIFF reader (every layout Copernicus and others use), the corridor
// mosaic, bilinear lookups on pixel centres, the HTTP API, and — when the real Copernicus tiles have been ingested
// (data/elevation/grids) — spot checks against them.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const { readGeoTiff, readHgt, lzwDecode } = require("../../lib/elevation/geotiff.js");
const { createDemStore, makeGrid, sample } = require("../../lib/elevation/dem-store.js");
const { mosaic, tilesFor, SOURCES } = await import("../../scripts/elevation-ingest.mjs");
const ROOT = fileURLToPath(new URL("../../", import.meta.url));

// ------------------------------------------------------------------ a tiny GeoTIFF writer, for the reader's tests
/**
 * @param {{ w: number, h: number, values: (r: number, c: number) => number, le?: boolean, kind?: "f32"|"i16", tile?: number|null,
 *   compression?: 1|8, predictor?: 1|2|3, pixelIsPoint?: boolean, lat0?: number, lng0?: number, step?: number, nodata?: string }} o
 */
function writeTiff(o) {
    const le = o.le !== false, kind = o.kind || "f32", bps = kind === "f32" ? 4 : 2;
    const bw = o.tile || o.w, bh = o.tile || Math.min(o.h, 3);              // tiled, or strips of 3 rows
    const across = Math.ceil(o.w / bw), down = Math.ceil(o.h / bh);
    const blocks = [];
    for (let by = 0; by < down; by++) for (let bx = 0; bx < across; bx++) {
        const rows = o.tile ? bh : Math.min(bh, o.h - by * bh);
        const b = Buffer.alloc(bw * rows * bps);
        for (let r = 0; r < rows; r++) for (let c = 0; c < bw; c++) {
            const R = by * bh + r, Cc = bx * bw + c;
            const v = R < o.h && Cc < o.w ? o.values(R, Cc) : 0;
            const i = (r * bw + c) * bps;
            if (kind === "f32") { if (o.predictor === 3 || !le) b.writeFloatBE(v, i); else b.writeFloatLE(v, i); }
            else if (le) b.writeInt16LE(v, i); else b.writeInt16BE(v, i);
        }
        if (o.predictor === 3) {                                   // split into byte planes (MSB first), then difference bytes
            const rowLen = bw * bps;
            for (let r = 0; r < rows; r++) {
                const src = Buffer.from(b.subarray(r * rowLen, (r + 1) * rowLen));
                for (let c = 0; c < bw; c++) for (let k = 0; k < bps; k++) b[r * rowLen + k * bw + c] = src[c * bps + k];
                for (let i = rowLen - 1; i > 0; i--) b[r * rowLen + i] = (b[r * rowLen + i] - b[r * rowLen + i - 1]) & 0xff;
            }
        } else if (o.predictor === 2) {
            for (let r = 0; r < rows; r++) for (let c = bw - 1; c > 0; c--) {
                const i = (r * bw + c) * bps, p = i - bps;
                const v = ((le ? b.readUInt16LE(i) : b.readUInt16BE(i)) - (le ? b.readUInt16LE(p) : b.readUInt16BE(p))) & 0xffff;
                if (le) b.writeUInt16LE(v, i); else b.writeUInt16BE(v, i);
            }
        }
        blocks.push(o.compression === 8 ? zlib.deflateSync(b) : b);
    }
    const step = o.step || 1 / 3600;
    const geoKeys = [1, 1, 0, 2, 1024, 0, 1, 2, 1025, 0, 1, o.pixelIsPoint ? 2 : 1];
    const nodataStr = o.nodata ? o.nodata + "\0" : null;
    const entries = [
        [256, 3, [o.w]], [257, 3, [o.h]], [258, 3, [bps * 8]], [259, 3, [o.compression || 1]], [277, 3, [1]],
        [317, 3, [o.predictor || 1]], [339, 3, [kind === "f32" ? 3 : 2]],
        ...(o.tile ? [[322, 3, [bw]], [323, 3, [bh]], [324, 4, "offsets"], [325, 4, blocks.map((b) => b.length)]]
            : [[273, 4, "offsets"], [278, 3, [bh]], [279, 4, blocks.map((b) => b.length)]]),
        [33550, 12, [step, step, 0]], [33922, 12, [0, 0, 0, o.lng0 ?? 82, o.lat0 ?? 19, 0]], [34735, 3, geoKeys],
        ...(nodataStr ? [[42113, 2, nodataStr]] : [])
    ].sort((a, b) => a[0] - b[0]);
    const size = { 2: 1, 3: 2, 4: 4, 12: 8 };
    const ifdAt = 8, ifdLen = 2 + entries.length * 12 + 4;
    let extra = ifdAt + ifdLen;
    const extras = [];
    const dataStart = () => extra;
    // lay out: header, IFD, out-of-line values, image blocks
    const valuesOf = (e) => (e[2] === "offsets" ? null : e[2]);
    const outOfLine = entries.map((e) => {
        const n = e[2] === "offsets" ? blocks.length : typeof e[2] === "string" ? e[2].length : e[2].length;
        const bytes = n * size[e[1]];
        if (bytes <= 4) return null;
        const at = extra; extra += bytes + (bytes & 1); return at;
    });
    let blockAt = extra;
    const offsets = blocks.map((b) => { const at = blockAt; blockAt += b.length; return at; });
    const out = Buffer.alloc(blockAt);
    out.write(le ? "II" : "MM", 0, "latin1");
    const w16 = (v, i) => (le ? out.writeUInt16LE(v, i) : out.writeUInt16BE(v, i));
    const w32 = (v, i) => (le ? out.writeUInt32LE(v, i) : out.writeUInt32BE(v, i));
    const wf64 = (v, i) => (le ? out.writeDoubleLE(v, i) : out.writeDoubleBE(v, i));
    w16(42, 2); w32(ifdAt, 4); w16(entries.length, ifdAt);
    entries.forEach((e, k) => {
        const p = ifdAt + 2 + k * 12;
        const vals = e[2] === "offsets" ? offsets : valuesOf(e);
        const n = typeof vals === "string" ? vals.length : vals.length;
        w16(e[0], p); w16(e[1], p + 2); w32(n, p + 4);
        const at = outOfLine[k] ?? p + 8;
        if (typeof vals === "string") out.write(vals, at, "latin1");
        else vals.forEach((v, j) => { if (e[1] === 3) w16(v, at + j * 2); else if (e[1] === 4) w32(v, at + j * 4); else wf64(v, at + j * 8); });
        if (outOfLine[k] !== null) w32(outOfLine[k], p + 8);
    });
    void extras; void dataStart;
    blocks.forEach((b, i) => b.copy(out, offsets[i]));
    return out;
}

const f = (r, c) => 100 + r * 10 + c + 0.25;                 // a plane with a quarter metre, so floats are tested

test("GeoTIFF reader: tiled and stripped, little and big endian, DEFLATE, float and integer predictors, area and point pixels", () => {
    const layouts = [
        { name: "Copernicus-like COG", tile: 4, compression: 8, predictor: 3, pixelIsPoint: true },
        { name: "plain strips", compression: 1 },
        { name: "big-endian deflate strips", le: false, compression: 8 },
        { name: "tiled, float predictor, big-endian", tile: 4, compression: 8, predictor: 3, le: false },
        { name: "Int16, horizontal predictor", kind: "i16", compression: 8, predictor: 2 }
    ];
    for (const L of layouts) {
        const vals = L.kind === "i16" ? (r, c) => 300 + r * 7 - c : f;
        const g = readGeoTiff(writeTiff({ w: 7, h: 5, values: vals, ...L }));
        assert.equal(g.width, 7, L.name); assert.equal(g.height, 5, L.name);
        for (let r = 0; r < 5; r++) for (let c = 0; c < 7; c++) assert.equal(g.data[r * 7 + c], Math.fround(vals(r, c)), `${L.name} (${r},${c})`);
        // georeferencing: point pixels have their centre on the tiepoint; area pixels half a pixel in
        const half = L.pixelIsPoint ? 0 : 0.5 / 3600;
        assert.ok(Math.abs(g.lat0 - (19 - half)) < 1e-12 && Math.abs(g.lng0 - (82 + half)) < 1e-12, L.name);
        assert.equal(g.dLat, 1 / 3600);
    }
    const nd = readGeoTiff(writeTiff({ w: 3, h: 3, values: f, nodata: "-32767" }));
    assert.equal(nd.nodata, -32767);
    assert.throws(() => readGeoTiff(Buffer.from("not a tiff at all")), /not a TIFF/);
});

test("LZW: the TIFF variant decodes (codes 256 clear, 257 end, early change)", () => {
    // "ABABABA" → codes A B 258(AB) 260(ABA) end, 9-bit MSB-first, preceded by a clear code
    const codes = [256, 65, 66, 258, 260, 257];
    let bits = "";
    for (const c of codes) bits += c.toString(2).padStart(9, "0");
    while (bits.length % 8) bits += "0";
    const buf = Buffer.from(bits.match(/.{8}/g).map((b) => parseInt(b, 2)));
    assert.equal(lzwDecode(buf, 7).toString("latin1"), "ABABABA");
});

test("NASADEM / SRTM .hgt: big-endian Int16, named after its south-west corner, voids", () => {
    const side = 4, buf = Buffer.alloc(side * side * 2);
    for (let i = 0; i < side * side; i++) buf.writeInt16BE(i === 5 ? -32768 : 500 + i, i * 2);
    const g = readHgt(buf, "N18E082.hgt");
    assert.equal(g.lat0, 19); assert.equal(g.lng0, 82); assert.equal(g.dLat, 1 / 3);
    assert.equal(g.data[0], 500); assert.equal(g.nodata, -32768);
    assert.throws(() => readHgt(buf, "x.hgt"));
});

test("mosaic: tiles stitched on their shared pixel grid, cut to the corridor, voids NaN", () => {
    const step = 0.1;
    const tile = (lat, lng, v) => ({ width: 10, height: 10, nodata: -9999, lat0: lat + 1, lng0: lng, dLat: step, dLng: step,
        data: Float32Array.from({ length: 100 }, (_, i) => (i === 0 ? -9999 : v)) });
    const m = mosaic({ s: 18.55, w: 82.75, n: 18.95, e: 83.25 }, [tile(18, 82, 1), tile(18, 83, 2)]);
    assert.ok(Math.abs(m.lat0 - 19) < 1e-9 && Math.abs(m.lng0 - 82.7) < 1e-9, "snapped outward onto pixel centres");
    const at = (lat, lng) => m.data[Math.round((m.lat0 - lat) / step) * m.width + Math.round((lng - m.lng0) / step)];
    assert.equal(at(18.8, 82.8), 1);
    assert.equal(at(18.8, 83.2), 2);
    assert.ok(Number.isNaN(at(19, 83)), "the second tile's nodata pixel");
    assert.ok(Number.isNaN(at(18.6, 82.7)) === false);
    assert.deepEqual(tilesFor({ s: 18.2, w: 82.4, n: 19.0, e: 83.1 }), [{ lat: 18, lng: 82 }, { lat: 18, lng: 83 }]);
    assert.equal(SOURCES.copernicus.file(18, 82), "Copernicus_DSM_COG_10_N18_00_E082_00_DEM.tif");
    assert.equal(SOURCES.copernicus.url(22, 84), "https://copernicus-dem-30m.s3.amazonaws.com/Copernicus_DSM_COG_10_N22_00_E084_00_DEM/Copernicus_DSM_COG_10_N22_00_E084_00_DEM.tif");
    assert.equal(SOURCES.nasadem.file(18, 82), "N18E082.hgt");
});

test("lookups: bilinear between pixel centres, exact on a centre, nearest valid beside a void, null outside", () => {
    // a 3×3 grid, 1 m per column, 10 m per row
    const g = makeGrid({ id: "t", lat0: 19, lng0: 82, dLat: 0.001, dLng: 0.001, width: 3, height: 3, source: "copernicus", attribution: "credit" },
        Float32Array.from([0, 1, 2, 10, 11, 12, 20, NaN, 22]));
    assert.equal(sample(g, 19, 82), 0);
    assert.equal(sample(g, 18.999, 82.001), 11);
    assert.ok(Math.abs(sample(g, 18.9995, 82.0005) - 5.5) < 1e-9, "midway between four centres");
    assert.equal(sample(g, 18.9985, 82.0005), 11, "beside the void: the nearest valid of the four");
    assert.equal(sample(g, 19.0001, 82), null);
    assert.equal(sample(g, 18.99, 82), null);
    const st = createDemStore({ grids: [g], log: () => {} });
    assert.equal(st.heightAt(18.9995, 82.00049), 5.5);
    assert.equal(st.heightAt(12.9, 77.6), null);
    assert.equal(st.heightAt(NaN, 82), null);
});

test("API: POST /api/elevation answers heights or null, with the source's credit; bad requests refused", () => {
    const g = makeGrid({ id: "t", lat0: 19, lng0: 82, dLat: 0.5, dLng: 0.5, width: 3, height: 3, source: "copernicus", sourceName: "Copernicus DEM GLO-30", attribution: "Copernicus credit" },
        Float32Array.from([1, 2, 3, 4, 5, 6, 7, 8, 9]));
    const st = createDemStore({ grids: [g], log: () => {} });
    const call = (body) => { const r = { code: 200, headers: {}, body: null, status(c) { r.code = c; return r; }, json(b) { r.body = b; return r; }, setHeader(k, v) { r.headers[k] = v; } }; st.handler({ body }, r); return r; };
    const ok = call({ lat: [18.5, 12, 18], lng: [82.5, 77, 83] });
    assert.deepEqual(ok.body.elevation, [5, null, 9]);
    assert.equal(ok.body.source, "copernicus");
    assert.equal(ok.body.resolutionM, 30);
    assert.deepEqual(ok.body.attribution, ["Copernicus credit"]);
    assert.deepEqual(call({ lat: [12], lng: [77] }).body.attribution, [], "no heights: no credit needed");
    assert.equal(call({ lat: [1], lng: [] }).code, 400);
    assert.equal(call({}).code, 400);
    assert.equal(call({ lat: Array(1001).fill(18), lng: Array(1001).fill(82) }).code, 413);
    assert.deepEqual(call({ lat: ["18.5", 95], lng: [82.5, 82] }).body.elevation, [null, null], "not numbers / not on Earth");
    const cov = { body: null, json(b) { cov.body = b; }, setHeader() { } };
    st.coverageHandler({}, cov);
    assert.deepEqual(cov.body.corridors[0].bbox, { n: 19, s: 18, w: 82, e: 83 });
});

test("store: loads <id>.json + <id>.f32 from a directory, skips broken ones", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mu-dem-"));
    try {
        fs.writeFileSync(path.join(dir, "a.json"), JSON.stringify({ lat0: 19, lng0: 82, dLat: 1, dLng: 1, width: 2, height: 2, source: "nasadem" }));
        fs.writeFileSync(path.join(dir, "a.f32"), Buffer.from(Float32Array.from([1, 2, 3, 4]).buffer));
        fs.writeFileSync(path.join(dir, "bad.json"), JSON.stringify({ lat0: 19, lng0: 82, dLat: 1, dLng: 1, width: 5, height: 5 }));
        fs.writeFileSync(path.join(dir, "bad.f32"), Buffer.alloc(8));
        fs.writeFileSync(path.join(dir, "notes.json"), "{}");
        const logs = [];
        const st = createDemStore({ dir, log: (m) => logs.push(m) });
        assert.equal(st.size, 1);
        assert.equal(st.heightAt(18.5, 82.5), 2.5);
        assert.ok(logs.some((l) => /bad skipped/.test(l)));
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

const GRIDS = path.join(ROOT, "data/elevation/grids");
const ingested = fs.existsSync(path.join(GRIDS, "koraput-araku.f32"));
test("real data (after scripts/elevation-ingest.mjs): Copernicus GLO-30 heights on the pilot corridors", { skip: !ingested && "run scripts/elevation-ingest.mjs first" }, () => {
    const st = createDemStore({ dir: GRIDS, log: () => {} });
    const meta = JSON.parse(fs.readFileSync(path.join(GRIDS, "koraput-araku.json"), "utf8"));
    assert.equal(meta.resolutionM, 30);
    assert.ok(meta.dLat > 0.000277 && meta.dLat < 0.000278, "1 arc-second");
    // plausible, not exact (the DEM is the surface: trees and roofs included): Koraput town is on a ~870 m plateau,
    // Jeypore lower, Rourkela on the plain
    const koraput = st.heightAt(18.811, 82.711), jeypore = st.heightAt(18.856, 82.571), rourkela = st.heightAt(22.25, 84.85);
    assert.ok(koraput > 820 && koraput < 940, `Koraput ${koraput}`);
    assert.ok(jeypore > 550 && jeypore < 650, `Jeypore ${jeypore}`);
    assert.ok(rourkela > 180 && rourkela < 260, `Rourkela ${rourkela}`);
    assert.equal(st.heightAt(20.5, 84), null, "between the corridors: no data, not a guess");
});

test("registry and wiring: ESA / NASA sources listed with their credit, no Open-Meteo elevation left, grids not committed", () => {
    const reg = JSON.parse(fs.readFileSync(path.join(ROOT, "data/sources.json"), "utf8"));
    const cop = reg.sources.find((s) => s.id === "copernicus-dem-glo30"), nasa = reg.sources.find((s) => s.id === "nasadem");
    assert.ok(cop && nasa);
    assert.equal(cop.commercial_use, "yes");
    assert.equal(cop.attribution, SOURCES.copernicus.attribution, "the credit the server sends is the registered one");
    assert.equal(nasa.attribution, SOURCES.nasadem.attribution);
    assert.ok(cop.hosts.includes("copernicus-dem-30m.s3.amazonaws.com"));
    assert.ok(!/elevation/i.test(reg.sources.find((s) => s.id === "open-meteo").use));
    assert.ok(!fs.readFileSync(path.join(ROOT, "public/js/trip/elevation.js"), "utf8").includes("open-meteo"));
    assert.match(fs.readFileSync(path.join(ROOT, ".gitignore"), "utf8"), /^data\/elevation\/grids\/$/m);
    const server = fs.readFileSync(path.join(ROOT, "server.js"), "utf8");
    assert.match(server, /app\.post\("\/api\/elevation", elevationLimiter, express\.json\(\{ limit: "64kb" \}\), dem\.handler\)/);
    assert.ok(server.indexOf('app.post("/api/elevation"') < server.indexOf("app.use(httpLimiter)"));
});
