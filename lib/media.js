"use strict";

/* ============================================================================
   MapUnite media store — lib/media.js
   ==============================================================================
   Memory photos and chat attachments used to live as base64 data-URLs inside
   SQLite (and inside every broadcast). Now:
     - the browser still uploads a data-URL over the socket (no new upload
       endpoint, works through the same offline queue),
     - the server decodes it, CHECKS THE FILE'S MAGIC BYTES against the type
       it claims (a renamed .html can't pass as a JPEG), and writes it to
       MEDIA_DIR/<kind>/<uuid>.<ext> atomically (temp file + rename),
     - SQLite keeps only the relative path ("memories/<uuid>.jpg"),
     - clients get a URL (/media/memories/<uuid>.jpg) served with nosniff, a
       sandboxing CSP, long immutable caching and — for documents — as a
       download, never rendered inline.
   File names are random UUIDs, so a URL can't be guessed.
   ============================================================================ */

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

// mime -> { ext, sniff(buf) } ; sniff returns true when the bytes match.
const has = (buf, bytes, at = 0) => bytes.every((b, i) => buf[at + i] === b);
const ascii = (buf, s, at = 0) => buf.length >= at + s.length && buf.toString("latin1", at, at + s.length) === s;
const ftypBrand = (buf) => (ascii(buf, "ftyp", 4) ? buf.toString("latin1", 8, 12) : null);

const TYPES = {
    "image/jpeg": { ext: "jpg", sniff: (b) => has(b, [0xff, 0xd8, 0xff]) },
    "image/png": { ext: "png", sniff: (b) => has(b, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]) },
    "image/webp": { ext: "webp", sniff: (b) => ascii(b, "RIFF") && ascii(b, "WEBP", 8) },
    "image/gif": { ext: "gif", sniff: (b) => ascii(b, "GIF87a") || ascii(b, "GIF89a") },
    "image/heic": { ext: "heic", sniff: (b) => /^(heic|heix|hevc|hevx|mif1|msf1)$/.test(ftypBrand(b) || "") },
    "image/heif": { ext: "heif", sniff: (b) => /^(heic|heix|hevc|hevx|mif1|msf1)$/.test(ftypBrand(b) || "") },
    "video/mp4": { ext: "mp4", sniff: (b) => Boolean(ftypBrand(b)) },
    "video/quicktime": { ext: "mov", sniff: (b) => Boolean(ftypBrand(b)) || ascii(b, "moov", 4) || ascii(b, "wide", 4) },
    "video/webm": { ext: "webm", sniff: (b) => has(b, [0x1a, 0x45, 0xdf, 0xa3]) },
    "video/3gpp": { ext: "3gp", sniff: (b) => Boolean(ftypBrand(b)) },
    "audio/webm": { ext: "weba", sniff: (b) => has(b, [0x1a, 0x45, 0xdf, 0xa3]) },
    "audio/ogg": { ext: "ogg", sniff: (b) => ascii(b, "OggS") },
    "audio/mpeg": { ext: "mp3", sniff: (b) => ascii(b, "ID3") || (b[0] === 0xff && (b[1] & 0xe0) === 0xe0) },
    "audio/mp4": { ext: "m4a", sniff: (b) => Boolean(ftypBrand(b)) },
    "audio/x-m4a": { ext: "m4a", sniff: (b) => Boolean(ftypBrand(b)) },
    "audio/aac": { ext: "aac", sniff: (b) => b[0] === 0xff && (b[1] & 0xf6) === 0xf0 },
    "audio/wav": { ext: "wav", sniff: (b) => ascii(b, "RIFF") && ascii(b, "WAVE", 8) },
    "audio/x-wav": { ext: "wav", sniff: (b) => ascii(b, "RIFF") && ascii(b, "WAVE", 8) },
    "application/pdf": { ext: "pdf", sniff: (b) => ascii(b, "%PDF-") },
    "application/zip": { ext: "zip", sniff: (b) => has(b, [0x50, 0x4b, 0x03, 0x04]) || has(b, [0x50, 0x4b, 0x05, 0x06]) },
    "application/x-zip-compressed": { ext: "zip", sniff: (b) => has(b, [0x50, 0x4b, 0x03, 0x04]) || has(b, [0x50, 0x4b, 0x05, 0x06]) },
    "application/msword": { ext: "doc", sniff: (b) => has(b, [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]) },
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document": { ext: "docx", sniff: (b) => has(b, [0x50, 0x4b, 0x03, 0x04]) },
    // Plain text: no magic bytes. Accept only if it decodes as UTF-8 with no NUL bytes
    // (and it's served as text/plain + attachment, so it can never execute).
    "text/plain": { ext: "txt", sniff: (b) => !b.includes(0) && Buffer.from(b.toString("utf8"), "utf8").equals(b) }
};

const KIND_TYPES = {
    memories: ["image/jpeg", "image/png", "image/webp", "image/gif", "image/heic", "image/heif"],
    "chat-image": ["image/jpeg", "image/png", "image/webp", "image/gif", "image/heic", "image/heif"],
    "chat-video": ["video/mp4", "video/quicktime", "video/webm", "video/3gpp"],
    "chat-audio": ["audio/webm", "audio/ogg", "audio/mpeg", "audio/mp4", "audio/x-m4a", "audio/aac", "audio/wav", "audio/x-wav"],
    "chat-document": ["application/pdf", "application/zip", "application/x-zip-compressed", "application/msword",
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document", "text/plain"]
};

const EXT_MIME = {
    jpg: "image/jpeg", png: "image/png", webp: "image/webp", gif: "image/gif", heic: "image/heic", heif: "image/heif",
    mp4: "video/mp4", mov: "video/quicktime", webm: "video/webm", "3gp": "video/3gpp",
    weba: "audio/webm", ogg: "audio/ogg", mp3: "audio/mpeg", m4a: "audio/mp4", aac: "audio/aac", wav: "audio/wav",
    pdf: "application/pdf", zip: "application/zip", doc: "application/msword",
    docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", txt: "text/plain; charset=utf-8"
};
const INLINE_EXT = new Set(["jpg", "png", "webp", "gif", "heic", "heif", "mp4", "mov", "webm", "3gp", "weba", "ogg", "mp3", "m4a", "aac", "wav"]);
const DIRS = ["memories", "chat"];
const FILE_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(jpg|png|webp|gif|heic|heif|mp4|mov|webm|3gp|weba|ogg|mp3|m4a|aac|wav|pdf|zip|doc|docx|txt)$/;
const REF_RE = new RegExp(`^(${DIRS.join("|")})/${FILE_RE.source.slice(1, -1)}$`);
const DATA_URL_RE = /^data:([a-z0-9.+-]+\/[a-z0-9.+-]+)(;[a-z0-9=._+-]+)*;base64,/i;

class MediaStore {
    constructor(root) {
        this.root = path.resolve(root);
        for (const d of DIRS) fs.mkdirSync(path.join(this.root, d), { recursive: true });
    }

    static isRef(v) { return typeof v === "string" && REF_RE.test(v); }
    static url(ref) { return MediaStore.isRef(ref) ? `/media/${ref}` : null; }

    // Decode + verify + write. `kind` is a key of KIND_TYPES; `dir` is
    // "memories" or "chat". Returns {ok, ref, mime, bytes} or {ok:false, reason}.
    saveDataUrl(dataUrl, kind, dir, maxBytes) {
        if (typeof dataUrl !== "string") return { ok: false, reason: "not-a-data-url" };
        const m = DATA_URL_RE.exec(dataUrl.slice(0, 200));
        if (!m) return { ok: false, reason: "not-a-data-url" };
        let mime = m[1].toLowerCase();
        if (mime === "image/jpg") mime = "image/jpeg";
        if (mime === "audio/mp3") mime = "audio/mpeg";
        if (mime === "video/x-m4v") mime = "video/mp4";
        const allowed = KIND_TYPES[kind] || [];
        const b64 = dataUrl.slice(dataUrl.indexOf(",") + 1);
        if (!/^[A-Za-z0-9+/\r\n]*={0,2}\s*$/.test(b64.slice(-64)) || b64.length === 0) return { ok: false, reason: "bad-base64" };
        const buf = Buffer.from(b64, "base64");
        if (buf.length === 0) return { ok: false, reason: "empty" };
        if (buf.length > maxBytes) return { ok: false, reason: "too-large" };
        let type = allowed.includes(mime) ? TYPES[mime] : null;
        // Browsers sometimes label files generically (application/octet-stream,
        // or an empty type for .heic): accept if the bytes match an allowed type.
        if (!type || !type.sniff(buf)) {
            const sniffed = allowed.find((t) => t !== "text/plain" && TYPES[t].sniff(buf));
            if (!sniffed) return { ok: false, reason: "type-mismatch" };
            mime = sniffed;
            type = TYPES[sniffed];
        }
        const name = `${crypto.randomUUID()}.${type.ext}`;
        const ref = `${dir}/${name}`;
        const final = path.join(this.root, dir, name);
        const tmp = `${final}.${process.pid}.tmp`;
        fs.writeFileSync(tmp, buf, { flag: "wx" });
        fs.renameSync(tmp, final);
        return { ok: true, ref, mime, bytes: buf.length };
    }

    remove(ref) {
        if (!MediaStore.isRef(ref)) return false;
        try { fs.unlinkSync(path.join(this.root, ref)); return true; } catch { return false; }
    }

    exists(ref) { return MediaStore.isRef(ref) && fs.existsSync(path.join(this.root, ref)); }

    // Express handler for GET /media/:dir/:file
    handler() {
        return (req, res) => {
            const { dir, file } = req.params;
            if (!DIRS.includes(dir) || !FILE_RE.test(file || "")) return res.status(404).end();
            const full = path.join(this.root, dir, file);
            fs.stat(full, (err, st) => {
                if (err || !st.isFile()) return res.status(404).end();
                const ext = file.slice(file.lastIndexOf(".") + 1);
                res.setHeader("Content-Type", EXT_MIME[ext] || "application/octet-stream");
                res.setHeader("X-Content-Type-Options", "nosniff");
                res.setHeader("Content-Security-Policy", "default-src 'none'; img-src 'self'; media-src 'self'; sandbox");
                res.setHeader("Cross-Origin-Resource-Policy", "same-origin");
                res.setHeader("Cache-Control", "private, max-age=31536000, immutable");
                res.setHeader("Content-Disposition", INLINE_EXT.has(ext) ? "inline" : "attachment");
                res.setHeader("Accept-Ranges", "bytes");
                // Byte ranges: Safari won't play <video>/<audio> without them.
                let start = 0, end = st.size - 1;
                const range = typeof req.headers.range === "string" ? /^bytes=(\d*)-(\d*)$/.exec(req.headers.range.trim()) : null;
                if (range && (range[1] !== "" || range[2] !== "")) {
                    if (range[1] === "") { start = Math.max(0, st.size - Number(range[2])); }
                    else { start = Number(range[1]); if (range[2] !== "") end = Math.min(end, Number(range[2])); }
                    if (start > end || start >= st.size) {
                        res.setHeader("Content-Range", `bytes */${st.size}`);
                        return res.status(416).end();
                    }
                    res.status(206);
                    res.setHeader("Content-Range", `bytes ${start}-${end}/${st.size}`);
                }
                res.setHeader("Content-Length", end - start + 1);
                if (req.method === "HEAD") return res.end();
                if (st.size === 0) return res.end();
                fs.createReadStream(full, { start, end }).on("error", () => res.destroy()).pipe(res);
            });
        };
    }
}

module.exports = { MediaStore, KIND_TYPES, TYPES };
