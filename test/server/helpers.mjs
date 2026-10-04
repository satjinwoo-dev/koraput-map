// Shared fixtures for the Step 5 server tests: a real bikes.sqlite built into a
// temp directory (with every SQLite driver this machine has), an optional
// 20,000-variant synthetic extension, and a tiny HTTP harness around the router.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { createRequire } from "node:module";
import { buildArtifacts, writeSqlite, assembleCatalog, Search } from "../../scripts/bikedb/catalog-build.mjs";
import { loadCatalog, ROOT } from "../../scripts/bikedb/load-catalog.mjs";
import { syntheticRows } from "../../scripts/bikedb/synthetic.mjs";

const require = createRequire(import.meta.url);
export const express = require("express");
export const Sqlite = require("../../lib/bikedb/sqlite.js");
export const { CatalogDb, CatalogUnavailable, DB_FORMAT, APPLICATION_ID } = require("../../lib/bikedb/catalog-db.js");
export const { RequestQueue, validateRequest, requestKey } = require("../../lib/bikedb/request-queue.js");
export const { createBikeApi } = require("../../lib/bikedb/http-api.js");
export const BikeApi = require("../../public/js/bikedb/bike-api.js");
export { Search, ROOT };

export const catalog = loadCatalog();
export const art = buildArtifacts(catalog);
export const realCatalogJson = JSON.parse(art.catalog.bytes);
export const realIndex = new Search.CatalogIndex(realCatalogJson);

/** Every SQLite driver that loads here (better-sqlite3 needs its native addon). */
export const drivers = Sqlite.DRIVERS.flatMap((name) => {
    try { return [Sqlite.loadDriver({ driver: name })]; } catch { return []; }
});
export const quiet = { warn() {}, info() {}, error() {} };

export function tmpDir(tag = "bikes") {
    return fs.mkdtempSync(path.join(os.tmpdir(), `mu-${tag}-`));
}

/** Build the real catalogue into <dir>/bikes.sqlite with `driver`. */
export function buildDb(dir, driver, file = "bikes.sqlite") {
    const out = path.join(dir, file);
    writeSqlite(art, catalog.ref, out, driver);
    return out;
}

/**
 * Add synthetic variants to a built database (FTS rows, search rows, sizes, aliases),
 * and return the CatalogIndex that catalog.json would give for the same rows.
 * @param {string} file @param {{ open: Function }} driver @param {number} n
 */
export function addSynthetic(file, driver, n) {
    const rows = syntheticRows(n);
    const db = driver.open(file);
    try {
        db.transaction(() => {
            const makeId = new Map(db.prepare("SELECT make_id AS id, name FROM make").all().map((r) => [r.name, Number(r.id)]));
            const modelId = new Map(db.prepare("SELECT model_id AS id, make_id AS mk, name FROM model").all().map((r) => [`${r.mk}\u0000${r.name}`, Number(r.id)]));
            let nextBundle = Number(db.prepare("SELECT max(bundle_id) AS m FROM bundle").get().m) + 1;
            const insMake = db.prepare("INSERT INTO make (make_id, name) VALUES (?, ?)");
            const insModel = db.prepare("INSERT INTO model (model_id, make_id, name) VALUES (?, ?, ?)");
            const insBundle = db.prepare(`INSERT INTO bundle (bundle_id, slug, kind, class_key, model_id, variant_name, title, market, year_from, year_to, schema_version, image_url, hash, body)
                                          VALUES (?, ?, 'variant', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
            const insSource = db.prepare("INSERT INTO source (bundle_id, source_key, ord, kind, title, retrieved) VALUES (?, 'syn', 0, 'derived', 'synthetic test row', '2026-10-03')");
            const insSpec = db.prepare("INSERT INTO spec_value (bundle_id, path, value, published_value, source_key, conf) VALUES (?, ?, ?, ?, 'syn', 0.5)");
            const insAlias = db.prepare("INSERT INTO alias (bundle_id, ord, alias) VALUES (?, ?, ?)");
            const insFts = db.prepare("INSERT INTO bundle_search (rowid, make, model, variant, aliases) VALUES (?, ?, ?, ?, ?)");
            for (const r of rows) {
                if (!makeId.has(r.make)) { makeId.set(r.make, makeId.size + 1000); insMake.run(makeId.get(r.make), r.make); }
                const mk = makeId.get(r.make), key = `${mk}\u0000${r.model}`;
                if (!modelId.has(key)) { modelId.set(key, modelId.size + 100000); insModel.run(modelId.get(key), mk, r.model); }
                const id = nextBundle++;
                const title = [r.make, r.model, r.variant].filter(Boolean).join(" ");
                insBundle.run(id, r.id, r.classKey, modelId.get(key), r.variant, title, r.market, r.yearFrom, r.yearTo, art.schemaVersion, r.image_url, r.bundle, JSON.stringify({ id: r.id }));
                insSource.run(id);
                const ev = r.classKey.startsWith("ev.");
                insSpec.run(id, ev ? "battery.grossCapacity" : "engine.displacement", r.size, ev ? r.size / 3.6e6 : r.size * 1e6);
                r.aliases.forEach((a, j) => insAlias.run(id, j, a));
                insFts.run(id, ...Search.ftsColumns(r));
            }
        });
    } finally { db.close(); }
    const combined = assembleCatalog([...art.catalog.rows, ...rows], art.classes, art.schemaVersion);
    return { rows, index: new Search.CatalogIndex(JSON.parse(combined.bytes)) };
}

/** Writable in-memory queue database for a driver. */
export function memoryDb(driver) {
    return driver.open(":memory:");
}

/**
 * Serve an express app on 127.0.0.1:<random port>.
 * @returns {Promise<{ url: string, close: () => Promise<void> }>}
 */
export function listen(app) {
    return new Promise((resolve) => {
        const server = http.createServer(app);
        server.keepAliveTimeout = 1;
        server.listen(0, "127.0.0.1", () => {
            const { port } = /** @type {import("node:net").AddressInfo} */ (server.address());
            resolve({ url: `http://127.0.0.1:${port}`, close: () => new Promise((r) => { server.closeAllConnections(); server.close(() => r()); }) });
        });
    });
}

/** An app with only the bike API mounted, as server.js mounts it. */
export async function serveApi(apiOpts) {
    const api = createBikeApi({ log: quiet, limits: false, ...apiOpts });
    const app = express();
    app.use("/api/bikes", api.router);
    const srv = await listen(app);
    return { api, ...srv };
}

/**
 * Raw HTTP request (no CORS enforcement, full control of headers) — what a
 * browser or the Android WebView would send.
 * @returns {Promise<{ status: number, headers: Record<string, string>, text: string, json: any }>}
 */
export function raw(url, { method = "GET", headers = {}, body } = {}) {
    return new Promise((resolve, reject) => {
        const req = http.request(url, { method, headers, agent: false }, (res) => {
            const chunks = [];
            res.on("data", (c) => chunks.push(c));
            res.on("end", () => {
                const text = Buffer.concat(chunks).toString("utf8");
                let json = null;
                try { json = JSON.parse(text); } catch { /* not JSON */ }
                resolve({ status: res.statusCode, headers: /** @type {any} */ (res.headers), text, json });
            });
        });
        req.on("error", reject);
        if (body !== undefined) req.write(body);
        req.end();
    });
}

export const bundleFile = (hash) => path.join(ROOT, "public", "bikedb", "bundles", `${hash}.json`);
