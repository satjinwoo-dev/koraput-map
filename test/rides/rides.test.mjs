// Roadmap step 10: ride summaries, anonymous tank telemetry (FLEET.md), delete my history
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { DatabaseSync } from "node:sqlite";

const require = createRequire(import.meta.url);
const F = require("../../public/js/rides/fleet.js");
const M = require("../../public/js/rides/ride-model.js");
const S = require("../../public/js/rides/ride-store.js");
const UI = require("../../public/js/rides/rides-ui.js");
const CU = require("../../public/js/rides/consent-ui.js");
const SRV = require("../../lib/fleet.js");
const U = require("../../public/js/garage/units.js");
const C = F.contract;

const NOW = new Date(2026, 9, 4, 9, 30).getTime();
/** A learner interval as FuelCurve.intervals() returns it. */
const iv = (o = {}) => ({ fromTs: new Date(2026, 8, 3).getTime(), toTs: new Date(2026, 8, 17).getTime(), litres: 11.45, litresAdj: 11.45, shape: [0, 0, 0, 0], bandKm: [74.2, 193.8, 119.6, 24.7], idleH: 0.717, km: 412.3, odoKm: 418, coverage: 0.986, trips: 14, usable: true, reason: "", ...o });
const BIKE = { id: "royal-enfield-hunter-350-metro-in", classKey: "ice_manual.cruiser", powertrain: "ice", name: "Royal Enfield Hunter 350" };
const memStorage = () => { const m = new Map(); return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k), _m: m }; };

test("contract: a learner interval is coarsened to SI exactly as FLEET.md §4 says", () => {
    const t = C.coarsen(iv());
    assert.deepEqual(t, { month: "2026-09", distance: 412300, fuel: 0.01145, odoDistance: 418000, coverage: 0.99, bandShare: [0.18, 0.47, 0.29, 0.06], idleTime: 2580, trips: 14 });
    assert.equal(C.validateTank({ id: "0123456789abcdef", ...t }, NOW), null);
    const noOdo = C.coarsen(iv({ odoKm: null, coverage: null }));
    assert.equal(noOdo.odoDistance, null); assert.equal(noOdo.coverage, null);
});

test("contract: every rule rejects what it should", () => {
    const ok = { id: "0123456789abcdef", ...C.coarsen(iv()) };
    const bad = (patch) => C.validateTank({ ...ok, ...patch }, NOW);
    assert.match(bad({ id: "xyz" }), /16 hex/);
    assert.match(bad({ month: "2026-13" }), /YYYY-MM/);
    assert.match(bad({ month: "2027-01" }), /out of range/);                 // the future
    assert.match(bad({ month: "2023-12" }), /out of range/);
    assert.match(bad({ distance: 1000 }), /distance/);
    assert.match(bad({ fuel: 0.07 }), /fuel/);
    assert.match(bad({ coverage: 0.4 }), /coverage/);
    assert.match(bad({ bandShare: [0.5, 0.5, 0.5, 0] }), /add up/);
    assert.match(bad({ bandShare: [1, 0, 0] }), /4 shares/);
    assert.match(bad({ trips: 1.5 }), /trips/);
    assert.match(bad({ idleTime: 3 * 86400 }), /idleTime/);
    assert.match(bad({ distance: 1e6, fuel: 0.005 }), /economy/);            // 200 km/L
    assert.match(bad({ lat: 18.8 }), /unknown field lat/);                    // nothing extra can ride along
    const env = { schema: F.SCHEMA, consent: F.CONSENT_VERSION, app: "mu", bike: { id: BIKE.id, classKey: BIKE.classKey, powertrain: "ice" }, tanks: [ok] };
    assert.equal(C.validateEnvelope(env), null);
    assert.match(C.validateEnvelope({ ...env, schema: "x" }), /schema/);
    assert.match(C.validateEnvelope({ ...env, bike: { ...env.bike, powertrain: "ev" } }), /ice/);
    assert.match(C.validateEnvelope({ ...env, bike: { ...env.bike, id: "Bad Id!" } }), /catalogue id/);
    assert.equal(C.validateEnvelope({ ...env, bike: { ...env.bike, id: null } }), null);
    assert.match(C.validateEnvelope({ ...env, tanks: new Array(21).fill(ok) }), /too many/);
});

/** Route a fake fetch into the reference server's handlers. */
function serverFetch(fleet, log = []) {
    return async (url, init = {}) => {
        const auth = init.headers && init.headers.Authorization;
        log.push({ method: init.method, url, auth, body: init.body ? JSON.parse(init.body) : null });
        let r;
        if (init.method === "POST" && url.endsWith("/api/fleet/v1/tanks")) r = fleet.upload({ auth, body: JSON.parse(init.body) });
        else if (init.method === "DELETE" && url.endsWith("/api/fleet/v1/contributor")) r = fleet.remove({ auth });
        else r = { status: 404, json: { ok: false } };
        return { status: r.status, ok: r.status < 300, json: async () => r.json };
    };
}

test("client: nothing leaves the phone before opt-in; opt-in sends the usable tanks once", async () => {
    const db = new DatabaseSync(":memory:");
    const fleet = SRV.createFleet(db, { now: () => NOW });
    const log = [];
    const storage = memStorage();
    const cl = F.createFleetClient({ storage, fetch: serverFetch(fleet, log), base: "https://x", now: () => NOW, online: () => true, appVersion: "mu-test" });
    const ivs = [iv(), iv({ fromTs: iv().toTs, toTs: new Date(2026, 8, 30).getTime(), km: 380, litres: 10.2, odoKm: null, coverage: null }), iv({ usable: false, fromTs: 1, toTs: 2 })];
    const r0 = await cl.sync(ivs, BIKE);
    assert.equal(r0.skipped, "not opted in"); assert.equal(log.length, 0);
    assert.equal(cl.shouldAsk(0), false); assert.equal(cl.shouldAsk(2), true);
    const pv = await cl.preview(ivs, BIKE);
    assert.equal(pv.authorization, "Fleet •••"); assert.equal(pv.body.tanks.length, 2);
    assert.equal(log.length, 0, "preview never sends");
    const r1 = await cl.optIn(ivs, BIKE);
    assert.deepEqual([r1.sent, r1.queued, r1.error], [2, 0, null]);
    assert.equal(log.length, 1);
    assert.match(log[0].auth, /^Fleet [A-Za-z0-9_-]{22}$/);
    assert.deepEqual(Object.keys(log[0].body).sort(), ["app", "bike", "consent", "schema", "tanks"]);
    assert.deepEqual(log[0].body.bike, { id: BIKE.id, classKey: BIKE.classKey, powertrain: "ice" });   // the name stays on the phone
    assert.ok(!JSON.stringify(log[0].body).includes("Royal Enfield"));
    // the next sync sends nothing new
    const r2 = await cl.sync(ivs, BIKE);
    assert.equal(r2.sent, 0); assert.equal(log.length, 1);
    assert.equal(cl.status().sentTotal, 2); assert.equal(cl.shouldAsk(5), false);
    // the server stores a hash of the contributor, never the secret
    const secret = log[0].auth.slice(6);
    const rows = db.prepare("SELECT hash FROM fleet_contributors").all();
    assert.equal(rows.length, 1); assert.notEqual(rows[0].hash, secret); assert.equal(rows[0].hash.length, 64);
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM fleet_tanks").get().n, 2);
    // EVs have no tanks
    assert.equal((await cl.sync(ivs, { ...BIKE, classKey: "ev.scooter", powertrain: "ev" })).skipped, "no tanks on an EV");
});

test("client: opt-out deletes on the server; offline it stays pending and finishes later; re-opt-in is a new ID", async () => {
    const db = new DatabaseSync(":memory:");
    const fleet = SRV.createFleet(db, { now: () => NOW });
    const log = [];
    let online = true;
    const storage = memStorage();
    const cl = F.createFleetClient({ storage, fetch: serverFetch(fleet, log), base: "", now: () => NOW, online: () => online });
    await cl.optIn([iv()], BIKE);
    const first = log[0].auth;
    online = false;
    const r = await cl.optOut();
    assert.deepEqual(r, { ok: false, deleted: null, pending: true });
    assert.equal(cl.status().optedIn, false); assert.equal(cl.status().pendingDelete, true);
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM fleet_tanks").get().n, 1, "still there until we're online");
    online = true;
    // the next start finishes the delete before anything else
    const again = F.createFleetClient({ storage, fetch: serverFetch(fleet, log), base: "", now: () => NOW, online: () => true });
    await again.sync([iv()], BIKE);
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM fleet_tanks").get().n, 0);
    assert.equal(again.status().pendingDelete, false);
    assert.equal(log.at(-1).method, "DELETE"); assert.equal(log.at(-1).auth, first);
    // "no" is respected for 60 days
    assert.equal(again.shouldAsk(3), false);
    const later = F.createFleetClient({ storage, fetch: serverFetch(fleet, log), base: "", now: () => NOW + 61 * 86400000, online: () => true });
    assert.equal(later.shouldAsk(3), true);
    await again.optIn([iv()], BIKE);
    assert.notEqual(log.at(-1).auth, first, "a fresh, unrelated ID");
    // the same tank under the new ID gets a different id too (salted)
    const ids = db.prepare("SELECT id FROM fleet_tanks").all().map((x) => x.id);
    assert.equal(ids.length, 1); assert.notEqual(ids[0], log[0].body.tanks[0].id);
});

test("client: backs off on server errors, drops what the server refuses", async () => {
    const storage = memStorage();
    let t = NOW, status = 503;
    const calls = [];
    const fetch = async (url, init) => { calls.push(init.method); return { status, ok: status === 200, json: async () => (status === 200 ? { ok: true, accepted: 1, duplicates: 0 } : { ok: false, error: "nope" }) }; };
    const cl = F.createFleetClient({ storage, fetch, now: () => t, online: () => true });
    const r = await cl.optIn([iv()], BIKE);
    assert.equal(r.sent, 0); assert.equal(r.queued, 1); assert.equal(r.error, "server error 503");
    await cl.sync([iv()], BIKE);
    assert.equal(calls.length, 1, "waits out the back-off");
    t += 2 * 60000 + 1; status = 200;
    const r2 = await cl.sync([iv()], BIKE);
    assert.equal(r2.sent, 1); assert.equal(r2.queued, 0);
    status = 400;
    await cl.sync([iv(), iv({ fromTs: 5, toTs: new Date(2026, 9, 1).getTime() })], BIKE);
    assert.equal(cl.status().queued, 0); assert.equal(cl.status().lastError, "nope");
});

test("server: auth, limits, duplicates, partial rejects, k-anonymity, retention", async () => {
    let now = NOW;
    const db = new DatabaseSync(":memory:");
    const fleet = SRV.createFleet(db, { now: () => now });
    const tank = (i, patch = {}) => ({ id: i.toString(16).padStart(16, "0"), ...C.coarsen(iv()), ...patch });
    const body = (tanks, bike = BIKE.id) => ({ schema: F.SCHEMA, consent: F.CONSENT_VERSION, app: "mu", bike: { id: bike, classKey: BIKE.classKey, powertrain: "ice" }, tanks });
    const auth = (n) => `Fleet ${String(n).padStart(22, "A").slice(0, 22)}`;
    assert.equal(fleet.upload({ auth: "Bearer x", body: body([tank(1)]) }).status, 401);
    assert.equal(fleet.upload({ auth: auth(1), body: body(new Array(21).fill(0).map((_, i) => tank(i + 1))) }).status, 413);
    assert.equal(fleet.upload({ auth: auth(1), body: { ...body([tank(1)]), schema: "old" } }).status, 400);
    let r = fleet.upload({ auth: auth(1), body: body([tank(1), tank(2, { distance: 10 })]) });
    assert.equal(r.status, 200); assert.equal(r.json.accepted, 1); assert.equal(r.json.rejected[0].error, "distance out of range");
    r = fleet.upload({ auth: auth(1), body: body([tank(1)]) });
    assert.deepEqual([r.json.accepted, r.json.duplicates], [0, 1]);
    assert.equal(fleet.upload({ auth: auth(1), body: body([tank(3, { fuel: 1 })]) }).status, 400);
    // daily limit per contributor
    const many = (start) => new Array(20).fill(0).map((_, i) => tank(start + i));
    let last;
    for (let k = 0; k < 11; k++) last = fleet.upload({ auth: auth(2), body: body(many(100 + k * 20)) });
    assert.equal(last.status, 429);
    // k-anonymity: < 5 contributors → nothing published
    assert.equal(fleet.summary(BIKE.id).status, 404);
    for (let c = 3; c <= 5; c++) fleet.upload({ auth: auth(c), body: body([tank(1000 + c)]) });
    const sm = fleet.summary(BIKE.id);
    assert.equal(sm.status, 200); assert.equal(sm.json.contributors, 5);
    assert.ok(sm.json.metresPerCubicMetre.median > 3e7 && sm.json.metresPerCubicMetre.median < 4e7);   // ~36 km/L
    // delete is idempotent and immediate
    assert.ok(fleet.remove({ auth: auth(5) }).json.deleted >= 1);
    assert.equal(fleet.remove({ auth: auth(5) }).json.deleted, 0);
    assert.equal(fleet.summary(BIKE.id).status, 404, "back under k");
    // nothing about the request is stored beyond the tank, consent and app versions
    const cols = db.prepare("PRAGMA table_info(fleet_tanks)").all().map((c) => c.name);
    assert.deepEqual(cols, ["id", "contributor_hash", "bike_id", "class_key", "month", "distance", "fuel", "odo_distance", "coverage", "band0", "band1", "band2", "band3", "idle_time", "trips", "consent", "app", "received_at"]);   // exactly FLEET.md §6
    now += 800 * 86400000;
    assert.ok(fleet.purgeOld() > 0);
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM fleet_tanks").get().n, 0);
});

test("ride model: SmartDrive's trip → a record; the HUD's totals make it richer; nothing absurd", () => {
    const pts = []; for (let i = 0; i < 600; i++) pts.push({ ts: NOW + i * 5000, lat: 18.81 + i * 0.0001, lng: 82.71 + Math.sin(i / 20) * 0.001, speedKmh: 40 });
    const d = { startedAt: NOW, endedAt: NOW + 3000 * 1000, totalDistKm: 7.2, avgSpeed: 36, maxSpeed: 62, fuelUsedL: 0.21, idleMin: 4, points: pts, place: "Koraput" };
    const r = M.fromTripEnd(d);
    assert.equal(r.id, `ride-${NOW}`); assert.equal(r.distance, 7200); assert.equal(r.duration, 3000); assert.equal(r.idleTime, 240);
    assert.ok(Math.abs(r.fuel - 0.00021) < 1e-12); assert.ok(Math.abs(r.maxSpeed - 62 / 3.6) < 1e-9);
    assert.ok(r.route.length <= M.MAX_ROUTE && r.route.length >= 10);
    assert.equal(r.source, "smartdrive");
    const live = { distance: 7350, time: 3000, moving: 2700, energy: 0.000198, perMetre: 2.7e-8, cost: 19.5, ecoScore: 0.82, harsh: { accel: 1, brake: 2 }, maxSpeed: 17.5, idleTime: 300 };
    const m = M.merge(r, { trip: d, live, powertrain: "ice", correction: 1.12, bike: "Hunter 350", priceUnit: "₹ 105/L" });
    assert.deepEqual([m.distance, m.moving, m.ecoScore, m.harsh, m.cost, m.bike, m.source, m.matched], [7350, 2700, 0.82, 3, 19.5, "Hunter 350", "hud", true]);
    assert.ok(Math.abs(m.avgSpeed - 7350 / 2700) < 1e-9);
    const e = M.economy(m);
    assert.equal(e.unit, "km/L"); assert.ok(Math.abs(e.value - 7.35 / 0.198) < 1e-9);
    const ev = M.merge(r, { trip: d, live: { ...live, energy: 3.6e6 }, powertrain: "ev" });
    assert.equal(ev.fuel, null); assert.equal(M.economy(ev).unit, "Wh/km"); assert.ok(Math.abs(M.economy(ev).value - 1000 / 7.35) < 1e-9);
    assert.equal(M.rideName(new Date(2026, 9, 4, 7).getTime()), "Morning ride");
    assert.equal(M.rideName(new Date(2026, 9, 4, 22).getTime()), "Night ride");
});

test("ride model: rollups bucket by local day / month and total honestly", () => {
    const at = (dDays, h = 9) => new Date(2026, 9, 4 - dDays, h).getTime();
    const rec = (dDays, km, o = {}) => ({ id: `r${dDays}-${km}`, startedAt: at(dDays), distance: km * 1000, moving: km * 100, fuel: km / 40 / 1000, evEnergy: null, cost: km * 2.5, ecoScore: 0.8, harsh: 1, ...o });
    const recs = [rec(0, 10), rec(0, 6, { cost: null, ecoScore: null }), rec(3, 20, { ecoScore: 0.6 }), rec(12, 40), rec(70, 15)];
    const w = M.rollup(recs, "7d", NOW);
    assert.equal(w.buckets.length, 7); assert.equal(w.buckets[6].rides, 2); assert.equal(w.buckets[3].distance, 20000);
    assert.equal(w.totals.rides, 3); assert.equal(w.totals.distance, 36000);
    assert.equal(w.totals.cost, 75); assert.equal(w.totals.costRides, 2);                 // the unpriced ride isn't counted as ₹0
    assert.ok(Math.abs(w.totals.eco - (0.8 * 10 + 0.6 * 20) / 30) < 1e-9);               // distance-weighted, only scored rides
    assert.ok(Math.abs(w.totals.economy - 40) < 1e-9);
    assert.equal(M.rollup(recs, "30d", NOW).totals.rides, 4);
    const y = M.rollup(recs, "12m", NOW);
    assert.equal(y.buckets.length, 12); assert.equal(y.buckets[11].key, "2026-10"); assert.equal(y.totals.rides, 5);
    assert.equal(M.rollup(recs, "all", NOW).buckets.length, 4);                           // July … October
    assert.equal(M.rollup([], "all", NOW).totals.eco, null);
    const p = M.routePath([[18.8, 82.7], [18.81, 82.72], [18.79, 82.73]], 56, 42, 5);
    assert.match(p.d, /^M[\d.]+,[\d.]+L/); assert.equal(p.start.length, 2);
    for (const [x, yy] of [p.start, p.end]) assert.ok(x >= 5 - 1e-9 && x <= 51 + 1e-9 && yy >= 5 - 1e-9 && yy <= 37 + 1e-9);
    assert.equal(M.routePath([], 10, 10).d, "");
});

test("ride store: memory fallback has the same surface, keeps newest first", async () => {
    const st = S.createRideStore({ indexedDB: null });
    assert.equal(st.kind, "memory");
    await st.put({ id: "a", startedAt: 1 }); await st.put({ id: "b", startedAt: 3 }); await st.put({ id: "c", startedAt: 2 });
    assert.deepEqual((await st.all()).map((r) => r.id), ["b", "c", "a"]);
    assert.equal((await st.get("c")).startedAt, 2); assert.equal(await st.get("zz"), null);
    await st.remove("b"); assert.equal(await st.count(), 2);
    assert.equal(await st.clear(), 2); assert.equal(await st.count(), 0);
});

test("view helpers: tiles, durations, day groups, eco words, consent example in words", () => {
    const tl = UI.tiles({ rides: 3, distance: 36000, moving: 3600 + 25 * 60, fuel: 0.0009, evEnergy: 0, cost: 75, costRides: 2, eco: 0.733, economy: 40 }, U);
    assert.deepEqual(tl.map((t) => t.key), ["rides", "distance", "time", "fuel", "cost", "eco"]);
    assert.equal(tl[2].value, "1:25"); assert.equal(tl[2].unit, "h");
    assert.equal(tl[4].note, "2 of 3 rides priced");
    assert.equal(tl[5].value, "73"); assert.equal(tl[5].note, "Steady");
    assert.equal(UI.tiles({ rides: 1, distance: 5000, moving: 600, fuel: 0, evEnergy: 7.2e6, cost: null, costRides: 0, eco: null, economy: null }, U)[3].key, "energy");
    assert.deepEqual(UI.dur(59 * 60), { value: "59", unit: "min" });
    const g = UI.byDay([{ startedAt: NOW }, { startedAt: NOW - 3600e3 }, { startedAt: NOW - 86400e3 }, { startedAt: NOW - 5 * 86400e3 }], NOW);
    assert.deepEqual(g.map((x) => [x.label, x.rides.length]).slice(0, 2), [["Today", 2], ["Yesterday", 1]]);
    assert.equal(g.length, 3);
    assert.equal(UI.ecoWord(0.9), "Smooth"); assert.equal(UI.ecoWord(0.4), "Rough"); assert.equal(UI.ecoWord(null), "");
    const w = CU.tankInWords({ id: "a", ...C.coarsen(iv()) }, U);
    assert.equal(w.line, "412 km on 11.45 L");
    assert.equal(w.bands, "18 % under 40 km/h · 47 % at 40–60 · 29 % at 60–80 · 6 % over 80");
    assert.equal(w.idle, "43 min idling · 14 rides");
    assert.match(w.month, /2026/);
});
