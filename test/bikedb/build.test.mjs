// Step 3: the build pipeline (catalog.json, bundles/<hash>.json, bikes.sqlite).
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { Contract, catalog, pending, ref, ROOT } from "./helpers.mjs";
import {
    buildArtifacts, writePublic, diffPublic, writeSqlite, diffSqlite, build, canonicalJson, shortHash, gzipSize,
    BuildError, Search, CATALOG_BUDGET_GZIP, HASH_CHARS, BUNDLE_FORMAT, DB_FORMAT
} from "../../scripts/bikedb/catalog-build.mjs";
import { loadDriver } from "../../scripts/bikedb/sqlite-driver.mjs";

const art = buildArtifacts(catalog);
const variants = catalog.entries.filter((e) => e.bundle.kind === "variant").map((e) => e.bundle);
const defaults = new Map(catalog.entries.filter((e) => e.bundle.kind === "class_default").map((e) => [e.bundle.classKey, e.bundle]));
const runtime = (id) => art.bundles.find((b) => b.id === id).runtime;
const tmpdir = () => fs.mkdtempSync(path.join(os.tmpdir(), "bikedb-build-"));
let driver = null, driverError = "";
try { driver = loadDriver(); } catch (e) { driverError = e.message.split("\n")[0]; }
const needsDb = driver ? {} : { skip: `no SQLite driver: ${driverError}` };

/** Same data, every object's keys in reverse order: the output must not change. */
const reverseKeys = (x) => Array.isArray(x) ? x.map(reverseKeys)
    : x && typeof x === "object" ? Object.fromEntries(Object.keys(x).reverse().map((k) => [k, reverseKeys(x[k])])) : x;

// ---------------------------------------------------------------------------
test("canonicalJson sorts keys at every level, keeps array order, and refuses what JSON can't hold", () => {
    assert.equal(canonicalJson({ b: 1, a: { d: [3, 1], c: null } }), '{"a":{"c":null,"d":[3,1]},"b":1}');
    assert.equal(canonicalJson("é\n"), JSON.stringify("é\n"));
    assert.throws(() => canonicalJson({ a: NaN }), BuildError);
    assert.throws(() => canonicalJson({ a: undefined }), BuildError);
    assert.throws(() => canonicalJson({ a: () => 1 }), BuildError);
});

test("builds every catalogue bundle, and nothing from pending/", () => {
    assert.equal(art.counts.variants, variants.length);
    assert.equal(art.counts.classDefaults, 10);
    assert.equal(art.bundles.length, catalog.entries.length);
    assert.equal(art.catalog.object.count, variants.length);
    const built = new Set(art.bundles.map((b) => b.id));
    for (const p of pending) assert.ok(!built.has(p.bundle.id), `${p.bundle.id} is pending but was built`);
});

test("each bundle is canonical JSON named by the hash of its bytes", () => {
    for (const b of art.bundles) {
        assert.match(b.hash, new RegExp(`^[0-9a-f]{${HASH_CHARS}}$`));
        assert.equal(shortHash(b.bytes), b.hash);
        assert.equal(canonicalJson(JSON.parse(b.bytes)), b.bytes, `${b.id} is not canonical`);
        assert.equal(JSON.parse(b.bytes).format, BUNDLE_FORMAT);
    }
    assert.equal(new Set(art.bundles.map((b) => b.hash)).size, art.bundles.length, "hashes are unique");
});

test("same input, same output — whatever the file order or key order", () => {
    const again = buildArtifacts(catalog);
    assert.equal(again.catalog.bytes, art.catalog.bytes);
    assert.deepEqual(again.bundles.map((b) => b.bytes), art.bundles.map((b) => b.bytes));
    const shuffled = { entries: [...catalog.entries].reverse().map((e) => ({ ...e, bundle: reverseKeys(e.bundle) })), ref: reverseKeys(ref) };
    const s = buildArtifacts(shuffled);
    assert.equal(s.catalog.bytes, art.catalog.bytes);
    assert.equal(s.inputHash, art.inputHash);
    assert.deepEqual(s.bundles.map((b) => b.hash).sort(), art.bundles.map((b) => b.hash).sort());
});

test("changing one bike changes only that bike's bundle (and the catalogue version)", () => {
    const entries = catalog.entries.map((e) => {
        if (e.bundle.id !== "royal-enfield-hunter-350-metro-in") return e;
        const b = structuredClone(e.bundle);
        b.chassis.mass.v = 180;
        return { ...e, bundle: b };
    });
    const changed = buildArtifacts({ entries, ref });
    const before = new Map(art.bundles.map((b) => [b.id, b.hash]));
    const diff = changed.bundles.filter((b) => before.get(b.id) !== b.hash).map((b) => b.id);
    assert.deepEqual(diff, ["royal-enfield-hunter-350-metro-in"]);
    assert.notEqual(changed.catalog.version, art.catalog.version);
    assert.notEqual(changed.inputHash, art.inputHash);
});

test("refuses to build an invalid catalogue, and names the file and the problem", () => {
    const entries = catalog.entries.map((e) => {
        if (e.bundle.id !== "honda-shine-125-obd2b-in") return e;
        const b = structuredClone(e.bundle);
        b.engine.peakPower.u = "hp";
        return { ...e, bundle: b };
    });
    assert.throws(() => buildArtifacts({ entries, ref }), (e) => e instanceof BuildError && /honda-shine-125-obd2b-in\.json engine\.peakPower\.u: .*\[unit\]/.test(e.message));
});

// ---------------------------------------------------------------------------
// Runtime bundle content
// ---------------------------------------------------------------------------
const FIELD = new Map(Contract.FIELDS.map((f) => [f.path, f]));
/** Every SI unit a bundle or the database may contain. */
const SI_ONLY = new Set(["1", "m", "m2", "m3", "kg", "m/s", "rad/s", "N*m", "W", "J", "V", "Pa", "Pa*s/rad", "Pa*s2/rad2", "J/m3", "kg/m3"]);

test("SI conversions: exact factors, decimal shifts without binary noise, every contract unit covered", () => {
    assert.equal(Contract.toSI(349.34, "cm3"), 0.00034934);
    assert.equal(Contract.toSI(14.87, "kW"), 14870);
    assert.equal(Contract.toSI(13, "L"), 0.013);
    assert.equal(Contract.toSI(2.9, "kWh"), 2.9 * 3.6e6);
    assert.equal(Contract.toSI(6100, "rpm"), 6100 * Math.PI / 30);
    assert.equal(Contract.toSI(100, "km/h"), 100 * 1000 / 3600);
    assert.equal(Contract.toSI(30.14, "MJ/L"), 3.014e10);
    assert.equal(Contract.toSI(0.7475, "kg/L"), 747.5);
    assert.equal(Contract.toSI(91, "RON"), 91);
    assert.ok(Math.abs(Contract.toSI(8, "kPa/krpm") - 8000 / (1000 * Math.PI / 30)) < 1e-9);
    assert.ok(Math.abs(Contract.toSI(0.6, "kPa/krpm2") - 600 / (1000 * Math.PI / 30) ** 2) < 1e-12);
    assert.deepEqual(Contract.toSI([2.615, 1.706], "1"), [2.615, 1.706]);
    assert.throws(() => Contract.toSI(1, "hp"), /no SI conversion/);
    for (const f of Contract.FIELDS) if (f.type !== "c") assert.ok(SI_ONLY.has(Contract.siUnit(f.unit)), `${f.path}: ${f.unit} → ${Contract.siUnit(f.unit)}`);
    for (const g of ref.fuelGrades.grades) for (const k of ["lhv", "density", "typicalRon"]) if (g[k]) assert.ok(SI_ONLY.has(Contract.siUnit(g[k].u)));
});

/** Collect every { u } in a runtime bundle except published originals. */
function unitsIn(x, out = new Set(), inPublished = false) {
    if (Array.isArray(x)) { for (const y of x) unitsIn(y, out, inPublished); return out; }
    if (!x || typeof x !== "object") return out;
    for (const [k, v] of Object.entries(x)) {
        if (k === "u" && typeof v === "string" && !inPublished) out.add(v);
        else unitsIn(v, out, inPublished || k === "published");
    }
    return out;
}

test("a bundle is strict SI: every quantity converted, the published figure kept beside it, provenance untouched", () => {
    for (const b of [...variants, ...defaults.values()]) {
        const rt = runtime(b.id);
        assert.equal(rt.units, "SI");
        for (const k of ["schemaVersion", "id", "kind", "classKey", "segment", "powertrain", "identity", "sources"]) assert.deepEqual(rt[k], b[k], `${b.id} ${k}`);
        assert.equal(rt.$schema, undefined);
        for (const u of unitsIn(rt)) assert.ok(SI_ONLY.has(u), `${b.id}: non-SI unit "${u}" outside published`);
        for (const g of ["engine", "motor", "battery", "transmission", "chassis", "emission", "fuel"]) {
            if (!b[g]) { assert.equal(rt[g], undefined); continue; }
            for (const [k, v] of Object.entries(b[g])) {
                const f = FIELD.get(`${g}.${k}`), out = rt[g][k];
                if (!f || f.type === "c") { assert.deepEqual(out, v, `${b.id} ${g}.${k}`); continue; }
                assert.deepEqual(out.v, Contract.toSI(v.v, v.u), `${b.id} ${g}.${k}`);
                assert.equal(out.u, Contract.siUnit(v.u));
                assert.equal(out.src, v.src);
                assert.equal(out.conf, v.conf);
                if (v.tol !== undefined) assert.equal(out.tol, Contract.toSI(v.tol, v.u));
                if (out.u === v.u) assert.equal(out.published, undefined);
                else assert.deepEqual(out.published, v.tol !== undefined ? { v: v.v, u: v.u, tol: v.tol } : { v: v.v, u: v.u });
            }
        }
    }
    const h = runtime("royal-enfield-hunter-350-metro-in");
    assert.deepEqual([h.engine.peakPower.v, h.engine.peakPower.u, h.engine.peakPower.published], [14870, "W", { v: 14.87, u: "kW" }]);
    assert.deepEqual([h.engine.displacement.v, h.engine.displacement.u], [0.00034934, "m3"]);
    assert.equal(h.engine.peakPowerRpm.u, "rad/s");
    assert.deepEqual([h.chassis.fuelTank.v, h.chassis.fuelTank.u], [0.013, "m3"]);
    const ather = runtime("ather-450x-2-9kwh-2025-in");
    assert.deepEqual([ather.battery.grossCapacity.v, ather.battery.grossCapacity.u], [2.9 * 3.6e6, "J"]);
});

test("image_url is on every bundle and catalogue row: null until a picture is sourced, the file's https URL when it is", () => {
    for (const b of art.bundles) assert.ok("image_url" in b.runtime && b.runtime.image_url === null, b.id);
    const c = JSON.parse(art.catalog.bytes);
    assert.ok(c.columns.image_url.every((x) => x === null));
    assert.ok(c.classes.every((x) => x.image_url === null));
    // With a sourced picture:
    const entries = catalog.entries.map((e) => {
        if (e.bundle.id !== "bajaj-chetak-c3501-in") return e;
        const b = structuredClone(e.bundle);
        b.image = { url: "https://cdn.example.com/chetak-c3501.webp", src: b.sources[0].id, credit: "Bajaj Auto" };
        return { ...e, bundle: b };
    });
    const withImg = buildArtifacts({ entries, ref });
    const rt = withImg.bundles.find((x) => x.id === "bajaj-chetak-c3501-in").runtime;
    assert.equal(rt.image_url, "https://cdn.example.com/chetak-c3501.webp");
    assert.equal(rt.image.credit, "Bajaj Auto");
    const row = Search.readCatalog(JSON.parse(withImg.catalog.bytes)).rows.find((r) => r.id === "bajaj-chetak-c3501-in");
    assert.equal(row.image_url, "https://cdn.example.com/chetak-c3501.webp");
});

test("the contract checks an image: https only, a real source, no unknown keys", () => {
    const base = structuredClone(catalog.entries.find((e) => e.bundle.id === "bajaj-chetak-c3501-in").bundle);
    const check = (image) => Contract.validateBundle({ ...base, image }, ref);
    assert.equal(check({ url: "https://cdn.example.com/x.webp", src: base.sources[0].id }).ok, true);
    assert.ok(check({ url: "http://cdn.example.com/x.webp", src: base.sources[0].id }).errors.some((e) => e.path === "image.url"));
    assert.ok(check({ url: "https://cdn.example.com/x.webp", src: "nope" }).errors.some((e) => e.code === "provenance"));
    assert.ok(check({ url: "https://cdn.example.com/x.webp", src: base.sources[0].id, alt: "x" }).errors.some((e) => e.code === "unknown_key"));
    assert.ok(check("https://cdn.example.com/x.webp").errors.some((e) => e.path === "image"));
});

test("priors are complete: the bike's own, else the class default's, marked inherited with that default's sources", () => {
    for (const b of variants) {
        const rt = runtime(b.id), d = defaults.get(b.classKey);
        assert.equal(rt.classDefault.id, d.id);
        const applicable = Contract.FIELDS.filter((f) => f.path.startsWith("priors.") && f.allow.includes(b.powertrain)).map((f) => f.path.slice(7));
        assert.deepEqual(Object.keys(rt.priors).sort(), applicable.sort(), b.id);
        const cdSources = new Set(rt.classDefault.sources.map((s) => s.id));
        for (const [k, p] of Object.entries(rt.priors)) {
            const srcPrior = (b.priors && b.priors[k]) || d.priors[k];
            const unit = FIELD.get(`priors.${k}`).unit;
            assert.equal(p.mean, Contract.toSI(srcPrior.mean, unit), `${b.id} ${k}`);
            assert.equal(p.sigma, Contract.toSI(srcPrior.sigma, unit));
            assert.equal(p.u, Contract.siUnit(unit));
            if (p.u !== unit) assert.deepEqual(p.published, { mean: srcPrior.mean, sigma: srcPrior.sigma, u: unit });
            if (b.priors && b.priors[k]) assert.equal(p.inherited, undefined);
            else {
                assert.equal(p.inherited, true);
                assert.equal(p.src, d.priors[k].src);
                assert.ok(cdSources.has(p.src), `${b.id} ${k}: src ${p.src} missing from classDefault.sources`);
            }
        }
    }
});

test("fuel advice in the bundle is exactly the contract's decision", () => {
    for (const b of [...variants, ...defaults.values()]) {
        const rt = runtime(b.id);
        if (b.powertrain === "ev") { assert.equal(rt.fuelAdvice, undefined); assert.equal(rt.reference, undefined); continue; }
        const expected = ref.fuelGrades.grades.map((g) => g.code).filter((c) => Contract.isFuelAdvisable(b, c, ref));
        assert.deepEqual(rt.fuelAdvice.advisable, expected, b.id);
        assert.equal(rt.fuelAdvice.minConf, Contract.ADVISE_MIN_CONF);
        assert.deepEqual(rt.reference.fuelGrades.grades.map((g) => g.code), ref.fuelGrades.grades.map((g) => g.code));
        const e20 = rt.reference.fuelGrades.grades.find((g) => g.code === "E20");
        assert.deepEqual([e20.lhv.v, e20.lhv.u, e20.lhv.published], [3.014e10, "J/m3", { v: 30.14, u: "MJ/L" }]);
        assert.deepEqual([e20.density.u, e20.typicalRon.u], ["kg/m3", "1"]);
        assert.equal(rt.reference.emission.standard.code, b.emission.standard.v);
        const refSrc = new Set(rt.reference.fuelGrades.sources.map((s) => s.id));
        for (const g of rt.reference.fuelGrades.grades) for (const k of ["lhv", "density", "typicalRon"]) if (g[k]) assert.ok(refSrc.has(g[k].src));
    }
    for (const d of defaults.values()) if (d.powertrain !== "ev") assert.deepEqual(runtime(d.id).fuelAdvice.advisable, [], "class defaults never advise a fuel");
    assert.deepEqual(runtime("honda-activa-110-dlx-obd2b-in").fuelAdvice.advisable, []);
    assert.ok(runtime("royal-enfield-hunter-350-metro-in").fuelAdvice.advisable.includes("E20"));
    for (const b of art.bundles) if (b.runtime.fuelAdvice) assert.ok(!b.runtime.fuelAdvice.advisable.some((c) => c === "E85" || c === "E100"), `${b.id}: flex blend advised`);
});

// ---------------------------------------------------------------------------
// catalog.json
// ---------------------------------------------------------------------------
test("catalog.json: within budget, readable by the app, every row pointing at its bundle", () => {
    assert.ok(art.catalog.gzipBytes <= CATALOG_BUDGET_GZIP);
    assert.equal(art.catalog.gzipBytes, gzipSize(art.catalog.bytes));
    const c = Search.readCatalog(JSON.parse(art.catalog.bytes));
    assert.equal(c.version, art.catalog.version);
    assert.equal(JSON.parse(art.catalog.bytes).units, "SI");
    const hunter = c.rows.find((r) => r.id === "royal-enfield-hunter-350-metro-in"), ather = c.rows.find((r) => r.id === "ather-450x-2-9kwh-2025-in");
    assert.equal(Search.formatSize(hunter), "349 cc");
    assert.equal(Search.formatSize(ather), "2.9 kWh");
    assert.deepEqual(c.classes.map((x) => x.key), Object.entries(Contract.CLASS_MATRIX).flatMap(([pt, s]) => s.map((x) => `${pt}.${x}`)));
    const hashes = new Map(art.bundles.map((b) => [b.id, b.hash]));
    for (const cl of c.classes) assert.equal(cl.bundle, hashes.get(defaults.get(cl.key).id));
    assert.equal(c.rows.length, variants.length);
    for (const r of c.rows) {
        const b = variants.find((v) => v.id === r.id);
        assert.equal(r.bundle, hashes.get(r.id));
        assert.deepEqual([r.make, r.model, r.variant, r.market, r.yearFrom, r.yearTo, r.classKey, r.aliases],
            [b.identity.make, b.identity.model, b.identity.variant ?? null, b.identity.market, b.identity.yearFrom, b.identity.yearTo, b.classKey, b.identity.aliases]);
        if (b.powertrain === "ev") { assert.equal(r.sizeUnit, "J"); assert.equal(r.size, Contract.toSI(b.battery.grossCapacity.v, "kWh")); }
        else { assert.equal(r.sizeUnit, "m3"); assert.equal(r.size, Contract.toSI(b.engine.displacement.v, "cm3")); }
        assert.equal(r.image_url, null);
    }
    // The catalogue version is the hash of everything else in it.
    const { version, ...body } = JSON.parse(art.catalog.bytes);
    assert.equal(shortHash(canonicalJson(body)), version);
});

// ---------------------------------------------------------------------------
// public/bikedb/ on disk
// ---------------------------------------------------------------------------
test("writePublic writes exactly the build, skips unchanged files and prunes stale bundles", () => {
    const dir = tmpdir();
    try {
        const first = writePublic(art, dir);
        assert.equal(first.written, art.bundles.length);
        assert.deepEqual(fs.readdirSync(dir).sort(), [".gitignore", "bundles", "catalog.json"]);
        assert.deepEqual(fs.readdirSync(path.join(dir, "bundles")).sort(), art.bundles.map((b) => `${b.hash}.json`).sort());
        for (const b of art.bundles) assert.equal(fs.readFileSync(path.join(dir, "bundles", `${b.hash}.json`), "utf8"), b.bytes);
        assert.deepEqual(diffPublic(art, dir), []);

        fs.writeFileSync(path.join(dir, "bundles", "0123456789abcdef.json"), "{}");      // a bundle from an older build
        fs.writeFileSync(path.join(dir, "bundles", "README.txt"), "not ours");            // anything else is left alone
        assert.deepEqual(diffPublic(art, dir), ["bundles/0123456789abcdef.json is stale"]);
        const second = writePublic(art, dir);
        assert.deepEqual([second.written, second.unchanged, second.pruned], [0, art.bundles.length, 1]);
        assert.ok(fs.existsSync(path.join(dir, "bundles", "README.txt")));
        assert.deepEqual(diffPublic(art, dir), []);

        fs.writeFileSync(path.join(dir, "bundles", `${art.bundles[0].hash}.json`), "{}");
        assert.match(diffPublic(art, dir).join("\n"), /doesn't match its hash/);
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("build() writes nothing when validation fails", async () => {
    const dir = tmpdir();
    try {
        fs.cpSync(path.join(ROOT, "data", "bikes"), path.join(dir, "data"), { recursive: true });
        const f = path.join(dir, "data", "variants", "tvs-raider-125-split-seat-in.json");
        const b = JSON.parse(fs.readFileSync(f, "utf8"));
        b.fuel.compat = [];
        fs.writeFileSync(f, JSON.stringify(b));
        await assert.rejects(build({ dataDir: path.join(dir, "data"), publicDir: path.join(dir, "pub"), dbFile: path.join(dir, "db", "bikes.sqlite") }), BuildError);
        assert.ok(!fs.existsSync(path.join(dir, "pub")) && !fs.existsSync(path.join(dir, "db")));
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

// ---------------------------------------------------------------------------
// bikes.sqlite
// ---------------------------------------------------------------------------
test("bikes.sqlite: byte-identical rebuilds, intact, and every value round-trips", needsDb, () => {
    const dir = tmpdir();
    try {
        const a = writeSqlite(art, ref, path.join(dir, "a.sqlite"), driver);
        const b = writeSqlite(buildArtifacts(catalog), ref, path.join(dir, "b.sqlite"), driver);
        assert.ok(fs.readFileSync(a.file).equals(fs.readFileSync(b.file)), "same input must give the same bytes");
        assert.deepEqual(fs.readdirSync(dir).sort(), [".gitignore", "a.sqlite", "b.sqlite"], "no temp files left behind");
        assert.deepEqual(diffSqlite(art, a.file, driver), []);

        const db = driver.open(a.file, { readonly: true });
        try {
            const one = (sql, ...p) => Object.values(db.prepare(sql).get(...p))[0];
            assert.equal(Number(one("PRAGMA user_version")), DB_FORMAT);
            assert.equal(Number(one("PRAGMA application_id")), 0x4D55424B);
            assert.equal(one("PRAGMA integrity_check"), "ok");
            assert.equal(db.prepare("PRAGMA foreign_key_check").all().length, 0);
            const meta = Object.fromEntries(db.prepare("SELECT key, value FROM meta").all().map((r) => [r.key, r.value]));
            assert.equal(meta.catalog_version, art.catalog.version);
            assert.equal(meta.input_hash, art.inputHash);
            assert.equal(meta.schema_version, Contract.SCHEMA_VERSION);

            assert.equal(Number(one("SELECT count(*) FROM bundle")), art.bundles.length);
            assert.equal(Number(one("SELECT count(*) FROM class_default")), 10);
            assert.equal(Number(one("SELECT count(*) FROM field")), Contract.FIELDS.length);
            assert.equal(Number(one("SELECT count(*) FROM v_variant")), variants.length);
            assert.equal(Number(one("SELECT count(*) FROM source")), catalog.entries.reduce((n, e) => n + e.bundle.sources.length, 0));

            const idOf = new Map(db.prepare("SELECT slug, bundle_id FROM bundle").all().map((r) => [r.slug, Number(r.bundle_id)]));
            const spec = db.prepare("SELECT * FROM spec_value WHERE bundle_id = ? AND path = ?");
            const prior = db.prepare("SELECT * FROM prior WHERE bundle_id = ? AND path = ?");
            for (const e of catalog.entries) {
                const bun = e.bundle, id = idOf.get(bun.id);
                const row = db.prepare("SELECT hash, body FROM bundle WHERE bundle_id = ?").get(id);
                const built = art.bundles.find((x) => x.id === bun.id);
                assert.equal(row.hash, built.hash);
                assert.equal(row.body, built.bytes, `${bun.id}: body must be the served bytes`);
                for (const f of Contract.FIELDS) {
                    const [g, k] = f.path.split(".");
                    const v = bun[g] && bun[g][k];
                    const r = f.type === "p" ? prior.get(id, f.path) : spec.get(id, f.path);
                    if (!v) { assert.equal(r, undefined, `${bun.id} ${f.path} should be absent`); continue; }
                    assert.ok(r, `${bun.id} ${f.path} missing`);
                    assert.equal(r.source_key, v.src);
                    assert.equal(r.conf, v.conf);
                    if (f.type === "p") {
                        assert.equal(r.mean, Contract.toSI(v.mean, f.unit)); assert.equal(r.sigma, Contract.toSI(v.sigma, f.unit));
                        assert.equal(r.published_mean, v.mean); assert.equal(r.published_sigma, v.sigma);
                    } else if (f.type === "q") {
                        assert.equal(r.value, Contract.toSI(v.v, f.unit), `${bun.id} ${f.path}`); assert.equal(r.published_value, v.v);
                        assert.equal(r.tol, v.tol === undefined ? null : Contract.toSI(v.tol, f.unit)); assert.equal(r.published_tol, v.tol === undefined ? null : v.tol);
                    } else if (f.type === "qa") {
                        assert.deepEqual(JSON.parse(r.vals), Contract.toSI(v.v, f.unit)); assert.deepEqual(JSON.parse(r.published_vals), v.v);
                    } else if (typeof v.v === "boolean") assert.equal(Number(r.flag), v.v ? 1 : 0);
                    else assert.equal(r.txt, v.v);
                }
                const advisable = new Set(built.runtime.fuelAdvice ? built.runtime.fuelAdvice.advisable : []);
                const compat = db.prepare("SELECT fuel_code, status, advisable FROM fuel_compat WHERE bundle_id = ? ORDER BY ord").all(id);
                assert.deepEqual(compat.map((c) => [c.fuel_code, c.status, Number(c.advisable)]),
                    ((bun.fuel && bun.fuel.compat) || []).map((c) => [c.fuel, c.status, advisable.has(c.fuel) ? 1 : 0]));
            }
            // Units: SI only, in every SI column and view.
            for (const r of db.prepare("SELECT path, unit, published_unit, si_factor FROM field WHERE unit IS NOT NULL").all()) {
                assert.ok(SI_ONLY.has(r.unit), `field ${r.path}: ${r.unit}`);
                assert.equal(r.unit, Contract.siUnit(r.published_unit));
                assert.equal(r.si_factor, Contract.toSI(1, r.published_unit));
            }
            for (const r of db.prepare("SELECT DISTINCT unit FROM v_spec_si WHERE unit IS NOT NULL UNION SELECT DISTINCT unit FROM v_resolved_prior UNION SELECT DISTINCT unit FROM fuel_grade_property").all()) assert.ok(SI_ONLY.has(r.unit), r.unit);
            const hunterId = idOf.get("royal-enfield-hunter-350-metro-in");
            const si = (path) => db.prepare("SELECT value, unit FROM v_spec_si WHERE bundle_id = ? AND path = ?").get(hunterId, path);
            assert.deepEqual({ ...si("engine.peakPower") }, { value: 14870, unit: "W" });
            assert.deepEqual({ ...si("engine.displacement") }, { value: 0.00034934, unit: "m3" });
            assert.deepEqual({ ...si("engine.peakPowerRpm") }, { value: 6100 * Math.PI / 30, unit: "rad/s" });
            assert.deepEqual({ ...si("chassis.fuelTank") }, { value: 0.013, unit: "m3" });
            const ev = db.prepare("SELECT displacement_m3, battery_gross_j, image_url FROM v_variant WHERE slug = 'ather-450x-2-9kwh-2025-in'").get();
            assert.deepEqual({ ...ev }, { displacement_m3: null, battery_gross_j: 2.9 * 3.6e6, image_url: null });
            // Inheritance in SQL (v_resolved_prior) agrees with the bundles.
            for (const v of variants) {
                const rows = db.prepare("SELECT path, mean, sigma, inherited FROM v_resolved_prior WHERE bundle_id = ? ORDER BY path").all(idOf.get(v.id));
                const rt = runtime(v.id).priors;
                assert.deepEqual(rows.map((r) => [r.path.slice(7), r.mean, r.sigma, Number(r.inherited) === 1]).sort(),
                    Object.entries(rt).map(([k, p]) => [k, p.mean, p.sigma, p.inherited === true]).sort(), v.id);
            }
            // The reference tables made it in.
            assert.equal(Number(one("SELECT count(*) FROM fuel_grade")), ref.fuelGrades.grades.length);
            assert.equal(one("SELECT value FROM fuel_grade_property WHERE code = 'E20' AND property = 'lhv'"), 3.014e10);
            assert.equal(one("SELECT published_value FROM fuel_grade_property WHERE code = 'E20' AND property = 'lhv'"), ref.fuelGrades.grades.find((g) => g.code === "E20").lhv.v);
            assert.equal(Number(one("SELECT count(*) FROM emission_standard")), ref.emissionStandards.standards.length);
        } finally { db.close(); }
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("bikes.sqlite: the schema itself rejects bad data", needsDb, () => {
    const dir = tmpdir();
    try {
        const file = path.join(dir, "x.sqlite");
        writeSqlite(art, ref, file, driver);
        const db = driver.open(file);
        try {
            db.exec("PRAGMA foreign_keys = ON");
            const id = Number(Object.values(db.prepare("SELECT bundle_id FROM bundle WHERE slug = 'royal-enfield-hunter-350-metro-in'").get())[0]);
            const bad = [
                ["a prior with no uncertainty", () => db.prepare("INSERT INTO prior (bundle_id, path, mean, sigma, source_key, conf) VALUES (?, 'priors.cda', 0.5, 0, 're-hunter-spec-2026', 0.5)").run(id)],
                ["a value citing a source the bike doesn't have", () => db.prepare("INSERT INTO spec_value (bundle_id, path, num, source_key, conf) VALUES (?, 'engine.redlineRpm', 7000, 'no-such-source', 0.5)").run(id)],
                ["an unknown field", () => db.prepare("INSERT INTO spec_value (bundle_id, path, num, source_key, conf) VALUES (?, 'engine.turbo', 1, 're-hunter-spec-2026', 0.5)").run(id)],
                ["a confidence above 1", () => db.prepare("UPDATE spec_value SET conf = 1.5 WHERE bundle_id = ? AND path = 'chassis.mass'").run(id)],
                ["a fuel advised that the source doesn't approve", () => db.prepare("UPDATE fuel_compat SET status = 'not_approved' WHERE bundle_id = ? AND advisable = 1").run(id)],
                ["a variant made the class default", () => db.prepare("UPDATE class_default SET bundle_id = ? WHERE class_key = 'ice_manual.naked'").run(id)],
                ["text in a number column (STRICT)", () => db.prepare("UPDATE bundle SET year_from = 'twenty' WHERE bundle_id = ?").run(id)],
                ["an SI value without its published figure", () => db.prepare("UPDATE spec_value SET published_value = NULL WHERE bundle_id = ? AND path = 'chassis.mass'").run(id)],
                ["a non-SI fuel energy unit", () => db.prepare("UPDATE fuel_grade_property SET unit = 'MJ/L' WHERE code = 'E20' AND property = 'lhv'").run()],
                ["an http image", () => db.prepare("UPDATE bundle SET image_url = 'http://example.com/x.jpg' WHERE bundle_id = ?").run(id)]
            ];
            for (const [what, fn] of bad) assert.throws(fn, undefined, `schema accepted ${what}`);
        } finally { db.close(); }
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("bikes.sqlite: FTS5 finds bikes by any spelling, and matches the in-memory index exactly", needsDb, () => {
    const dir = tmpdir();
    try {
        const file = path.join(dir, "s.sqlite");
        writeSqlite(art, ref, file, driver);
        const db = driver.open(file, { readonly: true });
        const index = new Search.CatalogIndex(JSON.parse(art.catalog.bytes));
        try {
            const st = db.prepare("SELECT b.slug FROM bundle_search s JOIN bundle b ON b.bundle_id = s.rowid WHERE bundle_search MATCH ?");
            const fts = (q) => { const m = Search.toFtsQuery(Search.queryTokens(q)); return m ? st.all(m).map((r) => r.slug).sort() : []; };
            assert.deepEqual(fts("hunter"), ["royal-enfield-hunter-350-metro-in"]);
            assert.deepEqual(fts("mt15"), ["yamaha-mt-15-v2-in"]);
            assert.deepEqual(fts("h ness"), ["honda-hness-cb350-dlx-in"]);
            const queries = ["re", "royal enfield", "350", "350cc", "pulsar", "ns 200", "ather 450", "kwh", "scooter", "splendor plus", "x pulse",
                "iqube", "e", "1", "tvs", "bajaj chetak", "and", "not", "near", "honda dio", "zzz", "rtr160", "classic", "himalayan 450", "r15", "v4"];
            for (const q of queries) assert.deepEqual(fts(q), index.matchIds(q), `"${q}"`);
            // FTS5 doesn't index class defaults: those are offered by class, not by name.
            assert.deepEqual(fts("generic"), []);
        } finally { db.close(); }
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------
test("CLI: builds, --check passes, a data change makes --check fail, bad arguments exit 2", { ...needsDb, timeout: 120000 }, () => {
    const dir = tmpdir();
    try {
        const cli = path.join(ROOT, "scripts", "build-bike-catalog.mjs");
        fs.cpSync(path.join(ROOT, "data", "bikes"), path.join(dir, "data"), { recursive: true });
        const args = ["--data", path.join(dir, "data"), "--out-public", path.join(dir, "pub"), "--out-db", path.join(dir, "db", "bikes.sqlite"), "--driver", driver.name];
        const run = (...extra) => spawnSync(process.execPath, [cli, ...args, ...extra], { encoding: "utf8", env: process.env });
        const built = run("--json");
        assert.equal(built.status, 0, built.stderr);
        const summary = JSON.parse(built.stdout);
        assert.equal(summary.catalogVersion, art.catalog.version);
        assert.equal(summary.bundles.count, art.bundles.length);
        assert.equal(fs.readFileSync(path.join(dir, "pub", "catalog.json"), "utf8"), art.catalog.bytes);
        assert.equal(run("--check").status, 0);

        const f = path.join(dir, "data", "variants", "hero-splendor-plus-obd2b-in.json");
        const b = JSON.parse(fs.readFileSync(f, "utf8"));
        b.chassis.fuelTank.v = 9.6;
        fs.writeFileSync(f, JSON.stringify(b));
        const stale = run("--check");
        assert.equal(stale.status, 1);
        assert.match(stale.stderr, /catalog\.json is out of date/);
        assert.match(stale.stderr, /bikes\.sqlite was built from different data/);

        const bad = spawnSync(process.execPath, [cli, "--frobnicate"], { encoding: "utf8" });
        assert.equal(bad.status, 2);
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
