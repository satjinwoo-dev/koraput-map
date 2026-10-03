// Step 3: lib/bikedb/schema.sql + scripts/build-bike-catalog.mjs — SI output, repeatable
// builds, immutable hashed bundles, image_url, fuel safety in SQLite, FTS5 search speed.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import zlib from "node:zlib";
import { createRequire } from "node:module";
import { build, compileBundle } from "../../scripts/build-bike-catalog.mjs";
import { benchSearch } from "../../scripts/bikedb/bench-search.mjs";
import { Contract, catalog, pending, ref, clone, ROOT } from "./helpers.mjs";

const require = createRequire(import.meta.url);
const { DatabaseSync } = require("node:sqlite");
const { makeSearch } = require("../../lib/bikedb/search.js");
const { toSI } = require("../../lib/bikedb/si-units.js");
const Keys = require("../../public/js/bikedb/search-keys.js");

const SI_UNITS = new Set(["1", "m", "m2", "m3", "kg", "W", "N*m", "rad/s", "m/s", "J", "V", "Pa", "Pa/(rad/s)", "Pa/(rad/s)2"]);
const RPM = (2 * Math.PI) / 60;
let tmp, out, db;
const readJson = (f) => JSON.parse(fs.readFileSync(f, "utf8"));
const catalogRows = () => {
    const c = readJson(path.join(out, "catalog.json"));
    return c.rows.map((r) => Object.fromEntries(c.columns.map((k, i) => [k, r[i]])));
};
const bundleOf = (id) => readJson(path.join(out, "bundles", `${catalogRows().find((r) => r.id === id).bundle}.json`));
/** Copy of data/bikes to mutate. */
function dataCopy() {
    const d = fs.mkdtempSync(path.join(tmp, "data-"));
    fs.cpSync(path.join(ROOT, "data/bikes"), d, { recursive: true });
    return d;
}

before(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "bikedb-build-"));
    out = path.join(tmp, "out");
    build({ outDir: out });
    db = new DatabaseSync(path.join(out, "bikes.sqlite"), { readOnly: true });
});
after(() => {
    db.close();
    fs.rmSync(tmp, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
test("the build is repeatable: same input, same bytes", () => {
    const out2 = path.join(tmp, "out2");
    build({ outDir: out2 });
    const files = (d) => fs.readdirSync(d, { recursive: true }).filter((f) => fs.statSync(path.join(d, f)).isFile()).sort();
    assert.deepEqual(files(out2), files(out));
    for (const f of files(out)) assert.ok(fs.readFileSync(path.join(out, f)).equals(fs.readFileSync(path.join(out2, f))), f);
});

test("bundles are immutable: the file name is the hash of its bytes", () => {
    const names = fs.readdirSync(path.join(out, "bundles"));
    assert.equal(names.length, catalog.entries.length);
    for (const n of names) {
        const h = crypto.createHash("sha256").update(fs.readFileSync(path.join(out, "bundles", n))).digest("hex").slice(0, 16);
        assert.equal(n, `${h}.json`);
    }
    const hashes = new Set(catalogRows().map((r) => r.bundle));
    assert.deepEqual([...hashes].sort(), names.map((n) => n.replace(".json", "")).sort());
});

test("catalog.json: every variant and class default, compact, with image_url", () => {
    const c = readJson(path.join(out, "catalog.json"));
    assert.ok(c.columns.includes("image_url"));
    assert.match(c.catalog_version, /^[0-9a-f]{16}$/);
    const rows = catalogRows();
    assert.equal(rows.filter((r) => r.kind === "variant").length, catalog.entries.filter((e) => e.bundle.kind === "variant").length);
    assert.equal(rows.filter((r) => r.kind === "class_default").length, catalog.entries.filter((e) => e.bundle.kind === "class_default").length);
    for (const r of rows) {
        assert.ok("image_url" in r, r.id);
        assert.ok(r.image_url === null || /^https:\/\//.test(r.image_url), r.id);
    }
    const gz = zlib.gzipSync(fs.readFileSync(path.join(out, "catalog.json")), { level: 9 }).length;
    assert.ok(gz < 300 * 1024, `${gz} B gzipped`);
    // fuel grades travel with the catalog, in SI (energy per m3)
    const e20 = c.fuel_grades.find((g) => g.code === "E20");
    assert.ok(e20.lhv_j_per_m3 > 25e9 && e20.lhv_j_per_m3 < 35e9, String(e20.lhv_j_per_m3));
});

test("every bundle carries image_url, and a sourced image flows through to all three outputs", () => {
    for (const r of catalogRows()) assert.ok("image_url" in bundleOf(r.id), r.id);
    const data = dataCopy();
    const file = path.join(data, "variants", "yamaha-mt-15-v2-in.json");
    const b = readJson(file);
    const url = "https://www.yamaha-motor-india.com/theme/v3/image/mt15-v2/side.png";
    b.media = { image: { v: url, src: "yamaha-mt15-site", conf: 0.9 } };
    fs.writeFileSync(file, JSON.stringify(b));
    const o = path.join(tmp, "out-image");
    build({ dataDir: data, outDir: o });
    const c = readJson(path.join(o, "catalog.json"));
    const row = c.rows.find((r) => r[0] === b.id);
    assert.equal(row[c.columns.indexOf("image_url")], url);
    assert.equal(readJson(path.join(o, "bundles", `${row[c.columns.indexOf("bundle")]}.json`)).image_url, url);
    const d2 = new DatabaseSync(path.join(o, "bikes.sqlite"), { readOnly: true });
    const r = d2.prepare("SELECT b.image_url, b.image_conf, s.kind FROM bundle b JOIN source s ON s.source_pk = b.image_source_pk WHERE bundle_id = ?").get(b.id);
    d2.close();
    assert.deepEqual({ ...r }, { image_url: url, image_conf: 0.9, kind: "manufacturer" });
});

test("an image URL can't be made up: it needs a cited, non-estimated source", () => {
    const b = clone("yamaha-mt-15-v2-in");
    b.media = { image: { v: "https://example.com/mt15.png", src: "single-cylinder-geometry", conf: 0.5 } };
    assert.ok(Contract.validateBundle(b, ref).errors.some((e) => e.path === "media.image.src"));
    b.media.image = { v: "http://insecure.example/mt15.png", src: "yamaha-mt15-site", conf: 0.9 };
    assert.ok(Contract.validateBundle(b, ref).errors.some((e) => e.path === "media.image.v"));
});

// ---------------------------------------------------------------------------
test("compiled bundles are strict SI, with the published figure kept beside each value", () => {
    const b = bundleOf("yamaha-mt-15-v2-in");
    assert.equal(b.units, "SI");
    assert.deepEqual(b.engine.displacement, { conf: 0.9, published: { u: "cm3", v: 155 }, src: "yamaha-mt15-site", u: "m3", v: 1.55e-4 });
    assert.equal(b.engine.peakPower.v, 13500);
    assert.equal(b.engine.peakPower.u, "W");
    assert.ok(Math.abs(b.engine.peakPowerRpm.v - 10000 * RPM) < 1e-6);
    assert.equal(b.engine.peakPowerRpm.u, "rad/s");
    assert.equal(b.chassis.fuelTank.u, "m3");
    const ev = bundleOf("ather-450x-3-7kwh-2025-in");
    assert.equal(ev.battery.grossCapacity.v, 3.7 * 3.6e6);
    assert.equal(ev.battery.grossCapacity.u, "J");
    assert.equal(ev.battery.certifiedRange.v, 161000);
    assert.ok(Math.abs(ev.chassis.topSpeed.v - 25) < 1e-9);

    // No non-SI unit anywhere in any bundle (published.u excepted: that's the brochure's).
    const walk = (node, at) => {
        if (Array.isArray(node)) return node.forEach((x, i) => walk(x, `${at}[${i}]`));
        if (!node || typeof node !== "object") return;
        for (const [k, v] of Object.entries(node)) {
            if (k === "published" || k === "sources") continue;
            if ((k === "u" || k === "axis_u") && typeof v === "string") assert.ok(SI_UNITS.has(v), `${at}.${k} = ${v}`);
            walk(v, `${at}.${k}`);
        }
    };
    for (const r of catalogRows()) walk(bundleOf(r.id), r.id);
});

test("priors: a variant's bundle carries the full set, each tagged with where it came from", () => {
    const b = bundleOf("yamaha-mt-15-v2-in");
    assert.equal(b.class_default_id, "default-ice-manual-naked");
    for (const k of ["cda", "crr", "drivetrainEfficiency", "riderMass", "indicatedEfficiency", "fmepA", "fmepB", "fmepC", "redlineFactor"]) {
        assert.ok(b.priors[k] && b.priors[k].sigma > 0, k);
        assert.ok(b.sources[b.priors[k].src], `${k} cites ${b.priors[k].src}`);
    }
    // 8 kPa/krpm -> Pa per rad/s: 8000 / (1000 rpm in rad/s)
    const fmepB = b.priors.fmepB;
    assert.ok(Math.abs(fmepB.mean - (fmepB.published.mean * 1000) / (1000 * RPM)) < 1e-6);
    assert.equal(fmepB.u, "Pa/(rad/s)");
});

test("SI conversion table: exact factors, unknown units refused", () => {
    assert.deepEqual(toSI(155, "cm3"), { value: 1.55e-4, unit: "m3" });
    assert.deepEqual(toSI(3.7, "kWh"), { value: 13320000, unit: "J" });
    assert.deepEqual(toSI(13.5, "kW"), { value: 13500, unit: "W" });
    assert.deepEqual(toSI(90, "km/h"), { value: 25, unit: "m/s" });
    assert.deepEqual(toSI([2.8, 1.9], "1"), { value: [2.8, 1.9], unit: "1" });
    assert.throws(() => toSI(20, "hp"), /no SI conversion/);
});

// ---------------------------------------------------------------------------
test("bikes.sqlite: integrity, foreign keys, counts and metadata", () => {
    assert.equal(Object.values(db.prepare("PRAGMA integrity_check").get())[0], "ok");
    assert.deepEqual(db.prepare("PRAGMA foreign_key_check").all(), []);
    const n = (sql) => db.prepare(sql).get().n;
    assert.equal(n("SELECT count(*) n FROM bundle WHERE kind = 'variant'"), catalog.entries.filter((e) => e.bundle.kind === "variant").length);
    assert.equal(n("SELECT count(*) n FROM bundle WHERE kind = 'class_default'"), catalog.entries.filter((e) => e.bundle.kind === "class_default").length);
    assert.equal(n("SELECT count(*) n FROM bike_search"), catalog.entries.length);
    const meta = Object.fromEntries(db.prepare("SELECT key, value FROM meta").all().map((r) => [r.key, r.value]));
    assert.equal(meta.unit_system, "SI");
    assert.equal(Number(meta.advise_min_conf), Contract.ADVISE_MIN_CONF);
    assert.equal(Number(meta.cert_min_conf), Contract.CERT_MIN_CONF);
    assert.equal(meta.catalog_version, readJson(path.join(out, "catalog.json")).catalog_version);
    // the picker view and the hashes agree with catalog.json
    for (const r of catalogRows()) assert.equal(db.prepare("SELECT content_hash h FROM picker WHERE bundle_id = ?").get(r.id).h, r.bundle);
});

test("bikes.sqlite: values are SI with the published figure and unit recorded", () => {
    const r = db.prepare(`SELECT mv.value, mv.source_value, f.si_unit, f.source_unit, m.conf, s.kind
        FROM measure_value mv JOIN measure m USING (bundle_id, path) JOIN field f USING (path) JOIN source s ON s.source_pk = m.source_pk
        WHERE bundle_id = 'royal-enfield-classic-350-in' AND path = 'engine.displacement'`).get();
    assert.equal(r.si_unit, "m3");
    assert.equal(r.source_unit, "cm3");
    assert.ok(Math.abs(r.value - r.source_value * 1e-6) < 1e-15);
    const gears = db.prepare("SELECT idx, value FROM measure_value WHERE bundle_id = 'yamaha-mt-15-v2-in' AND path = 'transmission.gearRatios' ORDER BY idx").all();
    assert.deepEqual(gears.map((g) => g.value), byIdOf("yamaha-mt-15-v2-in").transmission.gearRatios.v);
    // every variant resolves every prior its powertrain uses
    for (const e of catalog.entries.filter((x) => x.bundle.kind === "variant")) {
        const want = Contract.FIELDS.filter((f) => f.path.startsWith("priors.") && f.allow.includes(e.bundle.powertrain)).map((f) => f.path).sort();
        const got = db.prepare("SELECT path FROM resolved_prior WHERE bundle_id = ? ORDER BY path").all(e.bundle.id).map((x) => x.path);
        assert.deepEqual(got, want, e.bundle.id);
    }
});
const byIdOf = (id) => catalog.entries.find((e) => e.bundle.id === id).bundle;

test("pending bundles are never compiled", () => {
    assert.ok(pending.length > 0);
    const ids = new Set(catalogRows().map((r) => r.id));
    for (const p of pending) {
        assert.ok(!ids.has(p.bundle.id), p.bundle.id);
        assert.equal(db.prepare("SELECT count(*) n FROM bundle WHERE bundle_id = ?").get(p.bundle.id).n, 0);
    }
});

// ---------------------------------------------------------------------------
test("fuel safety: advisable is exactly the contract's isFuelAdvisable, and class defaults advise nothing", () => {
    for (const e of catalog.entries) {
        const b = e.bundle;
        for (const c of (b.fuel && b.fuel.compat) || []) {
            const row = db.prepare("SELECT advisable, status FROM fuel_compat WHERE bundle_id = ? AND fuel_code = ?").get(b.id, c.fuel);
            const want = b.kind === "variant" && Contract.isFuelAdvisable(b, c.fuel, ref);
            assert.equal(row.advisable, want ? 1 : 0, `${b.id} ${c.fuel}`);
            assert.equal(bundleOf(b.id).fuel.compat.find((x) => x.fuel === c.fuel).advisable, want, `${b.id} ${c.fuel} (bundle)`);
        }
    }
    assert.equal(db.prepare("SELECT count(*) n FROM fuel_compat fc JOIN bundle b USING (bundle_id) WHERE b.kind = 'class_default' AND (fc.advisable = 1 OR fc.status = 'certified')").get().n, 0);
    assert.equal(db.prepare("SELECT count(*) n FROM fuel_compat_violation WHERE problem IS NOT NULL").get().n, 0);
    // an EV has no fuel rows at all
    assert.equal(db.prepare("SELECT count(*) n FROM fuel_compat fc JOIN bundle b USING (bundle_id) WHERE b.class_key LIKE 'ev.%'").get().n, 0);
});

test("fuel safety triggers reject writes the contract would never produce", () => {
    // a writable copy of the built database
    const copy = path.join(tmp, "writable.sqlite");
    fs.copyFileSync(path.join(out, "bikes.sqlite"), copy);
    const d = new DatabaseSync(copy);
    d.exec("PRAGMA foreign_keys = ON");
    const classPrior = d.prepare("SELECT fc.source_pk FROM fuel_compat fc JOIN bundle b USING (bundle_id) WHERE b.kind = 'class_default' LIMIT 1").get().source_pk;
    assert.throws(() => d.prepare("UPDATE fuel_compat SET status = 'certified' WHERE bundle_id = 'default-ice-manual-naked' AND fuel_code = 'E20'").run(), /fuel safety/);
    assert.throws(() => d.prepare("UPDATE fuel_compat SET advisable = 1 WHERE bundle_id = 'default-ice-manual-naked' AND fuel_code = 'E20'").run(), /fuel safety/);
    // advice resting on a non-authoritative source
    assert.throws(() => d.prepare("UPDATE fuel_compat SET advisable = 1, status = 'compatible', source_pk = ? WHERE bundle_id = 'yamaha-mt-15-v2-in' AND fuel_code = 'E10'").run(classPrior), /fuel safety/);
    // a flex-fuel blend advised for an engine that isn't certified flex-fuel
    const mtE20 = d.prepare("SELECT source_pk, conf FROM fuel_compat WHERE bundle_id = 'yamaha-mt-15-v2-in' AND fuel_code = 'E20'").get();
    assert.throws(() => d.prepare("INSERT INTO fuel_compat (bundle_id, fuel_code, status, source_pk, conf, advisable) VALUES ('yamaha-mt-15-v2-in', 'E85', 'certified', ?, ?, 1)").run(mtE20.source_pk, mtE20.conf), /fuel safety/);
    // the same row without advice is just a record of what a source said
    d.prepare("INSERT INTO fuel_compat (bundle_id, fuel_code, status, source_pk, conf, advisable) VALUES ('yamaha-mt-15-v2-in', 'E85', 'not_approved', ?, ?, 0)").run(mtE20.source_pk, mtE20.conf);
    // CHECK: advice only for an approval
    assert.throws(() => d.prepare("UPDATE fuel_compat SET advisable = 1 WHERE bundle_id = 'yamaha-mt-15-v2-in' AND fuel_code = 'E85'").run(), /CHECK|fuel safety/);
    d.close();
});

test("schema CHECKs: impossible rows are refused by SQLite itself", () => {
    const d = new DatabaseSync(":memory:");
    d.exec(fs.readFileSync(path.join(ROOT, "lib/bikedb/schema.sql"), "utf8"));
    d.exec("INSERT INTO vehicle_class VALUES ('ev.scooter', 'ev', 'scooter')");
    const insBundle = (over) => {
        const r = { id: "x-in", kind: "class_default", model: null, label: "L", year_to: null, image: null, hash: "0123456789abcdef", ...over };
        d.prepare(`INSERT INTO bundle (bundle_id, kind, class_key, model_pk, variant_name, class_label, market, year_from, year_to, image_url, image_source_pk, image_conf, content_hash, schema_version)
            VALUES (?, ?, 'ev.scooter', ?, NULL, ?, 'IN', 2024, ?, ?, NULL, NULL, ?, '1.0.0')`).run(r.id, r.kind, r.model, r.label, r.year_to, r.image, r.hash);
    };
    assert.throws(() => insBundle({ year_to: 2020 }), /CHECK/);                 // ends before it starts
    assert.throws(() => insBundle({ image: "http://x.example/a.png" }), /CHECK/); // non-https image (and no source)
    assert.throws(() => insBundle({ hash: "NOT-A-HASH-AT-AL" }), /CHECK/);
    assert.throws(() => insBundle({ kind: "variant" }), /CHECK/);                // a variant needs a model
    assert.throws(() => insBundle({ id: "Bad Id" }), /CHECK/);
    assert.throws(() => d.exec("INSERT INTO vehicle_class VALUES ('ev.cruiser', 'ev', 'touring')"), /CHECK/);
    insBundle({});
    assert.throws(() => insBundle({ id: "y-in", hash: "fedcba9876543210" }), /UNIQUE/); // second default for one class
    d.close();
});

test("schema CHECK lists accept every value the contract allows", () => {
    const d = new DatabaseSync(":memory:");
    d.exec(fs.readFileSync(path.join(ROOT, "lib/bikedb/schema.sql"), "utf8"));
    for (const k of Contract.SOURCE_KINDS) d.prepare("INSERT INTO source (kind, title, retrieved) VALUES (?, ?, '2026-10-03')").run(k, `source ${k}`);
    for (const [pt, segs] of Object.entries(Contract.CLASS_MATRIX)) for (const s of segs) d.prepare("INSERT INTO vehicle_class VALUES (?, ?, ?)").run(`${pt}.${s}`, pt, s);
    for (const s of Contract.SEGMENTS) d.prepare("INSERT OR IGNORE INTO vehicle_class VALUES (?, 'ev', ?)").run(`ev.${s}`, s);
    const auth = d.prepare("SELECT kind FROM source WHERE authoritative = 1 ORDER BY kind").all().map((r) => r.kind);
    assert.deepEqual(auth, [...Contract.AUTHORITATIVE_KINDS].sort());
    d.close();
});

// ---------------------------------------------------------------------------
test("search: the spellings riders type find the right bike", () => {
    const search = makeSearch(db);
    const first = (q) => (search(q, 5)[0] || {}).id;
    assert.equal(first("mt15"), "yamaha-mt-15-v2-in");
    assert.equal(first("mt 15"), "yamaha-mt-15-v2-in");
    assert.equal(first("MT-15"), "yamaha-mt-15-v2-in");
    assert.equal(first("ns200"), "bajaj-pulsar-ns200-dual-abs-in");
    assert.equal(first("ns 200"), "bajaj-pulsar-ns200-dual-abs-in");
    assert.equal(first("rtr160"), "tvs-apache-rtr-160-4v-dual-abs-usd-in");
    assert.equal(first("classic"), "royal-enfield-classic-350-in");
    assert.ok(search("450x").every((r) => r.id.startsWith("ather-450x")) && search("450x").length === 2);
    assert.equal(search("royal enfield").filter((r) => r.kind === "variant").length, catalog.entries.filter((e) => e.bundle.identity.make === "Royal Enfield").length);
    // class defaults come after real bikes, and answer generic searches
    assert.ok(search("commuter").some((r) => r.kind === "class_default"));
    // too short, empty, or hostile input: no error, no rows
    for (const q of ["", "s", "  ", "\"", "*", "NEAR(", "x OR y AND *"]) assert.ok(Array.isArray(search(q)), q);
    assert.deepEqual(search("s"), []);
});

test("search keys: catalog.json's offline matcher agrees with FTS5 on the seed catalog", () => {
    const search = makeSearch(db);
    const rows = catalogRows();
    for (const q of ["mt15", "mt 15", "ns 200", "450 x", "royal", "classic 350", "rtr 160 4v", "activa", "pulsar", "chetak", "e20", "hunter metro"]) {
        const offline = rows.filter((r) => Keys.matches(q, r.search)).map((r) => r.id).sort();
        const fts = search(q, 50).map((r) => r.id).sort();
        assert.deepEqual(offline, fts, q);
    }
    assert.equal(Keys.ftsQuery("mt-15 \"; DROP"), '"mt"* "15"* "drop"*');
    assert.deepEqual(Keys.keywordsFor("TVS Apache RTR 160 4V Dual ABS"), ["1604v", "4", "rtr160", "rtr1604v", "v"]);
    assert.deepEqual(Keys.keywordsFor("Yamaha MT-15 Version 2.0 STD"), ["mt15"]);
});

test("FTS5 search stays under 10 ms at p95 on a synthetic 20k-row catalog", () => {
    const s = benchSearch({ rows: 20000, rounds: 10 });
    assert.ok(s.p95 < 10, `p95 ${s.p95.toFixed(2)} ms (worst query "${s.worst}")`);
});

// ---------------------------------------------------------------------------
test("invalid data stops the build and leaves the previous output untouched", () => {
    const data = dataCopy();
    const file = path.join(data, "variants", "yamaha-mt-15-v2-in.json");
    const b = readJson(file);
    b.chassis.mass.v = -141;
    fs.writeFileSync(file, JSON.stringify(b));
    const o = path.join(tmp, "out-keep");
    build({ outDir: o });
    const before = fs.readFileSync(path.join(o, "catalog.json"));
    assert.throws(() => build({ dataDir: data, outDir: o }), /validation failed[\s\S]*chassis\.mass/);
    assert.ok(fs.readFileSync(path.join(o, "catalog.json")).equals(before));
    assert.ok(!fs.readdirSync(tmp).some((f) => f.startsWith("out-keep.tmp")), "staging dir cleaned up");
});

test("the build refuses to replace a directory it didn't create", () => {
    const o = path.join(tmp, "not-mine");
    fs.mkdirSync(o);
    fs.writeFileSync(path.join(o, "precious.txt"), "keep me");
    assert.throws(() => build({ outDir: o }), /refusing to replace/);
    assert.equal(fs.readFileSync(path.join(o, "precious.txt"), "utf8"), "keep me");
});

test("curves compile to SI and to an int16 BLOB", () => {
    const data = dataCopy();
    const file = path.join(data, "variants", "yamaha-mt-15-v2-in.json");
    const b = readJson(file);
    const peak = b.engine.peakTorque.v, at = b.engine.peakTorqueRpm.v;
    // 2000..11000 rpm in 1000 rpm steps, peaking at the published torque, 0.01 N*m per count
    const data16 = Array.from({ length: 10 }, (_, i) => Math.round((peak * (1 - Math.abs(2000 + 1000 * i - at) / 12000)) * 100));
    b.curves = { torque: { rpmStart: 2000, rpmStep: 1000, scale: 0.01, u: "N*m", data: data16, method: "synthesized", src: "yamaha-mt15-site", conf: 0.3 } };
    fs.writeFileSync(file, JSON.stringify(b));
    assert.ok(Contract.validateBundle(b, ref).ok, JSON.stringify(Contract.validateBundle(b, ref).errors));
    const compiled = compileBundle(b, catalog.entries.find((e) => e.bundle.id === "default-ice-manual-naked").bundle, ref);
    assert.ok(Math.abs(compiled.curves.torque.axis_start - 2000 * RPM) < 1e-9);
    assert.equal(compiled.curves.torque.axis_u, "rad/s");
    const o = path.join(tmp, "out-curve");
    build({ dataDir: data, outDir: o });
    const d2 = new DatabaseSync(path.join(o, "bikes.sqlite"), { readOnly: true });
    const r = d2.prepare("SELECT sample_count, samples, scale FROM curve WHERE bundle_id = ? AND kind = 'torque'").get(b.id);
    d2.close();
    const buf = Buffer.from(r.samples);
    assert.equal(r.sample_count, 10);
    assert.deepEqual(Array.from({ length: 10 }, (_, i) => buf.readInt16LE(i * 2)), data16);
});
