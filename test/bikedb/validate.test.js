"use strict";

// Tests for public/js/bikedb/validate.js against the seed catalog and a
// corpus of deliberately broken bundles (fixtures.js). Run: npm test

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const V = require("../../public/js/bikedb/validate.js");
const { ROOT, RPM, load, mutations, MT15, IQUBE } = require("./fixtures.js");

const listJson = (dir) => fs.readdirSync(path.join(ROOT, dir)).filter((f) => f.endsWith(".json")).sort().map((f) => `${dir}/${f}`);
const BIKES = listJson("data/bikes");
const CLASSES = listJson("data/class-defaults");
const codes = (r) => r.errors.map((e) => e.code);
const clone = (x) => JSON.parse(JSON.stringify(x));

function catalog(overrides = {}) {
    return {
        bundles: [...BIKES, ...CLASSES].map((file) => ({ file, bundle: load(file) })),
        fuelGrades: load("data/lookups/fuel_grade.json"),
        emissionStandards: load("data/lookups/emission_standard.json"),
        ...overrides
    };
}

// ---------------------------------------------------------------------------
test("every seed bundle is valid", () => {
    for (const file of [...BIKES, ...CLASSES]) {
        const r = V.validateBundle(load(file));
        assert.deepEqual(r.errors, [], `${file}: ${JSON.stringify(r.errors, null, 1)}`);
        const unexpected = r.warnings.filter((w) => w.code !== "W_LOW_CONFIDENCE");
        assert.deepEqual(unexpected, [], `${file}: ${JSON.stringify(unexpected, null, 1)}`);
    }
});

test("the seed catalog covers the agreed scope", () => {
    const variants = BIKES.map(load);
    assert.ok(variants.length >= 20, `${variants.length} variants`);
    const by = (pt, seg) => variants.filter((b) => b.powertrain === pt && (!seg || b.segment === seg)).length;
    assert.ok(by("ice_manual", "commuter") >= 4, "commuters");
    assert.ok(by("ice_manual", "cruiser") >= 4, "350 class / cruisers");
    assert.ok(by("ice_manual", "naked") + by("ice_manual", "sport") >= 4, "nakeds / sports");
    assert.ok(by("ice_cvt", "scooter") >= 2, "CVT scooters");
    assert.ok(by("ev", "scooter") >= 2, "EV scooters");
    for (const b of variants) assert.equal(b.identity.market, "IN");
});

test("lookup tables are valid", () => {
    const fg = V.validateFuelGrades(load("data/lookups/fuel_grade.json"));
    assert.deepEqual([...fg.errors, ...fg.warnings], []);
    const es = V.validateEmissionStandards(load("data/lookups/emission_standard.json"));
    assert.deepEqual([...es.errors, ...es.warnings], []);
    const ids = load("data/lookups/emission_standard.json").rows.map((r) => r.id);
    assert.deepEqual(ids, ["BS4", "BS6-P1", "BS6-P2"]);
    const grades = load("data/lookups/fuel_grade.json").rows.map((r) => r.id);
    for (const g of ["E0", "E10", "E20", "E85", "E100"]) assert.ok(grades.includes(g), g);
});

test("catalog rules pass on the seed data", () => {
    const r = V.validateCatalog(catalog());
    assert.deepEqual([...r.errors, ...r.warnings], []);
});

test("class defaults cover every powertrain x segment", () => {
    const ids = new Set(CLASSES.map((f) => load(f).id));
    for (const pt of V.POWERTRAINS) for (const seg of V.SEGMENTS) assert.ok(ids.has(V.classDefaultId(pt, seg)), `${pt} x ${seg}`);
    assert.equal(CLASSES.length, V.POWERTRAINS.length * V.SEGMENTS.length);
});

test("every variant's values cite a declared source with a confidence", () => {
    // Walk every object carrying a value; each must have source + confidence + method.
    const walk = (node, at, sources, file) => {
        if (Array.isArray(node)) return node.forEach((x, i) => walk(x, `${at}/${i}`, sources, file));
        if (!node || typeof node !== "object") return;
        if ("value" in node || "values" in node || "status" in node) {
            assert.ok(sources.has(node.source), `${file}${at}: source ${node.source}`);
            assert.ok(node.confidence >= 0 && node.confidence <= 1, `${file}${at}: confidence`);
            assert.ok(typeof node.method === "string", `${file}${at}: method`);
            return;
        }
        for (const [k, v] of Object.entries(node)) if (k !== "sources" && k !== "identity" && k !== "record" && k !== "class_default") walk(v, `${at}/${k}`, sources, file);
    };
    for (const file of [...BIKES, ...CLASSES]) {
        const b = load(file);
        walk(b, "", new Set(b.sources.map((s) => s.id)), file);
    }
});

// ---------------------------------------------------------------------------
for (const m of mutations) {
    test(`rejects: ${m.name}`, () => {
        const b = load(m.base);
        m.mutate(b);
        const r = V.validateBundle(b);
        assert.equal(r.valid, false, `${m.name} was accepted`);
        assert.ok(codes(r).includes(m.code), `${m.name}: expected ${m.code}, got ${JSON.stringify(r.errors, null, 1)}`);
    });
}

test("a unit error names the SI unit and the converted value", () => {
    const b = load(MT15);
    b.engine.redline_speed.unit = "rpm";
    b.engine.redline_speed.value = 7500;
    const e = V.validateBundle(b).errors.find((x) => x.code === "E_UNIT");
    assert.ok(e);
    assert.equal(e.path, "/engine/redline_speed/unit");
    assert.match(e.message, /expected "rad\/s" \(7500 rpm = 785\.398 rad\/s\)/);
});

test("errors point at the offending field", () => {
    const b = load(MT15);
    b.engine.redline_speed.value = b.engine.idle_speed.value / 2;
    const e = V.validateBundle(b).errors.find((x) => x.code === "E_PHYSICS_IDLE_REDLINE");
    assert.equal(e.path, "/engine/redline_speed");
});

test("rejects things that aren't bundles", () => {
    for (const x of [null, 42, "bike", [], undefined]) assert.equal(V.validateBundle(x).valid, false);
});

test("a flex-fuel engine may be certified for E85", () => {
    const b = load("data/bikes/hero.splendor-plus-flex-fuel.2026.json");
    assert.equal(b.fuel.flex_fuel.value, true);
    assert.equal(b.fuel.compatibility.find((e) => e.grade === "E85").status, "certified");
    assert.equal(V.validateBundle(b).valid, true);
    b.fuel.flex_fuel.value = false;
    b.fuel.flex_fuel.method = "derived";
    delete b.fuel.flex_fuel.published;
    assert.ok(codes(V.validateBundle(b)).includes("E_FUEL_FLEX"));
});

test("an estimated gearing contradicting the top speed is a warning, not an error", () => {
    const b = load("data/bikes/tvs.apache-rtr-160-4v.2023.json");
    b.performance.top_speed.value = 250 / 3.6;
    const r = V.validateBundle(b);
    assert.equal(r.valid, true);
    assert.ok(r.warnings.some((w) => w.code === "W_PHYSICS_TOP_SPEED"));
});

test("low-confidence physics inputs are reported as sourcing debt", () => {
    const r = V.validateBundle(load("data/bikes/hero.splendor-plus.2023.json"));
    const debt = r.warnings.filter((w) => w.code === "W_LOW_CONFIDENCE").map((w) => w.path);
    assert.ok(debt.includes("/engine/idle_speed"));
    assert.ok(!debt.some((p) => p.startsWith("/priors/")), "priors are calibrated, not sourcing debt");
});

// ---------------------------------------------------------------------------
// curves
const torqueCurve = (b, overrides = {}) => ({
    unit: "N.m",
    axis: { unit: "rad/s", start: 2000 * RPM, step: 1000 * RPM },
    scale: 0.01,
    encoding: "array",
    data: [1050, 1200, 1300, 1380, 1410, 1395, 1350, 1290, 1200],   // 2000..10000 rpm
    source: b.sources[0].id, confidence: 0.6, method: "measured",
    ...overrides
});

test("accepts a quantised torque curve, as an array or as a base64 BLOB", () => {
    const b = load(MT15);
    b.curves = { torque: torqueCurve(b) };
    assert.deepEqual(V.validateBundle(b).errors, []);
    const samples = b.curves.torque.data;
    const blob = Buffer.alloc(samples.length * 2);
    samples.forEach((q, i) => blob.writeUInt16LE(q, i * 2));
    b.curves.torque = torqueCurve(b, { encoding: "u16le-base64", data: blob.toString("base64") });
    assert.deepEqual(V.validateBundle(b).errors, []);
    assert.deepEqual(V.decodeCurve(b.curves.torque).map((x) => Math.round(x * 100)), samples);
});

test("rejects a power curve that disagrees with torque x speed", () => {
    const b = load(MT15);
    const t = torqueCurve(b);
    const power = t.data.map((q, i) => Math.round((q * 0.01 * (2000 + 1000 * i) * RPM) / 1));
    power[5] = Math.round(power[5] * 1.3);
    b.curves = { torque: t, power: { ...torqueCurve(b), unit: "W", scale: 1, data: power } };
    assert.ok(codes(V.validateBundle(b)).includes("E_CURVE"));
    power[5] = Math.round(power[5] / 1.3);
    b.curves.power.data = power;
    assert.deepEqual(V.validateBundle(b).errors, []);
});

test("rejects a curve past the redline, a short curve and undecodable data", () => {
    const b = load(MT15);
    b.curves = { torque: torqueCurve(b, { axis: { unit: "rad/s", start: 6000 * RPM, step: 1000 * RPM } }) };
    assert.ok(codes(V.validateBundle(b)).includes("E_CURVE"));
    b.curves = { torque: torqueCurve(b, { data: [1, 2, 3] }) };
    assert.ok(codes(V.validateBundle(b)).includes("E_CURVE"));
    b.curves = { torque: torqueCurve(b, { encoding: "u16le-base64", data: "not base64!" }) };
    assert.ok(codes(V.validateBundle(b)).includes("E_CURVE"));
    b.curves = { torque: torqueCurve(b, { axis: { unit: "rpm", start: 2000, step: 1000 } }) };
    assert.ok(codes(V.validateBundle(b)).includes("E_UNIT"));
});

test("an EV can't carry engine curves", () => {
    const b = load(IQUBE);
    b.curves = { torque: torqueCurve(load(MT15), { source: "tvs-iqube-spec" }) };
    assert.ok(codes(V.validateBundle(b)).includes("E_POWERTRAIN_MISMATCH"));
});

// ---------------------------------------------------------------------------
// catalog rules
test("catalog: a missing class default is a coverage hole", () => {
    const c = catalog();
    c.bundles = c.bundles.filter((x) => x.bundle.id !== "class.ev.cruiser");
    const r = V.validateCatalog(c);
    assert.ok(codes(r).includes("E_CATALOG_COVERAGE"));
    assert.ok(r.errors.some((e) => /ev x cruiser/.test(e.message)));
});

test("catalog: duplicate ids and file names that aren't the id", () => {
    const c = catalog();
    c.bundles.push({ file: "data/bikes/copy.json", bundle: clone(c.bundles[0].bundle) });
    const r = codes(V.validateCatalog(c));
    assert.ok(r.includes("E_DUPLICATE"));
    assert.ok(r.includes("E_CATALOG"));
});

test("catalog: fuel grades, emission standards and class refs must resolve", () => {
    const c = catalog();
    const mt = c.bundles.find((x) => x.bundle.id === "yamaha.mt-15-v2.2023").bundle;
    mt.fuel.compatibility[0].grade = "E15";
    mt.emission_standard.value = "BS7";
    mt.sources.find((s) => s.kind === "class_default").class_ref = "class.ice-manual.touring";
    const r = V.validateCatalog(c);
    assert.equal(r.errors.filter((e) => e.code === "E_CATALOG_REF").length, 3, JSON.stringify(r.errors, null, 1));
});

test("catalog: model years must not end before the emission standard began", () => {
    const c = catalog();
    const mt = c.bundles.find((x) => x.bundle.id === "yamaha.mt-15-v2.2023").bundle;
    mt.identity.model_years = { from: 2015, to: 2019 };
    assert.ok(codes(V.validateCatalog(c)).includes("E_CATALOG_REF"));
});

test("catalog: an engine's minimum octane must be met by a certified grade", () => {
    const c = catalog();
    const mt = c.bundles.find((x) => x.bundle.id === "yamaha.mt-15-v2.2023").bundle;
    mt.fuel.min_ron = { value: 98, unit: "1", source: "91w-mt15", confidence: 0.8, method: "published", published: "RON 98" };
    assert.deepEqual(V.validateBundle(mt).errors, []);
    assert.ok(codes(V.validateCatalog(c)).includes("E_FUEL_OCTANE"));
});

// ---------------------------------------------------------------------------
// lookup tables
test("fuel_grade: id must match ethanol content; LHV per volume must match per mass x density", () => {
    const t = load("data/lookups/fuel_grade.json");
    t.rows[1].ethanol_volume_fraction.value = 0.2;
    t.rows[2].lhv_volume.value *= 1.1;
    const r = V.validateFuelGrades(t);
    assert.equal(r.errors.filter((e) => e.code === "E_FUEL_GRADE").length, 2);
});

test("fuel_grade: LHV in MJ/kg is rejected with the conversion", () => {
    const t = load("data/lookups/fuel_grade.json");
    t.rows[0].lhv_mass.unit = "MJ/kg";
    t.rows[0].lhv_mass.value = 44;
    const e = V.validateFuelGrades(t).errors.find((x) => x.code === "E_UNIT");
    assert.match(e.message, /44 MJ\/kg = 44000000 J\/kg/);
});

test("emission_standard: limits in g/km are rejected; duplicate ids rejected", () => {
    const t = load("data/lookups/emission_standard.json");
    t.rows[1].limits.nox.unit = "g/km";
    t.rows.push(clone(t.rows[0]));
    const r = codes(V.validateEmissionStandards(t));
    assert.ok(r.includes("E_UNIT"));
    assert.ok(r.includes("E_DUPLICATE"));
});

// ---------------------------------------------------------------------------
test("tyre codes parse to the unloaded radius", () => {
    const near = (a, b) => assert.ok(Math.abs(a - b) < 1e-9, `${a} != ${b}`);
    near(V.parseTyreCode("80/100-18 M/C 47P").radiusM, 0.4572 / 2 + 0.08);
    near(V.parseTyreCode("140/70 R17").radiusM, 0.4318 / 2 + 0.098);
    near(V.parseTyreCode("140/70-R17").radiusM, 0.4318 / 2 + 0.098);
    near(V.parseTyreCode("2.75-17 41P").radiusM, 0.4318 / 2 + 2.75 * 0.0254);
    near(V.parseTyreCode("3.00 x 17").radiusM, 0.4318 / 2 + 3 * 0.0254);
    for (const bad of ["", "fat", "80/100-118", "80/100"]) assert.equal(V.parseTyreCode(bad), null, bad);
});
