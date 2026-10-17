// @ts-check
"use strict";
/* ============================================================================
   MapUnite elevation — a small GeoTIFF reader (no dependencies)
   ==============================================================================
   Reads the full-resolution image (the first IFD) of a single-band elevation
   GeoTIFF, which is all the DEM pilot needs:
     - classic TIFF (not BigTIFF), little- or big-endian;
     - tiled or stripped;
     - compression none (1), LZW (5) or DEFLATE (8, 32946);
     - predictor none (1), horizontal (2) or floating point (3);
     - 32-bit float, 16-bit or 32-bit signed integer samples;
     - georeferencing from ModelPixelScale + ModelTiepoint, the raster type
       (PixelIsArea / PixelIsPoint) from the GeoKey directory, and GDAL_NODATA.
   Copernicus GLO-30 tiles (Cloud-Optimized GeoTIFF: tiled, DEFLATE, float
   predictor, Float32) are read this way. NASADEM / SRTM .hgt files are raw
   big-endian Int16 and are read by readHgt().

   Coordinates: grid(row, col) is the CENTRE of pixel (row, col); centre(0, 0)
   is { lat: lat0, lng: lng0 }, rows go south by dLat, columns east by dLng.
   ============================================================================ */

const zlib = require("node:zlib");

const TAG = Object.freeze({
    width: 256, height: 257, bits: 258, compression: 259, stripOffsets: 273, samplesPerPixel: 277, rowsPerStrip: 278,
    stripByteCounts: 279, planar: 284, predictor: 317, tileWidth: 322, tileHeight: 323, tileOffsets: 324, tileByteCounts: 325,
    sampleFormat: 339, pixelScale: 33550, tiepoint: 33922, geoKeys: 34735, gdalNodata: 42113
});
const TYPE_SIZE = { 1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 6: 1, 7: 1, 8: 2, 9: 4, 10: 8, 11: 4, 12: 8, 16: 8 };

/**
 * @param {Buffer} buf
 * @returns {{ width: number, height: number, data: Float32Array, nodata: number|null, lat0: number, lng0: number, dLat: number, dLng: number }}
 */
function readGeoTiff(buf) {
    const order = buf.toString("latin1", 0, 2);
    if (order !== "II" && order !== "MM") throw new Error("not a TIFF");
    const le = order === "II";
    const u16 = (o) => (le ? buf.readUInt16LE(o) : buf.readUInt16BE(o));
    const u32 = (o) => (le ? buf.readUInt32LE(o) : buf.readUInt32BE(o));
    const magic = u16(2);
    if (magic === 43) throw new Error("BigTIFF is not supported");
    if (magic !== 42) throw new Error("not a TIFF");
    const ifd = u32(4);
    const n = u16(ifd);
    /** @type {Record<number, number[]|string>} */ const tags = {};
    for (let i = 0; i < n; i++) {
        const e = ifd + 2 + i * 12;
        const tag = u16(e), type = u16(e + 2), count = u32(e + 4);
        const size = (TYPE_SIZE[/** @type {keyof typeof TYPE_SIZE} */ (type)] || 1) * count;
        const at = size <= 4 ? e + 8 : u32(e + 8);
        if (type === 2) { tags[tag] = buf.toString("latin1", at, at + count).replace(/\0+$/, ""); continue; }
        const vals = [];
        for (let k = 0; k < count; k++) {
            if (type === 3) vals.push(u16(at + k * 2));
            else if (type === 4) vals.push(u32(at + k * 4));
            else if (type === 8) vals.push(le ? buf.readInt16LE(at + k * 2) : buf.readInt16BE(at + k * 2));
            else if (type === 9) vals.push(le ? buf.readInt32LE(at + k * 4) : buf.readInt32BE(at + k * 4));
            else if (type === 11) vals.push(le ? buf.readFloatLE(at + k * 4) : buf.readFloatBE(at + k * 4));
            else if (type === 12) vals.push(le ? buf.readDoubleLE(at + k * 8) : buf.readDoubleBE(at + k * 8));
            else if (type === 1 || type === 7) vals.push(buf[at + k]);
            else if (type === 16) vals.push(Number(le ? buf.readBigUInt64LE(at + k * 8) : buf.readBigUInt64BE(at + k * 8)));
        }
        tags[tag] = vals;
    }
    const num = (t, d) => (Array.isArray(tags[t]) ? /** @type {number[]} */ (tags[t])[0] : d);
    const arr = (t) => (Array.isArray(tags[t]) ? /** @type {number[]} */ (tags[t]) : null);

    const width = num(TAG.width), height = num(TAG.height);
    const bits = num(TAG.bits, 1), fmt = num(TAG.sampleFormat, 1), compression = num(TAG.compression, 1), predictor = num(TAG.predictor, 1);
    if (num(TAG.samplesPerPixel, 1) !== 1) throw new Error("only single-band rasters are supported");
    const kind = fmt === 3 && bits === 32 ? "f32" : fmt === 2 && bits === 16 ? "i16" : fmt === 2 && bits === 32 ? "i32" : fmt === 1 && bits === 16 ? "u16" : null;
    if (!kind) throw new Error(`unsupported samples: format ${fmt}, ${bits} bits`);
    const bps = bits / 8;

    const tiled = Boolean(arr(TAG.tileOffsets));
    const bw = tiled ? num(TAG.tileWidth) : width;
    const bh = tiled ? num(TAG.tileHeight) : num(TAG.rowsPerStrip, height);
    const offsets = /** @type {number[]} */ (tiled ? arr(TAG.tileOffsets) : arr(TAG.stripOffsets));
    const counts = /** @type {number[]} */ (tiled ? arr(TAG.tileByteCounts) : arr(TAG.stripByteCounts));
    if (!offsets || !counts) throw new Error("no image data");
    const across = Math.ceil(width / bw);

    const data = new Float32Array(width * height);
    for (let b = 0; b < offsets.length; b++) {
        const bx = (b % across) * bw, by = Math.floor(b / across) * bh;
        if (by >= height) break;
        const rows = tiled ? bh : Math.min(bh, height - by);
        let raw = buf.subarray(offsets[b], offsets[b] + counts[b]);
        if (compression === 8 || compression === 32946) raw = zlib.inflateSync(raw);
        else if (compression === 5) raw = lzwDecode(raw, bw * rows * bps);
        else if (compression !== 1) throw new Error(`unsupported compression ${compression}`);
        const block = Buffer.from(raw);                        // writable copy for the predictor
        if (predictor === 2) undoHorizontal(block, bw, rows, bps, le);
        else if (predictor === 3) undoFloat(block, bw, rows, bps, le);
        const rd = predictor === 3
            ? (/** @type {number} */ i) => block.readFloatBE(i * 4)          // the float predictor leaves bytes big-endian
            : kind === "f32" ? (/** @type {number} */ i) => (le ? block.readFloatLE(i * 4) : block.readFloatBE(i * 4))
            : kind === "i16" ? (/** @type {number} */ i) => (le ? block.readInt16LE(i * 2) : block.readInt16BE(i * 2))
            : kind === "u16" ? (/** @type {number} */ i) => (le ? block.readUInt16LE(i * 2) : block.readUInt16BE(i * 2))
            : (/** @type {number} */ i) => (le ? block.readInt32LE(i * 4) : block.readInt32BE(i * 4));
        for (let r = 0; r < rows && by + r < height; r++) {
            for (let c = 0; c < bw && bx + c < width; c++) data[(by + r) * width + bx + c] = rd(r * bw + c);
        }
    }

    const scale = arr(TAG.pixelScale), tie = arr(TAG.tiepoint);
    if (!scale || !tie) throw new Error("no georeferencing (ModelPixelScale / ModelTiepoint)");
    const [ti, tj, , tx, ty] = tie;
    const dLng = scale[0], dLat = scale[1];
    // GeoKey 1025 GTRasterTypeGeoKey: 1 PixelIsArea (the tiepoint is a pixel's corner), 2 PixelIsPoint (its centre)
    let pixelIsPoint = false;
    const gk = arr(TAG.geoKeys);
    if (gk) for (let k = 4; k + 3 < gk.length; k += 4) if (gk[k] === 1025 && gk[k + 1] === 0) pixelIsPoint = gk[k + 3] === 2;
    const half = pixelIsPoint ? 0 : 0.5;
    const lng0 = tx + (0 - ti + half) * dLng, lat0 = ty - (0 - tj + half) * dLat;
    const nd = typeof tags[TAG.gdalNodata] === "string" ? Number(tags[TAG.gdalNodata]) : NaN;
    return { width, height, data, nodata: Number.isFinite(nd) ? nd : null, lat0, lng0, dLat, dLng };
}

/** Undo TIFF predictor 2 (horizontal differencing of samples), in place. */
function undoHorizontal(b, w, rows, bps, le) {
    for (let r = 0; r < rows; r++) {
        const o = r * w * bps;
        for (let c = 1; c < w; c++) {
            const i = o + c * bps, p = i - bps;
            if (bps === 2) {
                const v = ((le ? b.readUInt16LE(i) : b.readUInt16BE(i)) + (le ? b.readUInt16LE(p) : b.readUInt16BE(p))) & 0xffff;
                if (le) b.writeUInt16LE(v, i); else b.writeUInt16BE(v, i);
            } else if (bps === 4) {
                const v = ((le ? b.readUInt32LE(i) : b.readUInt32BE(i)) + (le ? b.readUInt32LE(p) : b.readUInt32BE(p))) >>> 0;
                if (le) b.writeUInt32LE(v, i); else b.writeUInt32BE(v, i);
            } else b[i] = (b[i] + b[p]) & 0xff;
        }
    }
}

/**
 * Undo TIFF predictor 3 (floating point), in place: byte-wise differencing across the row, then the bytes of each
 * sample are regrouped from planes (most significant first). Afterwards each sample is big-endian.
 */
function undoFloat(b, w, rows, bps, _le) {
    const rowLen = w * bps;
    const tmp = Buffer.alloc(rowLen);
    for (let r = 0; r < rows; r++) {
        const o = r * rowLen;
        for (let i = 1; i < rowLen; i++) b[o + i] = (b[o + i] + b[o + i - 1]) & 0xff;
        b.copy(tmp, 0, o, o + rowLen);
        for (let c = 0; c < w; c++) for (let k = 0; k < bps; k++) b[o + c * bps + k] = tmp[k * w + c];
    }
}

/** TIFF LZW (MSB-first codes, early change). */
function lzwDecode(input, expected) {
    const out = Buffer.alloc(expected);
    let op = 0, bitPos = 0, codeLen = 9;
    /** @type {Array<Buffer|null>} */ let dict = [];
    const reset = () => { dict = []; for (let i = 0; i < 256; i++) dict[i] = Buffer.from([i]); dict[256] = null; dict[257] = null; codeLen = 9; };
    const read = () => {
        let v = 0;
        for (let i = 0; i < codeLen; i++) {
            const byte = input[(bitPos + i) >> 3];
            if (byte === undefined) return 257;
            v = (v << 1) | ((byte >> (7 - ((bitPos + i) & 7))) & 1);
        }
        bitPos += codeLen;
        return v;
    };
    reset();
    let prev = null;
    for (;;) {
        const code = read();
        if (code === 257) break;
        if (code === 256) { reset(); prev = null; continue; }
        let entry;
        if (code < dict.length && dict[code]) entry = /** @type {Buffer} */ (dict[code]);
        else if (prev) entry = Buffer.concat([prev, prev.subarray(0, 1)]);
        else break;
        const n = Math.min(entry.length, expected - op);
        entry.copy(out, op, 0, n);
        op += n;
        if (prev) dict.push(Buffer.concat([prev, entry.subarray(0, 1)]));
        prev = entry;
        if (dict.length + 1 >= 1 << codeLen && codeLen < 12) codeLen++;
        if (op >= expected) break;
    }
    return out;
}

/**
 * NASADEM / SRTM .hgt: big-endian Int16, square (3601 × 3601 at 1″), named after its south-west corner
 * ("N18E082.hgt"); pixel centres on whole arc-seconds, the first row on the tile's north edge. Void: -32768.
 * @param {Buffer} buf @param {string} name
 */
function readHgt(buf, name) {
    const m = /([NS])(\d{2})([EW])(\d{3})/i.exec(name);
    if (!m) throw new Error(`can't tell the tile from the name "${name}"`);
    const side = Math.round(Math.sqrt(buf.length / 2));
    if (side * side * 2 !== buf.length) throw new Error("not a square .hgt");
    const lat = (m[1].toUpperCase() === "S" ? -1 : 1) * Number(m[2]), lng = (m[3].toUpperCase() === "W" ? -1 : 1) * Number(m[4]);
    const data = new Float32Array(side * side);
    for (let i = 0; i < side * side; i++) data[i] = buf.readInt16BE(i * 2);
    const step = 1 / (side - 1);
    return { width: side, height: side, data, nodata: -32768, lat0: lat + 1, lng0: lng, dLat: step, dLng: step };
}

module.exports = { readGeoTiff, readHgt, undoFloat, undoHorizontal, lzwDecode };
