#!/usr/bin/env node
/*
 * Fleet calibration (roadmap Step 11): fit each petrol class's priors to the anonymous
 * full-to-full tanks riders shared (POST /api/bikes/fillups), store the results for
 * the Fuel Learner dashboard (GET /api/bikes/calibration), and — with --write —
 * write a reviewable proposal per class that passed every check to
 * data/bikes/calibration/<class-key>.json. The build applies proposals; nothing
 * reaches riders without that reviewed diff.
 *
 *   npm run bikes:calibrate                               fit every class, store results, print a summary
 *   npm run bikes:calibrate -- --class ice_manual.commuter
 *   npm run bikes:calibrate -- --write                    also write proposals (then review, commit, rebuild)
 *   npm run bikes:calibrate -- --json                     machine-readable output
 *   DB_PATH=/srv/mapunite/data/mapunite.db npm run bikes:calibrate
 *
 * Reads the tanks from the server's database (DB_PATH, default data/mapunite.db) and
 * the curated bike data from data/bikes (the fit starts from the curated priors, never
 * from a previous calibration, so no tank counts twice). Old tanks past the retention
 * period (FLEET_RETENTION_DAYS, default 730) are purged first. Run it from a checkout
 * of the commit the server is deployed from. Exit code: 0 ok, 1 a fit failed, 2 bad arguments.
 */
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { ROOT, DATA, loadCatalog } from "./load-catalog.mjs";
import { buildArtifacts } from "./catalog-build.mjs";
import { makeProposal, CALIBRATION_DIR } from "./calibration-file.mjs";
import { formatJson } from "./format.mjs";

const require = createRequire(import.meta.url);
const Physics = require("../../public/js/physics/index.js");
const Contract = require("../../public/js/bikedb/bundle-contract.js");
const { loadDriver } = require("../../lib/bikedb/sqlite.js");
const { FleetStore } = require("../../lib/bikedb/fleet.js");
const { fitClass, CAL_PARAMS } = require("../../lib/bikedb/calibration.js");

/** Plausible SI range of each calibrated prior (the contract's FIELDS). */
export function calibrationRanges() {
    return Object.fromEntries(CAL_PARAMS.map((c) => {
        const f = Contract.FIELDS.find((x) => x.path === `priors.${c.prior}`);
        return [c.prior, f.range.map((v) => Contract.toSI(v, f.unit))];
    }));
}

/**
 * Fit classes and (optionally) write proposals. Exported for tests.
 *
 * Every fit starts from the CURATED data (data/bikes without data/bikes/calibration/),
 * built in memory: re-fitting from an already-calibrated prior would count the same
 * tanks twice. A new proposal therefore replaces the class's previous one; it never
 * stacks on it.
 * @param {{ db: any, dataDir?: string, only?: string|null, write?: boolean, now?: () => number, retentionDays?: number, options?: any }} o
 */
export function calibrate(o) {
    const dataDir = o.dataDir || DATA;
    const fleet = new FleetStore(o.db, { now: o.now, retentionDays: o.retentionDays });
    const purged = fleet.purge();
    const curated = loadCatalog(dataDir, { calibrations: false });
    const art = buildArtifacts(curated);
    const bundles = new Map(art.bundles.map((b) => [b.id, b.runtime]));
    const ranges = calibrationRanges();
    const results = [];
    for (const { classKey } of fleet.classes()) {
        if (o.only && classKey !== o.only) continue;
        const built = art.bundles.find((b) => b.kind === "class_default" && b.classKey === classKey);
        if (!built) { results.push({ classKey, proposed: false, reason: "no such class in the catalogue", file: null }); continue; }
        const fit = fitClass({ physics: Physics, classDefault: built.runtime, classDefaultHash: built.hash, bundles, tanks: fleet.tanks(classKey), ranges, options: o.options });
        fleet.saveFit(classKey, art.catalog.version, fit);
        let file = null;
        if (o.write && fit.proposed) {
            const proposal = makeProposal(fit, built.source, fleet.today());
            const dir = path.join(dataDir, CALIBRATION_DIR);
            fs.mkdirSync(dir, { recursive: true });
            file = path.join(dir, `${classKey}.json`);
            fs.writeFileSync(file, formatJson(proposal) + "\n");
        }
        results.push({ ...fit, file: file ? path.relative(ROOT, file).split(path.sep).join("/") : null });
    }
    return { curatedVersion: art.catalog.version, purged, results };
}

// ----------------------------------------------------------------------------
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    const argv = process.argv.slice(2);
    const known = ["--write", "--json", "--class"];
    for (const a of argv) if (a.startsWith("--") && !known.includes(a)) { console.error(`unknown option ${a}`); process.exit(2); }
    const ci = argv.indexOf("--class");
    const only = ci >= 0 ? argv[ci + 1] : null;
    if (ci >= 0 && !only) { console.error("--class needs a class key"); process.exit(2); }
    const dbFile = process.env.DB_PATH || path.join(ROOT, "data", "mapunite.db");
    if (!fs.existsSync(dbFile)) { console.error(`no server database at ${dbFile} (set DB_PATH)`); process.exit(2); }
    const driver = loadDriver({ purpose: "fit the fleet calibration" });
    const db = driver.open(dbFile);
    // the server may be running on the same file (WAL): wait for its locks; purged rows are overwritten
    db.exec("PRAGMA busy_timeout = 5000; PRAGMA secure_delete = ON;");
    try {
        const days = process.env.FLEET_RETENTION_DAYS === undefined ? undefined : Number(process.env.FLEET_RETENTION_DAYS);
        const r = calibrate({ db, only, write: argv.includes("--write"), retentionDays: days });
        if (argv.includes("--json")) console.log(JSON.stringify(r, null, 2));
        else {
            console.log(`fleet calibration from the curated catalogue ${r.curatedVersion}${r.purged ? ` (${r.purged} tanks past retention removed)` : ""}`);
            if (!r.results.length) console.log("no tanks yet");
            for (const x of r.results) {
                const ev = x.evidence ? `${x.evidence.tanks} tanks, ${x.evidence.riders} riders` : "";
                const cv = x.cv ? `, held-out error ${Math.round(x.cv.prior * 100)} % → ${Math.round(x.cv.posterior * 100)} %` : "";
                const oh = x.overhead ? `, overhead ×${x.overhead.mean}` : "";
                console.log(`  ${x.classKey}: ${x.proposed ? "PROPOSED" : "not proposed"} — ${ev}${cv}${oh}${x.reason ? ` (${x.reason})` : ""}${x.file ? `\n      wrote ${x.file}: review it, commit it, then npm run bikes:build` : ""}`);
            }
        }
    } catch (e) {
        console.error(e && e.stack ? e.stack : e);
        process.exitCode = 1;
    } finally {
        db.close();
    }
}
