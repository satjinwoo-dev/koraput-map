// Step 5: the server's read-only view of bikes.sqlite — FTS5 search that matches
// and ranks exactly like the app's offline index, bundles byte-identical to the
// shipped files, and a catalogue that survives a missing, broken or rebuilt file.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { syntheticQueries } from "../../scripts/bikedb/synthetic.mjs";
import { art, realIndex, drivers, quiet, tmpDir, buildDb, addSynthetic, CatalogDb, CatalogUnavailable, DB_FORMAT, APPLICATION_ID, bundleFile, Search } from "./helpers.mjs";

assert.ok(drivers.length > 0, "at least one SQLite driver (node:sqlite ships with Node 22.5+)");

/** Type-ahead queries over the real catalogue: every prefix of every word, combinations, junk and FTS5 syntax. */
function realQueries() {
    const qs = new Set(["", "   ", "cc", "350cc", "royal enfield", "re hunter", "h'ness", "hness", "h ness", "mt15", "mt-15 v2", "ns200", "splendor+",
        "\"", "*", "\"hunter\" OR \"pulsar\"", "NEAR(royal hunter)", "hunter NOT pulsar", "-pulsar", "^royal", "make:royal", "(", "a AND", "🏍️ bike", "Ólá s1 pró",
        "x".repeat(150), "1", "2", "zz", "qqq", "4v", "e", "ev"]);
    for (const r of art.catalog.rows) {
        const words = [r.make, r.model, r.variant || "", ...r.aliases].join(" ").split(/\s+/).filter(Boolean);
        for (const w of words) for (let i = 1; i <= w.length; i++) qs.add(w.slice(0, i));
        qs.add(`${r.make} ${r.model.slice(0, 3)}`);
        qs.add(`${r.make} ${r.model} ${r.variant || ""}`);
    }
    for (const q of syntheticQueries(art.catalog.rows, 300)) qs.add(q);
    return [...qs];
}

for (const driver of drivers) {
    test(`[${driver.name}] search matches and ranks exactly like the app's offline index, on every real-catalogue query`, () => {
        const dir = tmpDir();
        const cat = new CatalogDb({ file: buildDb(dir, driver), driver, log: quiet });
        const queries = realQueries();
        assert.ok(queries.length >= 600, `${queries.length} queries`);
        for (const q of queries) {
            for (const limit of [1, 5, 200]) {
                const s = cat.search(q, { limit });
                assert.deepEqual(s.results, realIndex.search(q, { limit }), `results for ${JSON.stringify(q)} limit ${limit}`);
                assert.equal(s.total, realIndex.matchIds(q).length, `total for ${JSON.stringify(q)}`);
                assert.equal(s.catalogVersion, art.catalog.version);
            }
            assert.deepEqual(cat.matchIds(q), realIndex.matchIds(q), `matches for ${JSON.stringify(q)}`);
        }
        cat.close();
        fs.rmSync(dir, { recursive: true, force: true });
    });

    test(`[${driver.name}] search results never include class defaults or pending bikes`, () => {
        const dir = tmpDir();
        const cat = new CatalogDb({ file: buildDb(dir, driver), driver, log: quiet });
        const ids = new Set(cat.search("a", { limit: 200 }).results.map((r) => r.id));
        for (const q of ["default", "generic", "commuter", "scooter"]) for (const r of cat.search(q, { limit: 200 }).results) ids.add(r.id);
        const variants = new Set(art.catalog.rows.map((r) => r.id));
        for (const id of ids) assert.ok(variants.has(id), `${id} is a shipped variant`);
        for (const c of art.classes) assert.ok(!ids.has(c.key));
        cat.close();
        fs.rmSync(dir, { recursive: true, force: true });
    });

    test(`[${driver.name}] bundles: byte-identical to public/bikedb/bundles/<hash>.json, by hash and by bike id, class defaults included`, () => {
        const dir = tmpDir();
        const cat = new CatalogDb({ file: buildDb(dir, driver), driver, log: quiet });
        assert.equal(art.bundles.length, art.catalog.rows.length + art.classes.length);
        for (const b of art.bundles) {
            const byHash = cat.bundle(b.hash), byId = cat.bundle(b.id);
            assert.ok(byHash && byId, b.id);
            assert.equal(byHash.body, fs.readFileSync(bundleFile(b.hash), "utf8"), `${b.id}: same bytes as the static file`);
            assert.equal(byId.body, byHash.body);
            assert.equal(crypto.createHash("sha256").update(byHash.body, "utf8").digest("hex").slice(0, 16), b.hash, "content hash");
            assert.equal(byHash.id, b.id);
            assert.equal(byHash.kind, b.kind);
            assert.equal(JSON.parse(byHash.body).units, "SI");
            assert.ok("image_url" in JSON.parse(byHash.body), `${b.id} carries image_url`);
        }
        for (const k of ["0000000000000000", "no-such-bike", "tvs-ntorq-125-pending", "../etc/passwd", "ABCDEF0123456789", "", "x".repeat(81), "-bad", "bad-"]) assert.equal(cat.bundle(k), null, k);
        cat.close();
        fs.rmSync(dir, { recursive: true, force: true });
    });
}

test("pending bikes are not in the database at all", async () => {
    const { loadPending } = await import("../../scripts/bikedb/load-catalog.mjs");
    const pending = loadPending();
    assert.ok(pending.length > 0);
    const dir = tmpDir();
    const cat = new CatalogDb({ file: buildDb(dir, drivers[0]), driver: drivers[0], log: quiet });
    for (const p of pending) {
        assert.equal(cat.bundle(p.bundle.id), null, p.bundle.id);
        assert.ok(!cat.matchIds(`${p.bundle.identity.make} ${p.bundle.identity.model}`).includes(p.bundle.id));
    }
    cat.close();
    fs.rmSync(dir, { recursive: true, force: true });
});

test("at 20,000 variants: same matches and order as the app's index, and search stays under 10 ms at p99", () => {
    const driver = drivers[0];
    const dir = tmpDir();
    const file = buildDb(dir, driver);
    const { rows, index } = addSynthetic(file, driver, 20000);
    const cat = new CatalogDb({ file, driver, log: quiet });
    assert.equal(cat.status().variants, 20000 + art.catalog.rows.length);
    const queries = syntheticQueries(rows, 1000);
    const cold = [];
    for (const q of queries) {
        const t0 = process.hrtime.bigint();
        const s = cat.search(q, { limit: 20 });
        cold.push(Number(process.hrtime.bigint() - t0) / 1e6);
        assert.deepEqual(s.results, index.search(q, { limit: 20 }), JSON.stringify(q));
        assert.equal(s.total, index.matchIds(q).length, JSON.stringify(q));
    }
    for (const q of queries.slice(0, 200)) assert.deepEqual(cat.matchIds(q), index.matchIds(q), JSON.stringify(q));
    const warm = queries.map((q) => { const t0 = process.hrtime.bigint(); cat.search(q, { limit: 20 }); return Number(process.hrtime.bigint() - t0) / 1e6; });
    const p = (xs, f) => [...xs].sort((a, b) => a - b)[Math.floor(f * (xs.length - 1))];
    console.log(`search at 20,025 variants (${driver.name}): cold p50 ${p(cold, 0.5).toFixed(2)} ms, p99 ${p(cold, 0.99).toFixed(2)} ms; warm p50 ${p(warm, 0.5).toFixed(2)} ms, p99 ${p(warm, 0.99).toFixed(2)} ms`);
    assert.ok(p(warm, 0.99) < 10, `warm p99 ${p(warm, 0.99).toFixed(2)} ms`);
    cat.close();
    fs.rmSync(dir, { recursive: true, force: true });
});

test("a missing catalogue is a 'catalog-unavailable' error, not a crash; it is picked up once built", () => {
    const dir = tmpDir();
    const file = path.join(dir, "bikes.sqlite");
    let t = 0;
    const cat = new CatalogDb({ file, driver: drivers[0], log: quiet, now: () => t, reloadCheckMs: 5000 });
    assert.throws(() => cat.search("hunter"), (e) => e instanceof CatalogUnavailable && e.reason === "catalog-unavailable");
    assert.throws(() => cat.bundle("royal-enfield-hunter-350-metro-in"), CatalogUnavailable);
    const s = cat.status();
    assert.equal(s.available, false);
    assert.equal(s.reason, "catalog-unavailable");
    buildDb(dir, drivers[0]);
    t = 1000;
    assert.throws(() => cat.search("hunter"), CatalogUnavailable, "not re-checked before reloadCheckMs");
    t = 5000;
    assert.equal(cat.search("hunter").total, 1, "found on the next check");
    cat.close();
    fs.rmSync(dir, { recursive: true, force: true });
});

test("a rebuilt catalogue is swapped in without a restart; a broken one is refused and the old one keeps serving", process.platform === "win32" ? { skip: "atomic SQLite file swap on open files requires POSIX filesystem semantics (tested in CI on Linux)" } : {}, () => {
    const driver = drivers[0];
    const dir = tmpDir();
    const file = buildDb(dir, driver);
    let t = 0;
    const warnings = [];
    const cat = new CatalogDb({ file, driver, log: { warn: (m) => warnings.push(m), info() {} }, now: () => t, reloadCheckMs: 1000 });
    assert.equal(cat.search("hunter").total, 1);
    assert.equal(cat.status().variants, art.catalog.rows.length);

    // a new build (here: the real one + 50 synthetic bikes) replaces the file atomically, as the build does
    const next = buildDb(dir, driver, "next.sqlite");
    addSynthetic(next, driver, 50);
    fs.renameSync(next, file);
    t = 1000;
    assert.equal(cat.status().variants, art.catalog.rows.length + 50, "new build in use");
    assert.equal(cat.search("hunter").total, 1);

    // a broken file: refused, the previous catalogue keeps answering
    fs.writeFileSync(path.join(dir, "junk.sqlite"), "this is not a database");
    fs.renameSync(path.join(dir, "junk.sqlite"), file);
    t = 2000;
    assert.equal(cat.status().variants, art.catalog.rows.length + 50);
    assert.equal(cat.search("hunter").total, 1);
    assert.ok(warnings.some((w) => /new catalogue refused/.test(w)), warnings.join("\n"));

    // deleted: keep serving the open build
    fs.rmSync(file);
    t = 3000;
    assert.equal(cat.search("hunter").total, 1);
    cat.close();
    fs.rmSync(dir, { recursive: true, force: true });
});

test("a database that isn't a MapUnite catalogue, or has another format, is refused as 'catalog-incompatible'", () => {
    const driver = drivers[0];
    const cases = [
        ["foreign", (db) => db.exec("PRAGMA application_id = 42")],
        ["older format", (db) => db.exec(`PRAGMA user_version = ${DB_FORMAT - 1}`)],
        ["other catalogue format", (db) => db.exec("UPDATE meta SET value = 'mapunite-bike-catalog/0' WHERE key = 'catalog_format'")]
    ];
    for (const [name, spoil] of cases) {
        const dir = tmpDir();
        const file = buildDb(dir, driver);
        const db = driver.open(file);
        spoil(db);
        db.close();
        const cat = new CatalogDb({ file, driver, log: quiet });
        assert.throws(() => cat.search("hunter"), (e) => e instanceof CatalogUnavailable && e.reason === "catalog-incompatible", name);
        assert.equal(cat.status().reason, "catalog-incompatible", name);
        fs.rmSync(dir, { recursive: true, force: true });
    }
    assert.equal(APPLICATION_ID, 1297433163, "same id as lib/bikedb/schema.sql");
});

test("the server opens the catalogue read-only: it can never modify the build output", () => {
    const driver = drivers[0];
    const dir = tmpDir();
    const file = buildDb(dir, driver);
    const before = fs.readFileSync(file);
    const cat = new CatalogDb({ file, driver, log: quiet });
    cat.search("royal");
    cat.bundle("royal-enfield-hunter-350-metro-in");
    assert.throws(() => cat._open.db.exec("DELETE FROM bundle"), /readonly|read-only|attempt to write/i);
    cat.close();
    assert.ok(fs.readFileSync(file).equals(before), "file unchanged");
    fs.rmSync(dir, { recursive: true, force: true });
});

test("DB_FORMAT is read from lib/bikedb/schema.sql and agrees with the build", async () => {
    const { DB_FORMAT: buildFormat } = await import("../../scripts/bikedb/catalog-build.mjs");
    assert.equal(DB_FORMAT, buildFormat);
    assert.equal(Search.CATALOG_FORMAT, JSON.parse(art.catalog.bytes).format);
});
