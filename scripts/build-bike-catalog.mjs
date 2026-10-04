#!/usr/bin/env node
/*
 * Builds the bike catalogue from data/bikes/ (Step 3):
 *
 *   public/bikedb/catalog.json           compact search catalogue (app, website, offline)
 *   public/bikedb/bundles/<hash>.json    one self-contained bundle per bike, cacheable forever
 *   build/bikedb/bikes.sqlite            normalised database + FTS5 search, for the server
 *                                        (schema: lib/bikedb/schema.sql)
 *
 * Nothing is written unless every file validates (scripts/bikedb/validate.mjs
 * runs the same checks). Bikes in data/bikes/pending/ are never built.
 * Same input, same output: catalog.json and the bundles are byte-identical on
 * every build; bikes.sqlite too, for the same SQLite version.
 *
 *   node scripts/build-bike-catalog.mjs                 # build everything
 *   node scripts/build-bike-catalog.mjs --check         # exit 1 if any output is missing or out of date
 *   node scripts/build-bike-catalog.mjs --skip-sqlite   # catalog.json + bundles only (no SQLite driver needed)
 * With no SQLite driver on this machine (and none named with --driver), catalog.json and the
 * bundles are still built, bikes.sqlite is skipped and a warning says why.
 *   node scripts/build-bike-catalog.mjs --json          # machine-readable summary
 * Options: --out-public <dir>, --out-db <file>, --data <dir>, --no-prune (keep old bundle files),
 *          --driver better-sqlite3|node:sqlite (default: whichever is available, in that order).
 * Exit codes: 0 ok, 1 build failed or --check found differences, 2 bad arguments.
 */
import path from "node:path";
import {
    build, buildArtifacts, diffPublic, diffSqlite, BuildError,
    DEFAULT_PUBLIC_DIR, DEFAULT_DB_FILE, CATALOG_BUDGET_GZIP
} from "./bikedb/catalog-build.mjs";
import { loadCatalog, DATA } from "./bikedb/load-catalog.mjs";

const FLAGS = ["--check", "--skip-sqlite", "--json", "--no-prune", "--quiet"];
const VALUED = ["--out-public", "--out-db", "--data", "--driver"];

function parseArgs(argv) {
    const o = { flags: new Set(), values: {} };
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        if (FLAGS.includes(a)) o.flags.add(a);
        else if (VALUED.includes(a)) {
            if (i + 1 >= argv.length || argv[i + 1].startsWith("--")) usage(`${a} needs a value`);
            o.values[a] = argv[++i];
        } else usage(`unknown argument ${a}`);
    }
    return o;
}

function usage(msg) {
    console.error(`build-bike-catalog: ${msg}\nusage: node scripts/build-bike-catalog.mjs [--check] [--skip-sqlite] [--json] [--no-prune] [--out-public DIR] [--out-db FILE] [--data DIR] [--driver NAME]`);
    process.exit(2);
}

const rel = (p) => path.relative(process.cwd(), p) || ".";
const kb = (n) => `${(n / 1024).toFixed(1)} KB`;

async function main() {
    const args = parseArgs(process.argv.slice(2));
    const resolveArg = (k, dflt) => (args.values[k] ? path.resolve(args.values[k]) : dflt);
    const opts = {
        dataDir: resolveArg("--data", DATA),
        publicDir: resolveArg("--out-public", DEFAULT_PUBLIC_DIR),
        dbFile: resolveArg("--out-db", DEFAULT_DB_FILE),
        skipSqlite: args.flags.has("--skip-sqlite"),
        prune: !args.flags.has("--no-prune"),
        driver: args.values["--driver"]
    };
    const asJson = args.flags.has("--json");

    if (args.flags.has("--check")) {
        const input = loadCatalog(opts.dataDir);
        const art = buildArtifacts(input);
        const diffs = diffPublic(art, opts.publicDir);
        if (!opts.skipSqlite) {
            const { loadDriver } = await import("./bikedb/sqlite-driver.mjs");
            diffs.push(...diffSqlite(art, opts.dbFile, loadDriver({ driver: opts.driver })));
        }
        if (asJson) console.log(JSON.stringify({ ok: diffs.length === 0, catalogVersion: art.catalog.version, differences: diffs }, null, 2));
        else if (diffs.length) console.error(`bike catalogue is out of date (run node scripts/build-bike-catalog.mjs):\n  ${diffs.join("\n  ")}`);
        else console.log(`bike catalogue is up to date (version ${art.catalog.version})`);
        process.exit(diffs.length ? 1 : 0);
    }

    const { art, pub, db, sqliteSkipped } = await build(opts);
    const summary = {
        ok: true,
        catalogVersion: art.catalog.version,
        variants: art.counts.variants,
        classDefaults: art.counts.classDefaults,
        warnings: art.counts.warnings,
        catalog: { file: path.join(opts.publicDir, "catalog.json"), bytes: pub.catalogBytes, gzipBytes: pub.catalogGzip, budgetGzipBytes: CATALOG_BUDGET_GZIP },
        bundles: { dir: path.join(opts.publicDir, "bundles"), count: art.bundles.length, bytes: pub.bundleBytes, written: pub.written, unchanged: pub.unchanged, pruned: pub.pruned },
        sqlite: db ? { file: db.file, bytes: db.bytes, driver: db.driver, sqliteVersion: db.sqliteVersion } : null,
        sqliteSkipped,
        inputHash: art.inputHash
    };
    if (sqliteSkipped) console.error(`build-bike-catalog: WARNING: bikes.sqlite was not built — ${sqliteSkipped.split("\n").join("\n  ")}\n  The app's bike list (catalog.json) and the bundles were built and work without it; the server's\n  /api/bikes search answers 503 until bikes.sqlite exists (Node 22.13+ has node:sqlite built in).`);
    if (asJson) { console.log(JSON.stringify(summary, null, 2)); return; }
    if (args.flags.has("--quiet")) return;
    console.log(`bike catalogue ${art.catalog.version}: ${art.counts.variants} variants, ${art.counts.classDefaults} class defaults${art.counts.warnings ? `, ${art.counts.warnings} warning${art.counts.warnings === 1 ? "" : "s"} (see validate.mjs)` : ""}`);
    console.log(`  catalog.json   ${rel(summary.catalog.file)}   ${kb(pub.catalogBytes)}, ${kb(pub.catalogGzip)} gzipped (budget ${kb(CATALOG_BUDGET_GZIP)})`);
    console.log(`  bundles        ${rel(summary.bundles.dir)}/   ${art.bundles.length} files, ${kb(pub.bundleBytes)} (${pub.written} written, ${pub.unchanged} unchanged, ${pub.pruned} removed)`);
    if (db) console.log(`  bikes.sqlite   ${rel(db.file)}   ${kb(db.bytes)} (${db.driver}, SQLite ${db.sqliteVersion})`);
    else console.log(`  bikes.sqlite   skipped (${sqliteSkipped ? "no SQLite driver, see the warning above" : "--skip-sqlite"})`);
}

main().catch((e) => {
    if (e instanceof BuildError) console.error(`build-bike-catalog: ${e.message}`);
    else console.error(`build-bike-catalog: ${e && e.stack ? e.stack : e}`);
    process.exit(1);
});
