// Step 7: trip energy (route profile, elevation, physics estimate, cost), the card's
// pure helpers, and the offline completeness of sw.js. The DOM card itself is
// exercised in headless Chromium (see public/js/trip/README.md).
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { buildArtifacts } from "../../scripts/bikedb/catalog-build.mjs";
import { loadCatalog } from "../../scripts/bikedb/load-catalog.mjs";

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const Physics = require("../../public/js/physics/index.js");
const Search = require("../../public/js/bikedb/catalog-search.js");
const U = require("../../public/js/garage/units.js");
const Prof = require("../../public/js/trip/profile.js");
const Elev = require("../../public/js/trip/elevation.js");
const En = require("../../public/js/trip/energy.js");
const Card = require("../../public/js/trip/trip-card.js");

// ---------------------------------------------------------------------------
// Real bikes from the catalogue build
// ---------------------------------------------------------------------------
const art = buildArtifacts(loadCatalog());
const byHash = new Map(art.bundles.map((b) => [b.hash, JSON.parse(b.bytes)]));
const index = new Search.CatalogIndex(JSON.parse(art.catalog.bytes));
/** Physics model for the first search hit (with its class default). */
function bike(q, settings = {}) {
    const row = index.search(q, { limit: 1 })[0];
    assert.ok(row, `no bike for ${q}`);
    const b = byHash.get(row.bundle);
    const cls = index.classes.find((c) => c.key === b.classKey);
    const classDefault = cls ? byHash.get(cls.bundle) : undefined;
    return { row, bundle: b, classDefault, model: Physics.createBikeModel(b, { classDefault, settings }) };
}
const firstOf = (powertrain) => {
    const c = index.classes.find((x) => x.powertrain === powertrain);
    const b = byHash.get(c.bundle);
    return { bundle: b, model: Physics.createBikeModel(b) };
};

/** A straight route along a parallel: n segments of `seg` metres, with a height function. */
function route(lengthM, zOf, o = {}) {
    const lat = 28.6, mPerDegLng = (Math.PI / 180) * Prof.R_EARTH * Math.cos((lat * Math.PI) / 180);
    const pts = [];
    const N = 200;
    for (let i = 0; i <= N; i++) pts.push([lat, 77.2 + ((lengthM * i) / N) / mPerDegLng]);
    const rs = Prof.resample(pts, Prof.plan(lengthM, o));
    const z = zOf ? Array.from(rs.s, zOf) : null;
    return { pts, rs, profile: Prof.buildProfile(rs.s, z, { distance: lengthM }) };
}
const constSpeed = (profile, v) => ({ speed: new Float64Array(profile.ds.length).fill(v), source: "steps" });

// ---------------------------------------------------------------------------
// Profile
// ---------------------------------------------------------------------------
test("haversine: one degree of latitude ≈ 111.2 km", () => {
    assert.ok(Math.abs(Prof.haversine(10, 77, 11, 77) - 111195) < 5);
    assert.equal(Prof.haversine(10, 77, 10, 77), 0);
});

test("resample: even spacing, ends kept, junk points dropped", () => {
    const pts = [[28.6, 77.2], [28.6, 77.2], [NaN, 1], [28.6, 77.21], null, [28.6, 77.22]];
    const rs = Prof.resample(/** @type {any} */ (pts), 100);
    assert.ok(Math.abs(rs.length - 1953) < 5, `length ${rs.length}`);
    assert.equal(rs.s[0], 0);
    assert.equal(rs.s[rs.s.length - 1], rs.length);
    for (let i = 1; i < rs.s.length - 1; i++) assert.ok(Math.abs(rs.s[i] - rs.s[i - 1] - 100) < 1e-6);
    assert.ok(Math.abs(rs.lng[rs.lng.length - 1] - 77.22) < 1e-9);
    assert.equal(Prof.resample([[1, 2]], 100).s.length, 1);
    assert.equal(Prof.resample([], 100).s.length, 0);
});

test("plan: DEM resolution floor and a cap on the number of points", () => {
    assert.equal(Prof.plan(1000), 90);
    assert.ok(Math.abs(Prof.plan(399000) - 1000) < 1e-9);
    assert.equal(Prof.plan(0), 90);
});

test("buildProfile: a steady 5 % ramp is read as 5 %, ascent exact", () => {
    const { profile } = route(4000, (s) => 100 + 0.05 * s);
    const mid = profile.grade.slice(5, -5);
    for (const g of mid) assert.ok(Math.abs(g - 0.05) < 1e-9, `grade ${g}`);
    assert.ok(Math.abs(profile.ascent - 200) < 1, `ascent ${profile.ascent}`);
    assert.ok(profile.descent < 1e-9);
    assert.equal(profile.source, "dem");
    assert.ok(Math.abs(profile.distance - 4000) < 1e-9);
    assert.ok(Math.abs(profile.ds.reduce((a, b) => a + b, 0) - 4000) < 1e-6);
});

test("buildProfile: a flyover dip in the DEM is removed, not turned into a 40 % grade", () => {
    const { profile } = route(3000, (s) => (Math.abs(s - 1530) < 50 ? 160 : 200));
    assert.ok(Math.max(...profile.grade.map(Math.abs)) < 0.02, `max grade ${Math.max(...profile.grade.map(Math.abs))}`);
    assert.ok(profile.ascent < 3 && profile.descent < 3);
});

test("buildProfile: clamps at ±25 %, fills gaps, falls back to flat when data is mostly missing", () => {
    const cliff = route(2000, (s) => (s > 1000 ? 1000 : 0)).profile;
    assert.ok(Math.max(...cliff.grade) <= 0.25 + 1e-12);
    assert.ok(cliff.clampedShare > 0);
    const n = route(2000, null).rs.s.length;
    const holes = route(2000, (s, ) => s).rs;
    const z = Array.from(holes.s, (s, i) => (i % 3 === 1 ? null : 50 + s * 0.02));
    const filled = Prof.buildProfile(holes.s, z, { distance: 2000 });
    assert.equal(filled.source, "dem");
    assert.ok(filled.missingShare > 0.3 && filled.missingShare < 0.4);
    for (const g of filled.grade.slice(4, -4)) assert.ok(Math.abs(g - 0.02) < 1e-9);
    const mostlyMissing = Prof.buildProfile(holes.s, Array.from(holes.s, (s, i) => (i % 4 ? null : 10)), { distance: 2000 });
    assert.equal(mostlyMissing.source, "flat");
    const none = Prof.buildProfile(holes.s, null, { distance: 2000 });
    assert.equal(none.source, "flat");
    assert.ok(none.grade.every((g) => g === 0));
    assert.ok(n > 2);
});

test("segmentSpeeds: router steps become per-segment speeds; live traffic slows them all", () => {
    const edges = Float64Array.from([0, 1000, 2000, 3000, 4000]);
    const steps = [{ distance: 2000, duration: 200 }, { distance: 2000, duration: 100 }, { distance: 0, duration: 0 }];
    const a = Prof.segmentSpeeds(edges, steps, {});
    assert.equal(a.source, "steps");
    assert.deepEqual(Array.from(a.speed), [10, 10, 20, 20]);
    const t = Prof.segmentSpeeds(edges, steps, { duration: 600 });   // traffic doubles the trip time
    assert.deepEqual(Array.from(t.speed), [5, 5, 10, 10]);
    const scaled = Prof.segmentSpeeds(edges, [{ distance: 1000, duration: 100 }, { distance: 1000, duration: 50 }], {});   // steps sum to 2 km: scaled to 4 km
    assert.deepEqual(Array.from(scaled.speed), [10, 10, 20, 20]);
    const avg = Prof.segmentSpeeds(edges, null, { distance: 4000, duration: 400 });
    assert.equal(avg.source, "average");
    assert.ok(avg.speed.every((v) => v === 10));
    const none = Prof.segmentSpeeds(edges, [], {});
    assert.equal(none.source, "assumed");
    assert.ok(Math.abs(none.speed[0] - 40 / 3.6) < 1e-12);
    const slow = Prof.segmentSpeeds(edges, [{ distance: 4000, duration: 40000 }], {});
    assert.ok(slow.speed.every((v) => v === 2), "clamped to the 2 m/s floor");
});

// ---------------------------------------------------------------------------
// Energy
// ---------------------------------------------------------------------------
test("energy: steady flat ride above 55 km/h equals the cruise table exactly (no stops, no idling)", () => {
    const { model } = bike("Hunter 350");
    const { profile } = route(10000, null);
    const est = En.createTripEstimator(Physics, model, { altitude: 0 });
    const r = est.estimate(profile, constSpeed(profile, 20), {});
    const t = Physics.cruiseTable(model, { altitude: 0, grade: 0 }, { step: 1, vMin: 0 });
    assert.ok(Math.abs(r.total.mean - t.perMetre[20] * 10000) < 1e-12 * 10000, `${r.total.mean} vs ${t.perMetre[20] * 10000}`);
    assert.equal(r.stopCount, 0);
    assert.equal(r.idle, 0);
    assert.equal(r.hills, 0);
    assert.equal(r.unit, "m3");
    assert.ok(r.total.lo < r.total.mean && r.total.mean < r.total.hi);
    assert.ok(Math.abs(r.total.hi - r.total.mean - (t.perMetreHi[20] - t.perMetre[20]) * 10000) < 1e-9, "σ summed linearly along the route");
});

test("energy: climbs cost more, monotone in grade; fuel never negative on a long descent", () => {
    const { model } = bike("Pulsar NS200");
    const est = En.createTripEstimator(Physics, model, {});
    const at = (g) => {
        const { profile } = route(5000, (s) => g * s);
        return est.estimate(profile, constSpeed(profile, 12), { traffic: "light" });
    };
    const up = [0, 0.02, 0.04, 0.06].map((g) => at(g).total.mean);
    for (let i = 1; i < up.length; i++) assert.ok(up[i] > up[i - 1], `grade step ${i}: ${up}`);
    const down = at(-0.06);
    assert.ok(down.total.mean >= 0 && down.total.lo >= 0);
    assert.ok(down.cruise.mean < up[0] * 0.5, "a 6 % descent costs far less than the flat");
    assert.ok(down.hills < 0);
});

test("energy: petrol round trip over a hill costs more than the flat (descents can't pay back climbs)", () => {
    const { model } = bike("Activa");
    const est = En.createTripEstimator(Physics, model, {});
    const hill = route(12000, (s) => 300 * Math.sin((Math.PI * s) / 12000));
    const flat = route(12000, null);
    const a = est.estimate(hill.profile, constSpeed(hill.profile, 11), {});
    const b = est.estimate(flat.profile, constSpeed(flat.profile, 11), {});
    assert.ok(a.hills > 0, `hills ${a.hills}`);
    assert.ok(a.total.mean > b.total.mean);
    assert.ok(Math.abs(hill.profile.ascent - 300) < 15 && Math.abs(hill.profile.descent - 300) < 15);
});

test("energy: EVs recover energy downhill (negative = charging) and a net recharge costs nothing", () => {
    const { model } = firstOf("ev");
    const est = En.createTripEstimator(Physics, model, {});
    const { profile } = route(4000, (s) => -0.07 * s);
    const r = est.estimate(profile, constSpeed(profile, 8), { traffic: "light" });
    assert.equal(r.unit, "J");
    assert.ok(r.cruise.mean < 0, `cruise ${r.cruise.mean}`);
    assert.ok(r.regen > 0);
    assert.ok(r.batteryShare && Number.isFinite(r.batteryShare.mean));
    const cost = En.tripCost({ ...r, total: { mean: -1e6, lo: -2e6, hi: -5e5 } }, { energyPerJ: 8 / 3.6e6 });
    assert.deepEqual(cost, { mean: 0, lo: 0, hi: 0 });
    const flat = route(4000, null).profile;
    const f = est.estimate(flat, constSpeed(flat, 8), {});
    assert.ok(f.total.mean > 0 && Number.isFinite(f.total.mean));
    assert.ok(f.stops > 0 && f.idle > 0, "standing still still draws the accessories");
});

test("energy: traffic and load move the estimate the right way; no stops on open roads", () => {
    const { bundle, classDefault, model } = bike("Hunter 350");
    const { profile } = route(8000, null);
    const city = constSpeed(profile, 6);
    const est = En.createTripEstimator(Physics, model, {});
    const [l, n, hv] = ["light", "normal", "heavy"].map((t) => est.estimate(profile, city, { traffic: t }).total.mean);
    assert.ok(l < n && n < hv, `${l} ${n} ${hv}`);
    assert.equal(est.estimate(profile, constSpeed(profile, 16), { traffic: "heavy" }).stopCount, 0);
    const two = Physics.createBikeModel(bundle, { classDefault, settings: { pillionMass: 70 } });
    const r2 = En.createTripEstimator(Physics, two, {}).estimate(profile, city, {});
    assert.ok(r2.total.mean > n);
    // standing still never exceeds 30 % of the router's own trip time
    const capped = est.estimate(profile, city, { traffic: "heavy", routeDuration: 8000 / 6 });
    assert.ok(capped.idleTime <= 0.3 * (8000 / 6) + 1e-9, `idle ${capped.idleTime}`);
    assert.ok(capped.total.mean < hv);
    const s = En.stopsPerMetre(6) * 1000;
    assert.ok(s > 0 && s <= 1.5);
    assert.equal(En.stopsPerMetre(15.3), 0);
});

test("energy: a climb too steep for traffic speed is slowed and flagged, never NaN", () => {
    const { model } = bike("Activa");
    const est = En.createTripEstimator(Physics, model, {});
    const { profile } = route(1500, (s) => 0.22 * s);
    const r = est.estimate(profile, constSpeed(profile, 16), {});
    assert.ok(r.flags.includes("slowed") || r.flags.includes("too-steep"), r.flags.join());
    assert.ok(r.slowedDistance + r.steepDistance > 1000);
    assert.ok(Number.isFinite(r.total.mean) && Number.isFinite(r.total.hi) && r.total.mean > 0);
    assert.ok(r.duration > 1500 / 16, "slower climbing takes longer");
});

test("energy: flags for missing hills, assumed speed and the bike's top speed", () => {
    const { model } = bike("Activa");
    const est = En.createTripEstimator(Physics, model, {});
    const flat = route(3000, null).profile;
    const r = est.estimate(flat, { speed: new Float64Array(flat.ds.length).fill(39), source: "assumed" }, {});
    assert.ok(r.flags.includes("hills-unknown"));
    assert.ok(r.flags.includes("speed-assumed"));
    assert.ok(r.flags.includes("top-speed") || r.flags.includes("slowed"), r.flags.join());
    assert.throws(() => est.estimate(flat, { speed: new Float64Array(2), source: "steps" }, {}), /one entry per profile segment/);
    assert.throws(() => En.createTripEstimator({}, model), /physics core/);
});

test("energy: a 400-point route estimates quickly once warm", () => {
    const { model } = bike("Hunter 350");
    const r = route(120000, (s) => 200 + 150 * Math.sin(s / 3000) + 40 * Math.sin(s / 700));
    const steps = Array.from({ length: 30 }, (_, i) => ({ distance: 4000, duration: 4000 / (6 + (i % 5) * 4) }));
    const sp = Prof.segmentSpeeds(r.profile.edges, steps, {});
    let vMax = 0; for (const v of sp.speed) vMax = Math.max(vMax, v);
    const est = En.createTripEstimator(Physics, model, { altitude: r.profile.zMean, vMax });
    est.estimate(r.profile, sp, {});                     // builds the tables
    const t0 = performance.now();
    for (let i = 0; i < 10; i++) est.estimate(r.profile, sp, { traffic: i % 2 ? "heavy" : "light" });
    const ms = (performance.now() - t0) / 10;
    assert.ok(ms < 5, `warm estimate took ${ms.toFixed(2)} ms`);
    assert.ok(r.profile.s.length <= 400);
});

test("tripCost: rider prices in SI denominators; EV pays charging loss", () => {
    const r = /** @type {any} */ ({ unit: "m3", total: { mean: 0.001, lo: 0.0008, hi: 0.0012 } });
    const c = En.tripCost(r, Card.siPrices({ fuelPerLitre: 104.5, energyPerKWh: null }));
    assert.ok(Math.abs(c.mean - 104.5) < 1e-9 && Math.abs(c.lo - 83.6) < 1e-9);
    const e = En.tripCost(/** @type {any} */ ({ unit: "J", total: { mean: 3.6e6, lo: 3.6e6, hi: 3.6e6 } }), Card.siPrices({ fuelPerLitre: null, energyPerKWh: 8 }));
    assert.ok(Math.abs(e.mean - 8 / 0.88) < 1e-9);
    assert.equal(En.tripCost(r, { fuelPerM3: null }), null);
    assert.equal(En.tripCost(r, { fuelPerM3: -1 }), null);
});

// ---------------------------------------------------------------------------
// Card helpers (pure)
// ---------------------------------------------------------------------------
test("card: describe() prints litres, km/L, ₹ and labels an example price", () => {
    const r = /** @type {any} */ ({
        unit: "m3", distance: 20000, total: { mean: 0.00044, lo: 0.00036, hi: 0.00053 }, cruise: { mean: 0.0004 }, hills: 0.00003,
        stops: 0.00001, idle: 0.00001, regen: 0, stopCount: 12.4, idleTime: 310, profileSource: "dem", ascent: 399, descent: 380, batteryShare: null
    });
    const prefs = { fuelPerLitre: null, energyPerKWh: null };
    const d = Card.describe(r, En.tripCost(r, Card.siPrices(prefs)), U, prefs);
    assert.equal(d.amount, "0.44");
    assert.equal(d.unit, "L");
    assert.equal(d.rate, "45.5");
    assert.equal(d.rateUnit, "km/L");
    assert.equal(d.cost, "₹44.0");
    assert.match(d.priceNote, /₹100\/L \(example\)/);
    assert.equal(d.priceSet, false);
    assert.equal(d.range, "0.36–0.53 L likely");
    assert.match(d.climb, /↑ 399 m/);
    assert.equal(d.breakdown.length, 4);
    const mine = Card.describe(r, En.tripCost(r, Card.siPrices({ fuelPerLitre: 104.77, energyPerKWh: null })), U, { fuelPerLitre: 104.77, energyPerKWh: null });
    assert.equal(mine.priceSet, true);
    assert.doesNotMatch(mine.priceNote, /example/);
});

test("card: describe() for an EV: kWh, Wh/km, battery share, recharge shown with +", () => {
    const base = { unit: "J", distance: 10000, cruise: { mean: 0 }, hills: 0, stops: 0, idle: 0, regen: 3600 * 50, stopCount: 0, idleTime: 0, profileSource: "flat", ascent: 0, descent: 0 };
    const r = /** @type {any} */ ({ ...base, total: { mean: 1.08e6, lo: 0.9e6, hi: 1.2e6 }, batteryShare: { mean: 0.1, lo: 0.08, hi: 0.12 } });
    const d = Card.describe(r, En.tripCost(r, Card.siPrices({ fuelPerLitre: null, energyPerKWh: 8 })), U, { fuelPerLitre: null, energyPerKWh: 8 });
    assert.equal(d.amount, "0.30");
    assert.equal(d.rate, "30");
    assert.equal(d.rateUnit, "Wh/km");
    assert.match(d.battery, /^10 % of a full charge$/);
    assert.equal(d.needsCharge, false);
    assert.ok(d.breakdown.some(([k]) => /regeneration/.test(k)));
    const back = Card.describe(/** @type {any} */ ({ ...base, total: { mean: -3.6e5, lo: -4e5, hi: -3e5 }, batteryShare: { mean: -0.03, lo: -0.04, hi: -0.02 } }), { mean: 0, lo: 0, hi: 0 }, U, { fuelPerLitre: null, energyPerKWh: null });
    assert.equal(back.amount, "+0.10");
    assert.match(back.amountLabel, /back into the battery/);
    const long = Card.describe(/** @type {any} */ ({ ...base, total: { mean: 3e6, lo: 2.8e6, hi: 3.3e6 }, batteryShare: { mean: 0.85, lo: 0.8, hi: 0.95 } }), null, U, { fuelPerLitre: null, energyPerKWh: null });
    assert.equal(long.needsCharge, true);
});

test("card: chart paths — flat stays flat, warnings only where the bike was slowed", () => {
    const s = Float64Array.from([0, 100, 200, 300]);
    const flat = Card.chartPaths(s, Float64Array.from([5, 5, 5, 5]), null);
    const ys = [...flat.line.matchAll(/[ML][\d.]+ ([\d.]+)/g)].map((m) => m[1]);
    assert.equal(new Set(ys).size, 1);
    assert.ok(flat.zHi - flat.zLo >= 30);
    const hill = Card.chartPaths(s, Float64Array.from([0, 50, 100, 50]), Uint8Array.from([0, 1, 0]));
    assert.equal((hill.warn.match(/M/g) || []).length, 1);
    assert.match(hill.area, /Z$/);
    assert.equal(Card.chartPaths(Float64Array.from([0]), Float64Array.from([0]), null).line, "");
});

test("card: prefs are sanitised; flag lines explain every assumption", () => {
    const st = { v: JSON.stringify({ traffic: "gridlock", pillion: "yes", fuelPerLitre: -3, energyPerKWh: 9, expanded: false }), getItem() { return this.v; }, setItem(k, v) { this.v = v; } };
    const p = Card.loadPrefs(/** @type {any} */ (st));
    assert.deepEqual(p, { traffic: "normal", pillion: null, fuelPerLitre: null, energyPerKWh: 9, expanded: false });
    assert.equal(Card.loadPrefs(/** @type {any} */ ({ getItem() { return "{not json"; } })).traffic, "normal");
    const lines = Card.flagLines(/** @type {any} */ ({ unit: "J", flags: ["hills-unknown", "slowed"], slowedDistance: 1200, steepDistance: 0, cappedDistance: 0 }), U, { estimated: true, classTitle: "Electric scooter" });
    assert.ok(lines[0].text.includes("typical electric scooter"));
    assert.ok(lines.some((l) => /Hills not included/.test(l.text)));
    assert.ok(lines.some((l) => /1\.2 km/.test(l.text)));
    assert.ok(lines.some((l) => /charging loss/.test(l.text)));
});

// ---------------------------------------------------------------------------
// Elevation
// ---------------------------------------------------------------------------
function fakeCaches() {
    const stores = new Map();
    return {
        stores,
        async open(name) {
            if (!stores.has(name)) stores.set(name, new Map());
            const m = stores.get(name);
            return { async match(k) { return m.has(k) ? new Response(m.get(k)) : undefined; }, async put(k, res) { m.set(k, await res.text()); } };
        }
    };
}
function fakeMeteo() {
    const calls = [];
    let mode = "ok";
    const fetch = async (url) => {
        calls.push(url);
        if (mode === "offline") throw new TypeError("Failed to fetch");
        if (mode === "500") return new Response("{}", { status: 500 });
        const u = new URL(url);
        const lats = u.searchParams.get("latitude").split(",").map(Number);
        return new Response(JSON.stringify({ elevation: lats.map((x) => Math.round((x - 28) * 1000)) }), { status: 200 });
    };
    return { fetch, calls, set: (m) => { mode = m; } };
}

test("elevation: batches of 100, rounded keys, remembered, persisted, honest about failures", async () => {
    const net = fakeMeteo(), cs = fakeCaches();
    const el = Elev.createElevation({ fetch: net.fetch, caches: /** @type {any} */ (cs) });
    const lat = Array.from({ length: 250 }, (_, i) => 28 + i * 0.001), lng = lat.map(() => 77.123456);
    const a = await el.lookup(lat, lng);
    assert.equal(net.calls.length, 3);
    assert.ok(net.calls.every((u) => u.startsWith(Elev.ENDPOINT) && new URL(u).searchParams.get("latitude").split(",").length <= 100));
    assert.equal(a.source, "dem");
    assert.equal(a.z[10], 10);
    assert.ok(net.calls[0].includes("77.1235"), "coordinates rounded to ~11 m");
    const b = await el.lookup(lat.slice(0, 50), lng.slice(0, 50));
    assert.equal(net.calls.length, 3, "second lookup served from memory");
    assert.equal(b.cached, 50);
    // persisted to Cache Storage, readable by a fresh instance with no network
    await new Promise((r) => setTimeout(r, 1700));
    const offline = Elev.createElevation({ fetch: async () => { throw new TypeError("offline"); }, caches: /** @type {any} */ (cs) });
    const c = await offline.lookup(lat, lng);
    assert.equal(c.source, "dem");
    // a new place while offline: NaN + "none"; server error: same
    const d = await offline.lookup([12.97], [77.59]);
    assert.equal(d.source, "none");
    assert.ok(Number.isNaN(d.z[0]));
    net.set("500");
    const e = await Elev.createElevation({ fetch: net.fetch, caches: null }).lookup([12.97, 12.98], [77.59, 77.59]);
    assert.equal(e.source, "none");
    assert.equal(Elev.keyOf(12.345678, 77.000049), "12.3457,77.0000");
});

// ---------------------------------------------------------------------------
// Offline completeness: everything the pages load is precached by sw.js
// ---------------------------------------------------------------------------
test("sw.js precaches every script and stylesheet garage.html, index.html and the lazy garage need", () => {
    const sw = fs.readFileSync(path.join(ROOT, "public/sw.js"), "utf8");
    const ctx = vm.createContext({ self: { addEventListener() { }, location: { origin: "https://x" } }, caches: {}, fetch() { }, URL, Request: class { }, Response: class { }, console });
    vm.runInContext(sw, ctx);
    const pre = new Set(vm.runInContext("[...REQUIRED_PRECACHE, ...OPTIONAL_PRECACHE]", ctx));
    const pages = vm.runInContext("OFFLINE_PAGES", ctx);
    assert.equal(pages["/garage.html"], "/garage.html");
    assert.ok(vm.runInContext("NEVER_INTERCEPT_PATHS", ctx).includes("/bikedb/"));
    assert.match(vm.runInContext("VERSION", ctx), /^mu-2026-\d\d-\d\d\.\d+$/);   // bumped on every release
    const local = (src) => "/" + src.replace(/^\.?\//, "").split("?")[0];
    const refs = (html) => [...html.matchAll(/<(?:script[^>]*\ssrc|link[^>]*rel="stylesheet"[^>]*\shref)="([^"]+)"/g)].map((m) => m[1]).filter((u) => !/^(https?:)?\/\//.test(u) && !u.startsWith("/socket.io/"));
    const garage = fs.readFileSync(path.join(ROOT, "public/garage.html"), "utf8");
    const indexHtml = fs.readFileSync(path.join(ROOT, "public/index.html"), "utf8");
    const app = fs.readFileSync(path.join(ROOT, "public/js/trip/trip-app.js"), "utf8");
    const lazy = [...app.matchAll(/"(js\/garage\/[a-z-]+\.(?:js|css))"/g)].map((m) => m[1]);
    assert.ok(lazy.length >= 5);
    for (const u of [...refs(garage), ...refs(indexHtml), ...lazy]) {
        assert.ok(pre.has(local(u)), `${u} isn't precached`);
        if (local(u) !== "/config.js") assert.ok(fs.existsSync(path.join(ROOT, "public", local(u))), `${u} doesn't exist`);   // config.js: generated by the server
    }
    // one shared fonts stylesheet, the one sw.js precaches
    const fontCss = vm.runInContext("FONT_CSS", ctx);
    assert.ok(garage.includes(fontCss.replace(/&/g, "&")) && indexHtml.includes(fontCss), "both pages use FONT_CSS");
    // no inline scripts on garage.html (CSP script-src has no 'unsafe-inline')
    assert.doesNotMatch(garage, /<script>(?!\s*<\/script>)/);
});

test("index.html: Step 7 edits are additive — Maps script untouched, new ids present", () => {
    const html = fs.readFileSync(path.join(ROOT, "public/index.html"), "utf8");
    assert.equal((html.match(/<script src="https:\/\/maps\.googleapis\.com\/maps\/api\/js\?key=[^"]+&libraries=places&loading=async"><\/script>/g) || []).length, 1);
    for (const id of ["garage-btn", "my-bike-section", "open-garage-btn", "garage-modal", "garage-mount", "nav-bottom-sheet", "fuel-curve-section", "fuel-input-val", "btn-start-nav"]) {
        assert.equal((html.match(new RegExp(`id="${id}"`, "g")) || []).length, 1, id);
    }
    const order = ["js/boot.js", "js/physics/index.js", "js/garage/store.js", "js/trip/energy.js", "js/trip/trip-app.js"].map((s) => html.indexOf(`<script src="${s}`));
    assert.ok(order.every((i) => i > 0), String(order));
    assert.deepEqual([...order].sort((a, b) => a - b), order);
});
