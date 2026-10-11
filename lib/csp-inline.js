// CSP hashes for the inline blocks the page can't avoid: the import map that lets the
// Master AI avatar's module say `import * as THREE from "three"`. An import map has to
// be inline, and script-src has no 'unsafe-inline', so the exact text is allowed by its
// SHA-256 instead. Computed from the page itself at start-up, so editing the map in
// index.html can't silently break it.
"use strict";
const crypto = require("crypto");

const IMPORT_MAP_RE = /<script\s+type=["']importmap["']\s*>([\s\S]*?)<\/script>/gi;

/**
 * @param {string} html the page
 * @returns {string[]} CSP source expressions, e.g. "'sha256-…'", one per import map block
 */
function importMapHashes(html) {
    const out = [];
    for (const m of String(html || "").matchAll(IMPORT_MAP_RE)) {
        out.push(`'sha256-${crypto.createHash("sha256").update(m[1], "utf8").digest("base64")}'`);
    }
    return out;
}

module.exports = { importMapHashes };
