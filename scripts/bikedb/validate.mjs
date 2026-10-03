#!/usr/bin/env node
/*
 * Validates every bike profile in data/bikes against the bundle contract
 * (public/js/bikedb/bundle-contract.js): structure, canonical units, provenance
 * and confidence, physical consistency, fuel-approval safety, class-default
 * coverage, and the reference tables. Bundles in data/bikes/pending/ are not
 * part of the catalog: each must still FAIL (its blocking errors are listed);
 * one that passes is reported so it gets moved into variants/.
 *
 *   node scripts/bikedb/validate.mjs            # all files
 *   node scripts/bikedb/validate.mjs --quiet    # errors only
 *   node scripts/bikedb/validate.mjs --json     # machine-readable report
 * Exit code 1 if any error.
 */
import { loadCatalog, loadPending, Contract } from "./load-catalog.mjs";

const quiet = process.argv.includes("--quiet");
const asJson = process.argv.includes("--json");
let catalog;
try { catalog = loadCatalog(); } catch (e) { console.error(e.message); process.exit(1); }
const report = Contract.validateCatalog(catalog.entries, catalog.ref);

if (asJson) {
    const pendingReport = loadPending().map((p) => ({ file: p.file, result: Contract.validateBundle(p.bundle, catalog.ref) }));
    const ok = report.ok && pendingReport.every((p) => !p.result.ok);
    console.log(JSON.stringify({ ...report, ok, pending: pendingReport }, null, 2));
    process.exit(ok ? 0 : 1);
}
let errors = 0, warnings = 0;
for (const { file, result } of report.perFile) {
    errors += result.errors.length; warnings += result.warnings.length;
    if (result.errors.length || (!quiet && result.warnings.length)) console.log(`\n${file}`);
    for (const e of result.errors) console.log(`  ✗ ${e.path}: ${e.message}  [${e.code}]`);
    if (!quiet) for (const w of result.warnings) console.log(`  ! ${w.path}: ${w.message}  [${w.code}]`);
}
if (report.errors.length || (!quiet && report.warnings.length)) console.log("\ncatalog");
for (const e of report.errors) console.log(`  ✗ ${e.path}: ${e.message}  [${e.code}]`);
if (!quiet) for (const w of report.warnings) console.log(`  ! ${w.path}: ${w.message}  [${w.code}]`);
errors += report.errors.length; warnings += report.warnings.length;
// ---- pending: must fail, and say why ----
const pending = loadPending();
let readyToMove = 0;
for (const p of pending) {
    const r = Contract.validateBundle(p.bundle, catalog.ref);
    if (r.ok) { readyToMove++; if (!asJson) console.log(`\n${p.file}\n  ✗ now passes every rule — move it to data/bikes/variants/  [pending_ready]`); continue; }
    if (!quiet) {
        console.log(`\n${p.file}  (pending — not in the catalog)`);
        for (const e of r.errors) console.log(`  · blocked by ${e.path}: ${e.message}  [${e.code}]`);
    }
}
errors += readyToMove;
const variants = catalog.entries.filter((e) => e.bundle.kind === "variant").length;
console.log(`\n${catalog.entries.length} bundles (${variants} variants, ${catalog.entries.length - variants} class defaults): ${errors} errors, ${warnings} warnings. ${pending.length} pending (blocked, not shipped).`);
process.exit(errors ? 1 : 0);
