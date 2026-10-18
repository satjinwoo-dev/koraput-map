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

test("a whole plan: places and gaps from OSM, MET Norway weather at the right hour, riders' ratings first, known hospitals apart, no accident data → says so", async () => {
    const T0 = Date.UTC(2026, 9, 18, 0, 0);
    const depart = Date.UTC(2026, 9, 20, 1, 30);                  // in two days, 07:00 IST
    const calls = { overpass: 0 };
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
                { type: "node", id: 13, lat: 18.8 + 21000 * M, lon: 82.7005, tags: { amenity: "restaurant", name: "Maa Tarini Dhaba" } },
                { type: "node", id: 16, lat: 18.8 + 24000 * M, lon: 82.7002, tags: { amenity: "restaurant", name: "Highway Dhaba" } },
                { type: "node", id: 14, lat: 18.8 + 30000 * M, lon: 82.75, tags: { amenity: "fuel" } },          // 5 km off the road: not on it
                { type: "node", id: 15, lat: 18.8 + 70000 * M, lon: 82.7, tags: { shop: "motorcycle_repair", name: "Raju Bike Works" } }
            ] });
        }
        throw new Error(`unexpected ${u}`);
    };
    // MET Norway, as metno.js returns it: heavy rain in the 03:00 UTC hour
    const metno = { forecastAt: async (pts) => pts.map((p) => {
        const hourAt = Math.round(p.at / 3600000) * 3600000, wet = new Date(hourAt).getUTCHours() === 3;
        return { available: true, at: hourAt, hourly: true, tempC: 24, rhPct: 70, windMs: 3, gustMs: null, precipMmH: wet ? 9 : 0, rainProbPct: null, symbol: wet ? "heavyrain" : "fair", code: wet ? 65 : 1, hazards: wet ? [{ type: "heavy-rain", level: "warning", value: 9, unit: "mm/h" }] : [] };
    }) };
    // riders: Highway Dhaba 5 👍 1 👎 (shown), Maa Tarini 1 👍 (too few to show)
    const ratings = { lookupIds: (ids) => Object.fromEntries(ids.filter((id) => id === "n16" || id === "n13").map((id) => [id, id === "n16" ? { up: 5, down: 1, tags: { "good-food": 3 }, shown: true, score: 0.44 } : { up: 1, down: 0, tags: {}, shown: false, score: 0.2 }])) };
    const hospitals = { info: () => ({ count: 1, sources: [{ name: "Test directory" }] }), nearLine: () => [{ id: "t:1", name: "CHC Kotpad", lat: 18.8 + 80000 * M, lng: 82.705, sM: 80000, offM: 500, source: "t", phone: null }] };
    const plan = RP.createRidePlan({ fetchImpl, now: () => T0, metno, ratings, hospitals, blackspots: { info: () => ({ count: 0 }), nearLine: () => [] }, dem: null });
    const r = await plan.handle({ routes: [{ id: "r1", line, distanceM: 120000, durationS: 3 * 3600 }], departAt: depart, tzOffsetMin: 330 });
    assert.equal(r.status, 200);
    const rep = r.json.routes[0];
    assert.equal(rep.places.counts.fuel, 2, "the pump 5 km off the road isn't on the route");
    assert.deepEqual([rep.places.counts.hospital, rep.places.counts.knownHospitals, rep.places.counts.dhaba, rep.places.counts.mechanic], [1, 1, 2, 1]);
    assert.ok(Math.abs(rep.places.gaps.fuel.maxM - 90000) < 1000, "IOCL at km 5, the next at km 95");
    assert.ok(rep.places.gaps.hospital.maxM < 45000, "the known hospital at km 80 counts for the gap (it's still shown as only known)");
    assert.equal(rep.places.knownHospitals[0].known, true);
    assert.deepEqual([rep.road.breakers, rep.road.levelCrossings], [1, 1]);
    assert.ok(Math.abs(rep.road.unpavedKm - 2) < 0.15);
    assert.equal(rep.accidents.loaded, false, "no official list loaded: the report says so");
    assert.equal(rep.terrain.available, false);
    assert.deepEqual([rep.weather.available, rep.weather.certain, rep.weather.source], [true, true, "MET Norway"]);
    const wet = rep.weather.samples.filter((s) => s.hazards.some((h) => h.type === "heavy-rain"));
    assert.ok(wet.length >= 1 && wet.every((s) => new Date(s.hourAt).getUTCHours() === 3));
    assert.equal(rep.factors.weatherWarnings, wet.length);
    // picks: breakfast at 07:30 IST, half an hour in: near km 20; the dhaba riders rated comes first, the one with 1 rating shows none
    const bf = r.json.picks.meals[0];
    assert.equal(bf.meal, "breakfast");
    assert.equal(bf.ratings, true);
    assert.deepEqual(bf.options.map((p) => [p.name, Boolean(p.riders)]), [["Highway Dhaba", true], ["Maa Tarini Dhaba", false]]);
    assert.ok(r.json.picks.hospitals.some((x) => x.options.some((p) => p.known && p.name === "CHC Kotpad")));
    assert.ok(!JSON.stringify(r.json).match(/google/i), "nothing from Google anywhere in the plan");
    assert.deepEqual([r.json.sources.weather, r.json.sources.knownHospitals, r.json.sources.accidents], ["Weather forecast from MET Norway", "Test directory", null]);
    // the same route again: Overpass is cached
    const before = calls.overpass;
    await plan.handle({ routes: [{ id: "r1", line, distanceM: 120000, durationS: 3 * 3600 }], departAt: depart });
    assert.equal(calls.overpass, before);
    // too far ahead for MET's ~9 days: when to check again
    const far = await plan.handle({ routes: [{ id: "r1", line, durationS: 3 * 3600 }], departAt: T0 + 12 * 86400000 });
    assert.deepEqual([far.json.routes[0].weather.available, far.json.routes[0].weather.checkFrom], [false, T0 + 3 * 86400000]);
    // bad input
    assert.equal((await plan.handle({ routes: [{ line: [[18.8, 82.7]] }] })).status, 400);
    assert.equal((await plan.handle({ routes: [] })).status, 400);
});

test("MET Norway: symbols to weather codes, the step nearest the time, the server fetches with a User-Agent and caches", async () => {
    const MN = require("../../lib/master/metno.js");
    assert.deepEqual(["heavyrainandthunder", "rainshowersandthunder_day", "heavyrain", "lightrainshowers_night", "rain", "fog", "clearsky_day", "partlycloudy_night", "lightsnow"].map(MN.symbolToWmo), [96, 95, 65, 80, 63, 45, 0, 2, 71]);
    assert.equal(MN.symbolToWmo(null), null);
    const t0 = Date.UTC(2026, 9, 20, 0);
    const series = [
        ...Array.from({ length: 48 }, (_, i) => ({ time: new Date(t0 + i * 3600000).toISOString(), data: { instant: { details: { air_temperature: 20 + i * 0.1, relative_humidity: 80, wind_speed: 3, wind_speed_of_gust: 7 } }, next_1_hours: { summary: { symbol_code: i === 5 ? "heavyrain" : "cloudy" }, details: { precipitation_amount: i === 5 ? 8.2 : 0 } } } })),
        { time: new Date(t0 + 54 * 3600000).toISOString(), data: { instant: { details: { air_temperature: 18 } }, next_6_hours: { summary: { symbol_code: "rain" }, details: { precipitation_amount: 6 } } } }
    ];
    const s = MN.pickStep(series, t0 + 5 * 3600000 + 20 * 60000);
    assert.deepEqual([s.symbol, s.precipMmH, s.gustMs, s.hourly], ["heavyrain", 8.2, 7, true]);
    const six = MN.pickStep(series, t0 + 54 * 3600000);
    assert.deepEqual([six.precipMmH, six.hourly, six.gustMs], [1, false, null], "a 6-hour block as mm per hour; no gust given → null, not made up");
    assert.equal(MN.pickStep(series, t0 + 80 * 3600000), null, "past the forecast's end");
    let seen = [];
    const fetchImpl = async (url, init) => { seen.push({ url: String(url), ua: init.headers["user-agent"] }); return { ok: true, status: 200, headers: { get: () => null }, json: async () => ({ properties: { timeseries: series } }) }; };
    const met = MN.createMetNo({ fetchImpl, now: () => t0 });
    const out = await met.forecastAt([{ lat: 18.81234, lng: 82.71234, at: t0 + 5 * 3600000 }, { lat: 18.8149, lng: 82.7149, at: t0 + 6 * 3600000 }]);
    assert.equal(seen.length, 1, "two points in one ~1 km cell: one request");
    assert.match(seen[0].url, /^https:\/\/api\.met\.no\/weatherapi\/locationforecast\/2\.0\/complete\?lat=18\.81&lon=82\.71$/);
    assert.match(seen[0].ua, /^MapUnite\/1\.0 \(\+https:\/\//, "the app and a contact, as MET's terms require");
    assert.equal(out[0].hazards.find((h) => h.type === "heavy-rain").level, "warning");
    await met.forecastAt([{ lat: 18.81, lng: 82.71, at: t0 }]);
    assert.equal(seen.length, 1, "cached");
});

test("riders' ratings: only explicit answers, one per rider and place, fixed tags, shown from 3, forgettable", async () => {
    const PR = require("../../lib/master/place-ratings.js");
    const { openServerDatabase } = require("../../lib/server-db.js");
    assert.ok(PR.wilson(50, 2) > PR.wilson(3, 0), "many 👍 beat a few");
    assert.equal(PR.wilson(0, 0), 0);
    assert.deepEqual(PR.cleanTags(["clean", "rude", "clean", "<script>", "good-food"], true), ["clean", "good-food"], "only known tags that fit the verdict");
    assert.deepEqual(PR.cleanTags(["rude", "clean"], false), ["rude"]);
    const { db } = openServerDatabase(":memory:");
    let t = Date.UTC(2026, 9, 20);
    const pr = PR.createPlaceRatings({ db: () => db, secret: () => "s", now: () => t });
    const tok = (i) => `rider-token-${String(i).padStart(8, "0")}`;
    const rate = (i, up, tags = []) => pr.submit({ v: 1, rater: tok(i), place: { id: "n16", cat: "food" }, up, tags });
    assert.equal((await rate(1, true, ["good-food"])).status, 200);
    assert.equal((await rate(1, false)).status, 409, "the same rider again within 30 days");
    await rate(2, true, ["good-food", "fair-price"]); await rate(3, false, ["overcharged"]);
    const l = await pr.lookup({ ids: ["n16", "n99"] });
    assert.deepEqual([l.json.ratings.n16.up, l.json.ratings.n16.down, l.json.ratings.n16.shown, l.json.ratings.n16.tags["good-food"]], [2, 1, true, 2]);
    assert.equal(l.json.ratings.n99, undefined);
    // bad input never stored
    assert.equal((await pr.submit({ v: 1, rater: "short", place: { id: "n16", cat: "food" }, up: true })).status, 400);
    assert.equal((await pr.submit({ v: 1, rater: tok(4), place: { id: "16; DROP", cat: "food" }, up: true })).status, 400);
    assert.equal((await pr.submit({ v: 1, rater: tok(4), place: { id: "n16", cat: "food" }, up: "yes" })).status, 400);
    // no token stored as given
    assert.ok(!JSON.stringify(db.prepare("SELECT * FROM place_rating").all()).includes("rider-token"));
    // after 30 days the rider may change their mind
    t += 31 * 86400000;
    assert.equal((await rate(1, false)).status, 200);
    assert.equal((await pr.lookup({ ids: ["n16"] })).json.ratings.n16.down, 2);
    const f = await pr.forget({ v: 1, rater: tok(1) });
    assert.equal(f.json.deleted, 1);
    const after = (await pr.lookup({ ids: ["n16"] })).json.ratings.n16;
    assert.deepEqual([after.up, after.down, after.shown], [1, 1, false], "rider 1's rating is gone; 2 left is below the 3 needed to show");
});

test("known hospitals: imported from a government directory with coordinates, never guessed, found along a line", async () => {
    const { toHospitals } = await import("../../scripts/master/import-hospitals.mjs");
    const { parseCsv } = await import("../../scripts/master/import-blackspots.mjs");
    const csv = "Sr_No,Hospital_Name,Hospital_Category,State,District,Latitude,Longitude,Telephone\n1,CHC Kotpad,Public,Odisha,Koraput,19.14,82.32,06852-250000\n2,No Coords Hospital,Public,Odisha,Koraput,,,\n3,CHC Kotpad,Public,Odisha,Koraput,19.1401,82.3201,\n4,Somewhere Abroad,Private,X,Y,51.5,-0.1,\n5,Jeypore Hospital,Private,Odisha,Koraput,18.86,82.57,\n";
    const { hospitals, skipped, merged } = toHospitals(parseCsv(csv), {});
    assert.deepEqual(hospitals.map((h) => h.name), ["CHC Kotpad", "Jeypore Hospital"]);
    assert.deepEqual([skipped, merged], [2, 1], "no coordinates / outside India skipped; the same hospital 15 m apart merged");
    assert.equal(hospitals[0].phone, "06852-250000");
    const both = toHospitals(parseCsv("Hospital_Name,Location_Coordinates\nA,\"18.86, 82.57\"\n"), {});
    assert.deepEqual([both.hospitals[0].lat, both.hospitals[0].lng], [18.86, 82.57]);
    const { createHospitals } = require("../../lib/master/hospitals.js");
    const H = createHospitals();
    H.load([{ v: 1, source: { id: "t", name: "Test" }, hospitals }]);
    const along = H.nearLine([[18.80, 82.57], [18.95, 82.57]], 4000);
    assert.deepEqual(along.map((h) => h.name), ["Jeypore Hospital"]);
    assert.ok(along[0].sM > 6000 && along[0].sM < 7000 && along[0].offM < 10);
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
    assert.ok(!/google/i.test(app) && !/google/i.test(read("lib/master/rideplan.js")), "no Google in the Ride Plan");
    assert.match(app, /known location/);
    // after a ride: long stops only ask, never rate; the start and the end aren't stops
    const { StopAskCore: S } = require("../../public/js/rideplan/stop-ask.js");
    const T = Date.UTC(2026, 9, 20, 4, 0);
    const track = [];
    for (let i = 0; i < 40; i++) track.push({ ts: T + i * 5000, lat: 18.8 + i * 0.001, lng: 82.7 });                 // riding
    for (let i = 0; i < 150; i++) track.push({ ts: T + 200000 + i * 5000, lat: 18.84 + (i % 3) * 0.00005, lng: 82.7 }); // 12.4 min stopped
    for (let i = 0; i < 30; i++) track.push({ ts: T + 960000 + i * 5000, lat: 18.841 + i * 0.001, lng: 82.7 });       // riding on
    for (let i = 0; i < 100; i++) track.push({ ts: T + 1200000 + i * 5000, lat: 18.9, lng: 82.7 });                   // arrived: the end
    const stops = S.findStops(track);
    assert.equal(stops.length, 1, "the stop at the end of the ride isn't asked about");
    assert.ok(stops[0].durMin >= 12 && Math.abs(stops[0].lat - 18.84) < 0.001);
    assert.deepEqual(S.findStops(track.slice(0, 60)), [], "a short pause isn't a stop");
    assert.match(S.raterToken(globalThis.crypto), /^[A-Za-z0-9_-]{32}$/);
    const ask = read("public/js/rideplan/stop-ask.js");
    assert.ok(!/submit[^\n]*mu:trip-end|setTimeout\([^)]*submit/.test(ask), "nothing is sent when a ride ends");
    assert.match(ask, /Did you stop at one of these\?/);
    assert.ok(html.includes('<script src="js/rideplan/stop-ask.js') && sw.includes('"/js/rideplan/stop-ask.js"'));
    assert.match(api, /post\("\/ratings\/submit", 20, "4kb", o\.ratings\.submit\)/);
    assert.ok(!/verified/i.test(app.replace(/never "verified"|never “verified”|not verified/gi, "")), "the app never calls anything verified");
});
