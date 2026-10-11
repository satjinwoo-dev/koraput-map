// Roadmap step 9: gradient from elevation, bridges and tunnels fixed (public/js/gradient/)
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const core = require("../../public/js/gradient/gradient.js");
const ST = require("../../public/js/gradient/structures.js");
const V = require("../../public/js/gradient/profile-chart.js");
const P = require("../../public/js/trip/profile.js");
const U = require("../../public/js/garage/units.js");

const LAT = 18.8, LNG0 = 82.7;
const mPerDegLng = Math.cos(LAT * Math.PI / 180) * 6371008.8 * Math.PI / 180;
const lngAt = (m) => LNG0 + m / mPerDegLng;
/** A straight route due east, `km` long, a point every 20 m. */
function straight(km) { const out = []; for (let m = 0; m <= km * 1000 + 1e-9; m += 20) out.push([LAT, lngAt(m)]); return out; }
/** Samples the way the trip card takes them. */
function samples(path, distance) { return P.resample(path, P.plan(distance)); }

test("OSM structures: a bridge along the route counts; a flyover crossing above it doesn't", () => {
    const path = straight(6);
    const G = core.routeGeometry(path);
    assert.ok(Math.abs(G.length - 6000) < 2);
    const bridge = { id: "way/1", kind: "bridge", name: "Kolab bridge", coords: [[LAT + 0.00002, lngAt(2950)], [LAT + 0.00002, lngAt(3150)], [LAT, lngAt(3350)]] };
    const flyover = { id: "way/2", kind: "bridge", name: "Flyover", coords: [[LAT - 0.004, lngAt(4000)], [LAT, lngAt(4000)], [LAT + 0.004, lngAt(4005)]] };
    const parallelFar = { id: "way/3", kind: "bridge", name: "", coords: [[LAT + 0.001, lngAt(1000)], [LAT + 0.001, lngAt(1300)]] };   // 110 m away
    const tunnel = { id: "way/4", kind: "tunnel", name: "", coords: [[LAT, lngAt(5000)], [LAT, lngAt(5300)]] };
    const tunnel2 = { id: "way/5", kind: "tunnel", name: "", coords: [[LAT, lngAt(5320)], [LAT, lngAt(5500)]] };            // continues it
    const iv = core.structureIntervals(G, [bridge, flyover, parallelFar, tunnel, tunnel2]);
    assert.equal(iv.length, 2);
    assert.equal(iv[0].kind, "bridge"); assert.equal(iv[0].name, "Kolab bridge");
    assert.ok(Math.abs(iv[0].s0 - 2950) < 3 && Math.abs(iv[0].s1 - 3350) < 3);
    assert.equal(iv[1].kind, "tunnel"); assert.deepEqual(iv[1].ids, ["way/4", "way/5"]);   // merged across the 20 m gap
    assert.ok(Math.abs(iv[1].s1 - 5500) < 3);
});

test("DEM spikes: a dip that comes back is a likely bridge, a hump a likely tunnel; a real climb is neither", () => {
    const s = Float64Array.from({ length: 40 }, (_, i) => i * 90);
    const z = Float64Array.from(s, (x) => 200 + 0.03 * x);                    // steady 3 % climb
    z[10] -= 18; z[11] -= 22;                                                 // river valley under a bridge (~200 m)
    z[25] += 14;                                                              // ridge over a tunnel
    const sp = core.detectSpikes(s, z);
    assert.deepEqual(sp.map((x) => x.kind), ["likely-bridge", "likely-tunnel"]);
    assert.ok(sp[0].s0 <= 900 && sp[0].s1 >= 990 && sp[0].s1 - sp[0].s0 <= 450);
    assert.ok(sp[0].deviation >= 18);
    // an already-mapped structure suppresses the duplicate
    assert.equal(core.detectSpikes(s, z, [{ s0: 800, s1: 1100, kind: "bridge", name: "", source: "osm" }]).filter((x) => x.kind === "likely-bridge").length, 0);
    // a genuine 12 % climb that keeps going is not a spike
    const z2 = Float64Array.from(s, (x) => (x < 1800 ? 100 + 0.12 * x : 100 + 0.12 * 1800));
    assert.equal(core.detectSpikes(s, z2).length, 0);
});

test("applyStructures: a straight line between the road at either end; reports how far off the DEM was", () => {
    const s = Float64Array.from({ length: 21 }, (_, i) => i * 50);
    const z = Float64Array.from(s, () => 300);
    z[9] = 270; z[10] = 262; z[11] = 275;                                     // dip under a bridge at 450–550 m
    const r = core.applyStructures(s, z, [{ s0: 440, s1: 560, kind: "bridge", name: "", source: "osm" }]);
    for (let i = 8; i <= 12; i++) assert.ok(Math.abs(r.z[i] - 300) < 1e-9);
    assert.ok(Math.abs(r.intervals[0].deviation - 38) < 1e-9);
    assert.ok(Math.abs(r.intervals[0].grade) < 1e-9);
    assert.equal(z[10], 262, "input untouched");
});

test("analyze: the bridge dip disappears from the grades; steep sections are found and graded", () => {
    const path = straight(8);
    const rs = samples(path, 8000);
    const z = Array.from(rs.s, (x) => {
        let h = 400;
        if (x > 1000) h += 0.08 * Math.min(x - 1000, 1000);                   // 8 % for 1 km
        if (x > 2000) h += 0.13 * Math.min(x - 2000, 400);                    // 13 % for 400 m
        if (x > 5000) h -= 0.07 * Math.min(x - 5000, 900);                    // −7 % for 900 m
        if (x > 3300 && x < 3600) h -= 25;                                    // river under a bridge
        return h;
    });
    const bridge = { id: "way/9", kind: "bridge", name: "Indravati bridge", coords: [[LAT, lngAt(3280)], [LAT, lngAt(3620)]] };
    const withOsm = core.analyze({ path, sample: rs, z, distance: 8000, ways: [bridge], profileLib: P });
    const noOsm = core.analyze({ path, sample: rs, z, distance: 8000, ways: null, profileLib: P });
    const naive = P.buildProfile(rs.s, z, { distance: 8000 });
    const worst = (p, a, b) => { let w = 0; for (let i = 0; i < p.grade.length; i++) if (p.s[i] >= a && p.s[i] <= b) w = Math.max(w, Math.abs(p.grade[i])); return w; };
    assert.ok(worst(naive, 3100, 3800) > 0.06, "the raw DEM makes the bridge look steep");
    assert.ok(worst(withOsm.profile, 3100, 3800) < 0.02, "fixed with OpenStreetMap");
    assert.ok(worst(noOsm.profile, 3100, 3800) < 0.03, "fixed from the DEM alone");
    assert.equal(withOsm.structures[0].kind, "bridge"); assert.equal(withOsm.structures[0].source, "osm");
    assert.equal(noOsm.structures[0].kind, "likely-bridge"); assert.equal(noOsm.structures[0].source, "dem");
    assert.equal(withOsm.structureSource, "osm"); assert.equal(noOsm.structureSource, "none");
    const kinds = withOsm.sections.map((x) => `${x.kind}${x.level}`);
    assert.deepEqual(kinds, ["climb2", "descent1"]);                         // 8 % then 13 % merge into one very steep climb
    const climb = withOsm.sections[0];
    assert.ok(climb.s0 > 800 && climb.s0 < 1250 && climb.s1 > 2250 && climb.s1 < 2600);
    assert.ok(climb.rise > 100 && climb.maxGrade > 0.1);
    assert.ok(withOsm.summary.ascent < naive.ascent, "the fake dip-and-climb no longer adds ascent");
    assert.equal(withOsm.summary.bridges, 1);
    assert.ok(Math.abs(withOsm.profile.distance - 8000) < 1e-6);
});

test("analyze: terrain still unbelievable after cleaning is capped and reported; no data → flat", () => {
    const path = straight(3);
    const rs = samples(path, 3000);
    const z = Array.from(rs.s, (x) => (x < 1000 ? 100 : x < 1600 ? 100 + 0.45 * (x - 1000) : 370));   // a 45 % "road" for 600 m
    const r = core.analyze({ path, sample: rs, z, distance: 3000, ways: [], profileLib: P });
    assert.ok(r.structures.some((x) => x.kind === "capped"));
    assert.ok(r.summary.capped >= 1);
    assert.ok(r.summary.maxClimb <= 0.25 + 1e-9);
    const flat = core.analyze({ path, sample: rs, z: null, distance: 3000, ways: null, profileLib: P });
    assert.equal(flat.profile.source, "flat"); assert.equal(flat.sections.length, 0); assert.equal(flat.raw, null);
});

test("structures: simplification keeps the road shape, the query buffers it, parsing keeps only road bridges/tunnels", () => {
    const path = straight(30);                                                // 1501 points on a straight line
    const sim = ST.simplify(path);
    assert.equal(sim.pts.length, 2);
    const zig = []; for (let i = 0; i < 4000; i++) zig.push([LAT + (i % 2 ? 0.0005 : 0), lngAt(i * 10)]);
    const z2 = ST.simplify(zig);
    assert.ok(z2.pts.length <= 1200 && z2.tol > 8, "tolerance grows to stay under the cap");
    const q = ST.query([[LAT, 82.7], [LAT, 82.8]], 25);
    assert.match(q, /way\["highway"\]\["bridge"\]\["bridge"!="no"\]\(around:25,18\.80000,82\.70000,18\.80000,82\.80000\)/);
    assert.match(q, /\["tunnel"\]\["tunnel"!="no"\]/); assert.match(q, /out tags geom/);
    const ways = ST.parse({ elements: [
        { type: "way", id: 1, tags: { highway: "primary", bridge: "yes", name: "Big bridge" }, geometry: [{ lat: 1, lon: 2 }, { lat: 1.001, lon: 2 }] },
        { type: "way", id: 2, tags: { highway: "primary", tunnel: "yes" }, geometry: [{ lat: 1, lon: 2 }, { lat: 1.001, lon: 2 }] },
        { type: "way", id: 3, tags: { highway: "primary", bridge: "no" }, geometry: [{ lat: 1, lon: 2 }, { lat: 1.001, lon: 2 }] },
        { type: "way", id: 4, tags: { highway: "residential", covered: "yes" }, geometry: [{ lat: 1, lon: 2 }, { lat: 1.001, lon: 2 }] },
        { type: "node", id: 5, tags: { bridge: "yes" } },
        { type: "way", id: 6, tags: { highway: "primary", bridge: "viaduct" }, geometry: [{ lat: 1, lon: 2 }] }
    ] });
    assert.deepEqual(ways.map((w) => [w.id, w.kind, w.name]), [["way/1", "bridge", "Big bridge"], ["way/2", "tunnel", ""], ["way/4", "tunnel", ""]]);
    assert.equal(ST.routeKey([[1, 2], [3, 4]]), ST.routeKey([[1, 2], [3, 4]]));
    assert.notEqual(ST.routeKey([[1, 2], [3, 4]]), ST.routeKey([[1, 2], [3, 4.5]]));
});

/** A minimal Cache Storage. */
function fakeCaches() {
    const store = new Map();
    return { store, async open() { return { async match(k) { const v = store.get(k); return v ? { json: async () => JSON.parse(v) } : undefined; }, async put(k, res) { store.set(k, await res.text()); } }; } };
}

test("structures: one request per route, cached for 30 days, stale copy offline, nothing → 'none'", async () => {
    const calls = [];
    const fake = async (url, init) => { calls.push(init.body); return { ok: true, json: async () => ({ elements: [{ type: "way", id: 7, tags: { highway: "trunk", bridge: "yes" }, geometry: [{ lat: LAT, lon: 82.71 }, { lat: LAT, lon: 82.712 }] }] }) }; };
    let t = 0, online = true;
    const cs = fakeCaches();
    const S = ST.createStructures({ fetch: /** @type {any} */ (fake), caches: /** @type {any} */ (cs), now: () => t, online: () => online });
    const path = straight(5);
    const a = await S.along(path);
    assert.equal(a.source, "network"); assert.equal(a.ways.length, 1);
    assert.match(decodeURIComponent(calls[0]), /^data=\[out:json\]/);
    t = 10 * 86400000;
    assert.equal((await S.along(path)).source, "cache"); assert.equal(calls.length, 1);
    t = 40 * 86400000; online = false;
    assert.equal((await S.along(path)).source, "stale");
    const empty = ST.createStructures({ fetch: /** @type {any} */ (fake), caches: /** @type {any} */ (fakeCaches()), online: () => false });
    assert.deepEqual(await empty.along(path), { ways: [], source: "none" });
    const failing = ST.createStructures({ fetch: /** @type {any} */ (async () => ({ ok: false })), caches: null, online: () => true });
    assert.equal((await failing.along(path)).source, "none");
});

test("chart helpers: nice ticks, a complete table (route order), provenance in words", () => {
    const t = V.niceTicks(412, 897, 4);
    assert.deepEqual([t.lo, t.hi, t.step], [400, 1000, 200]);
    assert.deepEqual(V.niceTicks(5, 5).ticks, [-5, 5, 15]);
    const res = {
        sections: [{ kind: "climb", level: 2, s0: 1000, s1: 2400, length: 1400, rise: 140, avgGrade: 0.1, maxGrade: 0.13 }, { kind: "descent", level: 1, s0: 5000, s1: 5900, length: 900, rise: -63, avgGrade: -0.07, maxGrade: -0.075 }],
        structures: [{ kind: "bridge", s0: 3300, s1: 3600, name: "Indravati bridge", source: "osm", deviation: 25, grade: 0.001 }, { kind: "likely-tunnel", s0: 7000, s1: 7300, name: "", source: "dem", deviation: 14, grade: 0 }]
    };
    const rows = V.tableRows(res, U);
    assert.deepEqual(rows.map((r) => r.type), ["climb", "fixed", "descent", "fixed"]);
    assert.equal(rows[0].what, "Very steep climb"); assert.equal(rows[0].where, "km 1.0–2.4"); assert.equal(rows[0].length, "1.4 km");
    assert.match(rows[0].detail, /10 % average, 13 % at most · ↑ 140 m/);
    assert.equal(rows[1].what, "Bridge: Indravati bridge");
    assert.match(rows[1].detail, /terrain model was 25 m off · now \+0\.1 % · OpenStreetMap/);
    assert.equal(rows[3].what, "Likely tunnel or cutting"); assert.match(rows[3].detail, /found in the terrain data/);
    assert.equal(rows[2].length, "900 m");
    const pv = V.provenance({ elevation: { source: "dem", fetched: 0 }, structureSource: "none" });
    assert.deepEqual(pv.map((x) => x.tone), ["ok", "info"]);
    assert.match(pv[0].text, /works offline/); assert.match(pv[1].text, /not checked \(offline\)/);
    assert.match(V.provenance({ elevation: { source: "none" }, offline: true, structureSource: "cache" })[0].text, /shown flat/);
});

test("sections: a short easing doesn't split a climb; a long one does; tiny runs are dropped", () => {
    const mk = (grades, ds = 90) => {
        const s = [0], z = [100];
        for (const g of grades) { s.push(s[s.length - 1] + ds); z.push(z[z.length - 1] + g * ds); }
        return { s: Float64Array.from(s), z: Float64Array.from(z), grade: Float64Array.from(grades) };
    };
    const one = core.sections(mk([0.08, 0.08, 0.08, 0.04, 0.08, 0.11, 0.11]));
    assert.equal(one.length, 1);
    assert.equal(one[0].level, 2); assert.equal(one[0].length, 630);
    assert.ok(Math.abs(one[0].maxGrade - 0.11) < 1e-12);
    const two = core.sections(mk([0.08, 0.08, 0.08, 0.02, 0.02, 0.02, 0.08, 0.08]));
    assert.equal(two.length, 2);                                               // 270 m of easing ends it
    assert.equal(core.sections(mk([0.02, 0.09, 0.02])).length, 0);            // 90 m < 150 m
    const down = core.sections(mk([-0.07, -0.07, 0.07, 0.07]));
    assert.deepEqual(down.map((x) => x.kind), ["descent", "climb"]);          // opposite kinds never merge
});
