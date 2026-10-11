#!/usr/bin/env node
/*
 * Are all MapUnite batches in this checkout?
 *
 *   node scripts/check-batches.mjs
 *
 * Compares the repo with scripts/batch-manifest.json (the latest version of
 * every file each delivered batch contained), then checks that every script
 * and stylesheet the pages load, and every file sw.js precaches, exists.
 *
 *   MISSING   in a batch, not in this checkout        → copy it in (exit 1)
 *   CHANGED   different from the latest batch version → your own edit, or an older
 *             version; look at `git diff` after copying the batch version
 *   BROKEN    a page or sw.js references a file that isn't there (exit 1);
 *             the website serves index.html for it, which is the
 *             "MIME type ('text/html') is not executable" error in the browser
 *
 * Line endings don't count (CRLF and LF hash the same), so a Windows checkout
 * isn't reported as changed.
 *
 * Maintainers: `node scripts/check-batches.mjs --generate <batch-name>` rewrites
 * the manifest from the current tree (for the files already listed, plus any given
 * with --add path …).
 */
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const MANIFEST = path.join(ROOT, "scripts/batch-manifest.json");
const TEXT = /\.(js|mjs|cjs|json|html|css|md|txt|kt|java|xml|svg|ts|yml|yaml|csv|jsonl|sql|sh)$/i;

/** sha256 of a file, with CRLF → LF for text files. */
export function hashFile(abs) {
    let buf = fs.readFileSync(abs);
    if (TEXT.test(abs)) buf = Buffer.from(buf.toString("utf8").replace(/\r\n/g, "\n"), "utf8");
    return crypto.createHash("sha256").update(buf).digest("hex");
}

/** Local scripts / stylesheets a page loads (same rules as the precache test). */
export function pageRefs(html) {
    return [...html.matchAll(/<(?:script[^>]*\ssrc|link[^>]*rel="stylesheet"[^>]*\shref)="([^"]+)"/g)]
        .map((m) => m[1])
        .filter((u) => !/^(https?:)?\/\//.test(u) && !u.startsWith("/socket.io/") && !u.startsWith("vendor/"))   // vendor/: added by the Android build
        .map((u) => "/" + u.replace(/^\.?\//, "").split("?")[0]);
}

function precacheList() {
    const f = path.join(ROOT, "public/sw.js");
    if (!fs.existsSync(f)) return [];
    try {
        const ctx = vm.createContext({ self: { addEventListener() {}, location: { origin: "https://x" } }, caches: {}, fetch() {}, URL, Request: class {}, Response: class {}, console });
        vm.runInContext(fs.readFileSync(f, "utf8"), ctx);
        return vm.runInContext("[...REQUIRED_PRECACHE]", ctx).filter((u) => typeof u === "string" && u.startsWith("/") && !u.endsWith("/") && u !== "/config.js");
    } catch { return []; }
}

export function check(root = ROOT) {
    const man = JSON.parse(fs.readFileSync(path.join(root, "scripts/batch-manifest.json"), "utf8"));
    const missing = [], changed = [], broken = [];
    for (const [rel, info] of Object.entries(man.files)) {
        const abs = path.join(root, rel);
        if (!fs.existsSync(abs)) missing.push({ rel, batch: info.batch });
        else if (hashFile(abs) !== info.sha256) changed.push({ rel, batch: info.batch });
    }
    const seen = new Set();
    for (const page of ["public/index.html", "public/garage.html", "public/recorder.html"]) {
        const abs = path.join(root, page);
        if (!fs.existsSync(abs)) continue;
        for (const u of pageRefs(fs.readFileSync(abs, "utf8"))) {
            if (u === "/config.js" || seen.has(page + u)) continue;
            seen.add(page + u);
            if (!fs.existsSync(path.join(root, "public", u))) broken.push({ from: page, ref: u });
        }
    }
    for (const u of precacheList()) if (!fs.existsSync(path.join(root, "public", u))) broken.push({ from: "public/sw.js (precache)", ref: u });
    return { man, missing, changed, broken };
}

function generate(batch, add) {
    const man = fs.existsSync(MANIFEST) ? JSON.parse(fs.readFileSync(MANIFEST, "utf8")) : { files: {} };
    const files = {};
    for (const rel of [...Object.keys(man.files), ...add].sort()) {
        const abs = path.join(ROOT, rel);
        if (!fs.existsSync(abs)) continue;
        const sha256 = hashFile(abs);
        const prev = man.files[rel];
        files[rel] = { sha256, batch: prev && prev.sha256 === sha256 ? prev.batch : batch };
    }
    fs.writeFileSync(MANIFEST, JSON.stringify({ generatedAt: new Date().toISOString(), latestBatch: batch, files }, null, 1) + "\n");
    console.log(`check-batches: manifest has ${Object.keys(files).length} files`);
}

function main() {
    const gi = process.argv.indexOf("--generate");
    if (gi > 0) {
        const ai = process.argv.indexOf("--add");
        return generate(process.argv[gi + 1] || "unnamed", ai > 0 ? process.argv.slice(ai + 1) : []);
    }
    const { man, missing, changed, broken } = check();
    const byBatch = (list) => {
        const m = new Map();
        for (const x of list) m.set(x.batch, [...(m.get(x.batch) || []), x.rel]);
        return m;
    };
    console.log(`check-batches: ${Object.keys(man.files).length} files from the delivered batches (latest: ${man.latestBatch})`);
    if (missing.length) {
        console.log(`\nMISSING (${missing.length}): copy these from the latest batch zip`);
        for (const [b, list] of byBatch(missing)) { console.log(`  last changed in ${b}:`); for (const r of list) console.log(`    ${r}`); }
    }
    if (changed.length) {
        console.log(`\nCHANGED (${changed.length}): differ from the latest batch version (your edit, or an older copy)`);
        for (const [b, list] of byBatch(changed)) { console.log(`  last changed in ${b}:`); for (const r of list) console.log(`    ${r}`); }
    }
    if (broken.length) {
        console.log(`\nBROKEN (${broken.length}): referenced but not on disk (served as text/html → MIME errors)`);
        for (const x of broken) console.log(`  ${x.from} → ${x.ref}`);
    }
    if (!missing.length && !changed.length && !broken.length) console.log("✓ every batch file is present and current; every page reference exists");
    process.exit(missing.length || broken.length ? 1 : 0);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
