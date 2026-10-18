// Ride Story: the ride journal (js/story/journal.js) and the story it builds (js/story/story-core.js).
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { buildArtifacts } from "../../scripts/bikedb/catalog-build.mjs";
import { loadCatalog } from "../../scripts/bikedb/load-catalog.mjs";

const require = createRequire(import.meta.url);
const Physics = require("../../public/js/physics/index.js");
const Search = require("../../public/js/bikedb/catalog-search.js");
const L = require("../../public/js/hud/live.js");
const J = require("../../public/js/story/journal.js");
const S = require("../../public/js/story/story-core.js");

const art = buildArtifacts(loadCatalog());
const byHash = new Map(art.bundles.map((b) => [b.hash, JSON.parse(b.bytes)]));
const index = new Search.CatalogIndex(JSON.parse(art.catalog.bytes));
function model(q, settings) {
    const row = index.search(q, { limit: 1 })[0];
    const b = byHash.get(row.bundle), cls = index.classes.find((c) => c.key === b.classKey);
    return Physics.createBikeModel(b, { classDefault: cls ? byHash.get(cls.bundle) : undefined, settings });
}
const hunter = model("Hunter 350", { riderMass: 70, pillionMass: 55 });

/**
 * A ride heading due east: [seconds, speed m/s, grade] pieces.
 * 0–60 s pull away to 14 m/s; cruise; a 30 s traffic halt; a 5 % climb; a hard stop; a 5-minute break; a fast run.
 */
function profile() {
    const out = [];
    const add = (n, f) => { for (let i = 0; i < n; i++) out.push(f(i)); };
    add(15, (i) => ({ v: Math.min(14, i), g: 0 }));
    add(240, () => ({ v: 14, g: 0 }));
    add(14, (i) => ({ v: Math.max(0, 14 - i), g: 0 }));
    add(30, () => ({ v: 0, g: 0 }));                               // traffic
    add(10, (i) => ({ v: Math.min(11, i * 1.2), g: 0 }));
    add(180, () => ({ v: 11, g: 0.05 }));                          // the climb
    add(60, () => ({ v: 20, g: 0 }));
    add(6, (i) => ({ v: Math.max(0, 20 - (i + 1) * 4), g: 0 }));      // hard brake: −4 m/s² for 5 s
    add(300, () => ({ v: 0, g: 0 }));                              // break
    add(12, (i) => ({ v: Math.min(24, i * 2), g: 0 }));
    add(240, () => ({ v: 24, g: -0.01 }));                         // fast, slightly downhill
    add(8, (i) => ({ v: Math.max(0, 24 - i * 3), g: 0 }));
    return out;
}

function ride(withWeather = true) {
    const est = L.createLiveEstimator(Physics, hunter, { price: 100 * 1000 });
    const j = J.createJournal(Physics, hunter, { step: 250 });
    const t0 = Date.UTC(2026, 9, 18, 3, 30);
    if (withWeather) j.weather({ t: t0, tempK: 303.15, rh: 0.7, pressurePa: 100000, windMs: 6, windFrom: 90, code: 2, precipMm: 0 });
    let lat = 18.81, lng = 82.71, s;
    profile().forEach((p, i) => {
        const t = t0 + i * 1000;
        lng += (p.v / (6371008.8 * Math.cos(lat * Math.PI / 180))) * (180 / Math.PI);
        s = est.push({ t, v: p.v, grade: p.g });
        j.push({ t, lat, lng, v: p.v }, s);
    });
    return { s, journal: j.finish(), t0 };
}

test("the stretches add up to the trip: distance, fuel, time", () => {
    const { s, journal } = ride();
    const sum = (k) => journal.stretches.reduce((a, x) => a + x[k], 0);
    assert.ok(Math.abs(sum("d") - s.trip.distance) < 1e-6, `${sum("d")} vs ${s.trip.distance}`);
    assert.ok(Math.abs(sum("e") - s.trip.energy) / s.trip.energy < 1e-9);
    assert.ok(Math.abs(sum("time") - s.trip.time) < 1e-6);
    assert.ok(journal.stretches.length > 10 && journal.stretches.length <= J.JOURNAL_DEFAULTS.maxStretches);
    assert.ok(journal.route.length > 20);
});

test("stops: the 30 s halt is traffic, the 5-minute one a break; the longest run is before the break", () => {
    const { journal } = ride();
    assert.equal(journal.stops.length, 2);
    assert.equal(journal.stops[0].rest, false);
    assert.ok(Math.abs(journal.stops[0].dur - 30) <= 2);
    assert.equal(journal.stops[1].rest, true);
    assert.ok(journal.stops[1].dur >= 295);
    assert.ok(journal.longestRun.t > 500 && journal.longestRun.t < 600, String(journal.longestRun.t));
});

test("hard braking is where the estimator counted it, with the speed it came from", () => {
    const { s, journal } = ride();
    assert.equal(journal.brakes.length, s.trip.harsh.brake);
    assert.ok(journal.brakes.length >= 1);
    assert.ok(journal.brakes.some((b) => b.from >= 15), JSON.stringify(journal.brakes));
});

test("the wind: riding east into an east wind is a headwind and costs fuel", () => {
    const { journal } = ride();
    assert.ok(journal.headwind > 2.5 && journal.headwind < 3.5, String(journal.headwind));   // 6 m/s at 10 m × 0.5
    assert.ok(journal.work.wind > 0);
    assert.ok(journal.rho < journal.physics.rhoStd, "30 °C humid air is thinner than the standard 15 °C");
    assert.ok(Math.abs(J.headwind(10, 270, 90) + 5) < 1e-9, "a west wind behind an eastbound rider pushes");
});

test("the story: time, fuel, where it went, highlights, behaviour", () => {
    const { s, journal } = ride();
    const st = S.build(journal, { trip: s.trip, ev: false, priceUnit: "₹100/L", bike: { name: "Royal Enfield Hunter 350", tankM3: 0.013 }, tank: { start: 0.008 },
        people: { me: "rider", rider: { name: "Satyam", kg: 70 }, pillion: { name: "Riya", kg: 55 } }, usualKmL: 36, bestPm: Physics.cruiseTable(hunter, {}, { sigma: false, step: 0.5 }).eco.perMetreBest });
    assert.equal(st.time.traffic, 1);
    assert.equal(st.time.rest, 1);
    assert.ok(st.time.restTime >= 295);
    assert.ok(Math.abs(st.fuel.used - s.trip.energy) < 1e-15);
    assert.ok(Math.abs(st.fuel.cost - s.trip.cost) < 1e-9);
    assert.ok(st.fuel.economy > 15 && st.fuel.economy < 80, String(st.fuel.economy));
    assert.ok(st.fuel.ideal <= st.fuel.used && st.fuel.save >= 0);
    assert.ok(Math.abs(st.fuel.tankEnd - (0.008 - s.trip.energy)) < 1e-12);
    const shares = st.parts.filter((p) => p.share !== null).reduce((a, p) => a + p.share, 0);
    assert.ok(Math.abs(shares - 1) < 1e-9);
    const fuelParts = st.parts.reduce((a, p) => a + p.fuel, 0);
    assert.ok(Math.abs(fuelParts - s.trip.energy) / s.trip.energy < 1e-9, "the parts are the fuel");
    assert.equal(st.drag.wind.kind, "head");
    assert.ok(st.drag.wind.fuel > 0 && st.drag.wind.cost > 0);
    assert.equal(st.weather.windFromText, "E");
    assert.equal(st.weather.sky.text, "Partly cloudy");
    assert.ok(Math.abs(st.weather.tempC - 30) < 1e-9);
    // the climb is the thirstiest stretch, and says why
    assert.ok(st.highlights.thirsty, "a thirsty stretch");
    assert.ok(st.highlights.thirsty.reasons.some((r) => r.key === "uphill" || r.key === "fast"), JSON.stringify(st.highlights.thirsty.reasons));
    assert.ok(st.highlights.thrifty && st.highlights.thrifty.perMetre <= st.fuel.perMetre);
    assert.ok(Math.abs(st.mix.eco + st.mix.normal + st.mix.thirsty - 1) < 1e-6);
    assert.ok(["smooth", "steady", "mixed", "fast", "brakes", "throttle"].includes(st.behaviour.key));
    assert.equal(st.behaviour.hardBrakes, s.trip.harsh.brake);
    assert.ok(st.behaviour.top.speed >= 23.9);
    assert.ok(st.headline.climb > 90, String(st.headline.climb));
    assert.equal(st.people.pillion.name, "Riya");
    assert.ok(Math.abs(st.people.total - (hunter.massFixed + 70)) < 1e-9);
    assert.ok(st.facts.some((f) => f.key === "floors"));
    assert.equal(st.series.length, journal.stretches.length);
});

test("no weather, no sensor: the story says so instead of making it up", () => {
    const { s, journal } = ride(false);
    const st = S.build(journal, { trip: s.trip });
    assert.equal(st.weather, null);
    assert.equal(st.drag.wind, null);
    assert.equal(st.road.sensor, false);
    assert.equal(st.road.potholes, undefined);
});

test("road sensor: this ride's potholes, breakers and rough road; another ride's don't count", () => {
    const { s, journal, t0 } = ride();
    const items = [
        { kind: "impact", hazard: "pothole", t: t0 + 60000, lat: 18.81, lng: 82.72, severity: 3 },
        { kind: "impact", hazard: "pothole", t: t0 + 90000, lat: 18.81, lng: 82.73 },
        { kind: "impact", hazard: "speed_breaker", t: t0 + 120000, lat: 18.81, lng: 82.74 },
        { kind: "rough", hazard: "rough", t: t0 + 200000, lat: 18.81, lng: 82.75, lengthM: 180 },
        { kind: "impact", hazard: "bump", minor: true, t: t0 + 210000, lat: 18.81, lng: 82.75 },
        { kind: "impact", hazard: "pothole", t: t0 - 3600000, lat: 18.81, lng: 82.70 }
    ];
    const st = S.build(journal, { trip: s.trip, road: { startedAt: t0, endedAt: t0 + 1200000, items } });
    assert.equal(st.road.sensor, true);
    assert.equal(st.road.potholes, 2);
    assert.equal(st.road.breakers, 1);
    assert.equal(st.road.rough, 1);
    assert.equal(st.road.roughM, 180);
    assert.equal(st.road.small, 1);
    const other = S.build(journal, { trip: s.trip, road: { startedAt: t0 - 86400000, endedAt: t0 - 86000000, items } });
    assert.equal(other.road.sensor, false);
});

test("a long ride is merged down to the stretch limit, and still adds up", () => {
    const est = L.createLiveEstimator(Physics, hunter, {});
    const j = J.createJournal(Physics, hunter, { step: 250 });
    let s;
    for (let i = 0; i < 4000; i++) { s = est.push({ t: i * 1000, v: 20 }); j.push({ t: i * 1000, lat: 18.8, lng: 82.7 + i * 0.0002, v: 20 }, s); }
    const out = j.finish();
    assert.ok(out.stretches.length <= J.JOURNAL_DEFAULTS.maxStretches);
    const d = out.stretches.reduce((a, x) => a + x.d, 0);
    assert.ok(Math.abs(d - s.trip.distance) < 1e-6);
    assert.ok(out.route.length <= J.JOURNAL_DEFAULTS.maxRoute);
});
