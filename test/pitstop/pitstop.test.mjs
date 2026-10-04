// Step 8: the convoy pitstop planner (ranges, communal stops, costs), the station provider,
// and the panel's pure helpers. The DOM overlay is exercised in headless Chromium.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
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
const En = require("../../public/js/trip/energy.js");
const Plan = require("../../public/js/pitstop/plan.js");
const St = require("../../public/js/pitstop/stations.js");
const Panel = require("../../public/js/pitstop/convoy-panel.js");

const KM = 1000;
/** A route of `km` kilometres sampled every km, and a constant cost per metre. */
const line = (km) => Float64Array.from({ length: km + 1 }, (_, i) => i * KM);
const flatC = (S, pm) => Float64Array.from(S, (s) => s * pm);
const station = (id, km, kinds = ["fuel"]) => ({ id, s: km * KM, kinds, name: id });
// petrol: 1e-8 m³/m = 100 km/L... use 2.5e-8 (40 km/L); a 10 L tank → 400 km range
const PM = 2.5e-8;

test("cumulative, at and reach: exact on a constant-cost road", () => {
    const S = line(100);
    const C = Plan.cumulative(new Float64Array(100).fill(PM), new Float64Array(100).fill(KM));
    assert.ok(Math.abs(C[100] - 100 * KM * PM) < 1e-15);
    assert.ok(Math.abs(Plan.at(S, C, 12_500) - 12_500 * PM) < 1e-15);
    const r = Plan.reach(S, C, 10 * KM, 30 * KM * PM);
    assert.ok(Math.abs(r.s - 40 * KM) < 1e-6 && !r.ok);
    assert.equal(Plan.reach(S, C, 0, 1).ok, true);
    assert.equal(Plan.reach(S, C, 0, -1).ok, false);
});

test("reach: an EV that regenerates downhill runs out at the FIRST crossing", () => {
    const S = line(30);
    // up for 10 km (cost), down for 10 km (regen), up again
    const pm = Array.from({ length: 30 }, (_, i) => (i < 10 ? 100 : i < 20 ? -60 : 100));
    const C = Plan.cumulative(pm, new Float64Array(30).fill(KM));
    const budget = 9.5 * KM * 100;
    assert.ok(Math.abs(Plan.reach(S, C, 0, budget).s - 9.5 * KM) < 1e-6);
});

test("plan: everyone has enough → no stops, ranked by how much they'll have left", () => {
    const S = line(100);
    const members = [
        { id: "a", kind: "fuel", startS: 0, energy: 0.009, capacity: 0.01, C: flatC(S, PM) },
        { id: "b", kind: "fuel", startS: 0, energy: 0.005, capacity: 0.01, C: flatC(S, PM) }
    ];
    const p = Plan.planConvoy({ s: S, members });
    assert.equal(p.stops.length, 0);
    assert.equal(p.complete, true);
    const a = p.members.find((m) => m.id === "a"), b = p.members.find((m) => m.id === "b");
    assert.equal(a.status, "ok");
    assert.ok(Math.abs(b.arriveShare - (0.005 - 100 * KM * PM) / 0.01) < 1e-12);
    assert.equal(b.status, "tight");                   // arrives with 25 %: under reserve 12 % + 15 % margin
    assert.equal(a.rank, 2);
});

test("plan: one rider short → the LAST station before their deadline, then a full tank", () => {
    const S = line(200);
    const members = [
        { id: "riya", kind: "fuel", startS: 0, energy: 0.004, capacity: 0.0053, C: flatC(S, PM) },     // 0.004 - 0.000636 reserve → 134.6 km
        { id: "kabir", kind: "fuel", startS: 0, energy: 0.012, capacity: 0.013, C: flatC(S, PM) }
    ];
    const stations = [station("s20", 20), station("s60", 60), station("s120", 120), station("s150", 150)];
    const p = Plan.planConvoy({ s: S, members, stations });
    assert.equal(p.stops.length, 1);
    assert.equal(p.stops[0].station.id, "s120");
    assert.deepEqual(p.stops[0].riders.map((r) => r.id), ["riya"]);
    assert.deepEqual(p.stops[0].waiting, ["kabir"]);
    assert.ok(Math.abs(p.stops[0].riders[0].energyAdded - (0.0053 - (0.004 - 120 * KM * PM))) < 1e-12);
    const riya = p.members.find((m) => m.id === "riya");
    assert.ok(Math.abs(riya.needBy - (0.004 - 0.0053 * 0.12) / PM) < 1e-3);
    assert.equal(riya.rank, 1);
    assert.equal(riya.stops, 1);
    assert.ok(p.complete);
});

test("plan: a mixed group prefers one station that serves petrol AND charging", () => {
    const S = line(150);
    const EVPM = 30;                                                   // J/m (30 Wh/km ÷ 3.6 … roughly)
    const members = [
        { id: "petrol", kind: "fuel", startS: 0, energy: 0.0025, capacity: 0.0053, C: flatC(S, PM) },  // reach (0.0025-0.000636)/PM = 74.6 km
        { id: "ev", kind: "ev", startS: 0, energy: 2.0e6, capacity: 7.2e6, C: flatC(S, EVPM) }          // reach (2.0e6-0.72e6)/30 = 42.7 km
    ];
    const stations = [station("both30", 30, ["fuel", "ev"]), station("ev40", 40, ["ev"]), station("fuel70", 70, ["fuel"])];
    const p = Plan.planConvoy({ s: S, members, stations });
    assert.equal(p.stops[0].station.id, "both30", "serves both before the EV's deadline");
    assert.deepEqual(p.stops[0].riders.map((r) => r.id).sort(), ["ev", "petrol"]);
    const ev = p.stops[0].riders.find((r) => r.id === "ev");
    assert.ok(Math.abs(ev.energyAdded - (0.8 * 7.2e6 - (2.0e6 - 30 * KM * EVPM))) < 1e-6, "charged to 80 %");
    assert.ok(Math.abs(ev.waitS - ev.energyAdded / 3000) < 1e-9);
    assert.ok(p.stops.length >= 1 && p.stops.every((st, i) => i === 0 || st.s - p.stops[i - 1].s >= 3000));
    assert.ok(p.complete);
});

test("plan: a charger with a pump just down the road is ONE group stop", () => {
    const S = line(150);
    const members = [
        { id: "petrol", kind: "fuel", startS: 0, energy: 0.0025, capacity: 0.0053, C: flatC(S, PM) },  // deadline 74.6 km
        { id: "ev", kind: "ev", startS: 0, energy: 2.0e6, capacity: 7.2e6, C: flatC(S, 30) }            // deadline 42.7 km
    ];
    const p = Plan.planConvoy({ s: S, members, stations: [station("ev40", 40, ["ev"]), station("pump41", 41.5, ["fuel"]), station("pump70", 70)] });
    assert.equal(p.stops[0].station.id, "ev40");
    assert.equal(p.stops[0].partner.id, "pump41");
    assert.deepEqual(p.stops[0].riders.map((r) => r.id).sort(), ["ev", "petrol"]);
    assert.deepEqual(p.stops[0].kinds.sort(), ["ev", "fuel"]);
});

test("plan: no station data → a stretch of road to refuel along, flagged", () => {
    const S = line(200);
    const members = [{ id: "a", kind: "fuel", startS: 0, energy: 0.003, capacity: 0.0053, C: flatC(S, PM) }];
    const p = Plan.planConvoy({ s: S, members, stations: [] });
    assert.equal(p.stops.length, 1);
    const st = p.stops[0];
    assert.equal(st.noStation, true);
    const D = (0.003 - 0.0053 * 0.12) / PM;
    assert.ok(Math.abs(st.s - D) < 1e-3);
    assert.ok(Math.abs(st.window[0] - (D - 15000)) < 1e-3 && Math.abs(st.window[1] - D) < 1e-3);
    assert.ok(p.complete);
});

test("plan: a rider already on reserve gets the nearest station ahead, and tops the ranking", () => {
    const S = line(120);
    const members = [
        { id: "ok", kind: "fuel", startS: 0, energy: 0.012, capacity: 0.013, C: flatC(S, PM) },
        { id: "dry", kind: "fuel", startS: 0, energy: 0.0005, capacity: 0.0053, C: flatC(S, PM) }
    ];
    const p = Plan.planConvoy({ s: S, members, stations: [station("near", 8), station("far", 60)] });
    const dry = p.members.find((m) => m.id === "dry");
    assert.equal(dry.status, "reserve");
    assert.equal(dry.rank, 1);
    assert.equal(p.stops[0].station.id, "near");
    assert.equal(p.stops[0].urgent, true);
});

test("plan: riders joining part-way start from where they join, and pay to get there", () => {
    const S = line(100);
    const members = [{ id: "j", kind: "fuel", startS: 40 * KM, joinCost: 0.0002, energy: 0.003, capacity: 0.0053, C: flatC(S, PM) }];
    const p = Plan.planConvoy({ s: S, members });
    const m = p.members[0];
    assert.ok(Math.abs(m.energyToEnd - (60 * KM * PM + 0.0002)) < 1e-12);
    assert.equal(m.reachesEnd, true);
});

test("plan: ranking order and the status words", () => {
    const S = line(300);
    const mk = (id, energy, cap = 0.013) => ({ id, kind: "fuel", startS: 0, energy, capacity: cap, C: flatC(S, PM) });
    const p = Plan.planConvoy({ s: S, members: [mk("ok", 0.013), mk("stop", 0.006), mk("soon", 0.0025), mk("reserve", 0.001), mk("tight", 0.0095)] });
    const order = [...p.members].sort((a, b) => a.rank - b.rank).map((m) => m.status);
    assert.deepEqual(order, ["reserve", "soon", "stop", "tight", "ok"]);
    const words = Object.fromEntries(p.members.map((m) => [m.status, Panel.statusFor(m, { kind: "fuel" }, U)]));
    assert.equal(words.reserve.label, "On reserve now");
    assert.match(words.soon.label, /Needs fuel soon/);
    assert.match(words.stop.detail, /^by km \d+/);
    assert.match(words.ok.label, /Fine/);
    assert.equal(Panel.statusFor({ ...p.members[0], status: "soon", needIn: 12000, needBy: 12000 }, { kind: "ev" }, U).label, "Needs charge soon");
});

test("costs: each rider's own, the total, and the even split", () => {
    const c = Plan.costs([{ id: "a", kind: "fuel", energyToEnd: 0.002 }, { id: "b", kind: "ev", energyToEnd: 3.6e6 }], { fuelPerM3: 100000, energyPerJ: 8 / 3.6e6 });
    assert.ok(Math.abs(c.rows[0].cost - 200) < 1e-9);
    assert.ok(Math.abs(c.rows[1].cost - 8 / 0.88) < 1e-9);
    assert.ok(Math.abs(c.total - (200 + 8 / 0.88)) < 1e-9);
    assert.ok(Math.abs(c.even - c.total / 2) < 1e-9);
});

test("real bikes on a 260 km highway: the Activa needs fuel, the Hunter doesn't, the Ather needs charging", () => {
    const art = buildArtifacts(loadCatalog());
    const byHash = new Map(art.bundles.map((b) => [b.hash, JSON.parse(b.bytes)]));
    const idx = new Search.CatalogIndex(JSON.parse(art.catalog.bytes));
    const lat = 26.9, k = (Math.PI / 180) * Prof.R_EARTH * Math.cos((lat * Math.PI) / 180);
    const path = Array.from({ length: 261 }, (_, i) => [lat, 76 + (i * 1000) / k]);
    const rs = Prof.resample(path, Prof.plan(260000));
    const profile = Prof.buildProfile(rs.s, null, { distance: 260000 });
    const speeds = Prof.segmentSpeeds(profile.edges, [{ distance: 260000, duration: 260000 / 16 }], {});
    const rider = (q, share) => {
        const row = idx.search(q, { limit: 1 })[0];
        const b = byHash.get(row.bundle), cls = idx.classes.find((c) => c.key === b.classKey);
        const m = Physics.createBikeModel(b, { classDefault: cls ? byHash.get(cls.bundle) : undefined });
        const r = En.createTripEstimator(Physics, m, { vMax: 16 }).estimate(profile, speeds, {});
        const ev = m.powertrain === "ev";
        const cap = ev ? (m.battery.usable ?? m.battery.gross * 0.92) : b.chassis.fuelTank.v;
        return { id: q, kind: ev ? "ev" : "fuel", startS: 0, energy: share * cap, capacity: cap, C: Plan.cumulative(r.perMetre, profile.ds, r.total.mean / r.cruise.mean) };
    };
    const members = [rider("Activa", 0.6), rider("Hunter 350", 0.9), rider("Ather 450", 0.9)];
    const stations = Array.from({ length: 12 }, (_, i) => station(`f${i}`, 20 + i * 20, i % 2 === 0 ? ["fuel", "ev"] : ["fuel"]));   // chargers every 40 km
    const p = Plan.planConvoy({ s: profile.s, members, stations });
    if (process.env.DEBUG_PLAN) console.log(JSON.stringify({ m: p.members, stops: p.stops.map((x) => ({ s: x.s, st: x.station && x.station.id, r: x.riders, w: x.waiting, u: x.urgent })) }, null, 1));
    const by = Object.fromEntries(p.members.map((m) => [m.id, m]));
    assert.equal(by["Hunter 350"].reachesEnd, true);
    assert.equal(by["Activa"].reachesEnd, false);
    assert.equal(by["Ather 450"].reachesEnd, false);
    assert.ok(p.complete, "a full plan exists");
    for (const st of p.stops) assert.ok(st.riders.length > 0 && st.station);
    const evStops = p.stops.filter((st) => st.riders.some((r) => r.kind === "ev"));
    assert.ok(evStops.every((st) => st.station.kinds.includes("ev")));
});

// ---------------------------------------------------------------------------
// Stations
// ---------------------------------------------------------------------------
test("stations: query covers pumps and chargers along the thinned line", () => {
    const lat = Array.from({ length: 500 }, (_, i) => 26 + i * 0.001), lng = lat.map(() => 75);
    const pts = St.thin(lat, lng, 90);
    assert.ok(pts.length <= 91 && pts[0][0] === 26 && pts[pts.length - 1][0] === lat[499]);
    const q = St.query(pts);
    assert.match(q, /\[out:json\]/);
    assert.match(q, /node\["amenity"="fuel"\]\(around:1500,26\.00000,75\.00000,/);
    assert.match(q, /node\["amenity"="charging_station"\]/);
    assert.match(q, /out center tags/);
    assert.equal(St.routeKey(pts), St.routeKey(St.thin(lat, lng, 90)));
});

test("stations: parse OSM tags, project onto the route, merge duplicates, drop far ones", () => {
    const json = { elements: [
        { type: "node", id: 1, lat: 26.9001, lon: 76.1, tags: { amenity: "fuel", name: "HP Petrol", brand: "HP" } },
        { type: "node", id: 2, lat: 26.9002, lon: 76.1001, tags: { amenity: "charging_station", "socket:type2": "2" } },
        { type: "way", id: 3, center: { lat: 26.905, lon: 76.3 }, tags: { amenity: "fuel", "fuel:electricity": "yes", name: "IOCL" } },
        { type: "node", id: 4, lat: 27.2, lon: 76.2, tags: { amenity: "fuel", name: "Far away" } },
        { type: "node", id: 5, lat: 26.9, lon: 76.2, tags: { amenity: "parking" } }
    ] };
    const list = St.parse(json);
    assert.equal(list.length, 4);
    assert.deepEqual(list.find((x) => x.name === "IOCL").kinds.sort(), ["ev", "fuel"]);
    const lat = Array.from({ length: 41 }, () => 26.9), lng = Array.from({ length: 41 }, (_, i) => 76 + i * 0.01);
    const k = (Math.PI / 180) * St.RADIUS;           // unused; keeps the shape
    void k;
    const s = Float64Array.from(lng, (x) => (x - 76) * (Math.PI / 180) * 6371008.8 * Math.cos((26.9 * Math.PI) / 180));
    const proj = St.project(list, { lat, lng, s });
    assert.equal(proj.length, 2, "HP + charger merged; far one dropped");
    const hp = proj[0];
    assert.deepEqual(hp.kinds.sort(), ["ev", "fuel"]);
    assert.equal(hp.name, "HP Petrol");
    assert.ok(Math.abs(hp.s - s[10]) < 30, `s ${hp.s} vs ${s[10]}`);
    assert.ok(hp.offRoute < 30);
    assert.ok(Math.abs(proj[1].offRoute - 556) < 10, `IOCL ${proj[1].offRoute} m off`);
});

test("stations: network, then cache; offline with an old copy → stale; nothing → none", async () => {
    const store = new Map();
    const cs = { async open() { return { async match(k) { return store.has(k) ? new Response(store.get(k)) : undefined; }, async put(k, r) { store.set(k, await r.text()); } }; } };
    let calls = 0, mode = "ok", t = 1_700_000_000_000;
    const fetch = async (url, init) => {
        calls++;
        if (mode === "down") throw new TypeError("offline");
        assert.equal(init.method, "POST");
        assert.match(decodeURIComponent(init.body), /^data=\[out:json\]/);
        return new Response(JSON.stringify({ elements: [{ type: "node", id: 9, lat: 26.9, lon: 76.05, tags: { amenity: "fuel", name: "BPCL" } }] }), { status: 200 });
    };
    const lat = Array.from({ length: 11 }, () => 26.9), lng = Array.from({ length: 11 }, (_, i) => 76 + i * 0.01);
    const route = { lat, lng, s: Float64Array.from(lng, (x) => (x - 76) * 99000) };
    const api = St.createStations({ fetch, caches: /** @type {any} */ (cs), now: () => t });
    const a = await api.along(route);
    assert.equal(a.source, "network");
    assert.equal(a.stations[0].name, "BPCL");
    const b = await api.along(route);
    assert.equal(b.source, "cache");
    assert.equal(calls, 1);
    t += 8 * 86400000; mode = "down";
    const c = await api.along(route);
    assert.equal(c.source, "stale");
    const d = await St.createStations({ fetch, caches: null }).along(route);
    assert.equal(d.source, "none");
    assert.deepEqual(d.stations, []);
});

// ---------------------------------------------------------------------------
// Panel helpers and offline completeness
// ---------------------------------------------------------------------------
test("panel: level series drops as they ride and jumps at their refill", () => {
    const S = line(200);
    const rider = { id: "riya", kind: "fuel", startS: 0, energy: 0.004, capacity: 0.0053, C: flatC(S, PM) };
    const p = Plan.planConvoy({ s: S, members: [rider], stations: [station("s120", 120)] });
    const ser = Panel.levelSeries(rider, p, S, Plan, 50);
    assert.ok(Math.abs(ser[0][1] - 0.004 / 0.0053) < 1e-12);
    const before = ser.filter(([x]) => x <= 120 * KM).pop(), after = ser.find(([x]) => x > 120 * KM);
    assert.ok(after[1] > before[1] + 0.3, "refilled");
    assert.ok(Math.abs(after[1] - 1) < 1e-3, "to a full tank");
    assert.ok(ser.every((pt, i) => i === 0 || pt[0] >= ser[i - 1][0]));
    assert.equal(Panel.kmText(4200, U), "4.2 km");
    assert.equal(Panel.durText(80 * 60, U), "1 h 20 min");
    assert.equal(Panel.durText(20, U), "1 min");
    assert.equal(Panel.energyText(0.0042, "fuel", U), "4.20 L");
    assert.equal(Panel.energyText(0.012, "fuel", U), "12.0 L");
    assert.equal(Panel.energyText(1.2 * 3.6e6, "ev", U), "1.20 kWh");
});

test("pitstop-app and insights-app lazy files exist and are precached; index.html wiring is additive", () => {
    const sw = fs.readFileSync(path.join(ROOT, "public/sw.js"), "utf8");
    for (const f of ["pitstop/pitstop-app.js", "insights/insights-app.js"]) {
        const src = fs.readFileSync(path.join(ROOT, "public/js", f), "utf8");
        const files = [...src.matchAll(/"(js\/(?:pitstop|insights)\/[a-z-]+\.(?:js|css))"/g)].map((m) => m[1]);
        assert.ok(files.length >= 3, f);
        for (const x of files) { assert.ok(fs.existsSync(path.join(ROOT, "public", x)), x); assert.ok(sw.includes(`"/${x}"`), `${x} not precached`); }
        assert.ok(sw.includes(`"/js/${f}"`), `${f} not precached`);
    }
    const html = fs.readFileSync(path.join(ROOT, "public/index.html"), "utf8");
    for (const id of ["pitstop-plan-btn", "pitstop-panel", "open-fuel-dash-btn", "fuel-dash-modal", "fuel-dash-mount", "trip-panel", "trip-members-list", "fuel-curve-section"]) {
        assert.equal((html.match(new RegExp(`id="${id}"`, "g")) || []).length, 1, id);
    }
    assert.equal((html.match(/<script src="https:\/\/maps\.googleapis\.com\/maps\/api\/js\?key=[^"]+&libraries=places&loading=async"><\/script>/g) || []).length, 1);
    const server = fs.readFileSync(path.join(ROOT, "server.js"), "utf8");
    assert.match(server, /connectSrc:[^\]]*"https:\/\/overpass-api\.de"/s);
});
