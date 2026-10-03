// Step 7: SmartDrive's fuel baseline from the rider's bike (My bike → physics),
// with riders who haven't picked a bike seeing exactly the old behaviour.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { buildArtifacts } from "../../scripts/bikedb/catalog-build.mjs";
import { loadCatalog } from "../../scripts/bikedb/load-catalog.mjs";
import { loadSmartDrive, runScenario, memoryStorage, ROOT } from "./harness.mjs";

const require = createRequire(import.meta.url);
const Physics = require("../../public/js/physics/index.js");
const FB = require("../../public/js/garage/fuel-baseline.js");
const art = buildArtifacts(loadCatalog());
const runtime = new Map(art.bundles.map((b) => [b.id, b.runtime]));
const hashOf = new Map(art.bundles.map((b) => [b.id, b.hash]));
const classDefaultOf = (b) => art.bundles.find((x) => x.kind === "class_default" && x.classKey === b.classKey).runtime;
const golden = JSON.parse(fs.readFileSync(path.join(ROOT, "test/smartdrive/golden-legacy.json"), "utf8"));

const HUNTER = "royal-enfield-hunter-350-metro-in";
/** A garage entry as js/garage/store.js saves it. */
function garageFor(id, settings = {}) {
    const b = runtime.get(id);
    return { v: 1, bikeId: b.kind === "variant" ? id : null, bundle: hashOf.get(id), classKey: b.classKey, estimated: b.kind !== "variant", year: null, title: b.kind === "variant" ? `${b.identity.make} ${b.identity.model}` : b.identity.model, settings, savedAt: 1 };
}
function snapshotFor(g) {
    const b = runtime.get(g.bikeId || art.bundles.find((x) => x.hash === g.bundle).id);
    const m = Physics.createBikeModel(b, { classDefault: b.kind === "variant" ? classDefaultOf(b) : undefined, settings: g.settings });
    return FB.buildFuelBaseline(Physics, m, g);
}
/** SmartDrive with the baseline module loaded, as index.html loads them. */
function withBike(storageInit, globals) {
    const sd = loadSmartDrive({ storage: memoryStorage(storageInit), extraScripts: ["public/js/garage/fuel-baseline.js"], globals });
    return sd;
}
const json = (x) => JSON.parse(JSON.stringify(x));

// ---------------------------------------------------------------------------
test("no bike chosen: every fuel number is identical to the pre-Step-7 SmartDrive (golden run)", () => {
    for (const [name, init] of [["default", {}], ["stated45", { sd_mileage: "45" }]]) {
        for (const extra of [[], ["public/js/garage/fuel-baseline.js"]]) {
            const sd = loadSmartDrive({ storage: memoryStorage(init), extraScripts: extra });
            sd.run("SmartDrive.init(); FuelCurve.init();");
            assert.equal(sd.run("BikeFuel.status"), "none");
            assert.deepEqual(json(runScenario(sd)), golden[name], `${name}, baseline module ${extra.length ? "loaded" : "absent"}`);
            assert.equal(sd.run("SmartDrive.ratedKmPerL()"), name === "default" ? 18 : 45);
        }
    }
});

test("no bike chosen: start-up emits nothing new (meetup mileage is shared only when it changes)", () => {
    const sd = withBike({});
    sd.run("SmartDrive.init(); FuelCurve.init();");
    assert.deepEqual(sd.emitted, []);
});

test("with a bike: the physics snapshot is the baseline — km/L per speed, idle burn and the 40–60 reference", () => {
    const g = garageFor(HUNTER);
    const snap = snapshotFor(g);
    const sd = withBike({ "mu.garage.v1": JSON.stringify(g), mu_bike_fuel_v1: JSON.stringify(snap) });
    sd.run("SmartDrive.init(); FuelCurve.init();");
    assert.equal(sd.run("BikeFuel.status"), "ready", "a matching snapshot is used at once, synchronously");
    assert.equal(sd.run("SmartDrive.ratedKmPerL()"), snap.referenceKmPerL);
    assert.notEqual(snap.referenceKmPerL, 18);
    assert.equal(sd.run("FuelCurve.idleLPerHour()"), snap.idleLPerHour);
    assert.equal(sd.run("FuelCurve.efficientKmPerL()"), snap.referenceKmPerL);
    // one tick at 72 km/h for 1 s: fuel = distance ÷ the physics km/L at 72 km/h
    sd.run("SmartDrive.trip = { active: true, startTime: 0, totalDist: 0, actualFuel: 0, maxSpeed: 0, sumSpeed: 0, ticks: 0, ranges: { efficient: 0, moderate: 0, inefficient: 0 }, stoppedTimeSec: 0, points: [], lastPointTs: 0, idleSec: 0, idleFuelL: 0, bandKm: [0, 0, 0, 0], fitSeg: null };");
    sd.run("SmartDrive.tick({ smoothedKmh: 72, accepted: true, confidence: 0.9, dtSec: 1, distKm: 0.02 })");
    assert.ok(Math.abs(sd.run("SmartDrive.trip.actualFuel") - 0.02 / FB.kmPerLAt(snap, 72)) < 1e-15);
    sd.run("SmartDrive.tick({ smoothedKmh: 0, accepted: true, confidence: 0.9, dtSec: 60, distKm: 0 })");
    assert.ok(Math.abs(sd.run("SmartDrive.trip.idleFuelL") - snap.idleLPerHour / 60) < 1e-12, "idle at the physics rate, not the assumed 0.4 L/h");
    assert.equal(sd.run("SmartDrive.trip.fitSeg.hist[14]"), 0.02, "72 km/h goes in the 70–75 km/h bin");
});

test("with a bike: fill-ups correct the physics (not the generic curve), and the learned curve sits on top of it", () => {
    const g = garageFor(HUNTER);
    const snap = snapshotFor(g);
    const sd = withBike({ "mu.garage.v1": JSON.stringify(g), mu_bike_fuel_v1: JSON.stringify(snap) });
    sd.run("SmartDrive.init(); FuelCurve.init();");
    // the "true" bike burns 30 % more than steady-state physics everywhere (stops, wind, warm-up …)
    const r = runScenario(sd, { trueKmPerL: (v) => FB.kmPerLAt(snap, v) / 1.3, trueIdleLph: snap.idleLPerHour * 1.3 });
    assert.equal(r.fit.ready, true);
    assert.equal(sd.run("FuelCurve.fit.baseline"), snap.key, "fitted on the bike's baseline");
    assert.ok(r.fit.mape < 0.02, `fits the fill-ups within 2 % (${r.fit.mape})`);
    // Per-band β isn't identifiable when every tank mixes the same riding (the bands move together);
    // what the fill-ups do pin down is each tank's overall correction: 1.3 × the physics litres.
    const beta = sd.run("FuelCurve.fit.beta");
    for (const iv of sd.run("FuelCurve.fit.intervals")) {
        const phys = iv.bikeL.reduce((a, x) => a + x, 0) + iv.idleH * snap.idleLPerHour;
        const learned = iv.bikeL.reduce((a, x, j) => a + x * beta[j], 0) + iv.idleH * snap.idleLPerHour * beta[4];
        assert.ok(Math.abs(learned / phys - 1.3) < 0.03, `tank correction ${learned / phys}`);
    }
    assert.ok(Math.abs(r.fit.priorMape - 0.3 / 1.3) < 0.03, "physics alone is off by the 30 %");
    assert.match(r.status, /your bike's physics alone/);
    assert.ok(Math.abs(sd.run("FuelCurve.kmPerL(50)") - FB.kmPerLAt(snap, 50) / beta[1]) < 1e-9, "personal km/L = the bike's ÷ β of its band");
    const fills = JSON.parse(sd.ctx.localStorage.getItem("mu_fuel_curve")).fills;
    assert.ok(fills.every((f) => f.bike === `bike:${HUNTER}`), "fill-ups are tagged with the bike");
    const trips = JSON.parse(sd.ctx.localStorage.getItem("mu_fuel_curve")).trips;
    assert.ok(trips.every((t) => Array.isArray(t.hist) && t.hist.length === 40), "drives keep their 5 km/h speed bins");
});

test("fill-ups logged with another bike aren't used for this one; untagged (older) fill-ups still are", () => {
    const g = garageFor(HUNTER);
    const snap = snapshotFor(g);
    const sd = withBike({ "mu.garage.v1": JSON.stringify(g), mu_bike_fuel_v1: JSON.stringify(snap) });
    sd.run("SmartDrive.init(); FuelCurve.init();");
    runScenario(sd, { trueKmPerL: (v) => FB.kmPerLAt(snap, v) / 1.2 });
    const usable = () => sd.run("FuelCurve.fit.usable");
    assert.equal(usable(), 7);
    const st = JSON.parse(sd.ctx.localStorage.getItem("mu_fuel_curve"));
    st.fills.forEach((f, i) => { if (i < 3) f.bike = "bike:hero-splendor-plus-obd2b-in"; else if (i < 5) delete f.bike; });
    sd.ctx.localStorage.setItem("mu_fuel_curve", JSON.stringify(st));
    sd.run("FuelCurve.load(); FuelCurve.refit();");
    const ivs = sd.run("FuelCurve.fit.intervals");
    assert.deepEqual(json(ivs.map((iv) => iv.usable)), [false, false, false, true, true, true, true]);
    assert.equal(ivs[0].reason, "logged with a different bike");
});

test("the bike or its settings changed: the snapshot is rebuilt from the physics, and SmartDrive follows", async () => {
    const g = garageFor(HUNTER);
    const stale = snapshotFor(g);
    const heavier = garageFor(HUNTER, { pillionMass: 75 });
    let built = 0;
    // the page's shared store (js/trip/trip-app.js MUTrip.app.store) and the physics core
    const page = { MUPhysics: Physics, MUTrip: { app: { store: {
        catalog: async () => ({ index: {} }),
        model: async (gg) => { built++; const b = runtime.get(gg.bikeId); return { model: Physics.createBikeModel(b, { classDefault: classDefaultOf(b), settings: gg.settings }) }; }
    } } } };
    const sd = withBike({ "mu.garage.v1": JSON.stringify(heavier), mu_bike_fuel_v1: JSON.stringify(stale) }, page);
    sd.run("SmartDrive.init(); FuelCurve.init();");
    assert.equal(sd.run("BikeFuel.status"), "loading", "the stored snapshot is for other settings: not used");
    assert.equal(sd.run("SmartDrive.ratedKmPerL()"), 18, "meanwhile: the old behaviour");
    await sd.run("BikeFuel._pending.promise");
    assert.equal(sd.run("BikeFuel.status"), "ready");
    assert.equal(built, 1);
    const fresh = JSON.parse(sd.ctx.localStorage.getItem("mu_bike_fuel_v1"));
    assert.equal(fresh.key, FB.garageKey(heavier));
    assert.ok(fresh.referenceKmPerL < stale.referenceKmPerL, "a pillion costs mileage");
    assert.equal(sd.run("SmartDrive.ratedKmPerL()"), fresh.referenceKmPerL);
    assert.deepEqual(json(sd.emitted.at(-1)), ["setMileage", { kmPerL: fresh.referenceKmPerL }], "meetups cost this rider's leg with the bike");
    // the rider removes the bike: back to the old behaviour, snapshot dropped
    sd.ctx.localStorage.removeItem("mu.garage.v1");
    await sd.run("BikeFuel.sync()");
    assert.equal(sd.run("BikeFuel.status"), "none");
    assert.equal(sd.ctx.localStorage.getItem("mu_bike_fuel_v1"), null);
    assert.equal(sd.run("SmartDrive.ratedKmPerL()"), 18);
});

test("the bike's data can't be loaded (offline, first time): the old behaviour, a clear note, and a retry later", async () => {
    let fail = true;
    const store = {
        catalog: async () => { if (fail) throw new Error("This bike's data isn't on this phone yet."); return { index: {} }; },
        model: async (gg) => ({ model: Physics.createBikeModel(runtime.get(gg.bikeId), { classDefault: classDefaultOf(runtime.get(gg.bikeId)) }) })
    };
    const el = (o) => ({ addEventListener() {}, ...o });
    const els = { "fuel-input-val": el({ value: "", disabled: false }), "fuel-source-hint": el({ textContent: "", hidden: true }), "bike-fuel-status": el({ textContent: "" }) };
    const sd = withBike({ "mu.garage.v1": JSON.stringify(garageFor(HUNTER)), sd_mileage: "40" }, { MUPhysics: Physics, MUTrip: { app: { store } }, $: (id) => els[id] || null });
    sd.run("SmartDrive.init(); FuelCurve.init();");
    await sd.run("BikeFuel._pending.promise");
    assert.equal(sd.run("BikeFuel.status"), "error");
    assert.equal(sd.run("SmartDrive.ratedKmPerL()"), 40, "the rider's own km/L");
    assert.equal(els["fuel-input-val"].disabled, false);
    assert.match(els["fuel-source-hint"].textContent, /Couldn't load your bike's data/);
    fail = false;
    await sd.run("BikeFuel.sync()");
    assert.equal(sd.run("BikeFuel.status"), "ready");
    assert.equal(els["fuel-input-val"].disabled, true, "the km/L field now shows (and is) the bike's figure");
    assert.equal(Number(els["fuel-input-val"].value), Number(sd.run("BikeFuel.referenceKmPerL()").toFixed(1)));
    assert.match(els["fuel-source-hint"].textContent, /From your Royal Enfield Hunter 350 in My bike: \d+\.\d km\/L at 40–60 km\/h ±\d+%/);
    assert.equal(els["bike-fuel-status"].textContent, "Royal Enfield Hunter 350");
});

test("an electric bike: no litres are counted, and its drives stay out of the fill-up learner", () => {
    const g = garageFor("ather-450x-2-9kwh-2025-in");
    const snap = snapshotFor(g);
    assert.equal(snap.kind, "ev");
    const sd = withBike({ "mu.garage.v1": JSON.stringify(g), mu_bike_fuel_v1: JSON.stringify(snap) });
    sd.run("SmartDrive.init(); FuelCurve.init();");
    assert.equal(sd.run("BikeFuel.status"), "ev");
    assert.equal(sd.run("BikeFuel.active()"), false);
    const r = runScenario(sd);
    assert.equal(r.totalFuel, 0);
    assert.equal(r.idleFuel, 0);
    assert.equal(JSON.parse(sd.ctx.localStorage.getItem("mu_fuel_curve")).trips.length, 0);
});

test("a typical bike (My bike's 'not listed' choice) works the same way, tagged by its class", () => {
    const g = garageFor("default-ice-cvt-scooter");
    const snap = snapshotFor(g);
    assert.equal(snap.bikeTag, "class:ice_cvt.scooter");
    assert.equal(snap.estimated, true);
    const sd = withBike({ "mu.garage.v1": JSON.stringify(g), mu_bike_fuel_v1: JSON.stringify(snap) });
    sd.run("SmartDrive.init(); FuelCurve.init();");
    assert.equal(sd.run("BikeFuel.status"), "ready");
    assert.match(sd.run("BikeFuel.describe()"), /^From your typical /);
});

test("the data layer isn't loaded at all (scripts failed): the old behaviour, never a crash", async () => {
    const sd = withBike({ "mu.garage.v1": JSON.stringify(garageFor(HUNTER)) });
    sd.run("SmartDrive.init(); FuelCurve.init();");
    await sd.run("BikeFuel._pending.promise");
    assert.equal(sd.run("BikeFuel.status"), "error");
    assert.equal(sd.run("SmartDrive.ratedKmPerL()"), 18);
});

test("the map's My bike sheet (mu:garage-change) makes SmartDrive re-read the bike", async () => {
    const g = garageFor(HUNTER);
    const listeners = {};
    const document = { addEventListener: (t, fn) => { listeners[t] = fn; }, createElement: () => ({}), querySelectorAll: () => [] };
    const sd = withBike({ "mu.garage.v1": JSON.stringify(g), mu_bike_fuel_v1: JSON.stringify(snapshotFor(g)) }, { document, addEventListener() {} });
    sd.run("SmartDrive.init(); FuelCurve.init();");
    assert.equal(sd.run("BikeFuel.status"), "ready");
    assert.equal(typeof listeners["mu:garage-change"], "function");
    sd.ctx.localStorage.removeItem("mu.garage.v1");          // the rider cleared the bike in the sheet
    await listeners["mu:garage-change"]();
    assert.equal(sd.run("BikeFuel.status"), "none");
    assert.equal(sd.run("SmartDrive.ratedKmPerL()"), 18, "back to 18 km/L");
});

test("junk in storage (a hand-edited or older snapshot) is ignored, never trusted", async () => {
    const g = garageFor(HUNTER);
    for (const junk of ["{", JSON.stringify({ format: 1, kind: "petrol", key: FB.garageKey(g), bikeTag: "x", title: "x", kmPerL: [1, "2"], step: 1, idleLPerHour: 0.1, referenceKmPerL: 1 }), JSON.stringify({ ...snapshotFor(g), format: 99 })]) {
        const sd = withBike({ "mu.garage.v1": JSON.stringify(g), mu_bike_fuel_v1: junk }, { MUPhysics: Physics, MUTrip: { app: { store: { catalog: async () => { throw new Error("offline"); } } } } });
        sd.run("SmartDrive.init(); FuelCurve.init();");
        await sd.run("BikeFuel._pending && BikeFuel._pending.promise");
        assert.equal(sd.run("BikeFuel.status"), "error");
        assert.equal(sd.run("SmartDrive.ratedKmPerL()"), 18);
    }
});

test("group features use the bike too: meetup costing counts it as stated, carpool defaults to it", () => {
    const src = fs.readFileSync(path.join(ROOT, "public/js/groupnav.js"), "utf8");
    assert.match(src, /BikeFuel\.active\(\)\) stated = true/);
    assert.match(src, /SmartDrive\.ratedKmPerL\(\) \|\| 15/);
    assert.doesNotMatch(src, /SmartDrive\.baseMileage/, "nothing reads the raw km/L field any more");
});
