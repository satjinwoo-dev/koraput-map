#!/usr/bin/env node
/*
 * Validates the whole bike database:
 *
 *   node scripts/validate-bikes.mjs            errors only; exit 1 if any
 *   node scripts/validate-bikes.mjs --debt     also list every low-confidence
 *                                              physics input (sourcing debt)
 *   node scripts/validate-bikes.mjs data/bikes/ktm.390-duke.2024.json
 *                                              just these files (+ catalog rules)
 *
 * Checks every file in data/bikes/ and data/class-defaults/ with
 * validateBundle, the two lookup tables in data/lookups/, then the catalog
 * rules across files (unique ids, file name = id, a class default for every
 * powertrain x segment, fuel grades and emission standards that exist).
 */
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const V = createRequire(import.meta.url)(path.join(ROOT, "public/js/bikedb/validate.js"));
const args = process.argv.slice(2);
const showDebt = args.includes("--debt");
const only = args.filter((a) => !a.startsWith("--")).map((f) => path.resolve(f));

const rel = (f) => path.relative(ROOT, f);
const list = (dir) => fs.readdirSync(path.join(ROOT, dir)).filter((f) => f.endsWith(".json")).sort().map((f) => path.join(ROOT, dir, f));
let errors = 0;
let debt = 0;

function readJson(file) {
    try { return JSON.parse(fs.readFileSync(file, "utf8")); }
    catch (e) { console.error(`✗ ${rel(file)}\n    E_JSON  ${e.message}`); errors++; return undefined; }
}
function report(file, res) {
    const lowConf = res.warnings.filter((w) => w.code === "W_LOW_CONFIDENCE");
    const other = res.warnings.filter((w) => w.code !== "W_LOW_CONFIDENCE");
    debt += lowConf.length;
    if (res.errors.length || other.length || (showDebt && lowConf.length)) {
        console.log(`${res.errors.length ? "✗" : "•"} ${file}`);
        for (const e of res.errors) console.log(`    ${e.code}  ${e.path}  ${e.message}`);
        for (const w of other) console.log(`    ${w.code}  ${w.path}  ${w.message}`);
        if (showDebt) for (const w of lowConf) console.log(`    ${w.code}  ${w.path}  ${w.message}`);
    }
    errors += res.errors.length;
}

const bundleFiles = [...list("data/bikes"), ...list("data/class-defaults")];
const bundles = [];
for (const file of bundleFiles) {
    const b = readJson(file);
    if (b === undefined) continue;
    bundles.push({ file: rel(file), bundle: b });
    if (only.length && !only.includes(file)) continue;
    report(rel(file), V.validateBundle(b));
}
const fuelFile = path.join(ROOT, "data/lookups/fuel_grade.json");
const emFile = path.join(ROOT, "data/lookups/emission_standard.json");
const fuelGrades = readJson(fuelFile);
const emissionStandards = readJson(emFile);
if (fuelGrades !== undefined) report(rel(fuelFile), V.validateFuelGrades(fuelGrades));
if (emissionStandards !== undefined) report(rel(emFile), V.validateEmissionStandards(emissionStandards));
report("catalog", V.validateCatalog({ bundles, fuelGrades, emissionStandards }));

const variants = bundles.filter((b) => b.bundle && b.bundle.kind === "variant").length;
console.log(`\n${bundles.length} bundles (${variants} variants, ${bundles.length - variants} class defaults), 2 lookup tables: ` +
    `${errors} error(s), ${debt} low-confidence physics input(s)${showDebt ? "" : " (--debt to list)"}`);
process.exit(errors ? 1 : 0);
