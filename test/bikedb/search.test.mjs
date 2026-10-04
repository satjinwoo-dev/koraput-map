// Step 3: the shared search module (catalog-search.js) and the 20k-row benchmark.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { catalog } from "./helpers.mjs";
import { buildArtifacts, assembleCatalog, Search, SCHEMA_SQL } from "../../scripts/bikedb/catalog-build.mjs";
import { syntheticRows, syntheticClasses, syntheticQueries } from "../../scripts/bikedb/synthetic.mjs";
import { loadDriver } from "../../scripts/bikedb/sqlite-driver.mjs";
import { runBenchmark, LIMIT_MS } from "../../scripts/bikedb/bench-search.mjs";

const { queryTokens, indexTokens, toFtsQuery, CatalogIndex, readCatalog } = Search;
const art = buildArtifacts(catalog);
const realCatalog = JSON.parse(art.catalog.bytes);
const index = new CatalogIndex(realCatalog);
const top = (q, n = 1) => index.search(q, { limit: n }).map((r) => r.id);
let driver = null, driverError = "";
try { driver = loadDriver(); } catch (e) { driverError = e.message.split("\n")[0]; }
const needsDb = driver ? {} : { skip: `no SQLite driver: ${driverError}` };

/** Independent oracle: every query token is a prefix of some index token of the row. */
function bruteForce(rows, query) {
    const q = queryTokens(query);
    if (!q.length) return [];
    return rows.filter((r) => { const toks = Search.rowFields(r).flat(); return q.every((t) => toks.some((x) => x.startsWith(t))); }).map((r) => r.id).sort();
}

// ---------------------------------------------------------------------------
test("queryTokens: case, accents, punctuation, letter/digit splits, stopwords, limits", () => {
    assert.deepEqual(queryTokens("MT-15 V2"), ["mt", "15", "v", "2"]);
    assert.deepEqual(queryTokens("mt15v2"), ["mt", "15", "v", "2"]);
    assert.deepEqual(queryTokens("NS200"), ["ns", "200"]);
    assert.deepEqual(queryTokens("H'ness CB350"), ["hness", "cb", "350"]);
    assert.deepEqual(queryTokens("H’ness"), ["hness"]);                         // typographic apostrophe
    assert.deepEqual(queryTokens("Splendor+"), ["splendor", "plus"]);
    assert.deepEqual(queryTokens("Ólá  S1 Pró"), ["ola", "s", "1", "pro"]);
    assert.deepEqual(queryTokens("classic 350cc"), ["classic", "350"]);
    assert.deepEqual(queryTokens("cc"), []);
    assert.deepEqual(queryTokens("pulsar pulsar PULSAR"), ["pulsar"]);
    assert.deepEqual(queryTokens("  -- !! "), []);
    assert.deepEqual(queryTokens(""), []);
    assert.deepEqual(queryTokens(/** @type {any} */ (null)), []);
    assert.deepEqual(queryTokens(/** @type {any} */ (42)), []);
    assert.equal(queryTokens("a b c d e f g h i j k").length, Search.MAX_QUERY_TOKENS);
    assert.ok(queryTokens("x".repeat(500))[0].length <= Search.MAX_TOKEN_CHARS);
    assert.ok(queryTokens("हीरो स्प्लेंडर").length === 0, "non-Latin scripts match nothing rather than crash");
});

test("indexTokens covers every spelling a rider might type", () => {
    const has = (text, ...toks) => { const t = indexTokens(text); for (const x of toks) assert.ok(t.includes(x), `${text} → ${x} (got ${t.join(" ")})`); };
    has("H'ness CB350", "hness", "h", "ness", "cb", "350");
    has("XPulse 200 4V", "xpulse", "x", "pulse", "200", "4", "v");
    has("iQube", "iqube", "i", "qube");
    has("MT-15", "mt", "15");
    has("Splendor+", "splendor", "plus");
    assert.deepEqual(indexTokens(""), []);
});

test("toFtsQuery quotes every token as a prefix, and refuses anything that isn't a token", () => {
    assert.equal(toFtsQuery(["ns", "200"]), '"ns"* AND "200"*');
    assert.equal(toFtsQuery(queryTokens("and or not near")), '"and"* AND "or"* AND "not"* AND "near"*');
    assert.equal(toFtsQuery([]), null);
    assert.throws(() => toFtsQuery(['x" OR "1']));
    assert.throws(() => toFtsQuery(["NS"]));
});

// ---------------------------------------------------------------------------
test("real catalogue: the bike you type comes first", () => {
    assert.deepEqual(top("hunter"), ["royal-enfield-hunter-350-metro-in"]);
    assert.deepEqual(top("re hunter"), ["royal-enfield-hunter-350-metro-in"]);
    assert.deepEqual(top("royal enfield classic"), ["royal-enfield-classic-350-in"]);
    assert.deepEqual(top("mt15"), ["yamaha-mt-15-v2-in"]);
    assert.deepEqual(top("MT 15"), ["yamaha-mt-15-v2-in"]);
    assert.deepEqual(top("ns 200"), ["bajaj-pulsar-ns200-dual-abs-in"]);
    assert.deepEqual(top("h ness"), ["honda-hness-cb350-dlx-in"]);
    assert.deepEqual(top("cb350"), ["honda-hness-cb350-dlx-in"]);
    assert.deepEqual(top("splendor plus"), ["hero-splendor-plus-obd2b-in"]);
    assert.deepEqual(top("x pulse"), ["hero-xpulse-200-4v-std-in"]);
    assert.deepEqual(top("rtr 160 4v"), ["tvs-apache-rtr-160-4v-dual-abs-usd-in"]);
    assert.deepEqual(top("ather", 5).sort(), ["ather-450-apex-in", "ather-450x-2-9kwh-2025-in", "ather-450x-3-7kwh-2025-in", "ather-rizta-3-7kwh-in"]);
    assert.equal(top("pulsar", 10).length, 10);
});

test("every query word must match (AND), and empty queries return nothing", () => {
    assert.deepEqual(top("pulsar ather", 10), []);
    assert.deepEqual(top("", 10), []);
    assert.deepEqual(top("cc", 10), []);
    assert.deepEqual(top("zzzz", 10), []);
});

test("results are fully ordered and the same on every run", () => {
    const a = index.search("e", { limit: 200 }), b = new CatalogIndex(realCatalog).search("e", { limit: 200 });
    assert.deepEqual(a.map((r) => r.id), b.map((r) => r.id));
    for (let i = 1; i < a.length; i++) assert.ok(Search.compareResults(a[i - 1], a[i]) < 0, `${a[i - 1].id} vs ${a[i].id}`);
    // rankResults (the server's path) orders the same rows identically.
    const rows = index.rows.filter((r) => a.some((x) => x.id === r.id));
    assert.deepEqual(Search.rankResults(rows, queryTokens("e"), 200).map((r) => r.id), a.map((r) => r.id));
});

test("limits are clamped", () => {
    assert.equal(index.search("e", { limit: 0 }).length, 1);
    assert.equal(index.search("e", { limit: 2 }).length, 2);
    assert.ok(index.search("e", { limit: 10_000 }).length <= Search.MAX_LIMIT);
    assert.equal(index.search("e", { limit: /** @type {any} */ ("abc") }).length, Math.min(Search.DEFAULT_LIMIT, index.matchIds("e").length));
});

test("lookups: by id, bundle URL, class list", () => {
    const r = index.get("royal-enfield-hunter-350-metro-in");
    assert.ok(r && r.bundle.length === 16);
    assert.equal(index.bundleUrl(r.bundle), `bundles/${r.bundle}.json`);
    assert.equal(index.get("no-such-bike"), null);
    assert.equal(index.classes.length, 10);
});

test("readCatalog rejects malformed or newer catalogues with a clear message", () => {
    const bad = (mut, re) => { const c = structuredClone(realCatalog); mut(c); assert.throws(() => readCatalog(c), re); };
    bad((c) => { c.format = "mapunite-bike-catalog/2"; }, /newer than this app understands/);
    bad((c) => { c.format = "something-else"; }, /unknown format/);
    bad((c) => { c.columns.model.pop(); }, /column model must be an array/);
    bad((c) => { delete c.columns.size; }, /columns must be exactly/);
    bad((c) => { c.columns.make[0] = 99; }, /row 0 is malformed/);
    bad((c) => { c.bundlePath = "bundles/x.json"; }, /bundlePath/);
    assert.throws(() => readCatalog(null), /not an object/);
});

// ---------------------------------------------------------------------------
// At scale
// ---------------------------------------------------------------------------
test("in-memory index matches a brute-force scan on a 3,000-variant synthetic catalogue", () => {
    const cat = assembleCatalog(syntheticRows(3000, 11), syntheticClasses(), "1.0.0");
    const ix = new CatalogIndex(JSON.parse(cat.bytes));
    for (const q of [...syntheticQueries(cat.rows, 300, 3), "a", "1", "h ness", "plus"]) assert.deepEqual(ix.matchIds(q), bruteForce(ix.rows, q), `"${q}"`);
});

test("FTS5 (the real bundle_search table) matches the in-memory index on 3,000 synthetic variants", needsDb, () => {
    const cat = assembleCatalog(syntheticRows(3000, 12), syntheticClasses(), "1.0.0");
    const ix = new CatalogIndex(JSON.parse(cat.bytes));
    const db = driver.open(":memory:");
    try {
        db.exec(fs.readFileSync(SCHEMA_SQL, "utf8"));
        const ins = db.prepare("INSERT INTO bundle_search (rowid, make, model, variant, aliases) VALUES (?, ?, ?, ?, ?)");
        db.transaction(() => cat.rows.forEach((r, i) => ins.run(i + 1, ...Search.ftsColumns(r))));
        const st = db.prepare("SELECT rowid FROM bundle_search WHERE bundle_search MATCH ?");
        for (const q of syntheticQueries(cat.rows, 300, 5)) {
            const m = toFtsQuery(queryTokens(q));
            const ids = m ? st.all(m).map((r) => cat.rows[Number(r.rowid) - 1].id).sort() : [];
            assert.deepEqual(ids, ix.matchIds(q), `"${q}"`);
        }
    } finally { db.close(); }
});

test(`benchmark: 20,000 variants, FTS5 and in-memory p99 under ${LIMIT_MS} ms with identical matches`, { ...needsDb, timeout: 120000 }, () => {
    const r = runBenchmark({ rows: 20000, queries: 400, driver: driver.name, capacity: false });
    assert.equal(r.mismatchCount, 0, JSON.stringify(r.mismatches));
    assert.ok(r.fts5.query.p99 < LIMIT_MS, `FTS5 p99 ${r.fts5.query.p99.toFixed(2)} ms`);
    assert.ok(r.memory.query.p99 < LIMIT_MS, `in-memory p99 ${r.memory.query.p99.toFixed(2)} ms`);
});
