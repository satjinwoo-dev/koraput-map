#!/usr/bin/env node
/*
 * Canonical formatting for data/bikes/**.json — one value per line, so a spec
 * change is a one-line diff in review:
 *
 *     "peakTorque": { "v": 27, "u": "N*m", "src": "re-classic-site", "conf": 0.95 },
 *
 * Objects and arrays made only of primitives (and short arrays of numbers) stay
 * on one line; everything else is indented by 2. Key order is preserved.
 *
 *   node scripts/bikedb/format.mjs            # rewrite files in place
 *   node scripts/bikedb/format.mjs --check    # exit 1 if any file isn't canonical
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const DATA = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "data", "bikes");
const LINE_LIMIT = 220;

const isPrim = (x) => x === null || ["string", "number", "boolean"].includes(typeof x);
const isLeaf = (x) => Array.isArray(x) ? x.every(isPrim) : (x && typeof x === "object" && Object.values(x).every((v) => isPrim(v) || (Array.isArray(v) && v.every(isPrim))));

function inline(x) {
    if (isPrim(x)) return JSON.stringify(x);
    if (Array.isArray(x)) return `[${x.map(inline).join(", ")}]`;
    return `{ ${Object.entries(x).map(([k, v]) => `${JSON.stringify(k)}: ${inline(v)}`).join(", ")} }`;
}

export function formatJson(value, indent = "") {
    if (isPrim(value)) return JSON.stringify(value);
    const next = indent + "  ";
    if (isLeaf(value)) {
        const one = inline(value);
        if (one.length + indent.length <= LINE_LIMIT || Array.isArray(value)) return one;
    }
    if (Array.isArray(value)) {
        if (!value.length) return "[]";
        return `[\n${value.map((v) => next + formatJson(v, next)).join(",\n")}\n${indent}]`;
    }
    const entries = Object.entries(value);
    if (!entries.length) return "{}";
    return `{\n${entries.map(([k, v]) => `${next}${JSON.stringify(k)}: ${formatJson(v, next)}`).join(",\n")}\n${indent}}`;
}

function files(dir) {
    return fs.readdirSync(dir, { withFileTypes: true }).flatMap((d) => d.isDirectory() ? files(path.join(dir, d.name)) : d.name.endsWith(".json") ? [path.join(dir, d.name)] : []);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    const check = process.argv.includes("--check");
    const bad = [];
    for (const f of files(DATA)) {
        const raw = fs.readFileSync(f, "utf8");
        const out = formatJson(JSON.parse(raw)) + "\n";
        if (raw !== out) {
            if (check) bad.push(path.relative(process.cwd(), f));
            else fs.writeFileSync(f, out);
        }
    }
    if (check && bad.length) { console.error(`not canonically formatted (run node scripts/bikedb/format.mjs):\n  ${bad.join("\n  ")}`); process.exit(1); }
    console.log(check ? "all bike data files are canonically formatted" : "formatted bike data files");
}
