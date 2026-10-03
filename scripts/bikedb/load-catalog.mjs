// Loads data/bikes (variants, class defaults, reference tables) for the CLI and tests.
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
export const DATA = path.join(ROOT, "data", "bikes");
export const Contract = createRequire(import.meta.url)("../../public/js/bikedb/bundle-contract.js");
import { applyCalibrations } from "./calibration-file.mjs";

function readJson(file) {
    try { return JSON.parse(fs.readFileSync(file, "utf8")); }
    catch (e) { throw new Error(`${path.relative(ROOT, file)}: invalid JSON — ${e.message}`); }
}

/**
 * data/bikes as the build sees it: the bike files, the reference tables, and the
 * reviewed fleet calibrations (data/bikes/calibration/, Step 8) applied to the class
 * defaults' priors. `calibrations` (per class: the real-riding overhead, the evidence)
 * goes into the runtime bundles; `calibrationReport` says what was applied or skipped.
 */
export function loadCatalog(dataDir = DATA, { calibrations = true } = {}) {
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
    // calibrations: false = the curated data alone (what a fleet re-fit starts from, so tanks never count twice)
    const cal = calibrations ? applyCalibrations(entries, dataDir) : { entries, calibrations: new Map(), report: [] };
    return { entries: cal.entries, ref, calibrations: cal.calibrations, calibrationReport: cal.report };
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
