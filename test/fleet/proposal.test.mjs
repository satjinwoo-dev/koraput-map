// Step 8, end to end: tanks in the server's database → `npm run bikes:calibrate --write`
// → a reviewable proposal file → the build applies it with provenance → the bundles
// ship the calibrated priors and the real-riding overhead. And everything that must
// NOT happen: a stale proposal applied, a malformed one built, a re-fit counting the
// same tanks twice.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { loadCatalog, DATA } from "../../scripts/bikedb/load-catalog.mjs";
import { buildArtifacts, writeSqlite } from "../../scripts/bikedb/catalog-build.mjs";
import { serveApi, raw } from "../server/helpers.mjs";
import { calibrate } from "../../scripts/bikedb/calibrate.mjs";
import { makeProposal, validateProposal, applyCalibrations, CalibrationError, CALIBRATION_FORMAT, CALIBRATION_SOURCE_ID } from "../../scripts/bikedb/calibration-file.mjs";
import { syntheticFleet, art, Physics } from "./synthetic.mjs";

const require = createRequire(import.meta.url);
const { FleetStore, validateTank } = require("../../lib/bikedb/fleet.js");
const { loadDriver } = require("../../lib/bikedb/sqlite.js");
const Contract = require("../../public/js/bikedb/bundle-contract.js");

const K = "ice_manual.commuter";
const NOW = () => Date.parse("2026-10-03T12:00:00Z");
const TRUTH = { cda: 1.15, indicatedEfficiency: 0.92, overhead: 1.12 };
const known = {
    bundleClass: (h) => { const b = art.bundles.find((x) => x.hash === h); return b ? { classKey: b.classKey, bikeId: b.id } : null; },
    fuels: ["E0", "E10", "E20", "E85", "E100"],
    evClass: (k) => k.startsWith("ev.")
};

let tmp, dataDir, db, result, proposalFile;
before(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "mu-cal-"));
    dataDir = path.join(tmp, "bikes");
    fs.cpSync(DATA, dataDir, { recursive: true });
    db = loadDriver().open(path.join(tmp, "mapunite.db"));
    const store = new FleetStore(db, { secret: "s3cret", now: NOW });
    const tanks = syntheticFleet({ classKey: K, truth: TRUTH, seed: 7 });
    const byRider = new Map();
    for (const t of tanks) byRider.set(t.contributor, [...(byRider.get(t.contributor) || []), t]);
    for (const [rider, list] of byRider) {
        const token = Buffer.from(rider.padEnd(16, "-")).toString("hex").slice(0, 32);
        store.submit(token, list.map((t) => validateTank({ bundle: t.bundle, fuelCode: t.fuelCode, massKg: t.massKg, litres: t.litres, km: t.km, idleH: t.idleH, hist: t.hist }, known).value));
    }
    // a second class with too little data: fitted and reported, never proposed
    const few = syntheticFleet({ classKey: "ice_cvt.scooter", riders: 3, tanksPerRider: 3, seed: 5 });
    store.submit("ab".repeat(16), few.map((t) => validateTank({ bundle: t.bundle, fuelCode: t.fuelCode, massKg: t.massKg, litres: t.litres, km: t.km, idleH: t.idleH, hist: t.hist }, known).value));
    result = calibrate({ db, dataDir, write: true, now: NOW });
    proposalFile = path.join(dataDir, "calibration", `${K}.json`);
});
after(() => {
    db.close();
    fs.rmSync(tmp, { recursive: true, force: true });
});
const readProposal = () => JSON.parse(fs.readFileSync(proposalFile, "utf8"));
const curatedCd = () => loadCatalog(dataDir, { calibrations: false }).entries.find((e) => e.bundle.kind === "class_default" && e.bundle.classKey === K).bundle;

test("calibrate: fits every class with tanks, stores the fits, writes a proposal only where it passed", () => {
    assert.deepEqual(result.results.map((r) => [r.classKey, r.proposed]), [["ice_cvt.scooter", false], [K, true]]);
    assert.match(result.results[0].reason, /needs 30 tanks/);
    assert.equal(result.results[0].file, null);
    assert.match(result.results[1].file, /calibration\/ice_manual\.commuter\.json$/);
    assert.ok(fs.existsSync(proposalFile));
    assert.deepEqual(fs.readdirSync(path.dirname(proposalFile)), [`${K}.json`]);
    const store = new FleetStore(db, { now: NOW });
    assert.deepEqual(store.fits().map((f) => [f.classKey, f.fittedDay, f.catalogVersion, f.result.proposed]),
        [["ice_cvt.scooter", "2026-10-03", art.catalog.version, false], [K, "2026-10-03", art.catalog.version, true]]);
});

test("proposal: published units, today's priors as basedOn, the evidence and the method", () => {
    const c = readProposal();
    validateProposal(c, `data/bikes/calibration/${K}.json`);
    assert.equal(c.format, CALIBRATION_FORMAT);
    assert.equal(c.classKey, K);
    assert.equal(c.classDefault, curatedCd().id);
    assert.equal(c.date, "2026-10-03");
    for (const k of ["cda", "crr", "indicatedEfficiency", "fmepA"]) {
        const src = curatedCd().priors[k];
        assert.deepEqual(c.basedOn[k], { mean: src.mean, sigma: src.sigma, u: src.u });
        assert.equal(c.priors[k].u, src.u, `${k} stays in the data files' unit`);
    }
    assert.equal(c.priors.fmepA.u, "kPa");
    assert.ok(c.priors.cda.mean > c.basedOn.cda.mean, "the fleet says more drag");
    assert.ok(c.overhead.mean > 1.05 && c.overhead.mean < 1.3, JSON.stringify(c.overhead));
    assert.equal(c.evidence.tanks, 400);
    assert.equal(c.evidence.riders, 40);
    assert.ok(c.evidence.cv.posterior < c.evidence.cv.prior);
    assert.match(c.method, /Bayesian MAP/);
    // formatted like every other data file (scripts/bikedb/format.mjs)
    assert.ok(fs.readFileSync(proposalFile, "utf8").endsWith("}\n"));
});

test("build: the class's bundles ship the calibrated priors (SI), provenance and the overhead; other classes are untouched", () => {
    const cat = loadCatalog(dataDir);
    assert.deepEqual(cat.calibrationReport.map((r) => [r.classKey, r.status]), [[K, "applied"]]);
    const built = buildArtifacts(cat);
    const c = readProposal();
    const cd = built.bundles.find((b) => b.kind === "class_default" && b.classKey === K);
    for (const k of ["cda", "crr", "indicatedEfficiency", "fmepA"]) {
        const f = Contract.FIELDS.find((x) => x.path === `priors.${k}`);
        assert.ok(Math.abs(cd.runtime.priors[k].mean - Contract.toSI(c.priors[k].mean, f.unit)) < 1e-12 * Math.abs(cd.runtime.priors[k].mean), k);
        assert.equal(cd.source.priors[k].src, CALIBRATION_SOURCE_ID);
        assert.match(cd.source.priors[k].note, /^Fleet calibration 2026-10-03 \(was /);
    }
    const s = cd.source.sources.find((x) => x.id === CALIBRATION_SOURCE_ID);
    assert.equal(s.kind, "derived");
    assert.match(s.note, /400 anonymous full-to-full tanks from 40 riders/);
    for (const b of built.bundles) {
        const before = art.bundles.find((x) => x.id === b.id);
        if (b.classKey === K) {
            assert.notEqual(b.hash, before.hash, `${b.id}: a calibrated class's bundles change`);
            assert.deepEqual(b.runtime.calibration, { date: "2026-10-03", tanks: 400, riders: 40, overhead: { ...c.overhead, src: CALIBRATION_SOURCE_ID } });
        } else {
            assert.equal(b.hash, before.hash, `${b.id}: other classes are untouched`);
            assert.equal(b.runtime.calibration, undefined);
        }
    }
    assert.notEqual(built.inputHash, art.inputHash);
    assert.notEqual(built.catalog.version, art.catalog.version);
    // and the physics runs on the calibrated bundle
    const model = Physics.createBikeModel(cd.runtime, { classDefault: cd.runtime });
    assert.ok(Physics.operatingPoint(model, 50 / 3.6).fuelPerMetre > 0);
});

test("after release: the server reports what ships, and phones still on the old bundles can send tanks", async () => {
    const cat = loadCatalog(dataDir);
    const built = buildArtifacts(cat);
    const file = path.join(tmp, "bikes-calibrated.sqlite");
    writeSqlite(built, cat.ref, file, loadDriver());
    const queueDb = loadDriver().open(":memory:");
    const srv = await serveApi({ catalog: file, queueDb, fleetSecret: "s3cret" });
    try {
        let r = await raw(`${srv.url}/api/bikes/fillups`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({
            consent: "fleet-calibration-v1", contributor: "ab".repeat(16),
            tanks: syntheticFleet({ classKey: K, riders: 2, tanksPerRider: 1, seed: 21 }).map((t) => ({ bundle: t.bundle, bike: t.bike, fuelCode: t.fuelCode, massKg: t.massKg, litres: t.litres, km: t.km, idleH: t.idleH, hist: t.hist }))
        }) });
        assert.equal(r.status, 202, r.text);
        assert.deepEqual([r.json.stored, r.json.rejected], [2, []], "pre-calibration bundle hashes, placed by bike id");
        r = await raw(`${srv.url}/api/bikes/calibration/${K}`);
        assert.equal(r.status, 200);
        assert.deepEqual(r.json.shipped, built.bundles.find((b) => b.kind === "class_default" && b.classKey === K).runtime.calibration);
        assert.equal(r.json.shipped.tanks, 400);
    } finally {
        await srv.close();
        srv.api.close();
        queueDb.close();
    }
});

test("re-fit: starts from the curated priors, so the same tanks give the same proposal (never stacked)", () => {
    const first = fs.readFileSync(proposalFile, "utf8");
    const again = calibrate({ db, dataDir, write: true, now: NOW, only: K });
    assert.deepEqual(again.results.map((r) => [r.classKey, r.proposed]), [[K, true]]);
    assert.equal(fs.readFileSync(proposalFile, "utf8"), first);
    assert.equal(again.curatedVersion, art.catalog.version);
});

test("stale: a curator changing the class default's priors stops the proposal from applying", () => {
    const entries = loadCatalog(dataDir, { calibrations: false }).entries;
    const i = entries.findIndex((e) => e.bundle.kind === "class_default" && e.bundle.classKey === K);
    const edited = entries.map((e, j) => (j === i ? { ...e, bundle: { ...e.bundle, priors: { ...e.bundle.priors, cda: { ...e.bundle.priors.cda, mean: e.bundle.priors.cda.mean + 0.01 } } } } : e));
    const r = applyCalibrations(edited, dataDir);
    assert.deepEqual(r.report.map((x) => [x.status, /cda/.test(x.message)]), [["stale", true]]);
    assert.equal(r.calibrations.size, 0);
    assert.strictEqual(r.entries[i], edited[i], "left exactly as curated");
    // and makeProposal refuses a fit made against other priors
    const fit = new FleetStore(db, { now: NOW }).fit(K).result;
    assert.throws(() => makeProposal(fit, edited[i].bundle, "2026-10-03"), /re-fit/);
});

test("invalid proposals stop the build with the reason", () => {
    const good = readProposal();
    const rel = `data/bikes/calibration/${K}.json`;
    const cases = [
        [{ ...good, format: "x" }, /format/],
        [{ ...good, classKey: "ev.scooter" }, /petrol class/],
        [{ ...good, date: "3 Oct" }, /date/],
        [{ ...good, priors: { ...good.priors, cda: { ...good.priors.cda, mean: 5 } } }, /plausible range/],
        [{ ...good, priors: { ...good.priors, cda: { ...good.priors.cda, u: "cm2" } } }, /unit must be m2/],
        [{ ...good, priors: { ...good.priors, extra: good.priors.cda } }, /exactly/],
        [{ ...good, priors: { ...good.priors, crr: { ...good.priors.crr, conf: 2 } } }, /conf/],
        [{ ...good, overhead: { mean: 4, sigma: 0.1, u: "1" } }, /overhead/],
        [{ ...good, evidence: { tanks: 0, riders: 1 } }, /evidence/],
        [{ ...good, method: "" }, /method/]
    ];
    for (const [c, re] of cases) assert.throws(() => validateProposal(c, rel), (e) => e instanceof CalibrationError && re.test(e.message), re.source);
    assert.throws(() => validateProposal(good, "data/bikes/calibration/other.json"), /named/);

    // through the loader: a broken file anywhere in data/bikes/calibration/ fails the whole build
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mu-cal-bad-"));
    try {
        fs.cpSync(dataDir, dir, { recursive: true });
        fs.writeFileSync(path.join(dir, "calibration", `${K}.json`), "{ nope");
        assert.throws(() => loadCatalog(dir), /invalid JSON/);
        fs.writeFileSync(path.join(dir, "calibration", `${K}.json`), JSON.stringify({ ...good, classDefault: "default-ice-manual-naked" }));
        assert.throws(() => loadCatalog(dir), /fitted for default-ice-manual-naked/);
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("the repository ships no calibration yet: the catalogue is exactly the curated one", () => {
    const cat = loadCatalog();
    assert.deepEqual(cat.calibrationReport, []);
    assert.equal(cat.calibrations.size, 0);
    assert.equal(buildArtifacts(cat).catalog.version, buildArtifacts(loadCatalog(DATA, { calibrations: false })).catalog.version);
});
