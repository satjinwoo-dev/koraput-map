// Ride Plan (lib/master/rideplan.js): the geometry helpers, rest and meal stops by time, place kinds, gaps, climb,
// the fastest vs best choice with its reasons, and a whole plan against fake Overpass / Open-Meteo / places answers:
// every figure from a source, "not loaded" instead of a guess, the Google budget respected.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const RP = require("../../lib/master/rideplan.js");

const M = 1 / 110540;
// 120 km due north from Koraput, one vertex every 500 m
const line = Array.from({ length: 241 }, (_, i) => [18.8 + i * 500 * M, 82.7]);

test("geometry: cumulative length, a point along the line, simplification keeps the shape", () => {
    const cum = RP.cumulative(line);
    assert.ok(Math.abs(cum.at(-1) - 120000) < 1200, "(the test's degrees-to-metres is approximate)");
    const p = RP.pointAt(line, cum, 60000);
    assert.ok(Math.abs(RP.cumulative([line[0], p]).at(-1) - 60000) < 1 && p[1] === 82.7);
    assert.equal(RP.simplify(line, 10).length, 2, "a straight line needs only its ends");
    const zig = line.map(([a, b], i) => [a, b + (i === 120 ? 0.01 : 0)]);
    assert.equal(RP.simplify(zig, 10).length, 5, "a 1 km detour is kept");
    assert.ok(RP.simplifyTo(zig, 3).line.length <= 3);
});

test("gaps: the longest stretch without fuel, counted from the start and to the end", () => {
    assert.deepEqual(RP.gaps([10000, 30000, 100000], 120000), { maxM: 70000, fromM: 30000, toM: 100000 });
    assert.deepEqual(RP.gaps([], 50000), { maxM: 50000, fromM: 0, toM: 50000 });
});

test("rest stops every 2 h of riding, none in the last half hour; meals where the ride crosses meal time (IST)", () => {
    const depart = Date.UTC(2026, 9, 20, 1, 30);              // 07:00 IST
    const r = RP.restStops(300000, 7 * 3600, depart);
    assert.deepEqual(r.map((x) => x.afterS / 3600), [2, 4, 6]);
    assert.equal(r[0].sM, Math.round(300000 * 2 / 7));
    assert.deepEqual(RP.restStops(300000, 6.2 * 3600, depart).map((x) => x.afterS / 3600), [2, 4], "6 h would be 12 min before arrival");
    const meals = RP.mealStops(300000, 8 * 3600, depart, 330);
    assert.deepEqual(meals.map((m) => m.meal), ["breakfast", "lunch"], "07:00 → 15:00 IST: breakfast at 07:30, lunch at 12:30");
    const b = meals[0];
    assert.equal(new Date(b.at + 330 * 60000).toISOString().slice(11, 16), "07:30");
    // leaving at 13:00 IST, inside lunch: lunch 30 min after setting off; dinner at 19:30
    const m2 = RP.mealStops(400000, 8 * 3600, Date.UTC(2026, 9, 20, 7, 30), 330);
    assert.deepEqual(m2.map((m) => [m.meal, new Date(m.at + 330 * 60000).toISOString().slice(11, 16)]), [["lunch", "13:30"], ["dinner", "19:30"]]);
    assert.deepEqual(RP.mealStops(20000, 1800, Date.UTC(2026, 9, 20, 4, 0), 330), [], "a half-hour ride in the late morning: no meal stop");
});

test("place kinds from OSM tags", () => {
    assert.deepEqual(RP.categorize({ amenity: "restaurant", name: "Sharma Dhaba" }), { cat: "food", kind: "dhaba" });
    assert.deepEqual(RP.categorize({ amenity: "cafe", name: "Highway Cafe" }), { cat: "food", kind: "tea" });
    assert.deepEqual(RP.categorize({ amenity: "fast_food", name: "Chai Point" }), { cat: "food", kind: "tea" });
    assert.deepEqual(RP.categorize({ shop: "tyres" }), { cat: "mechanic", kind: "tyres" });
    assert.deepEqual(RP.categorize({ amenity: "clinic", emergency: "yes" }), { cat: "hospital", kind: "clinic" });
    assert.equal(RP.categorize({ amenity: "clinic" }), null, "a clinic without emergency care isn't a hospital");
    assert.equal(RP.categorize({ amenity: "bench" }), null);
});

test("unpaved km: only the part of a way that runs along the route counts, not a road crossing it", () => {
    const along = [[18.8 + 1000 * M, 82.7], [18.8 + 1500 * M, 82.7], [18.8 + 2000 * M, 82.7]];
    assert.ok(Math.abs(RP.overlapM(along, line, 20) - RP.cumulative(along).at(-1)) < 0.01);
    const across = [[18.8 + 1000 * M, 82.69], [18.8 + 1000 * M, 82.7], [18.8 + 1000 * M, 82.71]];
    assert.equal(RP.overlapM(across, line, 20), 0);
});

test("climb: model noise isn't climbing; too little terrain data says so", () => {
    const flatNoisy = Array.from({ length: 100 }, (_, i) => 900 + (i % 2 ? 0.4 : -0.4));
    assert.equal(RP.climb(flatNoisy, 100).climbM, 0);
    const hill = Array.from({ length: 101 }, (_, i) => 500 + Math.min(i, 50) * 10);   // +500 m over 5 km, then flat
    const c = RP.climb(hill, 100);
    assert.ok(c.climbM >= 480 && c.climbM <= 500, `climb ${c.climbM}`);
    assert.ok(Math.abs(c.maxGradePct - 10) < 0.6);
    assert.equal(RP.climb([null, null, 5, null], 100).available, false);
});

test("fastest vs best: the reasons are the measured differences", () => {
    const f0 = { weatherWarnings: 0, blackspots: 0, unpavedKm: 0, levelCrossings: 0, breakers: 0, fuelGapKm: 30, hospitalGapKm: 20, climbM: 0 };
    const s = RP.scoreRoutes([
        { id: "a", durationS: 3 * 3600, factors: { ...f0, unpavedKm: 18, levelCrossings: 3, blackspots: 2 } },
        { id: "b", durationS: 3 * 3600 + 900, factors: f0 }
    ]);
    assert.equal(s.fastestId, "a");
    assert.equal(s.bestId, "b");
    assert.ok(s.why.includes("2 fewer official blackspots") && s.why.includes("18 km less unpaved or bad road") && s.why.includes("15 min slower"));
    // a much slower route doesn't win for small things
    const s2 = RP.scoreRoutes([{ id: "a", durationS: 3600, factors: { ...f0, breakers: 4 } }, { id: "b", durationS: 3 * 3600, factors: f0 }]);
    assert.deepEqual([s2.bestId, s2.why], ["a", ["also the fastest"]]);
});

test("a whole plan: places and gaps from OSM, ride-day weather at the right hour, no accident data → says so, Google budget kept", async () => {
    const T0 = Date.UTC(2026, 9, 18, 0, 0);
    const depart = Date.UTC(2026, 9, 20, 1, 30);                  // in two days, 07:00 IST
    const calls = { overpass: 0, meteo: 0, poi: 0 };
    const fetchImpl = async (url, init) => {
        const u = String(url);
        const ok = (j) => ({ ok: true, status: 200, headers: { get: () => "application/json" }, json: async () => j, text: async () => JSON.stringify(j) });
        if (u.includes("overpass")) {
            calls.overpass++;
            const q = decodeURIComponent(String(init.body).slice(5));
            if (q.includes("traffic_calming")) return ok({ elements: [
                { type: "node", id: 1, lat: 18.8 + 10000 * M, lon: 82.7, tags: { traffic_calming: "bump" } },
                { type: "node", id: 2, lat: 18.8 + 20000 * M, lon: 82.7, tags: { railway: "level_crossing" } },
                { type: "way", id: 3, tags: { highway: "primary", surface: "unpaved" }, geometry: [{ lat: 18.8 + 50000 * M, lon: 82.7 }, { lat: 18.8 + 52000 * M, lon: 82.7 }] }
            ] });
            return ok({ elements: [
                { type: "node", id: 10, lat: 18.8 + 5000 * M, lon: 82.701, tags: { amenity: "fuel", brand: "IndianOil", name: "IOCL Koraput" } },
                { type: "node", id: 11, lat: 18.8 + 95000 * M, lon: 82.7, tags: { amenity: "fuel" } },
                { type: "node", id: 12, lat: 18.8 + 40000 * M, lon: 82.71, tags: { amenity: "hospital", name: "District Hospital" } },
                { type: "node", id: 13, lat: 18.8 + 61000 * M, lon: 82.7005, tags: { amenity: "restaurant", name: "Maa Tarini Dhaba" } },
                { type: "node", id: 14, lat: 18.8 + 30000 * M, lon: 82.75, tags: { amenity: "fuel" } },          // 5 km off the road: not on it
                { type: "node", id: 15, lat: 18.8 + 70000 * M, lon: 82.7, tags: { shop: "motorcycle_repair", name: "Raju Bike Works" } }
            ] });
        }
        if (u.includes("open-meteo")) {
            calls.meteo++;
            const n = new URL(u).searchParams.get("latitude").split(",").length;
            const times = Array.from({ length: 48 }, (_, h) => new Date(Date.UTC(2026, 9, 20) + h * 3600000).toISOString().slice(0, 13) + ":00");
            const one = { hourly: { time: times, temperature_2m: times.map(() => 24), apparent_temperature: times.map(() => 25), relative_humidity_2m: times.map(() => 70),
                precipitation_probability: times.map((_t, h) => (h === 3 ? 90 : 10)), precipitation: times.map((_t, h) => (h === 3 ? 9 : 0)), weather_code: times.map((_t, h) => (h === 3 ? 65 : 1)),
                wind_gusts_10m: times.map(() => 5), visibility: times.map(() => 20000) } };
            return ok(n === 1 ? one : Array.from({ length: n }, () => one));
        }
        throw new Error(`unexpected ${u}`);
    };
    const poi = {
        configured: () => ({ google: true }),
        handle: async (b) => { calls.poi++; return { status: 200, json: { ok: true, sources: { google: true, osm: true }, places: [{ cat: b.categories[0], source: "google", placeId: "x", name: `Good ${b.categories[0]}`, lat: b.lat, lng: b.lng + 0.001, rating: 4.4, reviewsCount: 820, tier: "vetted" }] } }; }
    };
    const plan = RP.createRidePlan({ fetchImpl, now: () => T0, poi, blackspots: { info: () => ({ count: 0 }), nearLine: () => [] }, dem: null, googleMax: 4 });
    const r = await plan.handle({ routes: [{ id: "r1", line, distanceM: 120000, durationS: 3 * 3600 }], departAt: depart, tzOffsetMin: 330 });
    assert.equal(r.status, 200);
    const rep = r.json.routes[0];
    assert.equal(rep.places.counts.fuel, 2, "the pump 5 km off the road isn't on the route");
    assert.deepEqual([rep.places.counts.hospital, rep.places.counts.dhaba, rep.places.counts.mechanic], [1, 1, 1]);
    assert.ok(Math.abs(rep.places.gaps.fuel.maxM - 90000) < 1000, "IOCL at km 5, the next at km 95");
    assert.deepEqual([rep.road.breakers, rep.road.levelCrossings], [1, 1]);
    assert.ok(Math.abs(rep.road.unpavedKm - 2) < 0.15);
    assert.equal(rep.accidents.loaded, false, "no official list loaded: the report says so");
    assert.equal(rep.terrain.available, false);
    // ride-day weather: heavy rain at 03:00 UTC, which the rider reaches 1.5 h after leaving at 01:30 UTC (km 60)
    assert.equal(rep.weather.available, true);
    assert.equal(rep.weather.certain, true, "2 days ahead");
    const wet = rep.weather.samples.filter((s) => s.hazards.some((h) => h.type === "heavy-rain"));
    assert.ok(wet.length >= 1 && wet.every((s) => new Date(s.hourAt).getUTCHours() === 3));
    assert.equal(rep.factors.weatherWarnings, wet.length);
    // picks: breakfast (07:30 IST) + one hospital/mechanic point (2 calls) + destination hotel → stops at the budget of 4
    assert.equal(r.json.picks.routeId, "r1");
    assert.ok(r.json.picks.googleCalls <= 4);
    assert.equal(r.json.picks.meals[0].meal, "breakfast");
    assert.equal(r.json.picks.meals[0].options[0].tier, "vetted");
    assert.equal(r.json.sources.accidents, null);
    // the same route again: Overpass is cached
    const before = calls.overpass;
    await plan.handle({ routes: [{ id: "r1", line, distanceM: 120000, durationS: 3 * 3600 }], departAt: depart });
    assert.equal(calls.overpass, before);
    // too far ahead for a forecast: when to check again
    const far = await plan.handle({ routes: [{ id: "r1", line, durationS: 3 * 3600 }], departAt: T0 + 20 * 86400000 });
    assert.deepEqual([far.json.routes[0].weather.available, far.json.routes[0].weather.checkFrom], [false, T0 + 4 * 86400000]);
    // bad input
    assert.equal((await plan.handle({ routes: [{ line: [[18.8, 82.7]] }] })).status, 400);
    assert.equal((await plan.handle({ routes: [] })).status, 400);
});

test("the phone side: thinning, labels, km, the stop timeline, and the wiring", async () => {
    const fs = await import("node:fs");
    const { RidePlanCore: C } = require("../../public/js/rideplan/rideplan-app.js");
    const pts = Array.from({ length: 10001 }, (_, i) => [i, i]);
    const t = C.thin(pts, 3000);
    assert.equal(t.length, 3000);
    assert.deepEqual([t[0], t.at(-1)], [[0, 0], [10000, 10000]]);
    assert.equal(C.thin(pts.slice(0, 5), 3000).length, 5);
    assert.deepEqual([C.labelFor(0), C.labelFor(2)], ["Route A", "Route C"]);
    assert.deepEqual([C.fmtKm(820), C.fmtKm(4250), C.fmtKm(48600)], ["800 m", "4.3 km", "49 km"]);
    const tl = C.timeline({ meals: [{ meal: "lunch", sM: 150000, at: 3, options: [], reviews: true }], restStops: [{ sM: 90000, at: 2, afterS: 7200, options: [{ name: "x" }], reviews: false }] });
    assert.deepEqual(tl.map((r) => [r.label, r.sM]), [["Break after 2 h", 90000], ["Lunch", 150000]]);
    assert.deepEqual(C.timeline(null), []);
    assert.match(C.localInput(Date.UTC(2026, 9, 20, 1, 30)), /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/);
    const read = (p) => fs.readFileSync(new URL(`../../${p}`, import.meta.url), "utf8");
    const html = read("public/index.html"), sw = read("public/sw.js"), api = read("lib/master/http-api.js"), app = read("public/js/rideplan/rideplan-app.js");
    assert.ok(html.includes('<script src="js/rideplan/rideplan-app.js') && html.includes('href="js/rideplan/rideplan.css'));
    assert.ok(sw.includes('"/js/rideplan/rideplan-app.js"') && sw.includes('"/js/rideplan/rideplan.css"'));
    assert.match(api, /post\("\/ride-plan", 6, "320kb", s\.ridePlan\.handle\)/);
    assert.match(read("server.js"), /createMasterApi\(\{\s*express, rateLimit, roadsense, dem,/);
    // the plan says "no official accident data" rather than inventing any, and never calls a place "verified"
    assert.match(app, /No official accident data is loaded for this road yet/);
    assert.ok(!/verified/i.test(app.replace(/never "verified"|never “verified”/g, "")));
});
