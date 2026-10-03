// Roadmap Step 10: ride summaries on the phone, the opt-in fleet share, and "Clear my
// history" wiping all of it (js/rides/ride-log.js, js/rides/rides-app.js).
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { loadSmartDrive, memoryStorage, ROOT } from "../smartdrive/harness.mjs";
import { art, drivers, tmpDir, buildDb, memoryDb, serveApi } from "../server/helpers.mjs";
import { syntheticFleet } from "../fleet/synthetic.mjs";

const require = createRequire(import.meta.url);
const R = require("../../public/js/rides/ride-log.js");
const kmh = (x) => x / 3.6;

/** Feed the accumulator one fix a second at the speeds given (km/h). */
function feed(acc, speeds, t0 = 0) {
    speeds.forEach((v, i) => R.step(acc, { t: t0 + i, v: kmh(v), dt: i ? 1 : 0, distance: i ? kmh(v) : 0 }));
}

// ---------------------------------------------------------------------------- the accumulator
test("summary: distance and time per speed band and 5 km/h bin; moving vs idle; top speed", () => {
    const a = R.createAccumulator(Date.parse("2026-10-04T08:00:00+05:30"));
    feed(a, [...Array(61).fill(50), ...Array(30).fill(0), ...Array(60).fill(72)]);
    const s = R.finish(a, { endedAt: Date.parse("2026-10-04T08:03:00+05:30"), id: "r1" });
    assert.equal(s.bands.length, 4);
    assert.deepEqual(s.bands.map((b) => [Math.round(b.from * 3.6), b.to === null ? null : Math.round(b.to * 3.6)]), [[0, 40], [40, 60], [60, 80], [80, null]]);
    assert.ok(Math.abs(s.bands[1].distance - 60 * kmh(50)) < 2 && s.bands[1].time === 60, JSON.stringify(s.bands[1]));
    assert.ok(Math.abs(s.bands[2].distance - 60 * kmh(72)) < 2 && s.bands[2].time === 60);
    assert.equal(s.bands[0].distance + s.bands[3].distance, 0);
    assert.ok(Math.abs(s.hist[10] - 60 * kmh(50)) < 2 && Math.abs(s.hist[14] - 60 * kmh(72)) < 2, "50 → bin 10, 72 → bin 14");
    assert.equal(s.binWidth, 1.389);
    assert.equal(s.idleTime, 30);
    assert.equal(s.movingTime, 120);
    assert.ok(Math.abs(s.distance - 60 * (kmh(50) + kmh(72))) < 3);
    assert.equal(s.maxSpeed, 20);
    assert.equal(s.duration, 180);
    assert.equal(s.day, R.localDay(a.startedAt));
});

test("summary: coasting is slowing at least as fast as the road load alone; gentle easing isn't", () => {
    // 60 → 20 km/h at −1 m/s² (throttle closed: road load at 60 km/h is ~0.5 m/s²)
    const a = R.createAccumulator(0);
    const speeds = [];
    for (let v = kmh(60); v >= kmh(20); v -= 1) speeds.push(v * 3.6);
    feed(a, [60, 60, 60, ...speeds]);
    const s = R.finish(a, { endedAt: 60000, id: "c" });
    assert.ok(s.coasting.distance > 0.7 * s.distance - 3 * kmh(60), JSON.stringify(s.coasting));
    assert.equal(s.coasting.estimate, true);
    assert.ok(s.coasting.share > 0.5 && s.coasting.share <= 1);
    // easing from 60 to 50 over 60 s (−0.05 m/s²): the engine is still pushing
    const b = R.createAccumulator(0);
    feed(b, Array.from({ length: 61 }, (_, i) => 60 - i / 6));
    assert.equal(R.finish(b, { endedAt: 61000, id: "e" }).coasting.distance, 0);
    assert.ok(R.roadLoadDecel(kmh(60)) > 0.4 && R.roadLoadDecel(kmh(60)) < 0.8, `${R.roadLoadDecel(kmh(60))}`);
});

test("summary: a hard stop counts once; a single jittery fix doesn't count at all", () => {
    const a = R.createAccumulator(0);
    feed(a, [60, 60, 60, 44, 28, 12, 0, 0, 40, 40, 60, 60, 44, 60, 60]);
    const s = R.finish(a, { endedAt: 15000, id: "b" });
    assert.equal(s.hardBrakes, 1);
});

test("summary: fill-ups during the ride (SI volumes), the fuel estimate, and nothing about where", () => {
    const a = R.createAccumulator(1_000_000);
    feed(a, Array(30).fill(40), 1000);
    const s = R.finish(a, {
        endedAt: 1_100_000, id: "f", fuelL: 0.4321, idleFuelL: 0.01, fuelSource: "physics", bike: "bike:royal-enfield-hunter-350-metro-in", mode: "bike",
        fills: [{ ts: 900_000, litres: 9 }, { ts: 1_050_000, litres: 8.456, full: true }, { ts: 1_200_000, litres: 3 }]
    });
    assert.deepEqual(s.fillups, [{ volume: 0.008456, full: true, at: 1_050_000 }]);
    assert.deepEqual(s.fuel, { volume: 0.000432, idleVolume: 0.00001, source: "physics" });
    const text = JSON.stringify(s);
    for (const k of ["lat", "lng", "lon", "route", "points", "name", "city", "odometer"]) assert.ok(!text.includes(`"${k}`), `no ${k}`);
});

// ---------------------------------------------------------------------------- the log
test("ride log: add, list, replace by id, 400 rides / 365 days, storage full, clear", () => {
    let t = Date.parse("2026-10-04T00:00:00Z");
    const store = memoryStorage();
    const log = R.createRideLog({ storage: store, now: () => t });
    const ride = (id, endedAt) => ({ v: 1, id, endedAt, startedAt: endedAt - 1000 });
    log.add(ride("a", t - 400 * 86400000));                     // older than a year: dropped on write
    log.add(ride("b", t - 10));
    log.add(ride("b", t - 5));
    assert.deepEqual(log.list().map((r) => [r.id, r.endedAt]), [["b", t - 5]]);
    for (let i = 0; i < 410; i++) log.add(ride(`r${i}`, t + i));
    assert.equal(log.size, 400);
    assert.equal(log.list()[0].id, "r10");
    // quota: drops the oldest quarter until it fits
    let full = true;
    const tight = { getItem: (k) => store.getItem(k), removeItem: (k) => store.removeItem(k), setItem: (k, v) => { if (full && v.length > 20000) throw new Error("QuotaExceededError"); store.setItem(k, v); } };
    const log2 = R.createRideLog({ storage: tight, now: () => t });
    assert.equal(log2.add(ride("big", t + 1000)), true);
    assert.ok(log2.size < 400 && log2.list().at(-1).id === "big");
    log.clear();
    assert.equal(store.getItem(R.LOG_KEY), null);
    assert.equal(log.size, 0);
    // storage blocked: kept in memory for the session
    const mem = R.createRideLog({ storage: null });
    mem.add(ride("m", Date.now()));
    assert.equal(mem.size, 1);
});

// ---------------------------------------------------------------------------- the fleet share, against the real API
const wire = (t) => ({ bundle: t.bundle, bike: t.bike, fuelCode: t.fuelCode, massKg: t.massKg, litres: t.litres, km: t.km, idleH: t.idleH, hist: t.hist });
let dir, srv, queueDb;
before(async () => {
    dir = tmpDir("rides");
    queueDb = memoryDb(drivers[0]);
    srv = await serveApi({ catalog: buildDb(dir, drivers[0]), queueDb, fleetSecret: "s3cret" });
});
after(async () => { await srv.close(); srv.api.close(); queueDb.close(); fs.rmSync(dir, { recursive: true, force: true }); });

test("fleet share: nothing leaves the phone before opt-in; then tanks in batches of 20; opt-out erases them on the server", async () => {
    const calls = [];
    let offline = false;
    const fetchFn = async (url, init) => { calls.push({ url, init }); if (offline) throw new TypeError("Failed to fetch"); return fetch(url, init); };
    const store = memoryStorage();
    const share = R.createFleetShare({ storage: store, fetch: fetchFn, apiBase: srv.url });
    const tanks = syntheticFleet({ classKey: "ice_manual.commuter", riders: 1, tanksPerRider: 25, seed: 4 }).map(wire);

    assert.deepEqual(await share.sync(tanks), { ok: false, reason: "not-opted-in", stored: 0 });
    assert.equal(calls.length, 0, "not one request before the rider opts in");
    assert.equal(store.getItem(R.SHARE_KEY), null);

    const st = share.optIn();
    assert.equal(st.optedIn, true);
    const token = JSON.parse(store.getItem(R.SHARE_KEY)).token;
    assert.match(token, /^[0-9a-f]{32}$/);
    let r = await share.sync(tanks);
    assert.deepEqual(r, { ok: true, stored: 25, duplicates: 0, rejected: 0 });
    assert.equal(calls.length, 2, "25 tanks: two requests (20 + 5)");
    const body = JSON.parse(calls[0].init.body);
    assert.deepEqual(Object.keys(body).sort(), ["consent", "contributor", "tanks"]);
    assert.equal(body.consent, "fleet-calibration-v1");
    assert.equal(calls[0].init.credentials, "omit");
    r = await share.sync(tanks);
    assert.deepEqual([r.stored, r.duplicates], [0, 25], "resent: stored once");
    assert.deepEqual(await share.mine(), { ok: true, classes: [{ classKey: "ice_manual.commuter", tanks: 25 }] });
    assert.equal(share.status().sent, 25);

    // opt out offline: the token is forgotten here but its erasure waits, and runs on the next sync
    offline = true;
    let out = await share.optOut();
    assert.deepEqual(out, { deleted: 0, pending: 1 });
    assert.equal(share.status().optedIn, false);
    assert.equal(JSON.parse(store.getItem(R.SHARE_KEY)).token, null);
    assert.equal(srv.api.fleet().classes()[0].tanks, 25, "still on the server while offline");
    offline = false;
    out = await share.flushErase();
    assert.deepEqual(out, { deleted: 25, pending: 0 });
    assert.deepEqual(srv.api.fleet().classes(), [], "erased on the server");
    assert.equal(store.getItem(R.SHARE_KEY), null, "nothing left on the phone either");
    // no server configured (offline-only app): sharing is unavailable, never an error
    assert.equal(R.createFleetShare({ storage: memoryStorage(), fetch: fetchFn, apiBase: null }).status().available, false);
});

// ---------------------------------------------------------------------------- SmartDrive + rides-app + "Clear my history"
function loadApp(storage) {
    const events = [];
    const sd = loadSmartDrive({
        storage,
        extraScripts: ["public/js/rides/ride-log.js", "public/js/rides/rides-app.js"],
        globals: {
            document: { addEventListener() {}, dispatchEvent: (e) => events.push(e), createElement: () => ({ appendChild() {}, setAttribute() {} }), querySelectorAll: () => [] },
            CustomEvent: class { constructor(type, o) { this.type = type; this.detail = o && o.detail; } },
            TripAnalytics: { submitFinishedTrip() {} }, TripDB: undefined, cityName: "", safeShow() {}, $: () => null,
            navigator: {}, location: { origin: "http://127.0.0.1:1" }, fetch: async () => { throw new TypeError("offline"); },
            crypto: { randomUUID: () => "id-1", getRandomValues: (b) => { b.fill(7); return b; } },
            caches: { deleted: [], async delete(n) { this.deleted.push(n); return true; } }
        }
    });
    return { sd, events };
}

test("a ride end to end: summary stored on the phone; Clear my history wipes it, the learner's log and route caches", async () => {
    const storage = memoryStorage({ "mu.pitstop.v1": JSON.stringify({ v: 1, levels: { me: { share: 0.5, at: Date.now() } } }) });
    const { sd, events } = loadApp(storage);
    sd.run("SmartDrive.init(); FuelCurve.init(); SmartDrive.baseMileage = 40;");
    sd.run("SmartDrive.startTrip()");
    assert.equal(sd.run("SmartDrive.trip.rideSum.v"), 1);
    for (let i = 0; i < 120; i++) sd.run(`SmartDrive.tick({ smoothedKmh: ${i < 60 ? 50 : 70}, accepted: true, confidence: 0.9, dtSec: 1, distKm: ${(i < 60 ? 50 : 70) / 3600}, accuracyM: 5 })`);
    sd.run("FuelCurve.logFill({ litres: 6.2, full: true, odometerKm: 1200 })");
    sd.run("SmartDrive.endTrip()");
    const saved = JSON.parse(storage.getItem("mu_ride_summaries_v1")).rides;
    assert.equal(saved.length, 1);
    const s = saved[0];
    assert.ok(Math.abs(s.distance - 60 * (kmh(50) + kmh(70))) < 25, `${s.distance}`);
    assert.deepEqual(s.fillups.map((f) => f.volume), [0.0062]);
    assert.equal(s.fuel.source, "generic");
    assert.ok(s.fuel.volume > 0);
    assert.equal(sd.run("SmartDrive.trip.rideSum"), null);
    assert.ok(events.some((e) => e.type === "mu:ride-summary" && e.detail.id === s.id));
    assert.equal(sd.run("MURides.app.summaries().length"), 1);

    const r = await sd.run("MURides.app.clearAll()");
    assert.deepEqual({ ...r }, { rides: 1, fills: 1, sharedDeleted: 0, sharedPending: 0 });
    assert.equal(storage.getItem("mu_ride_summaries_v1"), null, "ride summaries gone");
    assert.deepEqual(JSON.parse(storage.getItem("mu_fuel_curve")).fills, [], "the learner's fill-ups gone");
    assert.deepEqual(JSON.parse(storage.getItem("mu_fuel_curve")).trips, [], "and its rides");
    assert.equal(storage.getItem("mu.pitstop.v1"), null);
    assert.deepEqual([...sd.ctx.caches.deleted].sort(), ["mu-pitstop-v1", "mu-trip-v1"], "route caches deleted");
});

test("Clear my history erases the shared tanks on the server too (and says so when it has to wait)", async () => {
    const storage = memoryStorage();
    storage.setItem(R.SHARE_KEY, JSON.stringify({ v: 1, consent: "fleet-calibration-v1", token: "ab".repeat(16), optedInAt: 1, sent: 3, lastSyncAt: 1, pendingErase: [] }));
    const { sd } = loadApp(storage);
    const r = await sd.run("MURides.app.clearAll()");
    assert.equal(r.sharedPending, 1, "offline: waiting to erase");
    assert.deepEqual(JSON.parse(storage.getItem(R.SHARE_KEY)).pendingErase, ["ab".repeat(16)]);
    assert.equal(JSON.parse(storage.getItem(R.SHARE_KEY)).consent, null, "and sharing is off");
    // privacy.js calls it after the server confirmed the deletion of the rest
    const privacy = fs.readFileSync(path.join(ROOT, "public/js/privacy.js"), "utf8");
    assert.match(privacy, /MURides\.app\.clearAll\(\)/);
    assert.match(privacy, /any fill-ups you shared anonymously, and on this phone your ride summaries, fill-up log/);
});

test("a walk or a ride that barely moved leaves no summary; a restored ride keeps its summary so far", () => {
    const storage = memoryStorage();
    const { sd } = loadApp(storage);
    sd.run("SmartDrive.init(); FuelCurve.init(); SmartDrive.startTrip();");
    sd.run("SmartDrive.tick({ smoothedKmh: 10, accepted: true, confidence: 0.9, dtSec: 1, distKm: 0.003, accuracyM: 5 })");
    sd.run("SmartDrive.endTrip()");
    assert.equal(storage.getItem("mu_ride_summaries_v1"), null);
    const trip = { active: true, startTime: 5, rideSum: { ...R.createAccumulator(5), distance: 999 } };
    sd.run("MURides.app.onStart")(trip);
    assert.equal(trip.rideSum.distance, 999);
});
