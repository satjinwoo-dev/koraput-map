#!/usr/bin/env node
/*
 * Search benchmark on a synthetic catalogue (default 20,000 variants):
 *   - catalog.json size, raw and gzipped (assembled by the same code as the real build);
 *   - FTS5 in bikes.sqlite's real bundle_search table (lib/bikedb/schema.sql),
 *     the ranked top 20 per query: the server's search;
 *   - the in-memory CatalogIndex the app and the website use offline;
 *   - that both match exactly the same rows for every query.
 *
 *   node scripts/bikedb/bench-search.mjs [--rows 20000] [--queries 1000] [--driver better-sqlite3|node:sqlite] [--json]
 *
 * Pass criteria (exit 1 if not met): FTS5 and in-memory p99 under 10 ms, and
 * identical matches. The 300 KB gzip budget applies to the catalogue that ships
 * (the build refuses to write a bigger one); here the report shows how many
 * synthetic variants fit inside it. The phone is slower than a desktop, so the in-memory
 * timings here should sit well below 10 ms; the report prints them so a
 * mid-range-phone measurement can be compared.
 */
import fs from "node:fs";
import { pathToFileURL } from "node:url";
import { performance } from "node:perf_hooks";
import { assembleCatalog, gzipSize, Search, SCHEMA_SQL, CATALOG_BUDGET_GZIP } from "./catalog-build.mjs";
import { syntheticRows, syntheticClasses, syntheticQueries } from "./synthetic.mjs";
import { loadDriver } from "./sqlite-driver.mjs";
import { Contract } from "./load-catalog.mjs";

export const LIMIT_MS = 10;

const arg = (name, dflt) => { const i = process.argv.indexOf(name); return i > 0 ? process.argv[i + 1] : dflt; };

/** @param {number[]} xs */
export function stats(xs) {
    const s = [...xs].sort((a, b) => a - b);
    const q = (p) => s[Math.min(s.length - 1, Math.floor(p * s.length))];
    return { n: s.length, p50: q(0.5), p95: q(0.95), p99: q(0.99), max: s[s.length - 1], mean: s.reduce((a, b) => a + b, 0) / s.length };
}

const time = (fn) => { const t = performance.now(); const r = fn(); return [performance.now() - t, r]; };

/**
 * Largest synthetic catalogue (to the nearest 250 variants) whose catalog.json
 * stays within the gzip budget.
 */
export function budgetCapacity() {
    const fits = (n) => gzipSize(assembleCatalog(syntheticRows(n), syntheticClasses(), Contract.SCHEMA_VERSION).bytes) <= CATALOG_BUDGET_GZIP;
    let lo = 250, hi = 40000;
    if (!fits(lo)) return 0;
    while (hi - lo > 250) { const mid = Math.round((lo + hi) / 500) * 250; if (fits(mid)) lo = mid; else hi = mid; }
    return lo;
}

/**
 * @param {{ rows?: number, queries?: number, driver?: string, capacity?: boolean }} [opts]
 */
export function runBenchmark(opts = {}) {
    const nRows = opts.rows || 20000;
    const nQueries = opts.queries || 1000;
    const rows = syntheticRows(nRows);
    const cat = assembleCatalog(rows, syntheticClasses(), Contract.SCHEMA_VERSION);
    const queries = syntheticQueries(cat.rows, nQueries);
    const warm = queries.slice(0, 50);

    // ---- in-memory index (app / website) ----
    const [parseMs, parsed] = time(() => JSON.parse(cat.bytes));
    const [indexMs, index] = time(() => new Search.CatalogIndex(parsed));
    for (const q of warm) index.search(q);
    const jsTimes = queries.map((q) => time(() => index.search(q))[0]);

    // ---- FTS5 (server) ----
    const driver = loadDriver({ driver: opts.driver });
    const db = driver.open(":memory:");
    db.exec(fs.readFileSync(SCHEMA_SQL, "utf8"));
    const ins = db.prepare("INSERT INTO bundle_search (rowid, make, model, variant, aliases) VALUES (?, ?, ?, ?, ?)");
    const [ftsBuildMs] = time(() => db.transaction(() => cat.rows.forEach((r, i) => ins.run(i + 1, ...Search.ftsColumns(r)))));
    db.exec("INSERT INTO bundle_search(bundle_search) VALUES ('optimize');");
    const top = db.prepare("SELECT rowid FROM bundle_search WHERE bundle_search MATCH ? ORDER BY rank LIMIT 20");
    const all = db.prepare("SELECT rowid FROM bundle_search WHERE bundle_search MATCH ?");
    const fts = (stmt, q) => { const m = Search.toFtsQuery(Search.queryTokens(q)); return m ? stmt.all(m) : []; };
    for (const q of warm) fts(top, q);
    const ftsTimes = queries.map((q) => time(() => fts(top, q))[0]);

    // ---- same matches? ----
    const mismatches = [];
    let hits = 0, empty = 0;
    for (const q of queries) {
        const a = fts(all, q).map((r) => cat.rows[Number(r.rowid) - 1].id).sort();
        const b = index.matchIds(q);
        if (a.length) hits++; else empty++;
        if (a.length !== b.length || a.some((x, i) => x !== b[i])) mismatches.push({ query: q, fts: a.length, memory: b.length });
    }
    db.close();

    const js = stats(jsTimes), ft = stats(ftsTimes);
    const gz = gzipSize(cat.bytes);
    const capacity = opts.capacity === false ? null : budgetCapacity();
    const pass = ft.p99 < LIMIT_MS && js.p99 < LIMIT_MS && mismatches.length === 0;
    return {
        pass,
        rows: nRows, queries: queries.length, queriesWithMatches: hits, queriesWithoutMatches: empty,
        catalog: { bytes: Buffer.byteLength(cat.bytes), gzipBytes: gz, withinBudget: gz <= CATALOG_BUDGET_GZIP, variantsWithinBudget: capacity },
        memory: { parseMs, indexBuildMs: indexMs, query: js },
        fts5: { driver: driver.name, sqliteVersion: db.sqliteVersion, indexBuildMs: ftsBuildMs, query: ft },
        mismatches: mismatches.slice(0, 20), mismatchCount: mismatches.length
    };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    const r = runBenchmark({ rows: Number(arg("--rows", 20000)), queries: Number(arg("--queries", 1000)), driver: arg("--driver", undefined) });
    if (process.argv.includes("--json")) console.log(JSON.stringify(r, null, 2));
    else {
        const ms = (x) => `${x.toFixed(2)} ms`;
        const row = (name, s) => `  ${name.padEnd(28)} p50 ${ms(s.p50).padStart(9)}   p95 ${ms(s.p95).padStart(9)}   p99 ${ms(s.p99).padStart(9)}   max ${ms(s.max).padStart(9)}`;
        console.log(`synthetic catalogue: ${r.rows} variants, ${r.queries} queries (${r.queriesWithMatches} with matches, ${r.queriesWithoutMatches} without)`);
        console.log(`  catalog.json                 ${(r.catalog.bytes / 1024).toFixed(0)} KB, ${(r.catalog.gzipBytes / 1024).toFixed(0)} KB gzipped (budget ${CATALOG_BUDGET_GZIP / 1024} KB: ${r.catalog.withinBudget ? "within" : "over"}; fits up to ~${r.catalog.variantsWithinBudget} variants)`);
        console.log(`  in-memory index build        parse ${ms(r.memory.parseMs)}, index ${ms(r.memory.indexBuildMs)} (once, on first search)`);
        console.log(row("in-memory search (top 20)", r.memory.query));
        console.log(row(`FTS5 search (top 20)`, r.fts5.query) + `   [${r.fts5.driver}, SQLite ${r.fts5.sqliteVersion}]`);
        console.log(`  identical matches            ${r.mismatchCount === 0 ? "yes, every query" : `NO — ${r.mismatchCount} queries differ: ${JSON.stringify(r.mismatches.slice(0, 5))}`}`);
        console.log(r.pass ? `PASS (p99 under ${LIMIT_MS} ms, same matches)` : `FAIL (needs p99 under ${LIMIT_MS} ms and identical matches)`);
    }
    process.exit(r.pass ? 0 : 1);
}
