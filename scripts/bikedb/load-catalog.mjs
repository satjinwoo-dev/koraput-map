// Loads data/bikes (variants, class defaults, reference tables) for the CLI and tests.
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
export const DATA = path.join(ROOT, "data", "bikes");
export const Contract = createRequire(import.meta.url)("../../public/js/bikedb/bundle-contract.js");

function readJson(file) {
    try { return JSON.parse(fs.readFileSync(file, "utf8")); }
    catch (e) { throw new Error(`${path.relative(ROOT, file)}: invalid JSON — ${e.message}`); }
}

export function loadCatalog(dataDir = DATA) {
    const entries = [];
    for (const sub of ["class-defaults", "variants"]) {
        const dir = path.join(dataDir, sub);
        if (!fs.existsSync(dir)) continue;
        for (const f of fs.readdirSync(dir).filter((x) => x.endsWith(".json")).sort()) {
            const file = path.join(dir, f);
            entries.push({ file: path.relative(ROOT, file).split(path.sep).join("/"), bundle: readJson(file) });
        }
    }
    const ref = {
        fuelGrades: readJson(path.join(dataDir, "reference", "fuel-grades.json")),
        emissionStandards: readJson(path.join(dataDir, "reference", "emission-standards.json"))
    };
    return { entries, ref };
}

/**
 * data/bikes/pending/: researched bundles that are NOT in the catalog because a
 * rule blocks them (usually fuel safety: no manufacturer certification yet).
 * They're validated on every run so the blocking reason stays visible, and so a
 * bundle that has become valid gets moved into variants/.
 */
export function loadPending(dataDir = DATA) {
    const dir = path.join(dataDir, "pending");
    if (!fs.existsSync(dir)) return [];
    return fs.readdirSync(dir).filter((x) => x.endsWith(".json")).sort()
        .map((f) => { const file = path.join(dir, f); return { file: path.relative(ROOT, file).split(path.sep).join("/"), bundle: readJson(file) }; });
}
