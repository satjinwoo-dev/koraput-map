// The real catalogue, cross-file rules, reference tables and the fuel-advice gate.
import { test } from "node:test";
import assert from "node:assert/strict";
import { Contract, catalog, pending, ref, clone, byId, ROOT } from "./helpers.mjs";

const RE_CLASSIC = "royal-enfield-classic-350-in";

// The only warnings allowed in the committed catalogue — each one is a known, documented gap.
const EXPECTED_WARNINGS = [
    "data/bikes/variants/honda-activa-110-dlx-obd2b-in.json no_advisable_fuel"   // only the 2020 manual certifies a fuel (E10, conf 0.6)
];
test("the committed catalogue validates with zero errors, and only the documented warnings", () => {
    const r = Contract.validateCatalog(catalog.entries, ref);
    const all = r.perFile.flatMap((p) => p.result.errors.map((e) => `${p.file} ${e.path}: ${e.message}`)).concat(r.errors.map((e) => e.message));
    assert.deepEqual(all, []);
    const warnings = r.perFile.flatMap((p) => p.result.warnings.map((w) => `${p.file} ${w.code}`)).concat(r.warnings.map((w) => `catalog ${w.code}`));
    assert.deepEqual(warnings.sort(), [...EXPECTED_WARNINGS].sort());
});
test("seed coverage: ≥ 20 variants across every powertrain, and a default for every valid class", () => {
    const variants = catalog.entries.filter((e) => e.bundle.kind === "variant").map((e) => e.bundle);
    assert.ok(variants.length >= 20, `${variants.length} variants`);
    for (const pt of Contract.POWERTRAINS) assert.ok(variants.some((v) => v.powertrain === pt), pt);
    for (const [pt, segs] of Object.entries(Contract.CLASS_MATRIX)) for (const s of segs) assert.ok(byId[`default-${pt.replace(/_/g, "-")}-${s.replace(/_/g, "-")}`], `${pt}.${s}`);
});
test("every variant resolves a complete prior set through its class default", () => {
    for (const e of catalog.entries.filter((x) => x.bundle.kind === "variant")) {
        const d = catalog.entries.find((x) => x.bundle.kind === "class_default" && x.bundle.classKey === e.bundle.classKey).bundle;
        const p = Contract.resolvePriors(e.bundle, d);
        for (const k of ["cda", "crr", "drivetrainEfficiency", "riderMass"]) assert.ok(p[k] && p[k].sigma > 0, `${e.bundle.id} ${k}`);
    }
});
test("detects a missing class default", () => {
    const entries = catalog.entries.filter((e) => e.bundle.id !== "default-ice-cvt-maxi-scooter");
    const r = Contract.validateCatalog(entries, ref);
    assert.ok(r.errors.some((e) => e.code === "missing_default" && e.message.includes("ice_cvt.maxi_scooter")));
});
test("detects duplicate ids and a file named differently from its id", () => {
    const dup = { file: "data/bikes/variants/copy.json", bundle: clone("royal-enfield-classic-350-in") };
    const r = Contract.validateCatalog([...catalog.entries, dup], ref);
    assert.ok(r.errors.some((e) => e.code === "duplicate_id"));
    assert.ok(r.errors.some((e) => e.code === "file_name"));
});
test("detects a second class default for the same class", () => {
    const d = clone("default-ev-sport");
    const r = Contract.validateCatalog([...catalog.entries, { file: "data/bikes/class-defaults/default-ev-sport.json", bundle: d }], ref);
    assert.ok(r.errors.some((e) => e.code === "duplicate_default"));
});

test("the picture rule: a new variant without image.url fails the catalogue; only the frozen list of older bikes is exempt", () => {
    const variants = catalog.entries.filter((e) => e.bundle.kind === "variant").map((e) => e.bundle.id).sort();
    assert.ok(Object.isFrozen(Contract.PICTURE_GRANDFATHERED));
    for (const id of Contract.PICTURE_GRANDFATHERED) assert.ok(variants.includes(id), `${id} is grandfathered but not in the catalogue: take it off the list`);
    const bike = (o = {}) => { const b = clone(RE_CLASSIC); b.id = "royal-enfield-classic-350-signals-test-in"; b.identity = { ...b.identity, variant: "Signals (test)", aliases: [] }; return Object.assign(b, o); };
    const file = "data/bikes/variants/royal-enfield-classic-350-signals-test-in.json";
    let r = Contract.validateCatalog([...catalog.entries, { file, bundle: bike() }], ref);
    assert.ok(r.errors.some((e) => e.code === "picture_required" && e.path === file), "no picture → the build refuses");
    r = Contract.validateCatalog([...catalog.entries, { file, bundle: bike({ image: { url: " ", src: "x" } }) }], ref);
    assert.ok(r.errors.some((e) => e.code === "picture_required"), "a blank url isn't a picture");
    const src = clone(RE_CLASSIC).sources[0].id;
    r = Contract.validateCatalog([...catalog.entries, { file, bundle: bike({ image: { url: "https://cdn.example.com/classic.jpg", src } }) }], ref);
    assert.deepEqual(r.errors, []);
    assert.equal(r.ok, true);
    // a grandfathered bike that gets its picture is told to leave the list
    const g = Contract.PICTURE_GRANDFATHERED[0];
    const entries = catalog.entries.map((e) => (e.bundle.id === g ? { ...e, bundle: { ...e.bundle, image: { url: "https://cdn.example.com/g.jpg", src: e.bundle.sources[0].id } } } : e));
    assert.ok(Contract.validateCatalog(entries, ref).warnings.some((w) => w.code === "picture_grandfathered"));
});

// ---- reference tables ----
test("reference tables validate, and energy per litre falls as ethanol rises", () => {
    assert.deepEqual(Contract.validateFuelGrades(ref.fuelGrades).errors, []);
    assert.deepEqual(Contract.validateEmissionStandards(ref.emissionStandards).errors, []);
    const g = Object.fromEntries(ref.fuelGrades.grades.map((x) => [x.code, x.lhv.v]));
    const dropE20 = 1 - g.E20 / g.E0;
    assert.ok(dropE20 > 0.06 && dropE20 < 0.08, `E20 carries ${(dropE20 * 100).toFixed(1)} % less energy per litre`);
});
test("reference-table mistakes are caught", () => {
    const t = structuredClone(ref.fuelGrades);
    t.grades.find((x) => x.code === "E85").flexFuelBlend = false;
    t.grades.find((x) => x.code === "E20").lhv.v = 33;
    const r = Contract.validateFuelGrades(t);
    assert.ok(r.errors.some((e) => e.path.includes("flexFuelBlend")));
    assert.ok(r.errors.some((e) => e.code === "impossible"));
    const s = structuredClone(ref.emissionStandards); s.standards[1].effectiveFrom = "April 2020";
    assert.ok(Contract.validateEmissionStandards(s).errors.some((e) => e.path.includes("effectiveFrom")));
});

test("every data file is in canonical format (one value per line — clean review diffs)", async () => {
    const { formatJson } = await import("../../scripts/bikedb/format.mjs");
    const fs = await import("node:fs");
    const path = await import("node:path");
    const { ROOT } = await import("./helpers.mjs");
    const dirs = ["variants", "class-defaults", "reference", "pending"].map((d) => path.join(ROOT, "data", "bikes", d));
    const bad = [];
    for (const dir of dirs) for (const f of fs.readdirSync(dir).filter((x) => x.endsWith(".json"))) {
        const raw = fs.readFileSync(path.join(dir, f), "utf8");
        if (raw !== formatJson(JSON.parse(raw)) + "\n") bad.push(f);
    }
    assert.deepEqual(bad, [], "run: node scripts/bikedb/format.mjs");
});

// ---- fuel-advice gate ----
test("fuel advice only for manufacturer-backed approvals at ≥ 0.7 confidence", () => {
    const A = (id, fuel) => Contract.isFuelAdvisable(byId[id], fuel, ref);
    assert.equal(A("hero-splendor-plus-obd2b-in", "E20"), true, "manufacturer site, 0.75");
    assert.equal(A("tvs-jupiter-110-disc-sxc-in", "E20"), true, "owner's manual, 0.85");
    assert.equal(A("royal-enfield-hunter-350-metro-in", "E20"), true, "Apr 2025 owner's manual: 'Petrol, up to E20'");
    assert.equal(A("royal-enfield-hunter-350-metro-in", "E10"), true, "owner's manual");
    assert.equal(A("suzuki-access-125-std-2025-in", "E20"), false, "aggregator only");
    assert.equal(A("honda-activa-110-dlx-obd2b-in", "E20"), false, "press quoting Honda");
    assert.equal(A("ktm-390-duke-r-399cc-in", "E20"), false, "unknown");
    assert.equal(A("hero-splendor-plus-obd2b-in", "E10"), false, "derived lower blend: shown as compatible, not advised");
    assert.equal(A("hero-xpulse-200-4v-std-in", "E85"), false, "not approved");
    assert.equal(A("default-ice-manual-commuter", "E20"), false, "class default — never advised");
    assert.equal(A("ather-450x-3-7kwh-2025-in", "E20"), false, "electric");
});
test("fuel advice never allows a flex blend on a non-flex engine, even if data says certified", () => {
    const b = clone("royal-enfield-classic-350-in");
    b.fuel.compat.push({ fuel: "E100", status: "certified", src: "re-classic-site", conf: 0.95 });
    assert.equal(Contract.isFuelAdvisable(b, "E100", ref), false);
    b.engine.flexFuel = { v: true, src: "re-classic-site", conf: 0.95 };
    assert.equal(Contract.isFuelAdvisable(b, "E100", ref), true);
});

// ---- pending bundles (researched, blocked, not shipped) ----
test("every pending bundle fails validation, stays out of the catalogue, and says why", () => {
    assert.ok(pending.length >= 1);
    const shipped = new Set(catalog.entries.map((e) => e.bundle.id));
    for (const p of pending) {
        assert.ok(!shipped.has(p.bundle.id), `${p.bundle.id} is both pending and shipped`);
        const r = Contract.validateBundle(p.bundle, ref);
        assert.equal(r.ok, false, `${p.file} passes — move it to variants/`);
        assert.ok(Array.isArray(p.bundle.notes) && /^PENDING/.test(p.bundle.notes[0]), `${p.file}: first note must say why it is pending`);
    }
    assert.ok(Contract.validateBundle(byId["ktm-390-duke-r-399cc-in"], ref).errors.some((e) => e.code === "no_certified_fuel"), "KTM: EU manual only");
    assert.ok(Contract.validateBundle(byId["suzuki-access-125-std-2025-in"], ref).errors.some((e) => e.code === "no_certified_fuel"), "Access: aggregator only");
});

test("CLI: validate.mjs passes on the repo, lists pending bundles, and fails when a pending bundle becomes valid", async () => {
    const fs = await import("node:fs");
    const os = await import("node:os");
    const path = await import("node:path");
    const { spawnSync } = await import("node:child_process");
    const run = (root) => spawnSync(process.execPath, [path.join(root, "scripts/bikedb/validate.mjs")], { encoding: "utf8" });
    const ok = run(ROOT);
    assert.equal(ok.status, 0, ok.stdout + ok.stderr);
    assert.match(ok.stdout, /0 errors, \d+ warnings?\. \d+ pending \(blocked, not shipped\)/);
    assert.match(ok.stdout, /pending\/ktm-390-duke-r-399cc-in\.json {2}\(pending — not in the catalog\)/);
    // Copy the bike-db pieces, then "source" a certification for the KTM: the CLI must ask for it to be moved.
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "bikedb-"));
    for (const d of ["scripts/bikedb", "public/js/bikedb", "data/bikes", "lib/bikedb"]) fs.cpSync(path.join(ROOT, d), path.join(tmp, d), { recursive: true });
    const f = path.join(tmp, "data/bikes/pending/ktm-390-duke-r-399cc-in.json");
    const b = JSON.parse(fs.readFileSync(f, "utf8"));
    b.fuel.compat.push({ fuel: "E10", status: "certified", src: b.fuel.compat[0].src, conf: 0.85 });
    b.sources.find((s) => s.id === b.fuel.compat[0].src).kind = "owners_manual";
    fs.writeFileSync(f, JSON.stringify(b));
    const ready = run(tmp);
    assert.equal(ready.status, 1);
    assert.match(ready.stdout, /now passes every rule — move it to data\/bikes\/variants\/ {2}\[pending_ready\]/);
    fs.rmSync(tmp, { recursive: true, force: true });
});

test("alias clashes: variants of one model may share names; different models may not", () => {
    const r = Contract.validateCatalog(catalog.entries, ref);
    assert.ok(!r.warnings.some((w) => w.code === "alias_clash"), "the two Ather 450X packs share names on purpose");
    const chetak = clone("bajaj-chetak-c3501-in");
    chetak.identity.aliases.push("Ather 450X");
    const entries = catalog.entries.map((e) => (e.bundle.id === chetak.id ? { ...e, bundle: chetak } : e));
    assert.ok(Contract.validateCatalog(entries, ref).warnings.some((w) => w.code === "alias_clash" && w.message.includes("ather-450x")));
});
