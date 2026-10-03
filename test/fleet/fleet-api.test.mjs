// Step 8: anonymous fill-ups — the store (lib/bikedb/fleet.js) and the HTTP routes
// the phone and the Fuel Learner dashboard call (lib/bikedb/http-api.js).
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import crypto from "node:crypto";
import { createRequire } from "node:module";
import { art, drivers, tmpDir, buildDb, memoryDb, serveApi, raw } from "../server/helpers.mjs";
import { syntheticFleet, classDefault } from "./synthetic.mjs";

const require = createRequire(import.meta.url);
const { FleetStore, validateTank, CONSENT, LIMITS } = require("../../lib/bikedb/fleet.js");

const ANDROID = "https://localhost";
const EVIL = "https://evil.example";
const K = "ice_manual.commuter";
const token = (seed) => crypto.createHash("sha256").update(String(seed)).digest("hex").slice(0, 32);
/** What the phone sends for a tank (no contributor, no bike id: the bundle hash says which bike). */
const wire = (t) => ({ bundle: t.bundle, fuelCode: t.fuelCode, massKg: t.massKg, litres: t.litres, km: t.km, idleH: t.idleH, hist: t.hist });
const fleetTanks = syntheticFleet({ classKey: K, truth: { overhead: 1.1 }, riders: 6, tanksPerRider: 4, seed: 11 });
const evBundle = art.bundles.find((b) => b.classKey.startsWith("ev.") && b.kind === "variant");
const known = {
    bundleClass: (h) => { const b = art.bundles.find((x) => x.hash === h); return b ? { classKey: b.classKey, bikeId: b.id } : null; },
    fuels: ["E0", "E10", "E20", "E85", "E100"],
    evClass: (k) => k.startsWith("ev.")
};

// ---------------------------------------------------------------------------
// validation
// ---------------------------------------------------------------------------
test("validateTank: a real tank passes, rounded (mass to 5 kg) and tied to the bike id", () => {
    const t = { ...wire(fleetTanks[0]), massKg: 77.4, litres: 7.123, km: 312.345 };
    const v = validateTank(t, known);
    assert.equal(v.ok, true, JSON.stringify(v));
    assert.equal(v.value.massKg, 75);
    assert.equal(v.value.litres, 7.12);
    assert.equal(v.value.km, 312.3);
    assert.equal(v.value.classKey, K);
    assert.equal(v.value.bikeId, fleetTanks[0].bike);
});

test("validateTank: implausible or unknown records are refused with the field at fault", () => {
    const ok = wire(fleetTanks[0]);
    const cases = [
        [null, ""], [[], ""],
        [{ ...ok, bundle: "zz" }, "bundle"],
        [{ ...ok, bundle: "0123456789abcdef" }, "bundle"],
        [{ ...ok, bundle: evBundle.hash }, "bundle"],
        [{ ...ok, classKey: "ice_manual.sport" }, "classKey"],
        [{ ...ok, fuelCode: "DIESEL" }, "fuelCode"],
        [{ ...ok, massKg: 20 }, "massKg"],
        [{ ...ok, km: 2 }, "km"],
        [{ ...ok, km: 4000 }, "km"],
        [{ ...ok, litres: 0.1 }, "litres"],
        [{ ...ok, litres: ok.km / 150 }, "litres"],          // 150 km/L
        [{ ...ok, litres: ok.km / 1.5 }, "litres"],          // 1.5 km/L
        [{ ...ok, idleH: -1 }, "idleH"],
        [{ ...ok, idleH: 49 }, "idleH"],
        [{ ...ok, hist: ok.hist.slice(1) }, "hist"],
        [{ ...ok, hist: ok.hist.map((x, i) => (i === 3 ? -1 : x)) }, "hist"],
        [{ ...ok, hist: ok.hist.map((x) => x * 1.2) }, "hist"],   // bins add up to 20 % more than the tank
        [{ ...ok, km: Number.NaN }, "km"]
    ];
    for (const [t, field] of cases) {
        const v = validateTank(t, known);
        assert.equal(v.ok, false, JSON.stringify(t && t.bundle));
        assert.equal(v.field, field);
        assert.ok(v.message.length > 5);
    }
    assert.match(validateTank({ ...ok, bundle: evBundle.hash }, known).message, /electric/);
});

test("validateTank: a bundle from an older catalogue build is placed by the bike's id (or the class, for a typical bike)", () => {
    const ok = wire(fleetTanks[0]);
    const variant = art.bundles.find((b) => b.id === fleetTanks[0].bike);
    const withIds = {
        ...known,
        bikeClass: (id, k) => {
            const b = id ? art.bundles.find((x) => x.kind === "variant" && x.id === id) : art.bundles.find((x) => x.kind === "class_default" && x.classKey === k);
            return b ? { classKey: b.classKey, bikeId: b.id } : null;
        }
    };
    const OLD = "0123456789abcdef";
    let v = validateTank({ ...ok, bundle: OLD, bike: variant.id }, withIds);
    assert.equal(v.ok, true, JSON.stringify(v));
    assert.deepEqual([v.value.bikeId, v.value.classKey, v.value.bundle], [variant.id, K, OLD], "the phone's bundle is kept as the data version it used");
    v = validateTank({ ...ok, bundle: OLD, classKey: K }, withIds);
    assert.deepEqual([v.ok, v.value.bikeId], [true, classDefault(K).id]);
    for (const [t, field] of [[{ ...ok, bundle: OLD }, "bundle"], [{ ...ok, bundle: OLD, bike: "no-such-bike" }, "bundle"], [{ ...ok, bike: "bajaj-pulsar-ns200-dual-abs-in" }, "bike"], [{ ...ok, bike: 7 }, "bike"]]) {
        v = validateTank(t, withIds);
        assert.deepEqual([v.ok, v.field], [false, field], JSON.stringify([t.bundle, t.bike]));
    }
});

// ---------------------------------------------------------------------------
// the store
// ---------------------------------------------------------------------------
function storeWith(now = () => Date.parse("2026-10-03T12:00:00Z")) {
    const db = memoryDb(drivers[0]);
    return { db, store: new FleetStore(db, { secret: "s3cret", now }) };
}
const valid = (tanks) => tanks.map((t) => validateTank(wire(t), known).value);

test("store: contributor ids are keyed HMACs (never the token), and a store without a secret refuses tokens", () => {
    const { db, store } = storeWith();
    const id = store.contributorId(token(1));
    assert.match(id, /^[0-9a-f]{32}$/);
    assert.notEqual(id, token(1));
    assert.equal(id, store.contributorId(token(1)));
    assert.notEqual(id, new FleetStore(db, { secret: "other" }).contributorId(token(1)));
    assert.throws(() => store.contributorId("short"), RangeError);
    assert.throws(() => store.contributorId(token(1).toUpperCase()), RangeError);
    assert.throws(() => new FleetStore(db).contributorId(token(1)), /no secret/);
    db.close();
});

test("store: submit, dedupe resent tanks, count per class, read back in the fit's shape", () => {
    const { db, store } = storeWith();
    const mine = valid(fleetTanks.slice(0, 4)), theirs = valid(fleetTanks.slice(4, 8));
    assert.deepEqual(store.submit(token(1), mine), { stored: 4, duplicates: 0 });
    assert.deepEqual(store.submit(token(1), mine), { stored: 0, duplicates: 4 }, "a resent batch is stored once");
    assert.deepEqual(store.submit(token(2), theirs), { stored: 4, duplicates: 0 });
    assert.deepEqual(store.classes(), [{ classKey: K, tanks: 8, riders: 2, km: store.classes()[0].km }]);
    assert.deepEqual(store.mine(token(1)), [{ classKey: K, tanks: 4 }]);
    const back = store.tanks(K);
    assert.equal(back.length, 8);
    assert.deepEqual(Object.keys(back[0]).sort(), ["bike", "contributor", "fuelCode", "hist", "idleH", "km", "litres", "massKg"]);
    assert.equal(back[0].hist.length, 40);
    assert.equal(back[0].bike, fleetTanks[0].bike);
    // nothing in the table can identify a person or a ride: no token, no time finer than a day
    const rows = db.prepare("SELECT * FROM fleet_tank").all();
    for (const r of rows) {
        assert.ok(!JSON.stringify(r).includes(token(1)) && !JSON.stringify(r).includes(token(2)));
        assert.equal(r.received_day, "2026-10-03");
    }
    assert.deepEqual(Object.keys(rows[0]).sort(), ["bike_id", "bundle", "class_key", "contributor", "fingerprint", "fuel_code", "hist", "idle_h", "km", "litres", "mass_kg", "received_day", "tank_id"]);
    db.close();
});

test("store: a failed batch stores nothing (atomic)", () => {
    const { db, store } = storeWith();
    const tanks = valid(fleetTanks.slice(0, 3));
    tanks[2] = { ...tanks[2], massKg: 77 };                       // violates the table's CHECK (mass in 5 kg steps)
    assert.throws(() => store.submit(token(1), tanks));
    assert.deepEqual(store.classes(), []);
    db.close();
});

test("store: forget deletes everything of one contributor; purge drops tanks past retention", () => {
    let t = Date.parse("2024-01-01T00:00:00Z");
    const { db, store } = storeWith(() => t);
    store.submit(token(1), valid(fleetTanks.slice(0, 4)));
    t = Date.parse("2026-10-03T00:00:00Z");
    store.submit(token(2), valid(fleetTanks.slice(4, 8)));
    store.submit(token(3), valid(fleetTanks.slice(8, 10)));
    assert.equal(store.forget(token(3)), 2);
    assert.equal(store.forget(token(3)), 0);
    assert.equal(store.purge(), 4, "the 2024 tanks are past 730 days");
    assert.deepEqual(store.classes().map((c) => [c.tanks, c.riders]), [[4, 1]]);
    assert.equal(new FleetStore(db, { retentionDays: 0 }).purge(), 0, "retention 0 = keep");
    db.close();
});

test("store: fits are saved per class and replaced by the next one", () => {
    const { db, store } = storeWith();
    store.saveFit(K, "v1", { proposed: false, reason: "needs 30 tanks (has 8)" });
    store.saveFit(K, "v2", { proposed: true, reason: null });
    assert.deepEqual(store.fit(K), { classKey: K, fittedDay: "2026-10-03", catalogVersion: "v2", result: { proposed: true, reason: null } });
    assert.equal(store.fits().length, 1);
    assert.equal(store.fit("ice_cvt.scooter"), null);
    db.close();
});

// ---------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------
let dir, file, srv, queueDb, bare;
before(async () => {
    dir = tmpDir("fleet");
    file = buildDb(dir, drivers[0]);
    queueDb = memoryDb(drivers[0]);
    srv = await serveApi({ catalog: file, queueDb, corsOrigins: [ANDROID], fleetSecret: () => "s3cret" });
    bare = await serveApi({ catalog: file, queueDb: memoryDb(drivers[0]) });           // no secret: fleet off
});
after(async () => {
    for (const s of [srv, bare]) { await s.close(); s.api.close(); }
    queueDb.close();
    fs.rmSync(dir, { recursive: true, force: true });
});
const send = (method, p, body, headers = {}) => {
    const text = typeof body === "string" ? body : JSON.stringify(body);
    return raw(srv.url + p, { method, headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(text), ...headers }, body: text });
};
const post = (p, body, headers) => send("POST", p, body, headers);

test("POST /fillups: consent, a contributor token and 1–20 tanks are required", async () => {
    const tanks = fleetTanks.slice(0, 2).map(wire);
    let r = await post("/api/bikes/fillups", { contributor: token(1), tanks });
    assert.equal(r.status, 400);
    assert.equal(r.json.reason, "consent-required");
    r = await post("/api/bikes/fillups", { consent: "yes", contributor: token(1), tanks });
    assert.equal(r.json.reason, "consent-required");
    for (const contributor of [undefined, "abc", token(1).toUpperCase(), 42]) {
        r = await post("/api/bikes/fillups", { consent: CONSENT, contributor, tanks });
        assert.equal(r.status, 400);
        assert.equal(r.json.errors[0].field, "contributor");
    }
    for (const t of [[], undefined, Array(LIMITS.tanksPerPost + 1).fill(tanks[0])]) {
        r = await post("/api/bikes/fillups", { consent: CONSENT, contributor: token(1), tanks: t });
        assert.equal(r.status, 400);
        assert.equal(r.json.errors[0].field, "tanks");
    }
    r = await post("/api/bikes/fillups", "[1,2]");
    assert.equal(r.status, 400);
    r = await raw(srv.url + "/api/bikes/fillups", { method: "POST", headers: { "Content-Type": "text/plain" }, body: "x" });
    assert.equal(r.status, 415);
    r = await post("/api/bikes/fillups", { consent: CONSENT, contributor: token(1), tanks, pad: "x".repeat(70 * 1024) });
    assert.equal(r.status, 413, "64 kB body limit");
});

test("POST /fillups: 202 with stored / duplicates / rejected; all-bad is a 400", async () => {
    const tanks = fleetTanks.slice(0, 4).map(wire);
    const bad = { ...tanks[0], bundle: evBundle.hash };
    let r = await post("/api/bikes/fillups", { consent: CONSENT, contributor: token(1), tanks: [...tanks, bad] });
    assert.equal(r.status, 202, r.text);
    assert.deepEqual({ ...r.json, rejected: r.json.rejected.map((x) => [x.index, x.field]) }, { ok: true, stored: 4, duplicates: 0, rejected: [[4, "bundle"]] });
    r = await post("/api/bikes/fillups", { consent: CONSENT, contributor: token(1), tanks });
    assert.deepEqual([r.status, r.json.stored, r.json.duplicates], [202, 0, 4]);
    // a bundle an older catalogue build shipped: placed by the bike's id, like the app sends it
    r = await post("/api/bikes/fillups", { consent: CONSENT, contributor: token(9), tanks: [{ ...wire(fleetTanks[23]), bundle: "0123456789abcdef", bike: fleetTanks[23].bike }] });
    assert.deepEqual([r.status, r.json.stored], [202, 1], r.text);
    await send("DELETE", "/api/bikes/fillups", { contributor: token(9) });
    r = await post("/api/bikes/fillups", { consent: CONSENT, contributor: token(1), tanks: [bad] });
    assert.equal(r.status, 400);
    assert.equal(r.json.reason, "invalid");
    assert.equal(r.json.rejected[0].field, "bundle");
});

test("POST /fillups/mine and DELETE /fillups: a rider sees and erases exactly their own tanks", async () => {
    await post("/api/bikes/fillups", { consent: CONSENT, contributor: token(2), tanks: fleetTanks.slice(4, 7).map(wire) });
    let r = await post("/api/bikes/fillups/mine", { contributor: token(2) });
    assert.equal(r.status, 200);
    assert.deepEqual(r.json.classes, [{ classKey: K, tanks: 3 }]);
    assert.equal(r.headers["cache-control"], "no-store");
    r = await send("DELETE", "/api/bikes/fillups", { contributor: token(2) });
    assert.deepEqual(r.json, { ok: true, deleted: 3 });
    r = await post("/api/bikes/fillups/mine", { contributor: token(2) });
    assert.deepEqual(r.json.classes, []);
    r = await send("DELETE", "/api/bikes/fillups", { contributor: "nope" });
    assert.equal(r.status, 400);
});

test("CORS: the Android app may POST and DELETE; other origins are refused", async () => {
    const pre = await raw(`${srv.url}/api/bikes/fillups`, { method: "OPTIONS", headers: { Origin: ANDROID, "Access-Control-Request-Method": "DELETE", "Access-Control-Request-Headers": "content-type" } });
    assert.equal(pre.status, 204);
    assert.equal(pre.headers["access-control-allow-origin"], ANDROID);
    assert.match(pre.headers["access-control-allow-methods"], /DELETE/);
    const ok = await post("/api/bikes/fillups/mine", { contributor: token(1) }, { Origin: ANDROID });
    assert.equal(ok.status, 200);
    assert.equal(ok.headers["access-control-allow-origin"], ANDROID);
    for (const [m, p] of [["POST", "/api/bikes/fillups"], ["POST", "/api/bikes/fillups/mine"], ["DELETE", "/api/bikes/fillups"]]) {
        const r = await send(m, p, { consent: CONSENT, contributor: token(1), tanks: [wire(fleetTanks[0])] }, { Origin: EVIL });
        assert.equal(r.status, 403, `${m} ${p}`);
        assert.equal(r.headers["access-control-allow-origin"], undefined);
    }
});

test("GET /calibration: per-class counts and the latest fit; one class in full; 400 / 404", async () => {
    srv.api.fleet().saveFit(K, art.catalog.version, { proposed: false, reason: "needs 30 tanks (has 4)", evidence: { tanks: 4 }, overhead: null, cv: null });
    let r = await raw(`${srv.url}/api/bikes/calibration`);
    assert.equal(r.status, 200);
    assert.equal(r.headers["cache-control"], "public, max-age=300");
    assert.deepEqual(r.json.classes.map((c) => [c.classKey, c.tanks, c.riders, c.fit.proposed, c.fit.reason]), [[K, 4, 1, false, "needs 30 tanks (has 4)"]]);
    r = await raw(`${srv.url}/api/bikes/calibration/${K}`);
    assert.equal(r.status, 200);
    assert.equal(r.json.classKey, K);
    assert.equal(r.json.data.tanks, 4);
    assert.equal(r.json.fit.catalogVersion, art.catalog.version);
    assert.equal(r.json.shipped, null, "no reviewed calibration in this catalogue");
    assert.equal((await raw(`${srv.url}/api/bikes/calibration/ice_cvt.scooter`)).status, 404);
    assert.equal((await raw(`${srv.url}/api/bikes/calibration/DROP%20TABLE`)).status, 400);
});

test("without a fleet secret the fleet routes are 503 and nothing else changes", async () => {
    for (const [m, p, b] of [["POST", "/api/bikes/fillups", { consent: CONSENT, contributor: token(1), tanks: [wire(fleetTanks[0])] }], ["POST", "/api/bikes/fillups/mine", { contributor: token(1) }], ["GET", "/api/bikes/calibration"]]) {
        const r = await raw(bare.url + p, { method: m, headers: { "Content-Type": "application/json" }, body: b && JSON.stringify(b) });
        assert.equal(r.status, 503, p);
        assert.equal(r.json.reason, "fleet-unavailable");
    }
    assert.equal((await raw(`${bare.url}/api/bikes/search?q=hunter`)).status, 200);
});
